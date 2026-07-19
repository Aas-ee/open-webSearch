import { isIP } from 'node:net';
import { config, getProxyUrl } from '../config.js';
import { openPlaywrightBrowser, loadPlaywrightClient, acquirePooledPlaywrightPage } from './playwrightClient.js';
import { assertPublicHttpUrl, assertPublicHttpUrlResolved } from './urlSafety.js';

const COOKIE_CACHE_TTL_MS = 10 * 60 * 1000;
const COOKIE_WARMUP_DELAY_MS = 1200;
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

// Hostname-level TTL cache used by the subresource guard so a page loading
// N assets from one CDN costs one DNS lookup, not N. Bounded to keep memory
// capped; short TTL shrinks the DNS-rebinding window for subresources.
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

function writeSubresourceClassification(hostname: string, allowed: boolean): void {
    if (subresourceClassificationCache.size >= SUBRESOURCE_CLASSIFICATION_MAX_ENTRIES) {
        // Map preserves insertion order; drop the oldest.
        const oldestKey = subresourceClassificationCache.keys().next().value;
        if (oldestKey !== undefined) {
            subresourceClassificationCache.delete(oldestKey);
        }
    }
    subresourceClassificationCache.set(hostname, {
        allowed,
        expiresAt: Date.now() + SUBRESOURCE_CLASSIFICATION_TTL_MS
    });
}

// Async variant for sub-resource requests. Uses the TTL cache so that common
// page-load patterns (dozens of assets from one CDN) don't trigger one DNS
// lookup per asset, while hostname-to-private resolutions are still caught.
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
    if (cached === true) {
        return;
    }
    if (cached === false) {
        throw new Error('Browser subresource URL points to a private or local network target, which is not allowed');
    }

    try {
        await assertPublicHttpUrlResolved(parsed, 'Browser subresource URL');
        writeSubresourceClassification(cacheKey, true);
    } catch (err) {
        writeSubresourceClassification(cacheKey, false);
        throw err;
    }
}

export function __resetBrowserSubresourceCacheForTests(): void {
    subresourceClassificationCache.clear();
}

export function __getBrowserSubresourceClassificationForTests(hostname: string): boolean | undefined {
    return subresourceClassificationCache.get(hostname.toLowerCase())?.allowed;
}

// Intercepts every request the page makes (navigation + sub-resources) and
// aborts ones whose target is private/loopback at either the literal or
// DNS-resolved level. Navigation hits DNS fresh every time to keep the
// rebinding window tight; sub-resources go through a hostname TTL cache.
// 本函数用页面级标记避免页面池复用时叠加多个 route 拦截器。
// 每次调用会替换已安装的拦截器，而不是再添加一个。
async function installNavigationGuard(page: any): Promise<void> {
    if (typeof page.route !== 'function') {
        return;
    }
    try {
        // 移除已安装的拦截器，防止叠加
        if (page.__navGuardInstalled) {
            await page.unroute('**/*').catch(() => undefined);
        }

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
        page.__navGuardInstalled = true;
    } catch {
        // Some connected browsers (e.g., certain CDP setups) may not support route
        // interception. Pre-navigation validation still gates the initial URL.
    }
}

async function createCookieCollectionPage(browser: any): Promise<{ page: any; close(): Promise<void> }> {
    // 解决 Cookie 采集复用页导致上下文状态串用的问题。
    // 这里显式为每次采集创建独立 context，确保 cookies/storage/open pages 不会跨调用污染。
    // 但 connectOverCDP 返回的浏览器通常只有一个默认持久化 context，不支持 newContext()，
    // 所以当 newContext 不可用时回退到默认 context + 手动清理。
    if (typeof browser.newContext === 'function') {
        try {
            const context = await browser.newContext(COOKIE_CONTEXT_OPTIONS);
            const page = await context.newPage();
            return {
                page,
                close: async () => {
                    await context.close().catch(() => undefined);
                }
            };
        } catch {
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

async function readCookiesFromPage(page: any, url: string): Promise<string> {
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
            // Capture <dialog> overlay text before the dialogs may be
            // auto-dismissed by page JS.  <dialog> is the semantic HTML
            // element for overlays — it signals "floating above" content.
            // We inject a MutationObserver via addInitScript so it runs
            // before any page script, then retrieve captured texts after
            // the page settles.
            if (typeof page.addInitScript === 'function') {
                await page.addInitScript(() => {
                    (window as any).__mcpCapturedDialogs = [];

                    function startDialogObserver() {
                        const root = document.documentElement;
                        // On pages that use document.open(), documentElement
                        // may be null temporarily.  Wait for DOMContentLoaded
                        // or the next microtask before retrying.
                        if (!root) {
                            if (document.readyState === 'loading') {
                                document.addEventListener('DOMContentLoaded', startDialogObserver, { once: true });
                            } else {
                                setTimeout(startDialogObserver, 0);
                            }
                            return;
                        }

                        // 内联：用 CSS 定位特征检测视觉悬浮层。
                        // position=fixed/absolute + 可见 + z-index > 0
                        // 是"浮在页面内容上层"的结构化信号。
                        function isVisuallyFloating(el: Element): boolean {
                            const style = window.getComputedStyle(el);
                            const pos = style.position;
                            if (pos !== 'fixed' && pos !== 'absolute') return false;
                            if (style.display === 'none' || style.visibility === 'hidden') return false;
                            const z = parseInt(style.zIndex || '0', 10);
                            return !isNaN(z) && z > 0;
                        }

                        // 递归检查元素及其 shadow root 中的悬浮层。
                        function findFloatingInTree(el: Element): string | undefined {
                            if (isVisuallyFloating(el)) {
                                return el.textContent?.trim();
                            }
                            if (el.shadowRoot) {
                                const walker = document.createTreeWalker(el.shadowRoot, NodeFilter.SHOW_ELEMENT);
                                while (walker.nextNode()) {
                                    const desc = walker.currentNode as Element;
                                    if (isVisuallyFloating(desc)) {
                                        return desc.textContent?.trim();
                                    }
                                }
                            }
                            return undefined;
                        }

                        const observer = new MutationObserver((mutations: MutationRecord[]) => {
                            for (const m of mutations) {
                                for (const node of m.addedNodes) {
                                    if (node instanceof Element) {
                                        const text = findFloatingInTree(node);
                                        if (text) {
                                            (window as any).__mcpCapturedDialogs.push(text);
                                        }
                                        // 同时检查可见的后代元素
                                        const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
                                        while (walker.nextNode()) {
                                            const desc = walker.currentNode as Element;
                                            const t = findFloatingInTree(desc);
                                            if (t) {
                                                (window as any).__mcpCapturedDialogs.push(t);
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

            const html = typeof page.content === 'function' ? await page.content() : '';
            const finalUrl = typeof page.url === 'function' ? page.url() : urlInput;
            const title = typeof page.title === 'function' ? await page.title().catch(() => '') : '';

            // 获取捕获的悬浮层文本。MutationObserver 监听的是 Light DOM，
            // 无法捕获 Shadow DOM 内的插入。页面稳定后，直接扫描所有
            // shadow root，只取视口中心最顶层的那个悬浮层。
            let dialogTexts: string[] | undefined;
            if (typeof page.evaluate === 'function') {
                dialogTexts = await page.evaluate(() => {
                    // 内联：用 CSS 定位特征检测视觉悬浮层。
                    function isVisuallyFloating(el: Element): boolean {
                        const style = window.getComputedStyle(el);
                        const pos = style.position;
                        if (pos !== 'fixed' && pos !== 'absolute') return false;
                        if (style.display === 'none' || style.visibility === 'hidden') return false;
                        const z = parseInt(style.zIndex || '0', 10);
                        return !isNaN(z) && z > 0;
                    }

                    // 用 elementFromPoint 找视口中心最顶层的元素，
                    // 向上追溯是否浮空。Shadow DOM 会阻断父链，
                    // 所以也检查 shadow root 内的悬浮层。
                    // 注意：document.createTreeWalker 无法遍历 shadow root，
                    // 必须用 querySelectorAll 代替。
                    function findFloatingInTree(el: Element): string | undefined {
                        if (isVisuallyFloating(el)) {
                            return el.textContent?.trim();
                        }
                        if (el.shadowRoot) {
                            const all = el.shadowRoot.querySelectorAll('*');
                            for (const desc of all) {
                                if (isVisuallyFloating(desc)) {
                                    return desc.textContent?.trim();
                                }
                            }
                        }
                        return undefined;
                    }

                    // 视口中心最顶层的元素
                    const cx = window.innerWidth / 2;
                    const cy = window.innerHeight / 2;
                    const topEl = document.elementFromPoint(cx, cy);
                    if (topEl) {
                        const text = findFloatingInTree(topEl);
                        if (text) return [text];
                    }

                    return undefined;
                }).catch(() => undefined);
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
