import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';

const RESULT_SELECTORS = [
    '#b_results > li.b_algo',
    '#b_results > li.b_ans',
    '#b_results > li:not(.b_ad):not(.b_pag):not(.b_msg)',
    '#b_topw > li.b_algo',
    '#b_topw > li.b_ans',
    '.b_algo',
    '.b_ans'
];

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function sanitizeBingUrl(rawUrl?: string): string {
    if (!rawUrl) {
        return '';
    }

    let resolvedUrl = rawUrl.trim();
    if (!resolvedUrl) {
        return '';
    }

    if (resolvedUrl.startsWith('//')) {
        resolvedUrl = `https:${resolvedUrl}`;
    } else if (resolvedUrl.startsWith('/')) {
        if (resolvedUrl.startsWith('/search') || resolvedUrl.startsWith('/ck/a') || resolvedUrl.startsWith('/newtabredir')) {
            return '';
        }
        resolvedUrl = `https://cn.bing.com${resolvedUrl}`;
    }

    if (!resolvedUrl.startsWith('http://') && !resolvedUrl.startsWith('https://')) {
        return '';
    }

    try {
        const url = new URL(resolvedUrl);
        const hostname = url.hostname.toLowerCase();
        const pathname = url.pathname.toLowerCase();

        if (hostname.endsWith('bing.com') && (pathname.startsWith('/search') || pathname.startsWith('/ck/a') || pathname.startsWith('/newtabredir'))) {
            return '';
        }

        ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'source'].forEach((param) => {
            url.searchParams.delete(param);
        });

        return url.toString();
    } catch {
        return '';
    }
}

function extractTitle($: any, element: any, fallbackUrl: string, index: number): string {
    const candidateTitle = normalizeWhitespace(
        element.find('h2 a').first().text() ||
        element.find('.b_tpcn .tptt').first().text() ||
        element.find('.b_title a').first().text() ||
        element.find('a').first().text() ||
        element.find('h2, h3, .b_title, .tptt').first().text()
    );

    if (candidateTitle) {
        return candidateTitle.slice(0, 200);
    }

    if (fallbackUrl) {
        try {
            return `Result from ${new URL(fallbackUrl).hostname}`;
        } catch {
            // noop
        }
    }

    return normalizeWhitespace(element.text()).slice(0, 50) || `Result ${index + 1}`;
}

function extractDescription(element: any, title: string): string {
    const directSnippet = normalizeWhitespace(
        element.find('.b_caption p').first().text() ||
        element.find('.b_caption').first().text() ||
        element.find('.b_snippet, .b_lineclamp2, .b_lineclamp3').first().text()
    );

    if (directSnippet) {
        return directSnippet.slice(0, 400);
    }

    const fallbackText = normalizeWhitespace(element.text()).replace(title, '').trim();
    return fallbackText.slice(0, 400);
}

function extractSource(element: any, url: string): string {
    const sourceText = normalizeWhitespace(
        element.find('.b_tpcn').first().text() ||
        element.find('.b_attribution cite').first().text() ||
        element.find('cite').first().text()
    );

    if (sourceText) {
        return sourceText.slice(0, 200);
    }

    if (!url) {
        return '';
    }

    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}

function collectFallbackLinks($: any, limit: number, seenUrls: Set<string>, results: SearchResult[]): void {
    const linkContainers = $('#b_results a[href], #b_topw a[href], .b_algo a[href], .b_ans a[href]');

    linkContainers.each((index: number, element: any) => {
        if (results.length >= limit) {
            return false;
        }

        const linkElement = $(element);
        const url = sanitizeBingUrl(linkElement.attr('href') || linkElement.attr('redirecturl') || linkElement.attr('data-h'));
        if (!url || seenUrls.has(url)) {
            return;
        }

        const container = linkElement.closest('li, .b_algo, .b_ans');
        const title = extractTitle($, container, url, index);
        const description = extractDescription(container, title) || `Result from ${new URL(url).hostname}`;

        seenUrls.add(url);
        results.push({
            title,
            url,
            description,
            source: extractSource(container, url),
            engine: 'bing'
        });
    });
}

export function parseBingSearchResults(htmlContent: string, limit: number): SearchResult[] {
    const $ = cheerio.load(htmlContent);
    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();

    for (const selector of RESULT_SELECTORS) {
        $(selector).each((index, node) => {
            if (results.length >= limit) {
                return false;
            }

            const element = $(node);
            if (element.hasClass('b_ad') || element.closest('.b_ad').length > 0 || element.hasClass('b_pag') || element.hasClass('b_msg')) {
                return;
            }

            const titleLink = element.find('h2 a, .b_title a, a.tilk, a[target="_blank"]').first();
            const url = sanitizeBingUrl(titleLink.attr('href') || titleLink.attr('redirecturl') || titleLink.attr('data-h'));
            if (!url || seenUrls.has(url)) {
                return;
            }

            const title = extractTitle($, element, url, index);
            const description = extractDescription(element, title);
            if (!title && !description) {
                return;
            }

            seenUrls.add(url);
            results.push({
                title,
                url,
                description,
                source: extractSource(element, url),
                engine: 'bing'
            });
        });

        if (results.length >= limit) {
            break;
        }
    }

    if (results.length === 0) {
        collectFallbackLinks($, limit, seenUrls, results);
    }

    return results.slice(0, limit);
}
