import axios from 'axios';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import { AppConfig, checkPlaywrightModeConfiguration, config, getEffectiveSearchMode } from '../../config.js';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import {
    acquirePooledPlaywrightPage,
    asBrowserUnavailableError,
    getPlaywrightModuleSource,
    loadPlaywrightClient,
    openPlaywrightBrowser,
    retryOnBrowserCrash
} from '../../utils/playwrightClient.js';

const STARTPAGE_BASE_URL = 'https://www.startpage.com';
const STARTPAGE_SEARCH_URL = `${STARTPAGE_BASE_URL}/sp/search`;
const STARTPAGE_SEARCH_POST_URL = `${STARTPAGE_BASE_URL}/do/search`;
const DEFAULT_PAGE_SIZE = 10;

const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': `${STARTPAGE_BASE_URL}/`
};

const BROWSER_CONTEXT_OPTIONS = {
    userAgent: COMMON_HEADERS['User-Agent'],
    locale: 'en-US',
    viewport: { width: 1440, height: 960 }
};

type StartpageHttpGet = (url: string, options: AxiosRequestConfig) => Promise<AxiosResponse>;
type StartpageHttpPost = (url: string, data: string, options: AxiosRequestConfig) => Promise<AxiosResponse>;
type StartpagePlaywrightSearch = (query: string, limit: number) => Promise<SearchResult[]>;
type StartpageBrowserOpener = typeof openPlaywrightBrowser;

type StartpageHtmlResponse = {
    html: string;
    cookieHeader: string;
};

let startpageHttpGet: StartpageHttpGet = (url, options) => axios.get(url, options);
let startpageHttpPost: StartpageHttpPost = (url, data, options) => axios.post(url, data, options);
let startpagePlaywrightSearchForTests: StartpagePlaywrightSearch | undefined;
let startpageBrowserOpener: StartpageBrowserOpener = openPlaywrightBrowser;
let playwrightAvailabilityPromise: Promise<boolean> | null = null;
let hasVerifiedPlaywrightAvailability = false;

export function __setStartpageHttpGetForTests(impl?: StartpageHttpGet): void {
    startpageHttpGet = impl ?? ((url, options) => axios.get(url, options));
}

export function __setStartpageHttpPostForTests(impl?: StartpageHttpPost): void {
    startpageHttpPost = impl ?? ((url, data, options) => axios.post(url, data, options));
}

export function __setStartpagePlaywrightSearchForTests(impl?: StartpagePlaywrightSearch): void {
    startpagePlaywrightSearchForTests = impl;
}

export function __setStartpageBrowserOpenerForTests(impl?: StartpageBrowserOpener): void {
    startpageBrowserOpener = impl ?? openPlaywrightBrowser;
    playwrightAvailabilityPromise = null;
    hasVerifiedPlaywrightAvailability = false;
}

function normalizeText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function htmlToText(value: string): string {
    return normalizeText(cheerio.load(`<div>${value}</div>`)('div').first().text());
}

function parseJsonObjectAt(source: string, startIndex: number): unknown | undefined {
    if (source[startIndex] !== '{') {
        return undefined;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = startIndex; index < source.length; index += 1) {
        const character = source[index];
        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (character === '\\') {
                escaped = true;
                continue;
            }
            if (character === '"') {
                inString = false;
            }
            continue;
        }

        if (character === '"') {
            inString = true;
            continue;
        }
        if (character === '{') {
            depth += 1;
            continue;
        }
        if (character === '}') {
            depth -= 1;
            if (depth === 0) {
                try {
                    return JSON.parse(source.slice(startIndex, index + 1));
                } catch {
                    return undefined;
                }
            }
        }
    }

    return undefined;
}

function extractBootstrapPayload(html: string): Record<string, unknown> | undefined {
    const markers = [
        'React.createElement(UIStartpage.AppSerpWeb,',
        'React.createElement(UIStartpage.AppHome,'
    ];

    for (const marker of markers) {
        const markerIndex = html.indexOf(marker);
        if (markerIndex < 0) {
            continue;
        }
        const objectStart = html.indexOf('{', markerIndex + marker.length);
        if (objectStart < 0) {
            continue;
        }
        const payload = parseJsonObjectAt(html, objectStart);
        if (payload && typeof payload === 'object') {
            return payload as Record<string, unknown>;
        }
    }

    return undefined;
}

export function extractStartpageScCode(html: string): string | undefined {
    const $ = cheerio.load(html);
    const formToken = $(
        'form[action*="/sp/search"] input[name="sc"], form[action*="/do/search"] input[name="sc"]'
    ).first().attr('value')?.trim();
    if (formToken) {
        return formToken;
    }

    const bootstrap = extractBootstrapPayload(html);
    const render = bootstrap?.render;
    if (render && typeof render === 'object') {
        const renderRecord = render as Record<string, unknown>;
        for (const key of ['search_sc', 'callback_sc']) {
            const value = renderRecord[key];
            if (typeof value === 'string' && value.trim()) {
                return value.trim();
            }
        }
    }

    const match = html.match(/"(?:search_sc|callback_sc)"\s*:\s*"([^"]+)"/);
    return match?.[1]?.trim() || undefined;
}

function hasRecognizableStartpageResults(html: string): boolean {
    const results: SearchResult[] = [];
    collectWebResults(extractBootstrapPayload(html), results, new Set<string>());
    return results.length > 0 || extractLegacyDomResults(html).length > 0;
}

export function isStartpageChallengePage(html: string): boolean {
    const normalized = html.toLowerCase();
    const $ = cheerio.load(html);
    const title = $('title').first().text().trim().toLowerCase();
    const hasChallengeUi = $([
        'form[action*="/sp/captcha"]',
        'iframe[src*="captcha"]',
        '[id*="captcha"]',
        '[class*="captcha"]',
        'script[src*=".within.website/x/cmd/anubis"]',
        'script[src*="sha256-webcrypto"]',
        'script#anubis_challenge'
    ].join(',')).length > 0;
    const hasChallengeTitle = [
        'making sure you',
        'verify you are human',
        'human verification',
        'security check'
    ].some((keyword) => title.includes(keyword));

    if (hasChallengeUi || hasChallengeTitle) {
        return true;
    }
    if (hasRecognizableStartpageResults(html)) {
        return false;
    }

    return [
        '/sp/captcha',
        '.within.website/x/cmd/anubis',
        'anubis_challenge',
        'sha256-webcrypto',
        'verify you are human',
        'human verification',
        'security check'
    ].some((keyword) => normalized.includes(keyword));
}

export function isStartpageBlockedPage(html: string): boolean {
    const $ = cheerio.load(html);
    const title = $('title').first().text().trim().toLowerCase();
    const normalized = html.toLowerCase();
    if (title.includes('access denied')) {
        return true;
    }
    return !hasRecognizableStartpageResults(html) && normalized.includes('blocked=true');
}

export function isStartpageChallengeRedirect(location: string): boolean {
    let url: URL;
    try {
        url = new URL(location, STARTPAGE_BASE_URL);
    } catch {
        return false;
    }

    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'startpage.com' && !hostname.endsWith('.startpage.com')) {
        return false;
    }

    return /(?:^|\/)(?:anubis|captcha|pass-challenge|verify)(?:\/|$)/i.test(url.pathname);
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

function hostnameOf(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}

function pushWebResult(value: unknown, results: SearchResult[], seenUrls: Set<string>): void {
    if (!value || typeof value !== 'object') {
        return;
    }

    const record = value as Record<string, unknown>;
    const url = typeof record.clickUrl === 'string' ? record.clickUrl.trim() : '';
    const title = typeof record.title === 'string' ? htmlToText(record.title) : '';
    if (!title || !/^https?:\/\//i.test(url) || seenUrls.has(url)) {
        return;
    }

    seenUrls.add(url);
    const description = typeof record.description === 'string' ? htmlToText(record.description) : '';
    const displayUrl = typeof record.displayUrl === 'string' ? record.displayUrl.trim() : '';

    results.push({
        title,
        url,
        description,
        source: hostnameOf(displayUrl) || hostnameOf(url),
        engine: 'startpage'
    });
}

function collectWebResults(node: unknown, results: SearchResult[], seenUrls: Set<string>): void {
    if (Array.isArray(node)) {
        for (const item of node) {
            collectWebResults(item, results, seenUrls);
        }
        return;
    }

    if (!node || typeof node !== 'object') {
        return;
    }

    const record = node as Record<string, unknown>;
    const displayType = typeof record.display_type === 'string' ? record.display_type : '';
    if (displayType.startsWith('web-') && Array.isArray(record.results)) {
        for (const item of record.results) {
            pushWebResult(item, results, seenUrls);
        }
        return;
    }
    if (displayType.startsWith('ads-')) {
        return;
    }

    for (const value of Object.values(record)) {
        collectWebResults(value, results, seenUrls);
    }
}

function extractLegacyDomResults(html: string): SearchResult[] {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();

    $('a.result-title.result-link[href], a.result-link[href]').each((_, element) => {
        const link = $(element);
        const url = link.attr('href')?.trim() || '';
        const title = normalizeText(link.find('h2').first().text()) || normalizeText(link.text());
        const description = normalizeText(link.nextAll('p.description').first().text());

        if (!url || !title || !/^https?:\/\//i.test(url) || seenUrls.has(url)) {
            return;
        }
        seenUrls.add(url);
        results.push({
            title,
            url,
            description,
            source: hostnameOf(url),
            engine: 'startpage'
        });
    });

    return results;
}

export function parseStartpageSearchResults(html: string): SearchResult[] {
    if (isStartpageBlockedPage(html)) {
        throw new Error('Startpage returned a blocked or access denied page');
    }
    if (isStartpageChallengePage(html)) {
        throw new Error('Startpage returned a verification or anti-bot page');
    }

    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();
    collectWebResults(extractBootstrapPayload(html), results, seenUrls);

    if (results.length > 0) {
        return results;
    }

    return extractLegacyDomResults(html);
}

function isAllowedStartpageRedirectUrl(url: URL): boolean {
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:'
        && (hostname === 'startpage.com' || hostname.endsWith('.startpage.com'));
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

async function fetchStartpageHtml(initialUrl: string, referer: string = `${STARTPAGE_BASE_URL}/`): Promise<StartpageHtmlResponse> {
    let currentUrl = initialUrl;
    let cookieHeader = '';

    for (let redirects = 0; redirects <= 5; redirects += 1) {
        const response = await startpageHttpGet(currentUrl, buildAxiosRequestOptions({
            trustedStaticHost: true,
            headers: {
                ...COMMON_HEADERS,
                Referer: referer,
                ...(cookieHeader ? { Cookie: cookieHeader } : {})
            },
            timeout: 20000,
            validateStatus: (status) => status >= 200 && status < 400
        }));

        cookieHeader = mergeSetCookie(cookieHeader, response.headers?.['set-cookie']);

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers?.location;
            if (!location) {
                throw new Error(`Startpage returned redirect status ${response.status} without a Location header`);
            }

            const redirectUrl = new URL(String(location), currentUrl);
            if (isStartpageChallengeRedirect(redirectUrl.toString())) {
                throw new Error('Startpage redirected to a verification or anti-bot page');
            }
            if (redirectUrl.protocol !== 'https:') {
                throw new Error('Startpage redirected from HTTPS to insecure HTTP');
            }
            if (!isAllowedStartpageRedirectUrl(redirectUrl)) {
                throw new Error(`Startpage redirected to an unexpected host: ${redirectUrl.hostname}`);
            }
            currentUrl = redirectUrl.toString();
            continue;
        }

        return {
            html: String(response.data || ''),
            cookieHeader
        };
    }

    throw new Error('Startpage returned too many redirects');
}

function buildStartpageSearchUrl(query: string, page: number): string {
    const url = new URL(STARTPAGE_SEARCH_URL);
    url.searchParams.set('query', query);
    url.searchParams.set('cat', 'web');
    if (page > 1) {
        url.searchParams.set('page', String(page));
    }
    return url.toString();
}

async function searchStartpagePage(query: string, page: number): Promise<SearchResult[]> {
    const fetched = await fetchStartpageHtml(buildStartpageSearchUrl(query, page));
    let html = fetched.html;
    const interstitialPayload = extractInterstitialPayload(html);
    if (interstitialPayload) {
        const response = await startpageHttpPost(
            STARTPAGE_SEARCH_POST_URL,
            new URLSearchParams(interstitialPayload).toString(),
            buildAxiosRequestOptions({
                trustedStaticHost: true,
                headers: {
                    ...COMMON_HEADERS,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Origin: STARTPAGE_BASE_URL,
                    Referer: STARTPAGE_SEARCH_URL,
                    ...(fetched.cookieHeader ? { Cookie: fetched.cookieHeader } : {})
                },
                timeout: 20000
            })
        );
        html = String(response.data || '');
    }

    return parseStartpageSearchResults(html);
}

async function searchStartpageWithHttp(query: string, limit: number): Promise<SearchResult[]> {
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

async function isPlaywrightAvailable(): Promise<boolean> {
    if (hasVerifiedPlaywrightAvailability) {
        return true;
    }

    if (!playwrightAvailabilityPromise) {
        playwrightAvailabilityPromise = (async () => {
            const playwright = await loadPlaywrightClient({ silent: true });
            if (!playwright) {
                return false;
            }

            try {
                const session = await startpageBrowserOpener({ antiBot: true });
                await session.release();
                hasVerifiedPlaywrightAvailability = true;
                return true;
            } catch (error) {
                const playwrightModuleSource = getPlaywrightModuleSource();
                console.warn(`Playwright browser is unavailable${playwrightModuleSource ? ` via ${playwrightModuleSource}` : ''}, Startpage auto fallback will retry on the next failed or empty request:`, error);
                return false;
            }
        })().finally(() => {
            if (!hasVerifiedPlaywrightAvailability) {
                playwrightAvailabilityPromise = null;
            }
        });
    }

    return playwrightAvailabilityPromise;
}

async function searchStartpageWithPlaywrightOnce(query: string, limit: number): Promise<SearchResult[]> {
    const playwright = await loadPlaywrightClient();
    if (!playwright) {
        throw asBrowserUnavailableError(
            new Error('Playwright client is not available'),
            'Startpage Playwright search'
        );
    }

    const session = await startpageBrowserOpener({ antiBot: true });
    try {
        const { page, releasePage } = await acquirePooledPlaywrightPage(session.browser, {
            poolKey: 'startpage-search',
            contextOptions: BROWSER_CONTEXT_OPTIONS
        });

        try {
            const allResults: SearchResult[] = [];
            const seenUrls = new Set<string>();
            const maxPage = Math.max(1, Math.ceil(limit / DEFAULT_PAGE_SIZE));
            const timeout = Math.max(config.playwrightNavigationTimeoutMs, 20000);

            for (let pageNumber = 1; pageNumber <= maxPage && allResults.length < limit; pageNumber += 1) {
                await page.goto(buildStartpageSearchUrl(query, pageNumber), {
                    waitUntil: 'domcontentloaded',
                    timeout
                });
                await page.waitForFunction(
                    () => document.documentElement.innerHTML.includes('UIStartpage.AppSerpWeb')
                        || document.documentElement.innerHTML.includes('"display_type":"web-'),
                    undefined,
                    { timeout }
                ).catch(() => undefined);

                const pageResults = parseStartpageSearchResults(await page.content())
                    .filter((result) => {
                        if (seenUrls.has(result.url)) {
                            return false;
                        }
                        seenUrls.add(result.url);
                        return true;
                    });

                allResults.push(...pageResults);
                if (pageResults.length === 0) {
                    break;
                }
            }

            return allResults.slice(0, limit);
        } finally {
            await releasePage();
        }
    } finally {
        await session.release();
    }
}

async function searchStartpageWithPlaywright(query: string, limit: number): Promise<SearchResult[]> {
    return retryOnBrowserCrash(() => searchStartpageWithPlaywrightOnce(query, limit));
}

async function runStartpagePlaywrightSearch(query: string, limit: number): Promise<SearchResult[]> {
    return startpagePlaywrightSearchForTests
        ? startpagePlaywrightSearchForTests(query, limit)
        : searchStartpageWithPlaywright(query, limit);
}

export async function searchStartpage(
    query: string,
    limit: number,
    options?: { searchMode?: AppConfig['searchMode'] }
): Promise<SearchResult[]> {
    const effectiveSearchMode = options?.searchMode ?? getEffectiveSearchMode(config);

    if (effectiveSearchMode === 'request') {
        return searchStartpageWithHttp(query, limit);
    }

    if (effectiveSearchMode === 'playwright') {
        const availability = checkPlaywrightModeConfiguration(config);
        if (!availability.available) {
            throw asBrowserUnavailableError(
                new Error(availability.reason || 'Playwright configuration is invalid'),
                'Startpage Playwright search'
            );
        }
        return runStartpagePlaywrightSearch(query, limit);
    }

    let requestResults: SearchResult[];
    try {
        requestResults = await searchStartpageWithHttp(query, limit);
    } catch (requestError) {
        const canUsePlaywright = await isPlaywrightAvailable();
        if (!canUsePlaywright) {
            throw requestError;
        }

        console.warn('Request-based Startpage search failed, falling back to Playwright mode:', requestError);
        return runStartpagePlaywrightSearch(query, limit);
    }

    if (requestResults.length > 0 || limit <= 0) {
        return requestResults;
    }

    const canUsePlaywright = await isPlaywrightAvailable();
    if (!canUsePlaywright) {
        return requestResults;
    }

    console.warn('Request-based Startpage search returned no results, falling back to Playwright mode');
    return runStartpagePlaywrightSearch(query, limit);
}
