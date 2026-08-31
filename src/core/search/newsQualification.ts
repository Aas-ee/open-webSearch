import type { SearchResult } from '../../types.js';

const NON_ARTICLE_LAST_SEGMENTS = new Set([
    'index',
    'default',
    'home',
    'news',
    'latest',
    'today',
    'feed',
    'recent',
    'category',
    'categories',
    'tag',
    'tags',
    'topic',
    'topics',
    'browse',
    'portal',
    'newsroom',
    'press-releases'
]);

const NON_NEWS_TITLE_PATTERNS = [
    /\bdefinition\b/i,
    /\bmeaning\b/i,
    /\bdictionary\b/i,
    /\bencyclop(?:a)?edia\b/i,
    /\bwhat is\b/i
];

function safeDecodePathSegment(segment: string): string {
    try {
        return decodeURIComponent(segment).trim();
    } catch {
        return segment.trim();
    }
}

function isLikelyArticleUrl(rawUrl: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
    }

    const segments = parsed.pathname
        .split('/')
        .map(safeDecodePathSegment)
        .filter(Boolean);
    if (segments.length === 0) {
        return false;
    }
    if (segments.slice(0, -1).some(segment => /^(?:category|categories|tags?|topics?|browse|portal)$/i.test(segment))) {
        return false;
    }

    const last = segments[segments.length - 1].toLowerCase();
    const base = last.replace(/\.(?:s?html?)$/i, '');
    if (!base || NON_ARTICLE_LAST_SEGMENTS.has(base)) {
        return false;
    }

    if (/\.(?:s?html?)$/i.test(last)) {
        return true;
    }
    if (/(?:^|\/)(?:19|20)\d{2}[\/_-]\d{1,2}[\/_-]\d{1,2}(?:\/|$)/.test(parsed.pathname)) {
        return true;
    }
    if ((base.match(/\d/g) ?? []).length >= 6) {
        return true;
    }

    return segments.length >= 2 && base.length >= 12 && base.includes('-');
}

function hasPlausiblePublicationTimestamp(result: SearchResult, retrievedAt: Date): boolean {
    const candidate = result.publishedAt?.trim();
    if (!candidate) {
        return false;
    }
    const timestamp = Date.parse(candidate);
    return Number.isFinite(timestamp) && timestamp <= retrievedAt.getTime();
}

export function isQualifiedNewsResult(result: SearchResult, retrievedAt: Date): boolean {
    const title = result.title.trim();
    if (!title || NON_NEWS_TITLE_PATTERNS.some(pattern => pattern.test(title))) {
        return false;
    }
    return hasPlausiblePublicationTimestamp(result, retrievedAt) && isLikelyArticleUrl(result.url);
}
