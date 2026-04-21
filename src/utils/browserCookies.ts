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

// Intercepts every navigation the page makes (including cross-origin redirects)
// and aborts ones whose target is private/loopback. Sub-resource requests are
// allowed through unless they're private — the validator rejects on either
// literal-private or DNS-resolved-private.
async function installNavigationGuard(page: any): Promise<void> {
    if (typeof page.route !== 'function') {
        return;
    }
    try {
        await page.route('**/*', async (route: any) => {
            const request = typeof route.request === 'function' ? route.request() : undefined;
            const targetUrl = typeof request?.url === 'function' ? request.url() : undefined;
            if (!targetUrl) {
                await route.continue().catch(() => undefined);
                return;
            }
            const isNav = typeof request?.isNavigationRequest === 'function'
                ? request.isNavigationRequest()
                : false;
            try {
                if (isNav) {
                    await assertPublicHttpUrlResolved(targetUrl, 'Browser navigation URL');
                } else {
                    // Subresources: literal-only check. Skipping per-resource DNS
                    // keeps a page load with dozens of assets fast; literal-private
                    // targets (image/script/XHR to 127.0.0.1, 169.254.169.254, …)
                    // are still blocked.
                    assertPublicHttpUrl(targetUrl, 'Browser subresource URL');
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
    if (typeof browser.newContext === 'function') {
        const context = await browser.newContext(COOKIE_CONTEXT_OPTIONS);
        const page = await context.newPage();
        return {
            page,
            close: async () => {
                await context.close().catch(() => undefined);
            }
        };
    }

    if (typeof browser.contexts === 'function') {
        const contexts = browser.contexts();
        if (Array.isArray(contexts) && contexts.length > 0 && typeof contexts[0].newPage === 'function') {
            const page = await contexts[0].newPage();
            return {
                page,
                close: async () => {
                    await page.close().catch(() => undefined);
                }
            };
        }
    }

    if (typeof browser.newPage === 'function') {
        const page = await browser.newPage();
        return {
            page,
            close: async () => {
                await page.close().catch(() => undefined);
            }
        };
    }

    throw new Error('Connected Playwright browser does not support creating a page for cookie collection');
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
        await session.close();
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
        await session.close();
    }
}
