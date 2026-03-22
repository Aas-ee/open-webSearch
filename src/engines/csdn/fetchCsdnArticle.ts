import axios from 'axios';
import * as cheerio from 'cheerio';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyUrl } from '../../config.js';
import { fetchPageHtmlWithBrowser, getBrowserCookieHeader, looksLikeBotChallengePage } from '../../utils/browserCookies.js';

function normalizeExtractedText(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function buildRequestOptions(cookieHeader?: string): any {
    const headers: Record<string, string> = {
        'Accept': '*/*',
        'Host': 'blog.csdn.net',
        'Connection': 'keep-alive',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
    };
    const effectiveProxyUrl = getProxyUrl();
    const requestOptions: any = { headers };

    if (cookieHeader) {
        headers.Cookie = cookieHeader;
    }

    if (effectiveProxyUrl) {
        const proxyAgent = new HttpsProxyAgent(effectiveProxyUrl);
        requestOptions.httpAgent = proxyAgent;
        requestOptions.httpsAgent = proxyAgent;
    }

    return requestOptions;
}

function extractArticleContent(html: string): string {
    const $ = cheerio.load(html);
    const article = $('#content_views').first();
    article.find('script, style, noscript').remove();
    return normalizeExtractedText(article.text());
}

function shouldRetryWithBrowser(html: string, content: string): boolean {
    return !content || (looksLikeBotChallengePage(html) && content.length < 200);
}

export async function fetchCsdnArticle(url: string): Promise<{ content: string }> {
    let response: any;
    let html = '';
    let content = '';

    try {
        response = await axios.get(url, buildRequestOptions());
        html = String(response.data || '');
        content = extractArticleContent(html);
    } catch (error: any) {
        const status = error?.response?.status;
        if (![401, 403, 429].includes(status)) {
            throw error;
        }

        const cookieHeader = await getBrowserCookieHeader(url);
        if (cookieHeader) {
            try {
                response = await axios.get(url, buildRequestOptions(cookieHeader));
                html = String(response.data || '');
                content = extractArticleContent(html);
            } catch {
                const browserPage = await fetchPageHtmlWithBrowser(url);
                html = browserPage.html;
                content = extractArticleContent(html);
            }
        } else {
            const browserPage = await fetchPageHtmlWithBrowser(url);
            html = browserPage.html;
            content = extractArticleContent(html);
        }
    }

    if (shouldRetryWithBrowser(html, content)) {
        const cookieHeader = await getBrowserCookieHeader(url);
        if (cookieHeader) {
            try {
                response = await axios.get(url, buildRequestOptions(cookieHeader));
                html = String(response.data || '');
                content = extractArticleContent(html);
            } catch {
                const browserPage = await fetchPageHtmlWithBrowser(url);
                html = browserPage.html;
                content = extractArticleContent(html);
            }
        }

        if (shouldRetryWithBrowser(html, content)) {
            const browserPage = await fetchPageHtmlWithBrowser(url);
            html = browserPage.html;
            content = extractArticleContent(html);
        }
    }

    if (!content) {
        throw new Error('Failed to extract readable CSDN article content');
    }

    return { content };
}
