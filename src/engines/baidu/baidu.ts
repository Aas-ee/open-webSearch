import axios from 'axios';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';

const BAIDU_SEARCH_URL = 'https://www.baidu.com/s';
const BAIDU_PAGE_SIZE = 10;

// hao123 个人页的稳定客户端标识：百度对纯请求会 302 到 wappass 验证码，
// 带上该 tn 才返回正常搜索结果页。它是长期固定的客户端 id，不是会过期的会话 token。
const BAIDU_TN = '88093251_62_hao_pg';

const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

type BaiduHttpGet = (url: string, options: AxiosRequestConfig) => Promise<AxiosResponse>;

let baiduHttpGet: BaiduHttpGet = (url, options) => axios.get(url, options);

export function __setBaiduHttpGetForTests(impl?: BaiduHttpGet): void {
    baiduHttpGet = impl ?? ((url, options) => axios.get(url, options));
}

function normalizeText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

/**
 * 百度限流时会把请求 302 到 `wappass.baidu.com/static/captcha/...`。Location 命中这些
 * 关键词即视为安全验证拦截，而不是普通跳转。
 */
function isBaiduChallengeRedirect(location: string): boolean {
    return /wappass|captcha|antispider|verify/i.test(location);
}

function isBaiduChallengePage(html: string): boolean {
    const normalized = html.toLowerCase();
    const $ = cheerio.load(html);
    const title = $('title').first().text().trim();

    return normalized.includes('wappass')
        || normalized.includes('百度安全验证')
        || normalized.includes('请输入验证码')
        || normalized.includes('antispider')
        || title.includes('验证');
}

export function parseBaiduSearchResults(html: string): SearchResult[] {
    if (isBaiduChallengePage(html)) {
        throw new Error('Baidu returned a security verification or anti-bot page');
    }

    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    $('#content_left').children().each((_, element) => {
        const card = $(element);
        const titleElement = card.find('h3').first();
        const linkElement = card.find('a').first();
        const snippetElement = card.find('.cos-row').first();
        const snippetElementBaidu = card.find('.c-font-normal.c-color-text').first();
        const sourceElement = card.find('.cosc-source').first();

        if (!titleElement.length || !linkElement.length) {
            return;
        }

        const url = linkElement.attr('href');
        if (!url || !url.startsWith('http')) {
            return;
        }

        results.push({
            title: normalizeText(titleElement.text()),
            url,
            description: snippetElementBaidu.attr('aria-label') || normalizeText(snippetElement.text()),
            source: normalizeText(sourceElement.text()),
            engine: 'baidu',
        });
    });

    return results;
}

async function searchBaiduPage(query: string, page: number): Promise<SearchResult[]> {
    const url = new URL(BAIDU_SEARCH_URL);
    url.searchParams.set('wd', query);
    url.searchParams.set('tn', BAIDU_TN);
    url.searchParams.set('ie', 'utf-8');
    url.searchParams.set('pn', String(page * BAIDU_PAGE_SIZE));

    // trustedStaticHost 会强制 maxRedirects=0：302 不被静默跟随，而是在下面显式识别，
    // 避免把 wappass 验证码跳转误当成正常结果页解析出 0 条。
    const response = await baiduHttpGet(url.toString(), buildAxiosRequestOptions({
        trustedStaticHost: true,
        headers: COMMON_HEADERS,
        timeout: 20000,
        validateStatus: (status) => status >= 200 && status < 400,
    }));

    if (response.status >= 300 && response.status < 400) {
        const location = String(response.headers?.location || '');
        if (isBaiduChallengeRedirect(location)) {
            throw new Error('Baidu redirected to a security verification page');
        }
        throw new Error(`Baidu returned an unexpected redirect: ${location || response.status}`);
    }

    return parseBaiduSearchResults(String(response.data || ''));
}

export async function searchBaidu(query: string, limit: number): Promise<SearchResult[]> {
    const allResults: SearchResult[] = [];
    const seenUrls = new Set<string>();
    const maxPage = Math.max(1, Math.ceil(limit / BAIDU_PAGE_SIZE));

    for (let page = 0; page < maxPage && allResults.length < limit; page += 1) {
        const pageResults = await searchBaiduPage(query, page);
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
