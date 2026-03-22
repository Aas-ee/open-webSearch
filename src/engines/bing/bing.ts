import axios from 'axios';
import * as cheerio from 'cheerio';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config, getProxyUrl } from '../../config.js';
import { SearchResult } from '../../types.js';
import { parseBingSearchResults } from './parser.js';
import { getPlaywrightModuleSource, loadPlaywrightClient, openPlaywrightBrowser } from '../../utils/playwrightClient.js';

const BING_BASE_URL = 'https://cn.bing.com/search';
const BING_HOME_URL = 'https://www.bing.com/?mkt=zh-CN';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH_INPUT_SELECTORS = [
    'input[name="q"]',
    'input[type="search"]',
    '#sb_form_q',
    'input#sb_form_q',
    '.b_searchboxForm input'
];
const NEXT_PAGE_SELECTORS = [
    'a.sb_pagN',
    '.b_pag a.sb_pagN',
    'a[title="Next page"]',
    'a[aria-label="Next page"]'
];
const FALLBACK_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1'
};
const BOT_DETECTION_KEYWORDS = [
    'captcha',
    'verification',
    'verify you are human',
    'access denied',
    'blocked',
    'rate limit',
    'too many requests',
    '请验证',
    '验证码',
    '人机验证'
];
const BROWSER_CONTEXT_OPTIONS = {
    userAgent: BROWSER_USER_AGENT,
    locale: 'zh-CN',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: 'light'
};

function buildBingSearchUrl(query: string, pageNumber: number): string {
    const url = new URL(BING_BASE_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('setlang', 'zh-CN');
    url.searchParams.set('ensearch', '0');
    url.searchParams.set('first', String(1 + pageNumber * 10));
    return url.toString();
}

function analyzeBlockedPage(html: string): { blocked: boolean; hasResults: boolean; detectedKeywords: string[]; title: string } {
    const normalized = html.toLowerCase();
    const $ = cheerio.load(html);
    const title = $('title').first().text().trim().toLowerCase();
    const detectedKeywords = BOT_DETECTION_KEYWORDS.filter((keyword) => normalized.includes(keyword));
    const resultSelector = '#b_results .b_algo, #b_results li.b_algo, .b_algo, .b_ans';
    const hasStructuredResults = $(resultSelector).length > 0;
    const hasParsedResults = parseBingSearchResults(html, 1).length > 0;
    const hasResults = hasStructuredResults || hasParsedResults;
    const hasCaptchaUi = $([
        'iframe[src*="captcha"]',
        '[id*="captcha"]',
        '[class*="captcha"]',
        'form[action*="validate"]',
        'input[name*="captcha"]',
        '#b_captcha',
        '.b_captcha'
    ].join(',')).length > 0;
    const hasStrongTitleSignal = [
        'captcha',
        'verify you are human',
        'access denied',
        'too many requests',
        '验证码',
        '人机验证',
        '请验证'
    ].some((keyword) => title.includes(keyword));
    const blocked = !hasResults && (hasCaptchaUi || hasStrongTitleSignal || detectedKeywords.length >= 2);

    return {
        blocked,
        hasResults,
        detectedKeywords,
        title
    };
}

function buildAxiosRequestOptions(): any {
    const effectiveProxyUrl = getProxyUrl();
    const requestOptions: any = {
        headers: FALLBACK_HEADERS,
        timeout: config.playwrightNavigationTimeoutMs
    };

    if (effectiveProxyUrl) {
        const proxyAgent = new HttpsProxyAgent(effectiveProxyUrl);
        requestOptions.httpAgent = proxyAgent;
        requestOptions.httpsAgent = proxyAgent;
    }

    return requestOptions;
}

let playwrightAvailabilityPromise: Promise<boolean> | null = null;
let hasVerifiedPlaywrightAvailability = false;

function randomDelay(minMs: number, maxMs: number): number {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

async function waitRandom(page: any, minMs: number, maxMs: number): Promise<void> {
    await page.waitForTimeout(randomDelay(minMs, maxMs));
}

function buildBrowserLaunchArgs(): string[] {
    return [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection'
    ];
}

async function setupAntiDetection(page: any): Promise<void> {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => false
        });
        delete (navigator as any).__proto__.webdriver;

        Object.defineProperty(navigator, 'userAgent', {
            get: () => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        Object.defineProperty(navigator, 'platform', {
            get: () => 'MacIntel'
        });
        Object.defineProperty(navigator, 'languages', {
            get: () => ['zh-CN', 'zh', 'en-US', 'en']
        });
        Object.defineProperty(navigator, 'hardwareConcurrency', {
            get: () => 8
        });

        if (!(navigator as any).deviceMemory) {
            Object.defineProperty(navigator, 'deviceMemory', {
                get: () => 8
            });
        }

        const createPlugin = (name: string, filename: string, description: string, mimeTypes: any[]) => {
            const plugin: any = { name, filename, description, length: mimeTypes.length };
            mimeTypes.forEach((mimeType, index) => {
                plugin[index] = mimeType;
            });
            return plugin;
        };
        const createMimeType = (type: string, suffixes: string, description: string) => ({
            type,
            suffixes,
            description,
            enabledPlugin: {}
        });

        Object.defineProperty(navigator, 'plugins', {
            get: () => [
                createPlugin('Chrome PDF Plugin', 'internal-pdf-viewer', 'Portable Document Format', [createMimeType('application/x-google-chrome-pdf', 'pdf', 'Portable Document Format')]),
                createPlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', '', [createMimeType('application/pdf', 'pdf', '')]),
                createPlugin('Native Client', 'internal-nacl-plugin', '', [
                    createMimeType('application/x-nacl', '', 'Native Client Executable'),
                    createMimeType('application/x-pnacl', '', 'Portable Native Client Executable')
                ])
            ]
        });

        Object.defineProperty(navigator, 'mimeTypes', {
            get: () => {
                const mimeTypes: any[] = [];
                const plugins = navigator.plugins as any;
                for (let pluginIndex = 0; pluginIndex < plugins.length; pluginIndex += 1) {
                    const plugin = plugins[pluginIndex];
                    for (let mimeIndex = 0; mimeIndex < plugin.length; mimeIndex += 1) {
                        mimeTypes.push(plugin[mimeIndex]);
                    }
                }
                return mimeTypes;
            }
        });

        (window as any).chrome = {
            app: {
                InstallState: 'installed',
                RunningState: 'running',
                getDetails: () => null,
                getIsInstalled: () => false
            },
            csi: () => ({
                startE: Date.now(),
                onloadT: Date.now(),
                pageT: 100,
                tran: 15
            }),
            loadTimes: () => ({
                commitLoadTime: 0,
                connectionInfo: 'http/1.1',
                finishDocumentLoadTime: 0,
                finishLoadTime: 0,
                firstPaintAfterLoadTime: 0,
                firstPaintTime: 0,
                navigationType: 'Other',
                npnNegotiatedProtocol: 'unknown',
                requestTime: 0,
                startLoadTime: 0,
                wasAlternateProtocolAvailable: false,
                wasFetchedViaSpdy: false,
                wasNpnNegotiated: false
            }),
            runtime: {
                connect: () => ({
                    onConnect: { addListener: () => undefined },
                    onMessage: { addListener: () => undefined },
                    postMessage: () => undefined,
                    disconnect: () => undefined
                }),
                sendMessage: () => Promise.resolve({}),
                onConnect: { addListener: () => undefined },
                onMessage: { addListener: () => undefined }
            }
        };

        const originalQuery = (window.navigator.permissions as any).query;
        (window.navigator.permissions as any).query = (parameters: any) => {
            if (parameters.name === 'notifications') {
                return Promise.resolve({ state: Notification.permission });
            }
            return originalQuery ? originalQuery(parameters) : Promise.resolve({ state: 'granted' });
        };

        const webglGetParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (parameter: number) {
            if (parameter === 37445) {
                return 'Intel Inc.';
            }
            if (parameter === 37446) {
                return 'Intel(R) Iris(TM) Graphics 6100';
            }
            return webglGetParameter.call(this, parameter);
        };

        if (typeof WebGL2RenderingContext !== 'undefined') {
            const webgl2GetParameter = WebGL2RenderingContext.prototype.getParameter;
            WebGL2RenderingContext.prototype.getParameter = function (parameter: number) {
                if (parameter === 37445) {
                    return 'Intel Inc.';
                }
                if (parameter === 37446) {
                    return 'Intel(R) Iris(TM) Graphics 6100';
                }
                return webgl2GetParameter.call(this, parameter);
            };
        }

        const viewportWidth = window.innerWidth || 1920;
        const viewportHeight = window.innerHeight || 1080;
        Object.defineProperty(window, 'outerWidth', { get: () => viewportWidth });
        Object.defineProperty(window, 'outerHeight', { get: () => viewportHeight });

        if (!(navigator as any).connection) {
            Object.defineProperty(navigator, 'connection', {
                get: () => ({
                    effectiveType: '4g',
                    rtt: 50,
                    downlink: 10,
                    saveData: false
                })
            });
        }

        const originalToString = Function.prototype.toString;
        Function.prototype.toString = function () {
            return originalToString.call(this).includes('[native code]') ? originalToString.call(this) : 'function () { [native code] }';
        };
    });
}

async function preparePlaywrightPage(page: any): Promise<void> {
    await setupAntiDetection(page);
    if (typeof page.setViewportSize === 'function') {
        await page.setViewportSize(BROWSER_CONTEXT_OPTIONS.viewport).catch(() => undefined);
    }
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7'
    });
}

async function createPlaywrightPage(browser: any): Promise<{ context: any | null; page: any; closePageContext(): Promise<void> }> {
    if (typeof browser.newContext === 'function') {
        const context = await browser.newContext(BROWSER_CONTEXT_OPTIONS);
        const page = await context.newPage();
        await preparePlaywrightPage(page);
        return {
            context,
            page,
            closePageContext: async () => {
                await context.close().catch(() => undefined);
            }
        };
    }

    if (typeof browser.contexts === 'function') {
        const contexts = browser.contexts();
        if (Array.isArray(contexts) && contexts.length > 0 && typeof contexts[0].newPage === 'function') {
            const page = await contexts[0].newPage();
            await preparePlaywrightPage(page);
            return {
                context: contexts[0],
                page,
                closePageContext: async () => {
                    await page.close().catch(() => undefined);
                }
            };
        }
    }

    if (typeof browser.newPage === 'function') {
        const page = await browser.newPage();
        await preparePlaywrightPage(page);
        return {
            context: null,
            page,
            closePageContext: async () => {
                await page.close().catch(() => undefined);
            }
        };
    }

    throw new Error('Connected Playwright browser does not support creating a page');
}

async function openBingAndSearch(page: any, query: string): Promise<void> {
    await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await waitRandom(page, 500, 1100);
    await page.goto(BING_HOME_URL, {
        waitUntil: 'load',
        timeout: Math.max(config.playwrightNavigationTimeoutMs, 30000)
    });
    await waitRandom(page, 700, 1600);

    let searchInput: any = null;
    for (const selector of SEARCH_INPUT_SELECTORS) {
        const candidate = await page.$(selector).catch(() => null);
        if (candidate) {
            searchInput = candidate;
            break;
        }
    }

    if (!searchInput) {
        throw new Error('Could not find Bing search input box');
    }

    await searchInput.click();
    await waitRandom(page, 180, 420);
    await searchInput.type(query, { delay: randomDelay(45, 120) });
    await waitRandom(page, 260, 700);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#b_results, .b_algo, #b_content', {
        timeout: Math.min(config.playwrightNavigationTimeoutMs, 15000)
    });
    await waitRandom(page, 900, 1600);
}

async function goToNextResultsPage(page: any): Promise<boolean> {
    for (const selector of NEXT_PAGE_SELECTORS) {
        const nextButton = await page.$(selector).catch(() => null);
        if (!nextButton) {
            continue;
        }

        await waitRandom(page, 400, 900);
        await Promise.all([
            page.waitForLoadState('domcontentloaded', { timeout: config.playwrightNavigationTimeoutMs }).catch(() => undefined),
            nextButton.click()
        ]);
        await page.waitForSelector('#b_results, .b_algo, #b_content', {
            timeout: Math.min(config.playwrightNavigationTimeoutMs, 12000)
        }).catch(() => undefined);
        await waitRandom(page, 800, 1400);
        return true;
    }

    return false;
}

async function isPlaywrightAvailable(): Promise<boolean> {
    if (hasVerifiedPlaywrightAvailability) {
        return true;
    }

    if (!playwrightAvailabilityPromise) {
        playwrightAvailabilityPromise = (async () => {
            const playwright = await loadPlaywrightClient({ silent: true });
            if (!playwright) {
                return false;
            }

            try {
                const session = await openPlaywrightBrowser(true, buildBrowserLaunchArgs());
                await session.close();
                hasVerifiedPlaywrightAvailability = true;
                return true;
            } catch (error) {
                const playwrightModuleSource = getPlaywrightModuleSource();
                console.warn(`Playwright browser is unavailable${playwrightModuleSource ? ` via ${playwrightModuleSource}` : ''}, auto fallback will retry on the next blocked request:`, error);
                return false;
            }
        })().finally(() => {
            if (!hasVerifiedPlaywrightAvailability) {
                playwrightAvailabilityPromise = null;
            }
        });
    }

    return playwrightAvailabilityPromise;
}

async function searchBingWithHttp(query: string, limit: number): Promise<SearchResult[]> {
    let allResults: SearchResult[] = [];
    let pageNumber = 0;

    while (allResults.length < limit) {
        const response = await axios.get(buildBingSearchUrl(query, pageNumber), buildAxiosRequestOptions());
        const html = String(response.data || '');

        const pageState = analyzeBlockedPage(html);
        if (pageState.blocked) {
            throw new Error(`Bing returned a verification or anti-bot page (title: ${pageState.title || 'unknown'}, keywords: ${pageState.detectedKeywords.join(', ') || 'none'})`);
        }
        if (pageState.hasResults && pageState.detectedKeywords.length > 0) {
            console.warn(`Bing page contains suspicious keywords but also has results, skipping block detection: ${pageState.detectedKeywords.join(', ')}`);
        }

        const results = parseBingSearchResults(html, limit - allResults.length);
        allResults = allResults.concat(results);

        if (results.length === 0) {
            console.error('⚠️ No more Bing results from HTTP mode, ending early.');
            break;
        }

        pageNumber += 1;
    }

    return allResults.slice(0, limit);
}

async function searchBingWithPlaywright(query: string, limit: number): Promise<SearchResult[]> {
    const playwright = await loadPlaywrightClient();
    if (!playwright) {
        throw new Error('Playwright client is not available. Install `playwright`/`playwright-core` manually or configure PLAYWRIGHT_MODULE_PATH.');
    }

    const session = await openPlaywrightBrowser(config.playwrightHeadless, buildBrowserLaunchArgs());

    try {
        const { page, closePageContext } = await createPlaywrightPage(session.browser);

        try {
            const allResults: SearchResult[] = [];
            const seenUrls = new Set<string>();

            for (let pageNumber = 0; allResults.length < limit; pageNumber += 1) {
                if (pageNumber === 0) {
                    console.error(`🔎 Bing Playwright interactive search: ${query}`);
                    await openBingAndSearch(page, query);
                } else {
                    const moved = await goToNextResultsPage(page);
                    if (!moved) {
                        console.error('⚠️ No next page button found in Playwright mode, ending early.');
                        break;
                    }
                }

                const html = await page.content();
                const pageState = analyzeBlockedPage(html);
                if (pageState.blocked) {
                    throw new Error(`Bing returned a verification or anti-bot page in Playwright mode (title: ${pageState.title || 'unknown'}, keywords: ${pageState.detectedKeywords.join(', ') || 'none'})`);
                }
                if (pageState.hasResults && pageState.detectedKeywords.length > 0) {
                    console.warn(`Playwright Bing page contains suspicious keywords but also has results, skipping block detection: ${pageState.detectedKeywords.join(', ')}`);
                }

                const pageResults = parseBingSearchResults(html, limit - allResults.length)
                    .filter((result) => {
                        if (seenUrls.has(result.url)) {
                            return false;
                        }
                        seenUrls.add(result.url);
                        return true;
                    });

                allResults.push(...pageResults);

                if (pageResults.length === 0) {
                    console.error('⚠️ No more Bing results from Playwright mode, ending early.');
                    break;
                }
            }

            return allResults.slice(0, limit);
        } finally {
            await closePageContext();
        }
    } finally {
        await session.close();
    }
}

export async function searchBing(query: string, limit: number): Promise<SearchResult[]> {
    if (config.searchMode === 'request') {
        return searchBingWithHttp(query, limit);
    }

    if (config.searchMode === 'playwright') {
        return searchBingWithPlaywright(query, limit);
    }

    try {
        return await searchBingWithHttp(query, limit);
    } catch (requestError) {
        const canUsePlaywright = await isPlaywrightAvailable();
        if (!canUsePlaywright) {
            throw requestError;
        }

        console.warn('Request-based Bing search failed, falling back to Playwright mode:', requestError);
        return searchBingWithPlaywright(query, limit);
    }
}
