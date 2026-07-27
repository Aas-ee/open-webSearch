import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { config } from '../../config.js';
import { buildAxiosRequestOptions, requestWithSafeRedirects } from '../../utils/httpRequest.js';
import { assertPublicHttpUrl, assertPublicHttpUrlResolved } from '../../utils/urlSafety.js';
import {
    getBrowserCookieHeader,
    looksLikeBotChallengePage,
    readCookiesFromPage
} from '../../utils/browserCookies.js';
import {
    loadPlaywrightClient,
    openPlaywrightBrowser,
    acquirePooledPlaywrightPage
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
};

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

// 传输层失败（TLS 握手被打断、连接超时、连接重置等）不会带 error.response，
// 因此不能按 HTTP 状态码判断。部分站点（如 www.nature.com）会对非浏览器的
// TLS 指纹直接断开连接，表现为 ECONNRESET / ETIMEDOUT / EPROTO 而非 403，
// 这类目标只能靠真实浏览器栈获取，需要委托给 Playwright 层。
const TRANSPORT_FAILURE_CODES = new Set([
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'EPROTO',
    'ETIMEDOUT',
    'ERR_SSL_PROTOCOL_ERROR',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'ECONNTIMEDOUT',
    'UND_ERR_SOCKET'
]);

const TRANSPORT_FAILURE_MESSAGE_PATTERN =
    /socket disconnected before secure tls connection|client network socket disconnected|tls|ssl|handshake|socket hang up|read econnreset|timeout of \d+ms exceeded|network socket/i;

function isTransportLevelFailure(error: any): boolean {
    // 有 HTTP 响应说明连接已建立，属于应用层拒绝，由状态码分支处理。
    if (error?.response) {
        return false;
    }

    // 安全与资源上限错误必须保持致命，不能退化成浏览器抓取绕过限制。
    if (error?.code === 'ERR_RESPONSE_TOO_LARGE') {
        return false;
    }

    const message = String(error?.message || '');
    if (/private or local network|resolves to private|must use HTTP or HTTPS|could not be resolved|Too many redirects|body too large|maxContentLength/i.test(message)) {
        return false;
    }

    const code = String(error?.code || '');
    if (TRANSPORT_FAILURE_CODES.has(code)) {
        return true;
    }

    if (code === 'ECONNABORTED' || error?.name === 'AggregateError') {
        return true;
    }

    return TRANSPORT_FAILURE_MESSAGE_PATTERN.test(message);
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

// ── 合并第2层（Cookie+HTTP）和第3层（浏览器渲染）──
// 浏览器导航一次，页面 domcontentloaded 后立即取 Cookie 发起 HTTP 请求，
// 同时浏览器继续渲染。两者竞速，先返回有效内容的路径胜出。
// 避免旧设计中 Cookie 采集和正文渲染分别导航两次、且 Cookie 采集开新 context
// 导致多余窗口的问题。
async function fetchWithCookiesRaceViaPlaywright(url: string): Promise<BrowserFetchResult> {
    const playwright = await loadPlaywrightClient({ silent: true });
    if (!playwright) {
        throw new Error('Playwright client is not available for browser fetch');
    }

    await assertPublicHttpUrlResolved(url, 'Browser fetch URL');

    const session = await openPlaywrightBrowser();

    try {
        const { page, releasePage } = await acquirePooledPlaywrightPage(session.browser, {
            poolKey: 'fetch-race',
            preparePage: async (p: any) => {
                // 安装导航守卫，拦截私有 IP 导航
                if (typeof p.route === 'function') {
                    try {
                        if ((p as any).__navGuardInstalled) {
                            await p.unroute('**/*').catch(() => undefined);
                        }
                        await p.route('**/*', async (route: any) => {
                            const request = route.request();
                            const targetUrl = request.url();
                            try {
                                if (request.isNavigationRequest()) {
                                    await assertPublicHttpUrlResolved(targetUrl, 'Browser navigation URL');
                                } else {
                                    const parsed = new URL(targetUrl);
                                    assertPublicHttpUrl(parsed, 'Browser subresource URL');
                                }
                                await route.continue();
                            } catch {
                                await route.abort().catch(() => undefined);
                            }
                        });
                        (p as any).__navGuardInstalled = true;
                    } catch { /* CDP 可能不支持 route */ }
                }
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
            const httpPromise = cookieHeader
                ? requestWithSafeRedirects('GET', url, buildRequestOptions(cookieHeader), 'Request URL')
                    .then(resp => ({
                        success: true as const,
                        contentType: String(resp.headers['content-type'] || '').toLowerCase(),
                        raw: typeof resp.data === 'string' ? resp.data : ''
                    }))
                    .catch(() => ({ success: false as const }))
                : Promise.resolve({ success: false as const });

            // ── 浏览器继续渲染 ──
            const browserPromise = (async () => {
                if (typeof page.waitForLoadState === 'function') {
                    await page.waitForLoadState('networkidle', {
                        timeout: Math.min(Math.max(config.playwrightNavigationTimeoutMs, 5000), 15000)
                    }).catch(() => undefined);
                }
                if (typeof page.waitForTimeout === 'function') {
                    await page.waitForTimeout(1200).catch(() => undefined);
                }
                const html = typeof page.content === 'function' ? await page.content() : '';
                const finalUrl = typeof page.url === 'function' ? page.url() : url;
                const title = typeof page.title === 'function' ? await page.title().catch(() => '') : '';

                let dialogTexts: string[] | undefined;
                if (typeof page.evaluate === 'function') {
                    dialogTexts = await page.evaluate(() => {
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
                    }).catch(() => undefined);
                }

                return {
                    contentType: 'text/html; charset=utf-8',
                    finalUrl: String(finalUrl || url),
                    raw: String(html || ''),
                    title: String(title || ''),
                    dialogTexts
                };
            })();

            // ── 竞速：HTTP 通常更快，先检查 ──
            const httpResult = await httpPromise;
            if (httpResult.success) {
                const httpContentType = httpResult.contentType;
                const httpRaw = httpResult.raw;
                // HTTP 内容足够（非空且非 bot challenge）
                if (httpRaw.length > 200 && !looksLikeBotChallengePage(httpRaw)) {
                    return {
                        contentType: httpContentType,
                        finalUrl: url,
                        raw: httpRaw,
                        title: '',
                        retrievalMethod: 'request-with-browser-cookies'
                    };
                }
            }

            // HTTP 不够，等浏览器
            const browserResult = await browserPromise;
            return {
                contentType: browserResult.contentType,
                finalUrl: browserResult.finalUrl,
                raw: browserResult.raw,
                title: browserResult.title,
                retrievalMethod: 'browser-html',
                dialogTexts: browserResult.dialogTexts
            };
        } finally {
            await releasePage();
        }
    } finally {
        await session.release();
    }
}

// 浏览器抓取层的注入接缝：生产使用 Playwright 实现，测试可整体替换，
// 从而不必在生产分支里判断"是否处于测试中"。
let browserFetcher: (url: string) => Promise<BrowserFetchResult> = fetchWithCookiesRaceViaPlaywright;

export function __setBrowserFetcherForTests(fetcher?: (url: string) => Promise<BrowserFetchResult>): void {
    browserFetcher = fetcher || fetchWithCookiesRaceViaPlaywright;
}

export async function fetchWebContent(
    url: string,
    maxChars: number = DEFAULT_MAX_CHARS,
    options: FetchWebContentOptions = {}
): Promise<FetchWebContentResult> {
    const parsedUrl = new URL(url);
    await assertPublicHttpUrlResolved(parsedUrl, 'Request URL');

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
    let usedBrowserCookies = false;
    let retrievalMethod: FetchWebContentResult['retrievalMethod'] = 'request';

    try {
        response = await requestWithSafeRedirects('GET', parsedUrl.toString(), requestOptions, 'Request URL');
    } catch (error: any) {
        const status = error?.response?.status;
        const blockedByStatus = [401, 403, 429].includes(status);
        // 传输层被断开的目标同样只能靠浏览器栈拿到内容，否则这里直接 rethrow
        // 会让已有的 Playwright 回退层永远不被触及。
        if (!blockedByStatus && !isTransportLevelFailure(error)) {
            throw error;
        }

        // HTTP 被拦截：设空响应，后续统一走 fetchWithCookiesRace 竞速
        response = {
            headers: { 'content-type': 'text/html; charset=utf-8' },
            data: '',
            request: { res: { responseUrl: parsedUrl.toString() } }
        };
    }

    let contentType = String(response.headers['content-type'] || '').toLowerCase();
    let finalUrl = response.request?.res?.responseUrl || parsedUrl.toString();
    assertPublicHttpUrl(finalUrl, 'Final URL');
    let raw = typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data, null, 2);

    const contentLength = Number(response.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
        throw new Error(`Response body too large (${contentLength} bytes). Max allowed is ${MAX_DOWNLOAD_BYTES} bytes`);
    }

    let title = '';
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
    if (isMarkdownPath(finalParsedUrl)) {
        extractedContent = normalizeText(raw);
    } else if (contentType.includes('text/html') || looksLikeHtml(raw)) {
        htmlExtraction = extractMainTextFromHtml(raw);
        title = htmlExtraction.title;
        extractedContent = htmlExtraction.text;
    } else if (isMarkdownContentType(contentType)) {
        extractedContent = normalizeText(raw);
    } else {
        extractedContent = normalizeText(raw);
    }

    if (shouldTryBrowserHtmlFallback(contentType, raw, htmlExtraction)) {
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
            // 浏览器回退失败（Playwright 不可用、测试桩故意抛错等）时，
            // 保留 HTTP 请求的提取结果。与旧 fetchHtmlViaBrowser 的
            // try/catch 行为一致，支持"桩抛错后保留 request 模式"的测试用例。
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
