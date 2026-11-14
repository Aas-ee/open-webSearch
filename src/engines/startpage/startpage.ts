import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';

export type { SearchResult } from '../../types.js';

export const STARTPAGE_BASE_URL = 'https://www.startpage.com';
export const STARTPAGE_SEARCH_URL = `${STARTPAGE_BASE_URL}/sp/search`;
export const STARTPAGE_ANUBIS_VERIFY_URL = `${STARTPAGE_BASE_URL}/anubis/verify`;
const DEFAULT_PAGE_SIZE = 10;
const MAX_REDIRECTS = 5;
const POW_TIMEOUT_MS = 60000;

const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
};

export type AnubisChallengeInfo = {
    challenge: string;
    difficulty: number;
    id?: string;
};

// Yield between batches so a difficult challenge cannot block the MCP server.
export async function solveAnubisChallenge(
    challenge: string,
    difficulty: number,
    timeoutMs: number = POW_TIMEOUT_MS
): Promise<{ nonce: number; hash: string }> {
    if (!challenge || !Number.isInteger(difficulty) || difficulty < 0 || difficulty > 64) {
        throw new Error('Invalid Startpage Anubis challenge or difficulty');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('Invalid Startpage Anubis time budget');
    }

    const target = '0'.repeat(difficulty);
    const deadline = performance.now() + timeoutMs;
    for (let nonce = 0; ; nonce++) {
        if (nonce % 4096 === 0) {
            if (performance.now() >= deadline) {
                throw new Error(`Startpage Anubis challenge exceeded ${timeoutMs}ms time budget`);
            }
            await setImmediate();
        }
        const hash = createHash('sha256').update(challenge + nonce).digest('hex');
        if (hash.startsWith(target)) {
            return { nonce, hash };
        }
    }
}

function normalizeText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

export function isHardCaptchaPage(html: string): boolean {
    const $ = cheerio.load(html);
    if ($('form[action*="/sp/captcha"], iframe[src*="captcha"], input[name*="captcha"], .g-recaptcha, .h-captcha, #captcha').length > 0) {
        return true;
    }
    // Search snippets can legitimately discuss CAPTCHA or human verification.
    if ($('a.result-link[href], a.result-title[href]').length > 0 || $('#anubis_challenge').length > 0) {
        return false;
    }
    const title = $('title').text();
    $('script, style').remove();
    return /captcha|human verification|security check/i.test(title)
        || /verify you are human|human verification/i.test($('body').text());
}

export function extractAnubisChallenge(html: string): AnubisChallengeInfo | null {
    const $ = cheerio.load(html);
    const challengeElement = $('#anubis_challenge');
    let raw = challengeElement.text().trim() || challengeElement.attr('value')?.trim();
    if (!raw) {
        // Older templates embed the same JSON in an Anubis assignment.
        $('script').each((_, element) => {
            raw ||= $(element).text().match(/(?:window\.)?anubis\s*=\s*(\{[\s\S]*?\})\s*;?/)?.[1];
        });
    }
    if (!raw) {
        if (challengeElement.length > 0) throw new Error('Invalid Startpage Anubis challenge');
        return null;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('Invalid Startpage Anubis challenge JSON');
    }
    const modern = parsed?.challenge && typeof parsed.challenge === 'object';
    const challenge = modern ? parsed.challenge.randomData : parsed?.challenge;
    const id = modern ? parsed.challenge.id : parsed?.id;
    const difficulty = modern
        ? (parsed.rules?.difficulty ?? parsed.challenge.difficulty ?? 6)
        : (parsed?.difficulty ?? 4);
    const algorithm = parsed?.rules?.algorithm;
    if (algorithm !== undefined && algorithm !== 'fast') {
        throw new Error(`Unsupported Startpage Anubis algorithm: ${algorithm}`);
    }
    if (typeof challenge !== 'string' || !challenge
        || !Number.isInteger(difficulty) || difficulty < 0 || difficulty > 64
        || (modern && (typeof id !== 'string' || !id))) {
        throw new Error('Invalid Startpage Anubis challenge or difficulty');
    }
    return { challenge, difficulty, id: typeof id === 'string' ? id : undefined };
}

function resultUrl(value: string | undefined): URL | undefined {
    if (!value?.trim() || value.trim().startsWith('#')) return undefined;
    try {
        const url = new URL(value.trim(), STARTPAGE_BASE_URL);
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : undefined;
    } catch {
        return undefined;
    }
}

export function parseStartpageSearchResults(html: string): SearchResult[] {
    if (isHardCaptchaPage(html)) throw new Error('Startpage blocked by hard CAPTCHA');

    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();
    $('.w-gl__result, div.result, a.result-title.result-link[href]').each((_, element) => {
        const item = $(element);
        // Startpage inserts hidden tracking cards alongside organic results.
        if (item.is('.h, [hidden], [aria-hidden="true"]')) return;
        // Card links are handled with their container, preserving document order.
        if (item.parents('.w-gl__result, div.result').length > 0) return;
        const legacy = item.is('a');
        const titleElement = item.find('.w-gl__result-title, h2, h3').first();
        let link = legacy ? item : item.find('a.result-title[href], a.result-link[href]').first();
        if (link.length === 0) link = titleElement.closest('a[href]');
        if (link.length === 0) link = titleElement.find('a[href]').first();
        if (link.length === 0) return;

        const title = normalizeText(titleElement.text() || link.text());
        const url = resultUrl(link.attr('href'));
        const description = normalizeText((legacy
            ? item.nextAll('p.description').first()
            : item.find('.w-gl__description, .description').first()).text());
        if (!title || !url || seenUrls.has(url.href)) return;
        if (url.origin === STARTPAGE_BASE_URL && /^\/(?:clev(?:\/|$)|sp\/|av\/)/.test(url.pathname)) return;
        seenUrls.add(url.href);
        results.push({ title, url: url.href, description, source: url.hostname, engine: 'startpage' });
    });
    return results;
}

function extractInterstitialPayload(html: string): URLSearchParams | undefined {
    const raw = html.match(/var data = (\{[\s\S]*?\});/)?.[1];
    if (!raw) return undefined;
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.query !== 'string' || typeof parsed?.sgt !== 'string') return undefined;
        return new URLSearchParams(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    } catch {
        return undefined;
    }
}

function assertStartpageUrl(value: string, base: string = STARTPAGE_BASE_URL): URL {
    const url = new URL(value, base);
    if (url.origin !== STARTPAGE_BASE_URL || url.username || url.password) {
        throw new Error('Startpage redirect must stay on the trusted HTTPS origin');
    }
    if (url.pathname.startsWith('/sp/captcha')) throw new Error('Startpage blocked by hard CAPTCHA');
    return url;
}

type SessionCookie = { value: string; path: string; expiresAt?: number };

export class StartpageEngine {
    private readonly client: AxiosInstance;
    private readonly cookies = new Map<string, SessionCookie>();
    private pendingSearch: Promise<void> = Promise.resolve();

    constructor(customClient?: AxiosInstance) {
        this.client = customClient ?? axios.create(buildAxiosRequestOptions({ trustedStaticHost: true, timeout: 25000 }));
    }

    private recordSetCookies(setCookie: string | string[] | undefined, url: URL): void {
        for (const item of typeof setCookie === 'string' ? [setCookie] : setCookie ?? []) {
            const [pair, ...attributes] = item.split(';');
            const index = pair.indexOf('=');
            if (index <= 0) continue;
            const name = pair.slice(0, index).trim();
            const options = new Map(attributes.map((attribute) => {
                const separator = attribute.indexOf('=');
                return separator < 0
                    ? [attribute.trim().toLowerCase(), '']
                    : [attribute.slice(0, separator).trim().toLowerCase(), attribute.slice(separator + 1).trim()];
            }));
            const domain = options.get('domain')?.replace(/^\./, '').toLowerCase();
            if (domain && domain !== url.hostname && !url.hostname.endsWith(`.${domain}`)) continue;
            const maxAge = options.has('max-age') ? Number(options.get('max-age')) : NaN;
            const expires = Date.parse(options.get('expires') ?? '');
            const expiresAt = Number.isFinite(maxAge) ? Date.now() + maxAge * 1000 : Number.isFinite(expires) ? expires : undefined;
            const defaultPath = url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/';
            const path = options.get('path')?.startsWith('/') ? options.get('path')! : defaultPath;
            const key = `${name};${path}`;
            if (expiresAt !== undefined && expiresAt <= Date.now()) {
                this.cookies.delete(key);
            } else {
                this.cookies.set(key, { value: `${name}=${pair.slice(index + 1).trim()}`, path, expiresAt });
            }
        }
    }

    private getCookieHeader(url: URL): string {
        const values: string[] = [];
        for (const [key, cookie] of this.cookies) {
            if (cookie.expiresAt !== undefined && cookie.expiresAt <= Date.now()) {
                this.cookies.delete(key);
                continue;
            }
            if (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)) {
                values.push(cookie.value);
            }
        }
        return values.join('; ');
    }

    private async request(value: string, postData?: URLSearchParams): Promise<AxiosResponse<string>> {
        const url = assertStartpageUrl(value);
        const response = await this.client.request<string>({
            url: url.href,
            method: postData ? 'POST' : 'GET',
            data: postData?.toString(),
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400,
            headers: {
                ...COMMON_HEADERS,
                'Referer': `${STARTPAGE_BASE_URL}/`,
                ...(postData ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': STARTPAGE_BASE_URL } : {}),
                ...(this.cookies.size > 0 ? { 'Cookie': this.getCookieHeader(url) } : {})
            }
        });
        if (response.headers.location) assertStartpageUrl(String(response.headers.location), url.href);
        this.recordSetCookies(response.headers['set-cookie'], url);
        return response;
    }

    private async requestWithRedirects(postData: URLSearchParams): Promise<AxiosResponse<string>> {
        let url = STARTPAGE_SEARCH_URL;
        let body: URLSearchParams | undefined = postData;
        for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
            const response = await this.request(url, body);
            if (response.status < 300 || response.status >= 400) return response;
            if (!response.headers.location) throw new Error('Startpage redirect is missing its location');
            url = assertStartpageUrl(String(response.headers.location), url).href;
            if ([301, 302, 303].includes(response.status)) body = undefined;
        }
        throw new Error(`Startpage exceeded ${MAX_REDIRECTS} redirects`);
    }

    private async executeSearchRequest(postData: URLSearchParams): Promise<AxiosResponse<string>> {
        let response = await this.requestWithRedirects(postData);
        let solved = false;
        let submittedInterstitial = false;
        for (let stage = 0; stage < 3; stage++) {
            const html = String(response.data ?? '');
            if (isHardCaptchaPage(html)) throw new Error('Startpage blocked by hard CAPTCHA');
            const challenge = extractAnubisChallenge(html);
            if (challenge) {
                if (solved) throw new Error('Startpage Anubis challenge was not cleared after verification');
                solved = true;
                const started = performance.now();
                const { nonce, hash } = await solveAnubisChallenge(challenge.challenge, challenge.difficulty);
                const verifyUrl = new URL(challenge.id
                    ? `${STARTPAGE_BASE_URL}/.within.website/x/cmd/anubis/api/pass-challenge`
                    : STARTPAGE_ANUBIS_VERIFY_URL);
                verifyUrl.searchParams.set('nonce', String(nonce));
                if (challenge.id) {
                    verifyUrl.searchParams.set('id', challenge.id);
                    verifyUrl.searchParams.set('response', hash);
                    verifyUrl.searchParams.set('redir', STARTPAGE_SEARCH_URL);
                    verifyUrl.searchParams.set('elapsedTime', String(Math.round(performance.now() - started)));
                }
                // Replay the POST after verification, preserving the query across its redirect.
                await this.request(verifyUrl.href);
                response = await this.requestWithRedirects(postData);
                continue;
            }
            const payload = extractInterstitialPayload(html);
            if (payload) {
                if (submittedInterstitial) throw new Error('Startpage search interstitial was not cleared');
                submittedInterstitial = true;
                response = await this.requestWithRedirects(payload);
                continue;
            }
            return response;
        }
        throw new Error('Startpage verification did not return a search results page');
    }

    public async search(query: string, limit: number = DEFAULT_PAGE_SIZE): Promise<SearchResult[]> {
        const cleanQuery = query.trim();
        if (!cleanQuery || !Number.isFinite(limit) || limit < 1) return [];
        // Anubis stores the pending query in session cookies, so searches sharing
        // this session must not overwrite each other's challenge or return URL.
        const pending = this.pendingSearch.then(() => this.searchPages(cleanQuery, Math.floor(limit)));
        this.pendingSearch = pending.then(() => undefined, () => {
            // A failed challenge must not replay its query in the next search.
            this.cookies.clear();
        });
        return pending;
    }

    private async searchPages(cleanQuery: string, limit: number): Promise<SearchResult[]> {
        const allResults: SearchResult[] = [];
        const seenUrls = new Set<string>();
        const maxPage = Math.ceil(limit / DEFAULT_PAGE_SIZE);
        for (let page = 1; page <= maxPage && allResults.length < limit; page++) {
            const postData = new URLSearchParams({ query: cleanQuery, cat: 'web', cmd: 'process_search' });
            if (page > 1) {
                postData.set('page', String(page));
                postData.set('segment', 'startpage.udog');
            }
            const response = await this.executeSearchRequest(postData);
            const pageResults = parseStartpageSearchResults(String(response.data ?? ''));
            for (const item of pageResults) {
                if (seenUrls.has(item.url)) continue;
                seenUrls.add(item.url);
                allResults.push(item);
            }
            if (pageResults.length === 0) break;
        }
        return allResults.slice(0, limit);
    }
}

let defaultEngineInstance: StartpageEngine | null = null;

export function __setStartpageEngineForTests(engine: StartpageEngine | null): void {
    defaultEngineInstance = engine;
}

export async function searchStartpage(query: string, limit: number = DEFAULT_PAGE_SIZE): Promise<SearchResult[]> {
    defaultEngineInstance ??= new StartpageEngine();
    return defaultEngineInstance.search(query, limit);
}
