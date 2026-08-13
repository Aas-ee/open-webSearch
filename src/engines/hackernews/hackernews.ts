import axios from 'axios';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { isPrivateOrLocalHostname } from '../../utils/urlSafety.js';

const HACKER_NEWS_SEARCH_URL = 'https://hn.algolia.com/api/v1/search';
const HACKER_NEWS_ITEM_URL = 'https://news.ycombinator.com/item';
const HACKER_NEWS_MAX_RESULTS = 50;

type HackerNewsHttpGet = (url: string, options: AxiosRequestConfig) => Promise<AxiosResponse>;

type HackerNewsHit = {
    objectID?: unknown;
    title?: unknown;
    url?: unknown;
    author?: unknown;
    points?: unknown;
    num_comments?: unknown;
    created_at?: unknown;
    story_text?: unknown;
};

let hackerNewsHttpGet: HackerNewsHttpGet = (url, options) => axios.get(url, options);

export function __setHackerNewsHttpGetForTests(impl?: HackerNewsHttpGet): void {
    hackerNewsHttpGet = impl ?? ((url, options) => axios.get(url, options));
}

function readText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readFiniteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseHttpResultUrl(value: unknown): URL | undefined {
    const rawUrl = readText(value);
    if (!rawUrl) {
        return undefined;
    }

    try {
        const parsed = new URL(rawUrl);
        if (
            (parsed.protocol === 'http:' || parsed.protocol === 'https:')
            && !parsed.username
            && !parsed.password
            && !isPrivateOrLocalHostname(parsed.hostname)
        ) {
            return parsed;
        }
    } catch {
        // Malformed upstream URLs fall back to the Hacker News discussion page.
    }

    return undefined;
}

function readObjectId(value: unknown): string {
    const objectId = readText(value);
    return /^\d+$/.test(objectId) ? objectId : '';
}

function buildDescription(hit: HackerNewsHit): string {
    const metadata: string[] = [];
    const author = readText(hit.author);
    const points = readFiniteNumber(hit.points);
    const comments = readFiniteNumber(hit.num_comments);
    const createdAt = readText(hit.created_at);

    if (author) {
        metadata.push(`By ${author}`);
    }
    if (points !== undefined) {
        metadata.push(`${points} point${points === 1 ? '' : 's'}`);
    }
    if (comments !== undefined) {
        metadata.push(`${comments} comment${comments === 1 ? '' : 's'}`);
    }
    if (createdAt) {
        const timestamp = Date.parse(createdAt);
        if (Number.isFinite(timestamp)) {
            metadata.push(new Date(timestamp).toISOString().slice(0, 10));
        }
    }

    const storyText = readText(hit.story_text);
    let summary = '';
    if (storyText) {
        const $ = cheerio.load(storyText);
        $('script, style').remove();
        $('br').replaceWith(' ');
        $('p, div, li, blockquote, pre, h1, h2, h3, h4, h5, h6').each((_, element) => {
            $(element).append(' ');
        });
        summary = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 500);
    }

    return [summary, ...metadata].filter(Boolean).join(' | ');
}

function mapHackerNewsHit(hit: unknown): SearchResult | undefined {
    if (!hit || typeof hit !== 'object' || Array.isArray(hit)) {
        return undefined;
    }

    const candidate = hit as HackerNewsHit;
    const title = readText(candidate.title);
    if (!title) {
        return undefined;
    }

    const objectId = readObjectId(candidate.objectID);
    const externalUrl = parseHttpResultUrl(candidate.url);
    const resultUrl = externalUrl?.toString()
        ?? (objectId ? `${HACKER_NEWS_ITEM_URL}?id=${encodeURIComponent(objectId)}` : '');
    if (!resultUrl) {
        return undefined;
    }

    return {
        title,
        url: resultUrl,
        description: buildDescription(candidate),
        source: externalUrl?.hostname || 'news.ycombinator.com',
        engine: 'hackernews'
    };
}

export function parseHackerNewsSearchResponse(data: unknown, limit: number): SearchResult[] {
    if (limit <= 0) {
        return [];
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Hacker News Search returned an invalid response');
    }

    const hits = (data as { hits?: unknown }).hits;
    if (!Array.isArray(hits)) {
        throw new Error('Hacker News Search response is missing a hits array');
    }

    const results: SearchResult[] = [];
    for (const hit of hits) {
        const result = mapHackerNewsHit(hit);
        if (!result) {
            continue;
        }
        results.push(result);
        if (results.length >= limit) {
            break;
        }
    }

    if (hits.length > 0 && results.length === 0) {
        throw new Error('Hacker News Search returned no usable story hits');
    }

    return results;
}

export async function searchHackerNews(query: string, limit: number): Promise<SearchResult[]> {
    const normalizedLimit = Math.floor(limit);
    if (!Number.isFinite(normalizedLimit) || normalizedLimit <= 0) {
        return [];
    }

    const hitsPerPage = Math.min(normalizedLimit, HACKER_NEWS_MAX_RESULTS);
    const response = await hackerNewsHttpGet(HACKER_NEWS_SEARCH_URL, buildAxiosRequestOptions({
        trustedStaticHost: true,
        headers: {
            Accept: 'application/json',
            'User-Agent': 'open-websearch'
        },
        params: {
            query,
            tags: 'story',
            hitsPerPage,
            attributesToRetrieve: 'objectID,title,url,author,points,num_comments,created_at,story_text'
        },
        timeout: 15000,
        maxContentLength: 2 * 1024 * 1024
    }));

    return parseHackerNewsSearchResponse(response.data, hitsPerPage);
}
