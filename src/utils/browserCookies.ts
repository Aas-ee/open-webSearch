import { isIP } from 'node:net';
import { config, getProxyUrl } from '../config.js';
import { openPlaywrightBrowser, loadPlaywrightClient } from './playwrightClient.js';
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
async function installNavigationGuard(page: any): Promise<void> {
    if (typeof page.route !== 'function') {
        return;
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

    const session = await openPlaywrightBrowser(true);

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

export async function fetchPageHtmlWithBrowser(urlInput: string): Promise<{ html: string; finalUrl: string; title: string }> {
    await assertPublicHttpUrlResolved(urlInput, 'Browser fetch URL');

    const playwright = await loadPlaywrightClient({ silent: true });
    if (!playwright) {
        throw new Error('Playwright client is not available for browser HTML fetch');
    }

    const session = await openPlaywrightBrowser(true);

    try {
        const { page, close } = await createCookieCollectionPage(session.browser);

        try {
            await installNavigationGuard(page);
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

            return {
                html: String(html || ''),
                finalUrl: String(finalUrl || urlInput),
                title: String(title || '')
            };
        } finally {
            await close();
        }
    } finally {
        await session.release();
    }
}
