import axios from 'axios';
import * as cheerio from 'cheerio';
import type { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { isQualifiedNewsResult } from '../../core/search/newsQualification.js';
import { chinaNewsFeedPlan } from './feeds.js';

const MAX_AGE_MS = 72 * 60 * 60 * 1000;
const CACHE_TTL_MS = 60 * 1000;

function plainText(value: string): string {
    const $ = cheerio.load(value);
    $('script, style, iframe').remove();
    return $.root().text().replace(/\s+/g, ' ').trim();
}

export function parseChinaNewsFeed(xml: string, now: Date): SearchResult[] {
    const $ = cheerio.load(xml, { xmlMode: true });
    if (!$('rss > channel').length) {
        throw new Error('China News returned an invalid RSS feed');
    }
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    $('channel > item').each((_, item) => {
        const element = $(item);
        const rawUrl = element.find('link').first().text().trim();
        let url: URL;
        try { url = new URL(rawUrl); } catch { return; }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
            !['www.chinanews.com.cn', 'www.chinanews.com'].includes(url.hostname) || url.port) {
            return;
        }
        const timestamp = Date.parse(element.find('pubDate').first().text().trim());
        if (!Number.isFinite(timestamp) || timestamp > now.getTime() || timestamp < now.getTime() - MAX_AGE_MS) {
            return;
        }
        url.hash = '';
        const result: SearchResult = {
            title: plainText(element.find('title').first().text()).slice(0, 200),
            url: url.href,
            description: plainText(element.find('description').first().text()).slice(0, 400),
            source: '中国新闻网',
            engine: 'chinanews',
            publishedAt: new Date(timestamp).toISOString()
        };
        if (!seen.has(result.url) && isQualifiedNewsResult(result, now)) {
            seen.add(result.url);
            results.push(result);
        }
    });
    return results;
}

async function loadPublicFeed(url: string): Promise<string> {
    const response = await axios.get<string>(url, buildAxiosRequestOptions({
        trustedStaticHost: true,
        headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
        responseType: 'text', timeout: 5000, maxContentLength: 2 * 1024 * 1024
    }));
    return response.data;
}

export function createChinaNewsSearch(options: {
    loadFeed?: (url: string) => Promise<string>;
    now?: () => Date;
} = {}): (query: string, limit: number) => Promise<SearchResult[]> {
    const load = options.loadFeed ?? loadPublicFeed;
    const now = options.now ?? (() => new Date());
    const cache = new Map<string, { expires: number; xml: string }>();
    const pending = new Map<string, Promise<string>>();
    async function feed(url: string): Promise<string> {
        const cached = cache.get(url);
        if (cached && cached.expires > now().getTime()) return cached.xml;
        const inFlight = pending.get(url);
        if (inFlight) return inFlight;
        const request = load(url).then(xml => {
            // Invalid/blocked responses must not become a successful cache entry.
            parseChinaNewsFeed(xml, now());
            cache.set(url, { expires: now().getTime() + CACHE_TTL_MS, xml });
            return xml;
        }).finally(() => pending.delete(url));
        pending.set(url, request);
        return request;
    }
    return async (query, limit) => {
        if (limit <= 0) return [];
        const plan = chinaNewsFeedPlan(query);
        if (!plan.urls.length) return [];
        const feeds = await Promise.allSettled(plan.urls.map(feed));
        const successful = feeds.filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled');
        if (!successful.length) throw new Error('China News RSS feeds unavailable');
        const retrievedAt = now();
        const results = successful.flatMap(result => parseChinaNewsFeed(result.value, retrievedAt))
            .filter(result => plan.matches(`${result.title} ${result.description}`))
            .sort((left, right) => Date.parse(right.publishedAt!) - Date.parse(left.publishedAt!));
        const unique = [...new Map(results.map(result => [result.url, result])).values()];
        return unique.slice(0, Math.min(50, limit));
    };
}

export const searchChinaNews = createChinaNewsSearch();
