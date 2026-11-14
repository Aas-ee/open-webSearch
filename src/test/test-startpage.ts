import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import {
    StartpageEngine,
    searchStartpage,
    solveAnubisChallenge,
    extractAnubisChallenge,
    isHardCaptchaPage,
    parseStartpageSearchResults,
    __setStartpageEngineForTests
} from '../engines/startpage/index.js';

const BASE = 'https://www.startpage.com';
const SEARCH = `${BASE}/sp/search`;
type Request = InternalAxiosRequestConfig;
type Reply = { data?: string; status?: number; headers?: AxiosResponse['headers'] };

function mockEngine(handler: (request: Request, index: number) => Reply) {
    const requests: Request[] = [];
    const client = axios.create({
        adapter: async (config): Promise<AxiosResponse> => {
            requests.push(config);
            assert.equal(config.maxRedirects, 0, 'automatic redirects must remain disabled');
            const reply = handler(config, requests.length - 1);
            return { status: reply.status ?? 200, statusText: 'Mock', headers: reply.headers ?? {}, data: reply.data ?? '', config };
        }
    });
    return { engine: new StartpageEngine(client), requests };
}

function resultsHtml(start: number = 0, count: number = 1): string {
    return Array.from({ length: count }, (_, index) => {
        const n = start + index;
        return `<div class="result">
          <a class="favicon-link" href="https://preview.example/${n}">Preview</a>
          <a class="result-title result-link" href="https://example.com/${n}"><h2 class="wgl-title"> Result ${n} </h2></a>
          <p class="description"> Description for result ${n}. </p>
        </div>`;
    }).join('');
}

function challengeHtml(modern: boolean = true): string {
    const challenge = modern
        ? { rules: { algorithm: 'fast', difficulty: 2 }, challenge: { id: 'challenge-id', randomData: 'pow_mock_seed', difficulty: 6 } }
        : { challenge: 'pow_mock_seed', difficulty: 2 };
    return `<script id="anubis_challenge" type="application/json">${JSON.stringify(challenge)}</script>`;
}

test('PoW returns a valid SHA-256 proof, including zero difficulty', async () => {
    const { nonce, hash } = await solveAnubisChallenge('test_challenge_anubis_123', 3);
    assert.equal(hash, createHash('sha256').update(`test_challenge_anubis_123${nonce}`).digest('hex'));
    assert.ok(hash.startsWith('000'));
    assert.equal((await solveAnubisChallenge('zero', 0)).nonce, 0);
});

test('PoW rejects invalid difficulty and yields to the event loop before its deadline', async () => {
    for (const difficulty of [-1, 1.5, 65, NaN, Infinity]) {
        await assert.rejects(solveAnubisChallenge('seed', difficulty), /Invalid/);
    }
    let yielded = false;
    const timer = setTimeout(() => { yielded = true; }, 0);
    try {
        await assert.rejects(solveAnubisChallenge('bounded-work', 64, 25), /time budget/);
        assert.ok(yielded, 'other requests must be able to run while solving');
    } finally {
        clearTimeout(timer);
    }
});

test('extract modern Anubis randomData, id and rules difficulty', () => {
    assert.deepEqual(extractAnubisChallenge(challengeHtml()), { challenge: 'pow_mock_seed', difficulty: 2, id: 'challenge-id' });
});

test('extract legacy challenge JSON and Anubis assignment', () => {
    assert.deepEqual(extractAnubisChallenge(challengeHtml(false)), { challenge: 'pow_mock_seed', difficulty: 2, id: undefined });
    assert.equal(extractAnubisChallenge('<script>window.anubis = {"challenge":"seed","difficulty":0};</script>')?.difficulty, 0);
    assert.equal(extractAnubisChallenge('<p>No challenge here</p>'), null);
    assert.equal(extractAnubisChallenge('<script>var result = {"challenge":"ordinary content","difficulty":3};</script>'), null);
});

test('malformed, unsupported and incomplete Anubis challenges fail explicitly', () => {
    for (const json of [
        '{bad json',
        '{"challenge":{"id":"id"},"rules":{"difficulty":2}}',
        '{"challenge":"seed","difficulty":-1}',
        '{"challenge":"seed","difficulty":1.5}',
        '{"challenge":"seed","difficulty":100}',
        '{"challenge":"seed","rules":{"algorithm":"unknown"}}'
    ]) {
        assert.throws(() => extractAnubisChallenge(`<script id="anubis_challenge">${json}</script>`), /Invalid|Unsupported/);
    }
});

test('parse current div.result cards using the title URL instead of the first link', () => {
    assert.deepEqual(parseStartpageSearchResults(resultsHtml())[0], {
        title: 'Result 0', url: 'https://example.com/0', description: 'Description for result 0.', source: 'example.com', engine: 'startpage'
    });
});

test('parse modern and legacy layouts together in document order, deduplicating URLs', () => {
    const html = `<div class="w-gl__result">
      <h3 class="w-gl__result-title"> Modern   title </h3>
      <a class="result-link" href="https://docs.example.org/guide">Visit</a>
      <span class="w-gl__description"> Modern   description </span>
    </div>
    <a class="result-title result-link" href="https://legacy.example.com"><h2>Legacy</h2></a><p class="description">Legacy description</p>
    ${resultsHtml()}${resultsHtml()}`;
    const results = parseStartpageSearchResults(html);
    assert.deepEqual(results.map(result => result.title), ['Modern title', 'Legacy', 'Result 0']);
    assert.equal(results[0].description, 'Modern description');
    assert.equal(results[1].url, 'https://legacy.example.com/');
    assert.equal(results[1].description, 'Legacy description');
});

test('discard invalid and non-HTTP result links and normalize relative links', () => {
    const links = ['javascript:alert(1)', 'data:text/plain,hello', '#fragment', 'https://', 'https://user:password@example.com', '', '/relative'];
    const html = links.map((href) => `<div class="result"><a class="result-link" href="${href}"><h2>Title</h2></a></div>`).join('');
    assert.deepEqual(parseStartpageSearchResults(html).map(result => result.url), [`${BASE}/relative`]);
});

test('discard hidden tracking cards and Startpage helper links', () => {
    const hidden = resultsHtml(1).replace('class="result"', 'class="result h"');
    const tracking = resultsHtml(2).replace('https://example.com/2', `${BASE}/clev?event=tracking`);
    const html = `${resultsHtml()}${hidden}${tracking}${resultsHtml(3).replace('class="result"', 'class="result" hidden')}`;
    assert.deepEqual(parseStartpageSearchResults(html).map(result => result.url), ['https://example.com/0']);
});

test('CAPTCHA and human-verification search snippets are valid results', () => {
    const html = `<title>CAPTCHA - Startpage</title>${resultsHtml().replace('Description for result 0.', 'CAPTCHA systems verify you are human; human verification explained.')}`;
    assert.equal(isHardCaptchaPage(html), false);
    assert.equal(parseStartpageSearchResults(html).length, 1);
});

test('detect actual CAPTCHA UI and verification pages', () => {
    for (const html of [
        '<form action="/sp/captcha">Robot check</form>',
        '<title>Security Check</title><p>Please verify you are human</p>',
        '<iframe src="https://captcha.example/widget"></iframe>',
        '<div class="g-recaptcha"></div>'
    ]) {
        assert.equal(isHardCaptchaPage(html), true);
        assert.throws(() => parseStartpageSearchResults(html), /hard CAPTCHA/);
    }
    assert.equal(isHardCaptchaPage(challengeHtml()), false);
});

for (const modern of [false, true]) {
    test(`${modern ? 'modern' : 'legacy'} Anubis flow verifies the proof and replays the POST with cookies`, async () => {
        const { engine, requests } = mockEngine((request, index) => {
            if (index === 0) return { data: challengeHtml(modern), headers: { 'set-cookie': ['challenge_cookie=initial; Path=/'] } };
            if (index === 1) {
                const url = new URL(request.url!);
                assert.equal(request.method, 'get');
                assert.equal(url.pathname, modern ? '/.within.website/x/cmd/anubis/api/pass-challenge' : '/anubis/verify');
                const nonce = url.searchParams.get('nonce');
                assert.ok(nonce);
                const hash = createHash('sha256').update(`pow_mock_seed${nonce}`).digest('hex');
                assert.ok(hash.startsWith('00'));
                assert.equal(request.headers.get('Cookie'), 'challenge_cookie=initial');
                if (modern) {
                    assert.equal(url.searchParams.get('id'), 'challenge-id');
                    assert.equal(url.searchParams.get('response'), hash);
                    assert.equal(url.searchParams.get('redir'), SEARCH);
                    assert.ok(Number(url.searchParams.get('elapsedTime')) >= 0);
                }
                return { status: 302, headers: { location: '/sp/search', 'set-cookie': ['anubis_token=verified; Path=/; HttpOnly'] } };
            }
            assert.equal(request.method, 'post');
            assert.equal(request.data, requests[0].data);
            assert.match(String(request.headers.get('Cookie')), /anubis_token=verified/);
            return { data: resultsHtml() };
        });
        assert.equal((await engine.search('open-websearch', 3)).length, 1);
        assert.equal(requests.length, 3);
    });
}

test('solve a challenge reached after multiple redirects and keep cookies on each hop', async () => {
    const { engine, requests } = mockEngine((request, index) => {
        if (index === 0) return { status: 302, headers: { location: '/challenge/step', 'set-cookie': ['session=one; Path=/'] } };
        if (index === 1) {
            assert.equal(request.url, `${BASE}/challenge/step`);
            assert.equal(request.method, 'get');
            assert.equal(request.headers.get('Cookie'), 'session=one');
            return { status: 302, headers: { location: 'next' } };
        }
        if (index === 2) {
            assert.equal(request.url, `${BASE}/challenge/next`);
            return { data: challengeHtml() };
        }
        if (index === 3) return { headers: { 'set-cookie': ['anubis_token=verified; Path=/'] } };
        assert.equal(request.method, 'post');
        return { data: resultsHtml() };
    });
    assert.equal((await engine.search('query', 1)).length, 1);
    assert.equal(requests.length, 5);
});

for (const status of [307, 308]) {
    test(`${status} redirects retain the POST body`, async () => {
        const { engine, requests } = mockEngine((request, index) => {
            if (index === 0) return { status, headers: { location: '/sp/results' } };
            assert.equal(request.method, 'post');
            assert.equal(request.data, requests[0].data);
            return { data: resultsHtml() };
        });
        assert.equal((await engine.search('query', 1)).length, 1);
    });
}

test('reject off-origin, private, credentialed and insecure redirects before sending cookies', async () => {
    for (const location of ['https://evil.example/steal', 'http://127.0.0.1/private', '//evil.example/path', 'http://www.startpage.com/sp/search', 'https://user:password@www.startpage.com/sp/search']) {
        const { engine, requests } = mockEngine(() => ({ status: 302, headers: { location, 'set-cookie': ['token=private; Path=/'] } }));
        await assert.rejects(engine.search('query', 1), /trusted HTTPS origin/);
        assert.equal(requests.length, 1);
    }
});

test('reject CAPTCHA redirects, redirect loops and redirects without a location', async () => {
    for (const [reply, message, count] of [
        [{ status: 302, headers: { location: '/sp/captcha' } }, /hard CAPTCHA/, 1],
        [{ status: 302, headers: { location: '/loop' } }, /exceeded 5 redirects/, 6],
        [{ status: 302 }, /missing its location/, 1]
    ] as const) {
        const { engine, requests } = mockEngine(() => reply);
        await assert.rejects(engine.search('query', 1), message);
        assert.equal(requests.length, count);
    }
});

test('a repeated Anubis challenge is an error rather than a successful empty search', async () => {
    const { engine, requests } = mockEngine((_, index) => ({ data: index === 1 ? '' : challengeHtml() }));
    await assert.rejects(engine.search('query', 1), /not cleared/);
    assert.equal(requests.length, 3);
});

test('preserve the legacy search interstitial flow', async () => {
    const { engine, requests } = mockEngine((request, index) => {
        if (index === 0) return { data: '<script>var data = {"query":"query","sgt":"token","cat":"web","ignored":42};</script>' };
        const body = new URLSearchParams(request.data);
        assert.equal(body.get('query'), 'query');
        assert.equal(body.get('sgt'), 'token');
        assert.equal(body.has('ignored'), false);
        return { data: resultsHtml() };
    });
    assert.equal((await engine.search('query', 1)).length, 1);
    assert.equal(requests.length, 2);
});

test('cookies respect domain, path and expiry, including deletion', async () => {
    const { engine } = mockEngine((request, index) => {
        if (index === 0) return {
            status: 302,
            headers: {
                location: '/sp/results',
                'set-cookie': ['session=live; Path=/; Domain=.startpage.com', 'old=expired; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'other=wrong; Domain=evil.example; Path=/', 'scoped=private; Path=/admin', 'remove=temporary; Path=/']
            }
        };
        if (index === 1) {
            assert.equal(request.headers.get('Cookie'), 'session=live; remove=temporary');
            return { status: 302, headers: { location: '/sp/final', 'set-cookie': ['remove=; Path=/; Max-Age=0'] } };
        }
        assert.equal(request.headers.get('Cookie'), 'session=live');
        return { data: resultsHtml() };
    });
    assert.equal((await engine.search('query', 1)).length, 1);
});

test('reuse the verified session across searches without another challenge', async () => {
    const { engine, requests } = mockEngine((request, index) => {
        if (index === 0) return { data: challengeHtml() };
        if (index === 1) return { headers: { 'set-cookie': ['anubis_token=verified; Path=/'] } };
        assert.equal(request.headers.get('Cookie'), 'anubis_token=verified');
        return { data: resultsHtml() };
    });
    await engine.search('first', 1);
    await engine.search('second', 1);
    assert.equal(requests.length, 4);
});

test('concurrent searches cannot overwrite a shared challenge session', async () => {
    let activeQuery: string | undefined;
    let verified = false;
    const { engine } = mockEngine((request) => {
        if (request.method === 'get') {
            verified = true;
            return {};
        }
        const query = new URLSearchParams(request.data).get('query')!;
        if (activeQuery === undefined) {
            activeQuery = query;
            verified = false;
            return { data: challengeHtml() };
        }
        assert.equal(query, activeQuery, 'another query must not replace the pending search');
        assert.ok(verified);
        activeQuery = undefined;
        return { data: resultsHtml(query === 'first' ? 1 : 2) };
    });
    const [first, second] = await Promise.all([engine.search('first', 1), engine.search('second', 1)]);
    assert.equal(first[0].url, 'https://example.com/1');
    assert.equal(second[0].url, 'https://example.com/2');
});

test('a failed challenge clears pending cookies before the next queued search', async () => {
    const { engine } = mockEngine((request, index) => {
        if (index === 0) return { data: challengeHtml(), headers: { 'set-cookie': ['sp_return=stale-query; Path=/'] } };
        if (index === 1) throw new Error('Verification unavailable');
        assert.equal(new URLSearchParams(request.data).get('query'), 'second');
        assert.equal(request.headers.get('Cookie'), undefined);
        return { data: resultsHtml(2) };
    });
    const first = engine.search('first', 1);
    const second = engine.search('second', 1);
    await assert.rejects(first, /Verification unavailable/);
    assert.equal((await second)[0].url, 'https://example.com/2');
});

test('pagination preserves the query, page and segment, deduplicating across pages', async () => {
    const { engine, requests } = mockEngine((request, index) => {
        const body = new URLSearchParams(request.data);
        assert.equal(body.get('query'), '中文 TypeScript');
        assert.equal(body.get('cmd'), 'process_search');
        if (index === 0) {
            assert.equal(body.has('page'), false);
            return { data: resultsHtml(0, 10) };
        }
        assert.equal(body.get('page'), '2');
        assert.equal(body.get('segment'), 'startpage.udog');
        return { data: resultsHtml(9, 10) };
    });
    const results = await engine.search(' 中文 TypeScript ', 15);
    assert.equal(results.length, 15);
    assert.equal(new Set(results.map(result => result.url)).size, 15);
    assert.equal(requests.length, 2);
});

test('an empty result page stops pagination', async () => {
    const { engine, requests } = mockEngine(() => ({ data: '<title>Startpage Search Results</title><p>No results</p>' }));
    assert.deepEqual(await engine.search('query', 20), []);
    assert.equal(requests.length, 1);
});

test('public search wrapper uses the engine and empty queries or limits make no requests', async () => {
    const { engine, requests } = mockEngine(() => ({ data: resultsHtml() }));
    __setStartpageEngineForTests(engine);
    try {
        assert.deepEqual(await searchStartpage('  ', 10), []);
        assert.deepEqual(await searchStartpage('query', 0), []);
        assert.deepEqual(await searchStartpage('query', Infinity), []);
        assert.equal(requests.length, 0);
        assert.equal((await searchStartpage('query', 1)).length, 1);
    } finally {
        __setStartpageEngineForTests(null);
    }
});

test('live Startpage search returns valid, unique results', { skip: process.env.LIVE_TEST !== '1', timeout: 120000 }, async () => {
    const started = performance.now();
    const results = await searchStartpage('open-websearch', 3);
    assert.ok(results.length > 0, 'live search must return results');
    assert.ok(results.length <= 3);
    assert.equal(new Set(results.map(result => result.url)).size, results.length);
    for (const result of results) {
        assert.ok(result.title.trim());
        assert.ok(['http:', 'https:'].includes(new URL(result.url).protocol));
        assert.equal(result.source, new URL(result.url).hostname);
        assert.equal(result.engine, 'startpage');
    }
    console.log(`Live Startpage: ${results.length} results in ${Math.round(performance.now() - started)}ms`);
    console.log(JSON.stringify(results, null, 2));
});
