import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';

const STARTPAGE_BASE_URL = 'https://www.startpage.com';
const STARTPAGE_SEARCH_URL = `${STARTPAGE_BASE_URL}/sp/search`;
const STARTPAGE_SC_TTL_MS = 30 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 10;

const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9'
};

let cachedScCode: string | undefined;
let cachedScAt = 0;

function isCaptchaPage(html: string): boolean {
    return /\/sp\/captcha|captcha|verify you are human|human verification/i.test(html);
}

function extractScCode(html: string): string | undefined {
    const $ = cheerio.load(html);
    return $('form[action="/sp/search"] input[name="sc"]').first().attr('value')?.trim() || undefined;
}

function extractInterstitialPayload(html: string): Record<string, string> | undefined {
    const match = html.match(/var data = (\{[\s\S]*?\});/);
    if (!match) {
        return undefined;
    }

    try {
        const payload = JSON.parse(match[1]) as Record<string, unknown>;
        if (typeof payload?.query !== 'string' || typeof payload?.sgt !== 'string') {
            return undefined;
        }

        const data = Object.entries(payload).reduce<Record<string, string>>((acc, [key, value]) => {
            if (typeof value === 'string') {
                acc[key] = value;
            }
            return acc;
        }, {});

        return Object.keys(data).length > 0 ? data : undefined;
    } catch {
        return undefined;
    }
}

async function getScCode(): Promise<string> {
    const now = Date.now();
    if (cachedScCode && now - cachedScAt < STARTPAGE_SC_TTL_MS) {
        return cachedScCode;
    }

    const response = await axios.get(
        `${STARTPAGE_BASE_URL}/`,
        buildAxiosRequestOptions({
            headers: {
                ...COMMON_HEADERS,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 15000
        })
    );

    const html = String(response.data || '');
    if (isCaptchaPage(html)) {
        throw new Error('Startpage returned a verification or anti-bot page while requesting the search token');
    }

    const scCode = extractScCode(html);
    if (!scCode) {
        throw new Error('Failed to extract Startpage search token');
    }

    cachedScCode = scCode;
    cachedScAt = now;
    return scCode;
}

function extractResultsFromHtml(html: string): SearchResult[] {
    if (isCaptchaPage(html)) {
        throw new Error('Startpage returned a verification or anti-bot page');
    }

    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();

    $('a.result-title.result-link[href]').each((_, element) => {
        const link = $(element);
        const url = link.attr('href')?.trim();
        const title = link.find('h2').first().text().replace(/\s+/g, ' ').trim();
        const description = link.nextAll('p.description').first().text().replace(/\s+/g, ' ').trim();

        if (!url || !title || seenUrls.has(url)) {
            return;
        }
        seenUrls.add(url);

        let source = '';
        try {
            source = new URL(url).hostname;
        } catch {
            source = '';
        }

        results.push({
            title,
            url,
            description,
            source,
            engine: 'startpage'
        });
    });

    if (results.length === 0) {
        throw new Error('Failed to locate Startpage results in the response HTML');
    }

    return results;
}

async function searchStartpagePage(query: string, page: number): Promise<SearchResult[]> {
    const scCode = await getScCode();
    const formData = new URLSearchParams({
        query,
        cat: 'web',
        t: 'device',
        sc: scCode,
        abp: '1',
        abd: '1',
        abe: '1'
    });

    if (page > 1) {
        formData.set('page', String(page));
        formData.set('segment', 'startpage.udog');
    }

    const response = await axios.post(
        STARTPAGE_SEARCH_URL,
        formData.toString(),
        buildAxiosRequestOptions({
            headers: {
                ...COMMON_HEADERS,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': STARTPAGE_BASE_URL,
                'Referer': `${STARTPAGE_BASE_URL}/`
            },
            timeout: 20000
        })
    );

    let html = String(response.data || '');
    const interstitialPayload = extractInterstitialPayload(html);
    if (interstitialPayload) {
        const followUpResponse = await axios.post(
            STARTPAGE_SEARCH_URL,
            new URLSearchParams(interstitialPayload).toString(),
            buildAxiosRequestOptions({
                headers: {
                    ...COMMON_HEADERS,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': STARTPAGE_BASE_URL,
                    'Referer': STARTPAGE_SEARCH_URL
                },
                timeout: 20000
            })
        );

        html = String(followUpResponse.data || '');
    }

    return extractResultsFromHtml(html);
}

export async function searchStartpage(query: string, limit: number): Promise<SearchResult[]> {
    const allResults: SearchResult[] = [];
    const seenUrls = new Set<string>();
    const maxPage = Math.max(1, Math.ceil(limit / DEFAULT_PAGE_SIZE));

    for (let page = 1; page <= maxPage && allResults.length < limit; page += 1) {
        const pageResults = await searchStartpagePage(query, page);
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
