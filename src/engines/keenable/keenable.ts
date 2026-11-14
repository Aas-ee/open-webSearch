import axios from 'axios';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { isPrivateOrLocalHostname } from '../../utils/urlSafety.js';

// Keenable's public search endpoint: no account or API key, rate limited per IP.
const KEENABLE_SEARCH_URL = 'https://api.keenable.ai/v1/search/public';
const KEENABLE_MAX_RESULTS = 50;
const KEENABLE_DESCRIPTION_CHARACTERS = 500;

type KeenableHttpPost = (url: string, body: unknown, options: AxiosRequestConfig) => Promise<AxiosResponse>;

type KeenableHit = {
    title?: unknown;
    url?: unknown;
    description?: unknown;
    snippet?: unknown;
    published_at?: unknown;
};

let keenableHttpPost: KeenableHttpPost = (url, body, options) => axios.post(url, body, options);

export function __setKeenableHttpPostForTests(impl?: KeenableHttpPost): void {
    keenableHttpPost = impl ?? ((url, body, options) => axios.post(url, body, options));
}

function readText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
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
        // Malformed upstream URLs are skipped.
    }

    return undefined;
}

function buildDescription(hit: KeenableHit): string {
    const text = (readText(hit.snippet) || readText(hit.description))
        .replace(/\s+/g, ' ')
        .slice(0, KEENABLE_DESCRIPTION_CHARACTERS);
    const publishedAt = readText(hit.published_at);
    const timestamp = publishedAt ? Date.parse(publishedAt) : NaN;
    const date = Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : '';
    return [text, date].filter(Boolean).join(' | ');
}

function mapKeenableHit(hit: unknown): SearchResult | undefined {
    if (!hit || typeof hit !== 'object' || Array.isArray(hit)) {
        return undefined;
    }

    const candidate = hit as KeenableHit;
    const url = parseHttpResultUrl(candidate.url);
    if (!url) {
        return undefined;
    }

    return {
        title: readText(candidate.title) || url.hostname,
        url: url.toString(),
        description: buildDescription(candidate),
        source: url.hostname,
        engine: 'keenable'
    };
}

export function parseKeenableSearchResponse(data: unknown, limit: number): SearchResult[] {
    if (limit <= 0) {
        return [];
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Keenable Search returned an invalid response');
    }

    const hits = (data as { results?: unknown }).results;
    if (!Array.isArray(hits)) {
        throw new Error('Keenable Search response is missing a results array');
    }

    const results: SearchResult[] = [];
    for (const hit of hits) {
        const result = mapKeenableHit(hit);
        if (!result) {
            continue;
        }
        results.push(result);
        if (results.length >= limit) {
            break;
        }
    }

    return results;
}

export async function searchKeenable(query: string, limit: number): Promise<SearchResult[]> {
    const normalizedLimit = Math.floor(limit);
    if (!Number.isFinite(normalizedLimit) || normalizedLimit <= 0) {
        return [];
    }

    const maxResults = Math.min(normalizedLimit, KEENABLE_MAX_RESULTS);
    const response = await keenableHttpPost(KEENABLE_SEARCH_URL, { query, max_results: maxResults }, buildAxiosRequestOptions({
        trustedStaticHost: true,
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'open-websearch',
            'X-Keenable-Title': 'open-websearch'
        },
        timeout: 15000,
        maxContentLength: 2 * 1024 * 1024
    }));

    return parseKeenableSearchResponse(response.data, maxResults);
}
