import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { config } from '../../config.js';
import { buildAxiosRequestOptions, requestWithSafeRedirects } from '../../utils/httpRequest.js';
import { assertPublicHttpUrl, assertPublicHttpUrlResolved } from '../../utils/urlSafety.js';
import {
    detectFloatingOverlayPageScript,
    fetchPageHtmlWithBrowser,
    installNavigationGuard,
    looksLikeBotChallengePage,
    readCookiesFromPage,
    MAX_BROWSER_HTML_BYTES
} from '../../utils/browserCookies.js';
import {
    loadPlaywrightClient,
    openPlaywrightBrowser,
    acquirePooledPlaywrightPage,
    type PlaywrightBrowserSession
} from '../../utils/playwrightClient.js';

export interface FetchWebContentResult {
    url: string;
    finalUrl: string;
    contentType: string;
    title: string;
    retrievalMethod: 'request' | 'request-with-browser-cookies' | 'browser-html';
    truncated: boolean;
    content: string;
    readabilityApplied?: boolean;
    readableHtml?: string;
    links?: ExtractedLink[];
    byline?: string;
    excerpt?: string;
    siteName?: string;
}

export type ExtractedLink = {
    text: string;
    href: string;
};

export type FetchWebContentOptions = {
    readability?: boolean;
    includeLinks?: boolean;
    renderMode?: FetchWebRenderMode;
};

export type FetchWebRenderMode = 'request' | 'auto' | 'browser';

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_CHARS = 30000;
const MIN_MAX_CHARS = 1000;
const MAX_MAX_CHARS = 200000;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MIN_METADATA_FALLBACK_CHARS = 200;

type HtmlExtractionResult = {
    title: string;
    text: string;
    mode: 'container' | 'body' | 'metadata';
};

type ReadabilityArticle = {
    title?: string | null;
    byline?: string | null;
    content?: string | null;
    textContent?: string | null;
    excerpt?: string | null;
    siteName?: string | null;
    length?: number | null;
};

class ReadabilityUnavailableError extends Error {}

function normalizeText(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function clampMaxChars(value: number): number {
    return Math.max(MIN_MAX_CHARS, Math.min(MAX_MAX_CHARS, value));
}

function looksLikeHtml(raw: string): boolean {
    return /<!doctype html|<html[\s>]|<body[\s>]/i.test(raw);
}

function isMarkdownPath(url: URL): boolean {
    const pathname = url.pathname.toLowerCase();
    return pathname.endsWith('.md') || pathname.endsWith('.markdown') || pathname.endsWith('.mdx');
}

function shouldDebugReadabilityFallback(): boolean {
    return process.env.OPEN_WEBSEARCH_DEBUG === '1';
}

function logReadabilityFallback(message: string, error?: unknown): void {
    if (!shouldDebugReadabilityFallback()) {
        return;
    }

    if (error instanceof Error) {
        console.error(`[fetchWebContent/readability] ${message}: ${error.message}`);
        return;
    }

    console.error(`[fetchWebContent/readability] ${message}`);
}

function isMarkdownContentType(contentType: string): boolean {
    const ct = contentType.toLowerCase();
    return ct.includes('text/markdown') || ct.includes('application/markdown') || ct.includes('text/x-markdown');
}

let browserHtmlFetcher: typeof fetchPageHtmlWithBrowser = fetchPageHtmlWithBrowser;
let readabilityParser: (html: string, finalUrl: string) => Promise<ReadabilityArticle | null> = async (html, finalUrl) => {
    try {
        const moduleName = '@mozilla/readability';
        const readabilityModule = await import(moduleName);
        const dom = new JSDOM(html, { url: finalUrl });
        return new readabilityModule.Readability(dom.window.document).parse();
    } catch (error) {
        if (error instanceof Error && /Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND/.test(error.message)) {
            throw new ReadabilityUnavailableError('Mozilla Readability is not available. Install `@mozilla/readability` to use readability mode.');
        }
        throw error;
    }
};

function extractMainTextFromHtml(html: string): HtmlExtractionResult {
    const $ = cheerio.load(html);
    const title = $('title').first().text().trim();
    const metaDescription = $('meta[name="description"]').attr('content')?.trim() ||
        $('meta[property="og:description"]').attr('content')?.trim() ||
        '';

    $('script, style, noscript, template, iframe, svg, canvas').remove();

    const preferredContainers = [
        'article',
        'main',
        '[role="main"]',
        '.markdown-body',
        '.article-content',
        '.post-content',
        '.entry-content',
        '.content'
    ];

    let selectedText = '';
    let mode: HtmlExtractionResult['mode'] = 'metadata';
    for (const selector of preferredContainers) {
        const container = $(selector).first();
        if (container.length === 0) {
            continue;
        }

        const candidate = normalizeText(container.text());
        if (candidate.length >= 120) {
            selectedText = candidate;
            mode = 'container';
            break;
        }
    }

    if (!selectedText) {
        const body = $('body');
        selectedText = normalizeText((body.length > 0 ? body : $.root()).text());
        if (selectedText) {
            mode = 'body';
        }
    }

    // SPA pages often render content by JS and leave body nearly empty.
    // Fall back to metadata so callers still get useful page info.
    if (!selectedText) {
        selectedText = normalizeText([title, metaDescription].filter(Boolean).join('\n\n'));
        mode = 'metadata';
    }

    return { title, text: selectedText, mode };
}

function extractReadableTextFromHtml(html: string): string {
    const dom = new JSDOM(html);
    return normalizeText(dom.window.document.body.textContent || '');
}

function extractReadableLinks(html: string, finalUrl: string): ExtractedLink[] {
    const dom = new JSDOM(html, { url: finalUrl });
    const anchors = Array.from(dom.window.document.querySelectorAll('a[href]'));
    const seen = new Set<string>();
    const links: ExtractedLink[] = [];

    for (const anchor of anchors) {
        const rawHref = anchor.getAttribute('href');
        if (!rawHref) {
            continue;
        }

        let href: string;
        try {
            href = new URL(rawHref, finalUrl).toString();
            assertPublicHttpUrl(href, 'Extracted link URL');
        } catch {
            continue;
        }

        if (seen.has(href)) {
            continue;
        }
        seen.add(href);

        links.push({
            text: normalizeText(anchor.textContent || ''),
            href
        });
    }

    return links;
}

function buildRequestOptions(cookieHeader?: string): any {
    const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'Accept': 'text/markdown,text/plain,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    };
    const requestOptions = buildAxiosRequestOptions({
        allowInsecureTls: config.fetchWebAllowInsecureTls,
        decompress: true,
        headers,
        maxBodyLength: MAX_DOWNLOAD_BYTES,
        maxContentLength: MAX_DOWNLOAD_BYTES,
        maxRedirects: 5,
        responseType: 'text',
        timeout: DEFAULT_TIMEOUT_MS,
    });

    if (cookieHeader) {
        headers.Cookie = cookieHeader;
    }

    return requestOptions;
}

// 致命错误黑名单：命中即必须原样上抛，不得进入浏览器回退。黑名单只收录三类“换任何栈也改变不了结果”的错误——安全与资源上限拒绝（来自本项目 urlSafety/requestWithSafeRedirects 的策略约束）、DNS 确定性失败；其余所有错误（传输层被断、TLS 指纹被拒、未知的新错误形态）一律委托给 Playwright 竞速层。黑名单若有遗漏，竞速层入口的 assertPublicHttpUrlResolved 与导航守卫会作为纵深防御兜底拦截。
const FATAL_FALLBACK_ERROR_CODES = new Set(['ERR_RESPONSE_TOO_LARGE', 'ENOTFOUND']);

const FATAL_FALLBACK_MESSAGE_PATTERN =
    /private or local network|resolves to private|must use HTTP or HTTPS|could not be resolved|Too many redirects|body too large|maxContentLength/i;

function isFatalRequestError(error: any): boolean {
    let current = error;
    // 沿 cause 链逐层检查（axios/undici 会把原生错误包在 cause 里），避免被包装的致命错误绕过判定
    for (let depth = 0; current && depth < 5; depth += 1) {
        const code = String(current.code || '');
        if (code && FATAL_FALLBACK_ERROR_CODES.has(code)) {
            return true;
        }
        if (FATAL_FALLBACK_MESSAGE_PATTERN.test(String(current.message || ''))) {
            return true;
        }
        current = current.cause;
    }
    return false;
}

function shouldTryBrowserHtmlFallback(contentType: string, raw: string, extraction?: HtmlExtractionResult): boolean {
    if (looksLikeBotChallengePage(raw)) {
        return true;
    }

    if (contentType.includes('text/html') || looksLikeHtml(raw)) {
        return extraction?.mode === 'metadata' && extraction.text.length < MIN_METADATA_FALLBACK_CHARS;
    }

    return false;
}

async function fetchHtmlViaBrowser(url: string): Promise<{ contentType: string; finalUrl: string; raw: string; title: string }> {
    const browserPage = await browserHtmlFetcher(url);
    await assertPublicHttpUrlResolved(browserPage.finalUrl, 'Final URL');

    const htmlBytes = Buffer.byteLength(browserPage.html, 'utf8');
    if (htmlBytes > MAX_BROWSER_HTML_BYTES) {
        throw new Error(`Response body too large (${htmlBytes} bytes). Max allowed is ${MAX_BROWSER_HTML_BYTES} bytes`);
    }

    return {
        contentType: 'text/html; charset=utf-8',
        finalUrl: browserPage.finalUrl,
        raw: browserPage.html,
        title: browserPage.title
    };
}

export function __setBrowserHtmlFetcherForTests(fetcher?: typeof fetchPageHtmlWithBrowser): void {
    browserHtmlFetcher = fetcher || fetchPageHtmlWithBrowser;
}

export function __setReadabilityParserForTests(parser?: (html: string, finalUrl: string) => Promise<ReadabilityArticle | null>): void {
    readabilityParser = parser || (async (html, finalUrl) => {
        try {
            const moduleName = '@mozilla/readability';
            const readabilityModule = await import(moduleName);
            const dom = new JSDOM(html, { url: finalUrl });
            return new readabilityModule.Readability(dom.window.document).parse();
        } catch (error) {
            if (error instanceof Error && /Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND/.test(error.message)) {
                throw new ReadabilityUnavailableError('Mozilla Readability is not available. Install `@mozilla/readability` to use readability mode.');
            }
            throw error;
        }
    });
}

type BrowserFetchResult = {
    contentType: string;
    finalUrl: string;
    raw: string;
    title: string;
    retrievalMethod: 'request-with-browser-cookies' | 'browser-html';
    dialogTexts?: string[];
};

const MIN_RACE_HTTP_HTML_CHARS = 200;

function isUsableHttpRaceResult(raw: string): boolean {
    return raw.length > MIN_RACE_HTTP_HTML_CHARS && !looksLikeBotChallengePage(raw);
}

type HttpRaceOutcome = { ok: true; contentType: string; raw: string; finalUrl: string } | { ok: false };
type BrowserRaceOutcome = { ok: true; result: BrowserFetchResult } | { ok: false; error: unknown };

// 浏览器导航一次，页面 domcontentloaded 后立即取 Cookie 发起 HTTP 请求，同时浏览器继续渲染。
// 两条路径竞速：任一结果到达 settle 循环即评估，内容可用的先达者立即胜出。HTTP 失败或无效时，浏览器渲染结果可以先于 HTTP 返回，不必等 HTTP 请求耗尽。
async function fetchWithCookiesRaceViaPlaywright(url: string): Promise<BrowserFetchResult> {
    const playwright = await loadPlaywrightClient({ silent: true });
    if (!playwright) {
        throw new Error('Playwright client is not available for browser fetch');
    }

    await assertPublicHttpUrlResolved(url, 'Browser fetch URL');

    const session = await browserSessionOpener();

    // 竞速取消与延迟释放：HTTP 胜出时浏览器臂可能仍在渲染，赢家立即返回结果，page/session 留到浏览器臂收尾完成后于后台释放，避免浏览器臂继续操作已释放的 page。
    let deferRelease = false;
    let raceCancelled = false;

    try {
        const { page, releasePage } = await acquirePooledPlaywrightPage(session.browser, {
            poolKey: 'fetch-race',
            preparePage: async (p: any) => {
                // 复用 browserCookies 的 fail-closed 导航守卫：导航与子资源都经过 DNS 解析级公网校验，route不可用或安装失败会直接抛错并终止本次抓取，杜绝无守卫导航带来的私网解析绕过。
                await installNavigationGuard(p);
            }
        });

        try {
            // ── 导航（只此一次）──
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: Math.max(config.playwrightNavigationTimeoutMs, 15000)
            });

            // ── 立即取 Cookie，发起 HTTP 请求 ──
            const cookieHeader = await readCookiesFromPage(page, url);
            const httpPromise: Promise<HttpRaceOutcome> = cookieHeader
                ? requestWithSafeRedirects('GET', url, buildRequestOptions(cookieHeader), 'Request URL')
                    .then((resp): HttpRaceOutcome => ({
                        ok: true as const,
                        contentType: String(resp.headers['content-type'] || '').toLowerCase(),
                        raw: typeof resp.data === 'string' ? resp.data : '',
                        // requestWithSafeRedirects 会在最终响应上回填重定向后的 URL（每一跳都经过公网校验），这里保留它作为 finalUrl，避免相对链接解析基于原始请求地址。
                        finalUrl: resp.request?.res?.responseUrl || url
                    }))
                    .catch((): HttpRaceOutcome => ({ ok: false as const }))
                : Promise.resolve({ ok: false as const } as HttpRaceOutcome);

            // ── 浏览器继续渲染（与 HTTP 请求真正并行竞速）──
            const renderBrowserHtml = async (): Promise<BrowserFetchResult> => {
                if (typeof page.waitForLoadState === 'function') {
                    await page.waitForLoadState('networkidle', {
                        timeout: Math.min(Math.max(config.playwrightNavigationTimeoutMs, 5000), 15000)
                    }).catch(() => undefined);
                }
                if (raceCancelled) {
                    throw new Error('browser race arm cancelled');
                }
                if (typeof page.waitForTimeout === 'function') {
                    await page.waitForTimeout(1200).catch(() => undefined);
                }
                if (raceCancelled) {
                    throw new Error('browser race arm cancelled');
                }
                const html = typeof page.content === 'function' ? await page.content() : '';
                if (raceCancelled) {
                    throw new Error('browser race arm cancelled');
                }
                const finalUrl = typeof page.url === 'function' ? page.url() : url;
                const title = typeof page.title === 'function' ? await page.title().catch(() => '') : '';
                if (raceCancelled) {
                    throw new Error('browser race arm cancelled');
                }

                let dialogTexts: string[] | undefined;
                if (typeof page.evaluate === 'function') {
                    dialogTexts = await page.evaluate(detectFloatingOverlayPageScript).catch(() => undefined);
                }

                const resolvedFinalUrl = String(finalUrl || url);
                // 浏览器导航可能到达任意最终 URL，这里执行 DNS 解析级公网校验，因为字面量校验无法拦截解析到私网地址的域名。
                await assertPublicHttpUrlResolved(resolvedFinalUrl, 'Final URL');

                const htmlBytes = Buffer.byteLength(String(html || ''), 'utf8');
                if (htmlBytes > MAX_BROWSER_HTML_BYTES) {
                    throw new Error(`Response body too large (${htmlBytes} bytes). Max allowed is ${MAX_BROWSER_HTML_BYTES} bytes`);
                }

                return {
                    contentType: 'text/html; charset=utf-8',
                    finalUrl: resolvedFinalUrl,
                    raw: String(html || ''),
                    title: String(title || ''),
                    retrievalMethod: 'browser-html' as const,
                    dialogTexts
                };
            };

            const browserOutcome: Promise<BrowserRaceOutcome> = renderBrowserHtml()
                .then((result): BrowserRaceOutcome => ({ ok: true, result }), (error): BrowserRaceOutcome => ({ ok: false, error }));

            // ── 竞速：两条臂并行推进，任一结果 settle 即评估，内容可用的先达者立即胜出。HTTP 无效时浏览器可以先返回；HTTP 有效时立即采纳，再异步收尾浏览器臂，避免其继续操作已释放的 page。
            let httpResolved: HttpRaceOutcome | undefined;
            let browserOutcomeValue: BrowserRaceOutcome | undefined;
            let httpConsumed = false;
            let browserConsumed = false;
            let browserFailure: unknown;

            const httpArrival: Promise<void> = httpPromise.then((outcome) => { httpResolved = outcome; });
            const browserArrival: Promise<void> = browserOutcome.then((outcome) => { browserOutcomeValue = outcome; });
            const remaining: Array<Promise<void>> = [httpArrival, browserArrival];

            for (;;) {
                if (remaining.length === 0) {
                    break;
                }
                await Promise.race(remaining);
                if (httpResolved !== undefined && remaining.includes(httpArrival)) {
                    remaining.splice(remaining.indexOf(httpArrival), 1);
                }
                if (browserOutcomeValue !== undefined && remaining.includes(browserArrival)) {
                    remaining.splice(remaining.indexOf(browserArrival), 1);
                }

                // HTTP 臂先 settle 且内容可用 → 立即胜出，浏览器臂转入后台收尾。
                if (!httpConsumed && httpResolved) {
                    if (httpResolved.ok && isUsableHttpRaceResult(httpResolved.raw)) {
                        raceCancelled = true;
                        deferRelease = true;
                        // 浏览器臂收尾后在后台释放 page/session（本函数已立即返回结果）。
                        browserOutcome
                            .catch(() => undefined)
                            .then(async () => {
                                await releasePage();
                                await session.release();
                            })
                            .catch(() => undefined);
                        return {
                            contentType: httpResolved.contentType,
                            finalUrl: httpResolved.finalUrl,
                            raw: httpResolved.raw,
                            title: '',
                            retrievalMethod: 'request-with-browser-cookies'
                        };
                    }
                    // HTTP 失败或内容不足/疑似验证页 → 放弃该臂，交给浏览器。
                    httpConsumed = true;
                }

                // 浏览器臂 settle：成功即返回；失败则记录并继续等待 HTTP（若仍在途）。
                if (!browserConsumed && browserOutcomeValue) {
                    if (browserOutcomeValue.ok) {
                        return browserOutcomeValue.result;
                    }
                    browserFailure = browserOutcomeValue.error;
                    browserConsumed = true;
                }

                if (httpConsumed && browserConsumed) {
                    break;
                }
            }

            // 两条臂都未产出可用内容：优先上抛浏览器失败原因。
            raceCancelled = true;
            if (browserFailure instanceof Error) {
                throw browserFailure;
            }
            throw new Error('Browser race fallback produced no usable content');
        } finally {
            if (!deferRelease) {
                await releasePage();
            }
        }
    } finally {
        if (!deferRelease) {
            await session.release();
        }
    }
}

// 浏览器抓取层的注入接缝：生产使用 Playwright 实现，测试可整体替换，从而不必在生产分支里判断"是否处于测试中"。
let browserFetcher: (url: string) => Promise<BrowserFetchResult> = fetchWithCookiesRaceViaPlaywright;

export function __setBrowserFetcherForTests(fetcher?: (url: string) => Promise<BrowserFetchResult>): void {
    browserFetcher = fetcher || fetchWithCookiesRaceViaPlaywright;
}

// 浏览器会话打开器的注入接缝：竞速层依赖它获取 browser 句柄，测试替换为假浏览器后可以真实驱动竞速逻辑。
let browserSessionOpener: (options?: { antiBot?: boolean }) => Promise<PlaywrightBrowserSession> = openPlaywrightBrowser;

export function __setBrowserSessionOpenerForTests(opener?: (options?: { antiBot?: boolean }) => Promise<PlaywrightBrowserSession>): void {
    browserSessionOpener = opener || openPlaywrightBrowser;
}

export async function fetchWebContent(
    url: string,
    maxChars: number = DEFAULT_MAX_CHARS,
    options: FetchWebContentOptions = {}
): Promise<FetchWebContentResult> {
    const parsedUrl = new URL(url);
    await assertPublicHttpUrlResolved(parsedUrl, 'Request URL');
    const renderMode = options.renderMode ?? 'auto';
    if (!['request', 'auto', 'browser'].includes(renderMode)) {
        throw new Error('renderMode must be one of: request, auto, browser');
    }

    let contentType = '';
    let finalUrl = parsedUrl.toString();
    let raw = '';
    let browserTitle = '';
    let retrievalMethod: FetchWebContentResult['retrievalMethod'] = 'request';

    if (renderMode === 'browser') {
        const browserResult = await fetchHtmlViaBrowser(parsedUrl.toString());
        contentType = browserResult.contentType;
        finalUrl = browserResult.finalUrl;
        raw = browserResult.raw;
        browserTitle = browserResult.title;
        retrievalMethod = 'browser-html';
    } else {
        const requestOptions = buildRequestOptions();

        // Pre-flight check to avoid downloading oversized payloads when Content-Length is present.
        try {
            const headResponse = await requestWithSafeRedirects('HEAD', parsedUrl.toString(), {
                ...requestOptions,
                responseType: 'json',
                validateStatus: (status: number) => status >= 200 && status < 400
            }, 'Request URL');
            const headLength = Number(headResponse.headers['content-length']);
            if (Number.isFinite(headLength) && headLength > MAX_DOWNLOAD_BYTES) {
                const tooLargeError = new Error(`Response body too large (${headLength} bytes). Max allowed is ${MAX_DOWNLOAD_BYTES} bytes`);
                (tooLargeError as any).code = 'ERR_RESPONSE_TOO_LARGE';
                throw tooLargeError;
            }
        } catch (error: any) {
            if (error?.code === 'ERR_RESPONSE_TOO_LARGE') {
                throw error;
            }
            const status = error?.response?.status;
            // Some servers don't support HEAD correctly; continue and rely on GET download limits.
            if (status !== undefined && ![400, 403, 404, 405, 406, 501].includes(status)) {
                throw error;
            }
        }

        let response: any;

        try {
            response = await requestWithSafeRedirects('GET', parsedUrl.toString(), requestOptions, 'Request URL');
        } catch (error: any) {
            const status = error?.response?.status;
            const blockedByStatus = [401, 403, 429].includes(status);
            // 黑名单语义：request 模式不使用任何浏览器辅助；带明确 HTTP 响应且不属于反爬状态码的（404/500 等真实拒绝），以及安全/资源/DNS 致命错误，必须原样上抛；其余错误全部委托浏览器竞速层。
            if (renderMode === 'request' || (!blockedByStatus && (error?.response || isFatalRequestError(error)))) {
                throw error;
            }

            console.error(`fetchWebContent: HTTP request failed (${error instanceof Error ? error.message : String(error)}), falling back to the browser race layer`);

            // HTTP 被拦截：设空响应，后续统一走 fetchWithCookiesRace 竞速（竞速层自己带 Cookie+HTTP 路径）
            response = {
                headers: { 'content-type': 'text/html; charset=utf-8' },
                data: '',
                request: { res: { responseUrl: parsedUrl.toString() } }
            };
        }

        contentType = String(response.headers['content-type'] || '').toLowerCase();
        finalUrl = response.request?.res?.responseUrl || parsedUrl.toString();
        assertPublicHttpUrl(finalUrl, 'Final URL');
        raw = typeof response.data === 'string'
            ? response.data
            : JSON.stringify(response.data, null, 2);

        const contentLength = Number(response.headers['content-length']);
        if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
            throw new Error(`Response body too large (${contentLength} bytes). Max allowed is ${MAX_DOWNLOAD_BYTES} bytes`);
        }
    }

    let title = browserTitle;
    let extractedContent = '';
    let htmlExtraction: HtmlExtractionResult | undefined;
    let readabilityApplied = false;
    let readableHtml: string | undefined;
    let links: ExtractedLink[] | undefined;
    let byline: string | undefined;
    let excerpt: string | undefined;
    let siteName: string | undefined;

    const finalParsedUrl = new URL(finalUrl);

    // Keep raw markdown behavior for the resolved final path.
    if (retrievalMethod !== 'browser-html' && isMarkdownPath(finalParsedUrl)) {
        extractedContent = normalizeText(raw);
    } else if (contentType.includes('text/html') || looksLikeHtml(raw)) {
        htmlExtraction = extractMainTextFromHtml(raw);
        title = htmlExtraction.title || title;
        extractedContent = htmlExtraction.text;
    } else if (isMarkdownContentType(contentType)) {
        extractedContent = normalizeText(raw);
    } else {
        extractedContent = normalizeText(raw);
    }

    if (renderMode === 'auto' && shouldTryBrowserHtmlFallback(contentType, raw, htmlExtraction)) {
        try {
            // 合并第2+3层：浏览器导航一次，Cookie+HTTP 和渲染竞速
            const raceResult = await browserFetcher(parsedUrl.toString());
            assertPublicHttpUrl(raceResult.finalUrl, 'Final URL');
            contentType = raceResult.contentType;
            finalUrl = raceResult.finalUrl;
            raw = raceResult.raw;
            retrievalMethod = raceResult.retrievalMethod;
            htmlExtraction = extractMainTextFromHtml(raw);
            title = htmlExtraction.title || raceResult.title;
            extractedContent = htmlExtraction.text;

            // dialogTexts 合并
            if (raceResult.dialogTexts && raceResult.dialogTexts.length > 0) {
                const newTexts = raceResult.dialogTexts.filter(t => !extractedContent.includes(t));
                if (newTexts.length > 0) {
                    extractedContent = newTexts.join('\n\n') + '\n\n' + extractedContent;
                }
            }
        } catch {
            // 浏览器回退失败（Playwright 不可用、测试桩故意抛错等）时，保留 HTTP 请求的提取结果。支持"桩抛错后保留 request 模式"的测试用例。
        }
    }

    if (options.readability && (contentType.includes('text/html') || looksLikeHtml(raw))) {
        try {
            const article = await readabilityParser(raw, finalUrl);
            if (article?.content) {
                const readableText = normalizeText(article.textContent || extractReadableTextFromHtml(article.content));
                if (readableText) {
                    readabilityApplied = true;
                    readableHtml = article.content;
                    links = options.includeLinks ? extractReadableLinks(article.content, finalUrl) : undefined;
                    byline = article.byline?.trim() || undefined;
                    excerpt = article.excerpt?.trim() || undefined;
                    siteName = article.siteName?.trim() || undefined;
                    title = article.title?.trim() || title;
                    extractedContent = readableText;
                }
            } else {
                logReadabilityFallback('parser returned no article content');
            }
        } catch (error) {
            if (error instanceof ReadabilityUnavailableError) {
                throw error;
            }

            logReadabilityFallback('falling back to existing extractor after parser error', error);
        }
    }

    if (!extractedContent) {
        throw new Error('No readable content was extracted from this URL');
    }

    const targetMaxChars = clampMaxChars(maxChars);
    const truncated = extractedContent.length > targetMaxChars;
    const content = truncated
        ? `${extractedContent.slice(0, targetMaxChars)}\n\n[...truncated ${extractedContent.length - targetMaxChars} characters]`
        : extractedContent;

    return {
        url: parsedUrl.toString(),
        finalUrl,
        contentType: contentType || 'unknown',
        title,
        retrievalMethod,
        truncated,
        content,
        ...(options.readability ? { readabilityApplied } : {}),
        ...(readableHtml ? { readableHtml } : {}),
        ...(links ? { links } : {}),
        ...(byline ? { byline } : {}),
        ...(excerpt ? { excerpt } : {}),
        ...(siteName ? { siteName } : {})
    };
}
