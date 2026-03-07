import axios from 'axios';
import * as cheerio from 'cheerio';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyUrl } from '../../config.js';
import { assertPublicHttpUrl } from '../../utils/urlSafety.js';

export interface FetchWebContentResult {
    url: string;
    finalUrl: string;
    contentType: string;
    title: string;
    truncated: boolean;
    content: string;
}

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_CHARS = 30000;
const MIN_MAX_CHARS = 1000;
const MAX_MAX_CHARS = 200000;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;

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

function isMarkdownContentType(contentType: string): boolean {
    const ct = contentType.toLowerCase();
    return ct.includes('text/markdown') || ct.includes('application/markdown') || ct.includes('text/x-markdown');
}

function extractMainTextFromHtml(html: string): { title: string; text: string } {
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
    for (const selector of preferredContainers) {
        const container = $(selector).first();
        if (container.length === 0) {
            continue;
        }

        const candidate = normalizeText(container.text());
        if (candidate.length >= 120) {
            selectedText = candidate;
            break;
        }
    }

    if (!selectedText) {
        const body = $('body');
        selectedText = normalizeText((body.length > 0 ? body : $.root()).text());
    }

    // SPA pages often render content by JS and leave body nearly empty.
    // Fall back to metadata so callers still get useful page info.
    if (!selectedText) {
        selectedText = normalizeText([title, metaDescription].filter(Boolean).join('\n\n'));
    }

    return { title, text: selectedText };
}

export async function fetchWebContent(url: string, maxChars: number = DEFAULT_MAX_CHARS): Promise<FetchWebContentResult> {
    const parsedUrl = new URL(url);
    assertPublicHttpUrl(parsedUrl, 'Request URL');

    const effectiveProxyUrl = getProxyUrl();
    const requestOptions: any = {
        timeout: DEFAULT_TIMEOUT_MS,
        maxRedirects: 5,
        responseType: 'text',
        maxContentLength: MAX_DOWNLOAD_BYTES,
        maxBodyLength: MAX_DOWNLOAD_BYTES,
        decompress: true,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
            'Accept': 'text/markdown,text/plain,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        }
    };

    if (effectiveProxyUrl) {
        const proxyAgent = new HttpsProxyAgent(effectiveProxyUrl);
        requestOptions.httpAgent = proxyAgent;
        requestOptions.httpsAgent = proxyAgent;
    }

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

    const response = await axios.get(parsedUrl.toString(), requestOptions);
    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    const finalUrl = response.request?.res?.responseUrl || parsedUrl.toString();
    assertPublicHttpUrl(finalUrl, 'Final URL');
    const contentLength = Number(response.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
        throw new Error(`Response body too large (${contentLength} bytes). Max allowed is ${MAX_DOWNLOAD_BYTES} bytes`);
    }
    const raw = typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data, null, 2);

    let title = '';
    let extractedContent = '';

    // Keep raw markdown behavior for explicit markdown paths.
    if (isMarkdownPath(parsedUrl)) {
        extractedContent = normalizeText(raw);
    } else if (contentType.includes('text/html') || looksLikeHtml(raw)) {
        const parsed = extractMainTextFromHtml(raw);
        title = parsed.title;
        extractedContent = parsed.text;
    } else if (isMarkdownContentType(contentType)) {
        extractedContent = normalizeText(raw);
    } else {
        extractedContent = normalizeText(raw);
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
        truncated,
        content
    };
}
