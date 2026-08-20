import { isIP } from 'node:net';
import { config, getProxyUrl } from '../config.js';
import { openPlaywrightBrowser, loadPlaywrightClient, acquirePooledPlaywrightPage } from './playwrightClient.js';
import { assertPublicHttpUrl, assertPublicHttpUrlResolved } from './urlSafety.js';

const COOKIE_CACHE_TTL_MS = 10 * 60 * 1000;
const COOKIE_WARMUP_DELAY_MS = 1200;
export const MAX_BROWSER_HTML_BYTES = 2 * 1024 * 1024;
const COOKIE_CONTEXT_OPTIONS = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    viewport: { width: 1440, height: 960 }
};
const BOT_KEYWORDS = [
    'captcha',
    'verification',
    'verify you are human',
    'access denied',
    'blocked',
    'rate limit',
    'too many requests',
    'please enable javascript',
    'please verify',
    '请验证',
    '验证码',
    '人机验证',
    '安全验证'
];

type CookieCacheEntry = {
    cookieHeader: string;
    expiresAt: number;
};

const cookieCache = new Map<string, CookieCacheEntry>();

function buildCookieCacheKey(url: URL): string {
    return [
        url.origin,
        getProxyUrl() || '-',
        config.playwrightPackage,
        config.playwrightModulePath || '-',
        config.playwrightExecutablePath || '-',
        config.playwrightWsEndpoint || '-',
        config.playwrightCdpEndpoint || '-'
    ].join('|');
}

function serializeCookieHeader(cookies: Array<{ name?: string; value?: string }>): string {
    return cookies
        .filter((cookie) => cookie.name && cookie.value !== undefined)
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join('; ');
}

export function looksLikeBotChallengePage(html: string): boolean {
    const normalized = html.toLowerCase();
    return BOT_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

// 页面侧脚本：检测视口中心的顶层悬浮浮层文本，用于捕获非语义化 <dialog> 的模态框，例如放在 Shadow DOM 内的 Salesforce SLDS 模态。
// 注意：本函数作为 page.evaluate 的参数传入，被序列化后在页面上下文执行，因此函数体必须自包含，不得引用外部模块变量。
export function detectFloatingOverlayPageScript(): string[] | undefined {
    function isVisuallyFloating(el: Element): boolean {
        const style = window.getComputedStyle(el);
        const pos = style.position;
        if (pos !== 'fixed' && pos !== 'absolute') return false;
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const z = parseInt(style.zIndex || '0', 10);
        return !isNaN(z) && z > 0;
    }
    function findFloatingInTree(el: Element): string | undefined {
        if (isVisuallyFloating(el)) return el.textContent?.trim();
        if (el.shadowRoot) {
            const all = el.shadowRoot.querySelectorAll('*');
            for (const desc of all) {
                if (isVisuallyFloating(desc)) return desc.textContent?.trim();
            }
        }
        return undefined;
    }
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const topEl = document.elementFromPoint(cx, cy);
    if (topEl) {
        const text = findFloatingInTree(topEl);
        if (text) return [text];
    }
    return undefined;
}

// Cache only blocked hostname classifications. Public resolutions are checked
// on every request so DNS rebinding cannot reuse an earlier allow decision.
const SUBRESOURCE_CLASSIFICATION_TTL_MS = 60 * 1000;
const SUBRESOURCE_CLASSIFICATION_MAX_ENTRIES = 1024;
type SubresourceClassification = { allowed: boolean; expiresAt: number };
const subresourceClassificationCache = new Map<string, SubresourceClassification>();

function readSubresourceClassification(hostname: string): boolean | undefined {
    const entry = subresourceClassificationCache.get(hostname);
    if (!entry) {
        return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
        subresourceClassificationCache.delete(hostname);
        return undefined;
    }
    return entry.allowed;
}

function writeBlockedSubresourceClassification(hostname: string): void {
    if (subresourceClassificationCache.size >= SUBRESOURCE_CLASSIFICATION_MAX_ENTRIES) {
        // Map preserves insertion order; drop the oldest.
        const oldestKey = subresourceClassificationCache.keys().next().value;
        if (oldestKey !== undefined) {
            subresourceClassificationCache.delete(oldestKey);
        }
    }
    subresourceClassificationCache.set(hostname, {
        allowed: false,
        expiresAt: Date.now() + SUBRESOURCE_CLASSIFICATION_TTL_MS
    });
}

// Async variant for sub-resource requests. Denials are cached, while allowed
// hosts are resolved on each request to remain fail-closed under DNS rebinding.
export async function classifyBrowserSubresourceUrl(targetUrl: string): Promise<void> {
    const parsed = new URL(targetUrl);
    // Protocol + literal-IP private check first (sync, free).
    assertPublicHttpUrl(parsed, 'Browser subresource URL');

    // URL.hostname brackets IPv6 literals; any IP literal is already cleared above.
    const { hostname } = parsed;
    if (isIP(hostname) !== 0 || hostname.startsWith('[')) {
        return;
    }

    const cacheKey = hostname.toLowerCase();
    const cached = readSubresourceClassification(cacheKey);
    if (cached === false) {
        throw new Error('Browser subresource URL points to a private or local network target, which is not allowed');
    }

    try {
        await assertPublicHttpUrlResolved(parsed, 'Browser subresource URL');
    } catch (err) {
        writeBlockedSubresourceClassification(cacheKey);
        throw err;
    }
}

export function __resetBrowserSubresourceCacheForTests(): void {
    subresourceClassificationCache.clear();
}

export function __getBrowserSubresourceClassificationForTests(hostname: string): boolean | undefined {
    return subresourceClassificationCache.get(hostname.toLowerCase())?.allowed;
}

export async function __installNavigationGuardForTests(page: any): Promise<void> {
    await installNavigationGuard(page);
}

// Intercepts every request the page makes (navigation + sub-resources) and
// aborts ones whose target is private/loopback at either the literal or
// DNS-resolved level. Navigation hits DNS fresh every time to keep the
// rebinding window tight; sub-resources go through a hostname TTL cache.
// 安装本身是 fail-closed：route 不可用或安装失败都会抛出，调用方必须拒绝无守卫的导航。
export async function installNavigationGuard(page: any): Promise<void> {
    if (typeof page.route !== 'function') {
        throw new Error('Browser request interception is unavailable; refusing browser navigation because public-network safety cannot be enforced');
    }
    try {
        await page.route('**/*', async (route: any) => {
            const request = route.request();
            const targetUrl = request.url();
            try {
                if (request.isNavigationRequest()) {
                    await assertPublicHttpUrlResolved(targetUrl, 'Browser navigation URL');
                } else {
                    await classifyBrowserSubresourceUrl(targetUrl);
                }
                await route.continue();
            } catch {
                await route.abort().catch(() => undefined);
            }
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Browser request interception could not be installed; refusing browser navigation because public-network safety cannot be enforced: ${message}`);
    }
}

async function createCookieCollectionPage(browser: any): Promise<{ page: any; close(): Promise<void> }> {
    // 解决 Cookie 采集复用页导致上下文状态串用的问题。
    // 这里显式为每次采集创建独立 context，确保 cookies/storage/open pages 不会跨调用污染。
    // 但 connectOverCDP 返回的浏览器通常只有一个默认持久化 context，不支持 newContext()，
    // 所以当 newContext 不可用时回退到默认 context + 手动清理。
    if (typeof browser.newContext === 'function') {
        let context: any;
        try {
            context = await browser.newContext(COOKIE_CONTEXT_OPTIONS);
            const page = await context.newPage();
            return {
                page,
                close: async () => {
                    await context.close().catch(() => undefined);
                }
            };
        } catch {
            if (context && typeof context.close === 'function') {
                await context.close().catch(() => undefined);
            }
            // newContext 可能在 CDP 连接上抛异常，回退到默认 context
        }
    }

    // CDP 回退：复用默认 context 并在清理时手动重置状态
    if (typeof browser.contexts === 'function') {
        const contexts = browser.contexts();
        if (Array.isArray(contexts) && contexts.length > 0 && typeof contexts[0].newPage === 'function') {
            const context = contexts[0];
            const page = await context.newPage();
            return {
                page,
                close: async () => {
                    await page.close().catch(() => undefined);
                    if (typeof context.clearCookies === 'function') {
                        await context.clearCookies().catch(() => undefined);
                    }
                }
            };
        }
    }

    throw new Error('Browser does not support creating a page for cookie collection');
}

export async function __createCookieCollectionPageForTests(browser: any): Promise<{ page: any; close(): Promise<void> }> {
    return await createCookieCollectionPage(browser);
}

export async function readCookiesFromPage(page: any, url: string): Promise<string> {
    if (typeof page.context === 'function') {
        const context = page.context();
        if (context && typeof context.cookies === 'function') {
            const cookies = await context.cookies([url]);
            return serializeCookieHeader(cookies);
        }
    }

    return '';
}

export async function getBrowserCookieHeader(urlInput: string, forceRefresh: boolean = false): Promise<string | undefined> {
    const url = new URL(urlInput);
    await assertPublicHttpUrlResolved(url, 'Browser cookie URL');
    const cacheKey = buildCookieCacheKey(url);
    const cached = cookieCache.get(cacheKey);

    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
        return cached.cookieHeader;
    }

    const playwright = await loadPlaywrightClient({ silent: true });
    if (!playwright) {
        return undefined;
    }

    const session = await openPlaywrightBrowser();

    try {
        const { page, close } = await createCookieCollectionPage(session.browser);

        try {
            await installNavigationGuard(page);
            await page.goto(url.toString(), {
                waitUntil: 'domcontentloaded',
                timeout: Math.max(config.playwrightNavigationTimeoutMs, 15000)
            }).catch(() => undefined);
            if (typeof page.waitForTimeout === 'function') {
                await page.waitForTimeout(COOKIE_WARMUP_DELAY_MS).catch(() => undefined);
            }

            const cookieHeader = await readCookiesFromPage(page, url.toString());
            if (!cookieHeader) {
                return undefined;
            }

            cookieCache.set(cacheKey, {
                cookieHeader,
                expiresAt: Date.now() + COOKIE_CACHE_TTL_MS
            });

            return cookieHeader;
        } finally {
            await close();
        }
    } finally {
        await session.release();
    }
}

export async function fetchPageHtmlWithBrowser(urlInput: string): Promise<{ html: string; finalUrl: string; title: string; dialogTexts?: string[] }> {
    await assertPublicHttpUrlResolved(urlInput, 'Browser fetch URL');

    const playwright = await loadPlaywrightClient({ silent: true });
    if (!playwright) {
        throw new Error('Playwright client is not available for browser HTML fetch');
    }

    const session = await openPlaywrightBrowser();

    try {
        // Copilot review r3524589121: 复用页面池换取无新窗口，但可能在不同 fetch 间泄漏
        // cookies/storage。当前 fetch 场景以抓取匿名 HTML 为主，不需要完全隔离；
        // 若需要干净 Cookie 隔离的 fetch 场景，应使用 getBrowserCookieHeader 的独立 context 路径。
        const { page, releasePage } = await acquirePooledPlaywrightPage(session.browser, {
            poolKey: 'fetch-html',
            preparePage: async (p) => { await installNavigationGuard(p); }
        });

        try {
            // 在页面 JS 自动关闭弹层之前抢先捕获 <dialog> 悬浮层文本：<dialog> 是"悬浮于内容之上"的语义化 HTML 元素。通过 addInitScript 注入 MutationObserver，使其先于任何页面脚本运行，待页面稳定后再取回捕获到的文本。
            if (typeof page.addInitScript === 'function') {
                await page.addInitScript(() => {
                    (window as any).__mcpCapturedDialogs = [];

                    function startDialogObserver() {
                        const root = document.documentElement;
                        // 使用 document.open() 的页面会让 documentElement 暂时为 null，等 DOMContentLoaded 或下一轮任务再重试。
                        if (!root) {
                            if (document.readyState === 'loading') {
                                document.addEventListener('DOMContentLoaded', startDialogObserver, { once: true });
                            } else {
                                setTimeout(startDialogObserver, 0);
                            }
                            return;
                        }

                        const observer = new MutationObserver((mutations: MutationRecord[]) => {
                            for (const m of mutations) {
                                for (const node of m.addedNodes) {
                                    if (node instanceof Element) {
                                        if (node.tagName === 'DIALOG' && (node as HTMLDialogElement).open) {
                                            const text = node.textContent?.trim();
                                            if (text) {
                                                (window as any).__mcpCapturedDialogs.push(text);
                                            }
                                        }
                                        const nested = node.querySelectorAll?.('dialog[open]');
                                        if (nested) {
                                            for (const d of nested) {
                                                const text = d.textContent?.trim();
                                                if (text) {
                                                    (window as any).__mcpCapturedDialogs.push(text);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        });
                        observer.observe(root, { childList: true, subtree: true });
                    }

                    startDialogObserver();
                }).catch(() => undefined);
            }

            await page.goto(urlInput, {
                waitUntil: 'domcontentloaded',
                timeout: Math.max(config.playwrightNavigationTimeoutMs, 15000)
            });

            if (typeof page.waitForLoadState === 'function') {
                await page.waitForLoadState('networkidle', {
                    timeout: Math.min(Math.max(config.playwrightNavigationTimeoutMs, 5000), 15000)
                }).catch(() => undefined);
            }

            if (typeof page.waitForTimeout === 'function') {
                await page.waitForTimeout(COOKIE_WARMUP_DELAY_MS).catch(() => undefined);
            }

            if (typeof page.evaluate === 'function') {
                const estimatedHtmlBytes = await page.evaluate(() => new Blob([
                    document.documentElement?.outerHTML || ''
                ]).size);
                if (Number(estimatedHtmlBytes) > MAX_BROWSER_HTML_BYTES) {
                    throw new Error(`Response body too large (${estimatedHtmlBytes} bytes). Max allowed is ${MAX_BROWSER_HTML_BYTES} bytes`);
                }
            }

            const html = typeof page.content === 'function' ? await page.content() : '';
            const finalUrl = typeof page.url === 'function' ? page.url() : urlInput;
            const title = typeof page.title === 'function' ? await page.title().catch(() => '') : '';

            // 取回捕获到的 dialog 文本，同时补查此刻仍处于打开状态的 dialog（以防它们在 MutationObserver 停止响应后才出现或被漏掉）。
            // 若仍为空，回退到视口中心悬浮层检测，因为真实站点的模态框经常不是语义化 <dialog>（例如 Salesforce SLDS 模态 SECTION.slds-modal 位于 Shadow DOM 内），只能靠 fixed/absolute + z-index 的视觉悬浮判定捕获。
            let dialogTexts: string[] | undefined;
            if (typeof page.evaluate === 'function') {
                const collected = await page.evaluate(() => {
                    const captured: string[] = (window as any).__mcpCapturedDialogs || [];
                    for (const d of document.querySelectorAll('dialog[open]')) {
                        const text = d.textContent?.trim();
                        if (text && !captured.includes(text)) {
                            captured.push(text);
                        }
                    }
                    return captured;
                }).catch(() => [] as string[]);

                if (collected && collected.length > 0) {
                    dialogTexts = collected;
                } else {
                    dialogTexts = await page.evaluate(detectFloatingOverlayPageScript).catch(() => undefined) ?? undefined;
                }

                if (dialogTexts && dialogTexts.length > 1) {
                    dialogTexts = Array.from(new Set(dialogTexts));
                }
            }

            return {
                html: String(html || ''),
                finalUrl: String(finalUrl || urlInput),
                title: String(title || ''),
                ...(dialogTexts ? { dialogTexts } : {})
            };
        } finally {
            await releasePage();
        }
    } finally {
        await session.release();
    }
}
