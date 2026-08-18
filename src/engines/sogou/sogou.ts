import axios from 'axios';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';

const SOGOU_SEARCH_URL = 'https://www.sogou.com/web';
const SOGOU_PAGE_SIZE = 10;

const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://www.sogou.com/'
};

type SogouHttpGet = (url: string, options: AxiosRequestConfig) => Promise<AxiosResponse>;

let sogouHttpGet: SogouHttpGet = (url, options) => axios.get(url, options);

export function __setSogouHttpGetForTests(impl?: SogouHttpGet): void {
    sogouHttpGet = impl ?? ((url, options) => axios.get(url, options));
}

function normalizeText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function isSogouChallengePage(html: string): boolean {
    const normalized = html.toLowerCase();
    const $ = cheerio.load(html);
    const title = $('title').first().text().trim();

    return normalized.includes('antispider')
        || normalized.includes('请输入验证码')
        || normalized.includes('访问过于频繁')
        || title.includes('搜狗搜索验证');
}

function resolveResultUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim();
    if (!trimmed) {
        return '';
    }

    try {
        const absoluteUrl = new URL(trimmed, SOGOU_SEARCH_URL).toString();
        const parsed = new URL(absoluteUrl);
        const target = parsed.searchParams.get('url') || parsed.searchParams.get('u') || parsed.searchParams.get('link');
        if (target && /^https?:\/\//i.test(target)) {
            return target;
        }
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return absoluteUrl;
        }
    } catch {
        return '';
    }

    return '';
}

function extractSource(url: string, sourceText: string): string {
    const cleanedSource = normalizeText(sourceText);
    if (cleanedSource) {
        return cleanedSource;
    }

    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}

function isAllowedSogouRedirectUrl(url: URL): boolean {
    const hostname = url.hostname.toLowerCase();
    return (url.protocol === 'https:' || url.protocol === 'http:')
        && (hostname === 'sogou.com' || hostname.endsWith('.sogou.com'));
}

function mergeSetCookie(cookieHeader: string, setCookie: string | string[] | undefined): string {
    if (!setCookie) {
        return cookieHeader;
    }

    const cookieMap = new Map<string, string>();
    for (const cookie of cookieHeader.split(';')) {
        const trimmed = cookie.trim();
        if (!trimmed) {
            continue;
        }
        const [name] = trimmed.split('=', 1);
        cookieMap.set(name, trimmed);
    }

    const values = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const value of values) {
        const pair = value.split(';', 1)[0]?.trim();
        if (!pair) {
            continue;
        }
        const [name] = pair.split('=', 1);
        cookieMap.set(name, pair);
    }

    return Array.from(cookieMap.values()).join('; ');
}

async function fetchSogouHtml(initialUrl: string): Promise<string> {
    let currentUrl = initialUrl;
    let cookieHeader = '';

    for (let redirects = 0; redirects <= 5; redirects += 1) {
        const response = await sogouHttpGet(currentUrl, buildAxiosRequestOptions({
            trustedStaticHost: true,
            headers: {
                ...COMMON_HEADERS,
                ...(cookieHeader ? { Cookie: cookieHeader } : {})
            },
            timeout: 20000,
            validateStatus: (status) => status >= 200 && status < 400
        }));

        cookieHeader = mergeSetCookie(cookieHeader, response.headers?.['set-cookie']);

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers?.location;
            if (!location) {
                throw new Error(`Sogou returned redirect status ${response.status} without a Location header`);
            }

            const redirectUrl = new URL(String(location), currentUrl);
            if (!isAllowedSogouRedirectUrl(redirectUrl)) {
                throw new Error(`Sogou redirected to an unexpected host: ${redirectUrl.hostname}`);
            }
            currentUrl = redirectUrl.toString();
            continue;
        }

        return String(response.data || '');
    }

    throw new Error('Sogou returned too many redirects');
}

export function parseSogouSearchResults(html: string): SearchResult[] {
    if (isSogouChallengePage(html)) {
        throw new Error('Sogou returned a verification or anti-bot page');
    }

    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();

    const resultSelectors = [
        '#main .vrwrap',
        '#main .rb',
        '#main .result',
        '#results .vrwrap',
        '.results .vrwrap',
        '.results .rb'
    ].join(',');

    $(resultSelectors).each((_, element) => {
        const card = $(element);
        const titleLink = card.find('h3 a[href], h2 a[href], .vr-title a[href], .pt a[href]').first();
        const rawUrl = titleLink.attr('href') || '';
        const url = resolveResultUrl(rawUrl);
        const title = normalizeText(titleLink.text());

        if (!title || !url || seenUrls.has(url)) {
            return;
        }

        const description = normalizeText(card.find('.str_info, .ft, .text-layout, .fz-mid, p').first().text());
        const source = extractSource(url, card.find('cite, .citeurl, .g, .url').first().text());

        seenUrls.add(url);
        results.push({
            title,
            url,
            description,
            source,
            engine: 'sogou'
        });
    });

    return results;
}

async function searchSogouPage(query: string, page: number): Promise<SearchResult[]> {
    const url = new URL(SOGOU_SEARCH_URL);
    url.searchParams.set('query', query);
    url.searchParams.set('page', String(page));
    url.searchParams.set('ie', 'utf8');

    return parseSogouSearchResults(await fetchSogouHtml(url.toString()));
}

export async function searchSogou(query: string, limit: number): Promise<SearchResult[]> {
    const allResults: SearchResult[] = [];
    const seenUrls = new Set<string>();
    const maxPage = Math.max(1, Math.ceil(limit / SOGOU_PAGE_SIZE));

    for (let page = 1; page <= maxPage && allResults.length < limit; page += 1) {
        const pageResults = await searchSogouPage(query, page);
        for (const result of pageResults) {
            if (seenUrls.has(result.url)) {
                continue;
            }
            seenUrls.add(result.url);
            allResults.push(result);
        }

        if (pageResults.length === 0) {
            break;
        }
    }

    return allResults.slice(0, limit);
}
