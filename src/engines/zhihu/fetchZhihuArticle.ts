import * as cheerio from 'cheerio';
import { fetchPageHtmlWithBrowser, getBrowserCookieHeader, looksLikeBotChallengePage } from '../../utils/browserCookies.js';
import { buildAxiosRequestOptions, requestWithSafeRedirects } from '../../utils/httpRequest.js';

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

function buildRequestOptions(url: string, cookieHeader?: string): any {
    const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'cache-control': 'max-age=0',
        'sec-ch-ua': '"Chromium";v="145", "Google Chrome";v="145", "Not:A-Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'upgrade-insecure-requests': '1',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        'referer': url,
        'accept-language': 'zh-CN,zh;q=0.9'
    };
    const requestOptions = buildAxiosRequestOptions({ headers });

    if (cookieHeader) {
        headers.Cookie = cookieHeader;
    }

    return requestOptions;
}

function extractArticleContent(html: string): string {
    const $ = cheerio.load(html);
    const selectors = ['#content', '.RichText.ztext', 'article', 'main'];

    for (const selector of selectors) {
        const element = $(selector).first();
        if (element.length === 0) {
            continue;
        }

        element.find('script, style, noscript').remove();
        const content = normalizeExtractedText(element.text());
        if (content.length > 0) {
            return content;
        }
    }

    return '';
}

function shouldRetryWithBrowser(html: string, content: string): boolean {
    return !content || (looksLikeBotChallengePage(html) && content.length < 200);
}

export async function fetchZhiHuArticle(url: string): Promise<{ content: string }> {
    const match = url.match(/\/p\/(\d+)/);
    if (!match) {
        throw new Error('Invalid URL: Cannot extract article ID.');
    }

    let response: any;
    let html = '';
    let content = '';

    try {
        response = await requestWithSafeRedirects('GET', url, buildRequestOptions(url));
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
                response = await requestWithSafeRedirects('GET', url, buildRequestOptions(url, cookieHeader));
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
                response = await requestWithSafeRedirects('GET', url, buildRequestOptions(url, cookieHeader));
                html = String(response.data || '');
                content = extractArticleContent(html);
            } catch {
                // Browser HTML fetch handles JS-rendered or still-blocked pages better than cookie-only retries.
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
        throw new Error('Failed to extract readable Zhihu article content');
    }

    return { content };
}
