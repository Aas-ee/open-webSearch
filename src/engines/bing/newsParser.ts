import * as cheerio from 'cheerio';
import type { SearchResult } from '../../types.js';

const DATE_TEXT_PATTERN = /^(?:\d{1,4}\s*(?:minutes?|hours?|days?)\s+ago|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})$/i;

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function parseExternalUrl(rawUrl?: string): string {
    const candidate = rawUrl?.trim();
    if (!candidate) {
        return '';
    }

    try {
        const url = new URL(candidate);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return '';
        }
        if (url.hostname.toLowerCase().endsWith('bing.com')) {
            return '';
        }
        return url.toString();
    } catch {
        return '';
    }
}

function extractDateText(element: any): string | undefined {
    const candidates: string[] = [];
    element.find('.source [aria-label]').each((_: number, node: any) => {
        const value = normalizeWhitespace(element.find(node).attr('aria-label') || '');
        if (DATE_TEXT_PATTERN.test(value)) {
            candidates.push(value);
        }
    });
    return candidates[0];
}

export function parseBingNewsResults(html: string, limit: number): SearchResult[] {
    if (!html || limit <= 0) {
        return [];
    }

    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();

    $('.news-card').each((_, node) => {
        if (results.length >= limit) {
            return false;
        }

        const element = $(node);
        const url = parseExternalUrl(
            element.attr('data-url') ||
            element.find('a.title').first().attr('href')
        );
        if (!url || seenUrls.has(url)) {
            return;
        }

        const title = normalizeWhitespace(
            element.attr('data-title') ||
            element.find('a.title').first().text()
        );
        if (!title) {
            return;
        }

        const description = normalizeWhitespace(
            element.find('.snippet').first().attr('title') ||
            element.find('.snippet').first().text()
        );
        const source = normalizeWhitespace(
            element.attr('data-author') ||
            element.find('.source a').first().text()
        );
        const dateText = extractDateText(element);

        seenUrls.add(url);
        results.push({
            title: title.slice(0, 200),
            url,
            description: description.slice(0, 400),
            source,
            ...(dateText ? { dateText } : {}),
            engine: 'bing'
        });
    });

    return results;
}
