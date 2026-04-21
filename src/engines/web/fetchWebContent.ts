import axios from 'axios';
import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { config } from '../../config.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { assertPublicHttpUrl, assertPublicHttpUrlResolved } from '../../utils/urlSafety.js';
import {
    fetchPageHtmlWithBrowser,
    getBrowserCookieHeader,
    looksLikeBotChallengePage
} from '../../utils/browserCookies.js';

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

function shouldTryBrowserHtmlFallback(contentType: string, raw: string, extraction?: HtmlExtractionResult): boolean {
    if (looksLikeBotChallengePage(raw)) {
        return true;
    }

    if (contentType.includes('text/html') || looksLikeHtml(raw)) {
        return extraction?.mode === 'metadata' && extraction.text.length < MIN_METADATA_FALLBACK_CHARS;
    }

    return false;
}

async function fetchHtmlViaBrowser(url: string): Promise<{ contentType: string; finalUrl: string; raw: string; title: string } | undefined> {
    try {
        const browserPage = await browserHtmlFetcher(url);
        assertPublicHttpUrl(browserPage.finalUrl, 'Final URL');

        return {
            contentType: 'text/html; charset=utf-8',
            finalUrl: browserPage.finalUrl,
            raw: browserPage.html,
            title: browserPage.title
        };
    } catch {
        return undefined;
    }
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

async function tryRequestWithBrowserCookies(url: string): Promise<{ response?: any; usedBrowserCookies: boolean }> {
    let cookieHeader: string | undefined;
    try {
        cookieHeader = await getBrowserCookieHeader(url);
    } catch {
        return { response: undefined, usedBrowserCookies: false };
    }

    if (!cookieHeader) {
        return { response: undefined, usedBrowserCookies: false };
    }

    try {
        return {
            response: await axios.get(url, buildRequestOptions(cookieHeader)),
            usedBrowserCookies: true
        };
    } catch {
        return {
            response: undefined,
            usedBrowserCookies: true
        };
    }
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
        const headResponse = await axios.head(parsedUrl.toString(), {
            ...requestOptions,
            responseType: 'json',
            validateStatus: (status: number) => status >= 200 && status < 400
        });
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
        response = await axios.get(parsedUrl.toString(), requestOptions);
    } catch (error: any) {
        const status = error?.response?.status;
        if (![401, 403, 429].includes(status)) {
            throw error;
        }

        const cookieRetry = await tryRequestWithBrowserCookies(parsedUrl.toString());
        if (cookieRetry.response) {
            response = cookieRetry.response;
            usedBrowserCookies = cookieRetry.usedBrowserCookies;
            retrievalMethod = 'request-with-browser-cookies';
        } else {
            response = {
                headers: { 'content-type': 'text/html; charset=utf-8' },
                data: '',
                request: { res: { responseUrl: parsedUrl.toString() } }
            };
        }
    }

    let contentType = String(response.headers['content-type'] || '').toLowerCase();
    let finalUrl = response.request?.res?.responseUrl || parsedUrl.toString();
    assertPublicHttpUrl(finalUrl, 'Final URL');
    let raw = typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data, null, 2);

    if (!usedBrowserCookies && looksLikeBotChallengePage(raw)) {
        const cookieRetry = await tryRequestWithBrowserCookies(parsedUrl.toString());
        if (cookieRetry.response) {
            response = cookieRetry.response;
            usedBrowserCookies = true;
            retrievalMethod = 'request-with-browser-cookies';
            contentType = String(response.headers['content-type'] || '').toLowerCase();
            finalUrl = response.request?.res?.responseUrl || parsedUrl.toString();
            assertPublicHttpUrl(finalUrl, 'Final URL');
            raw = typeof response.data === 'string'
                ? response.data
                : JSON.stringify(response.data, null, 2);
        }
    }

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
        const browserResult = await fetchHtmlViaBrowser(parsedUrl.toString());
        if (browserResult) {
            contentType = browserResult.contentType;
            finalUrl = browserResult.finalUrl;
            raw = browserResult.raw;
            retrievalMethod = 'browser-html';
            htmlExtraction = extractMainTextFromHtml(raw);
            title = htmlExtraction.title || browserResult.title;
            extractedContent = htmlExtraction.text;
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
