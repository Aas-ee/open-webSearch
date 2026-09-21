import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import {
    __setStartpageBrowserOpenerForTests,
    __setStartpageHttpGetForTests,
    __setStartpageHttpPostForTests,
    __setStartpagePlaywrightSearchForTests,
    extractStartpageScCode,
    isStartpageBlockedPage,
    isStartpageChallengePage,
    isStartpageChallengeRedirect,
    parseStartpageSearchResults,
    searchStartpage
} from '../engines/startpage/index.js';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function makeResponse(status: number, headers: Record<string, string | string[]>, data: string): AxiosResponse {
    return {
        status,
        statusText: String(status),
        headers,
        data,
        config: {} as AxiosResponse['config']
    };
}

const serpBootstrapPayload = {
    render: {
        search_sc: 'server-sc-token',
        callback_sc: 'server-sc-token',
        presenter: {
            regions: {
                mainline: [
                    {
                        display_type: 'ads-google-top',
                        results: [{ title: 'Ad', clickUrl: 'https://ads.example.com' }]
                    },
                    {
                        display_type: 'web-google',
                        presented_count: 2,
                        results: [
                            {
                                title: '<b>Weather</b> - NEA',
                                clickUrl: 'https://www.nea.gov.sg/corporate-functions/weather',
                                description: 'Warnings &amp; Advisories',
                                displayUrl: 'https://www.nea.gov.sg/corporate-functions/weather'
                            },
                            {
                                title: 'BBC Weather',
                                clickUrl: 'https://www.bbc.com/weather',
                                description: 'Forecast',
                                displayUrl: 'www.bbc.com/weather'
                            }
                        ]
                    }
                ]
            }
        }
    }
};

const serpBootstrapHtml = `
<html>
  <head><title>Startpage Search Results</title></head>
  <body>
    <script>
      React.createElement(UIStartpage.AppSerpWeb, ${JSON.stringify(serpBootstrapPayload)})
    </script>
  </body>
</html>
`;

const interstitialHtml = `
<html>
  <body>
    <script>var data = {"query":"weather","sgt":"interstitial-token"};</script>
  </body>
</html>
`;

function testDetectsBlockedPage(): void {
    assert(
        isStartpageBlockedPage('<html><title>Access Denied - Startpage</title><body>blocked=true</body></html>'),
        'Startpage Access Denied page should be detected'
    );
    assert(
        !isStartpageBlockedPage('<html><title>Startpage</title><body><form action="/sp/search"><input name="sc" value="token"></form></body></html>'),
        'normal Startpage homepage should not be treated as blocked'
    );
    assert(
        !isStartpageBlockedPage('<script id="anubis_challenge" type="application/json">{}</script>'),
        'anubis challenge is verification, not a CDN blocked page'
    );
    console.log('✅ detect Startpage blocked page');
}

function testExtractsTokenFromSupportedForms(): void {
    const html = '<form action="/sp/search?source=homepage"><input name="sc" value=" token-123 "></form>';
    assertEqual(extractStartpageScCode(html), 'token-123', 'Startpage search token should be extracted from a search form');
    assertEqual(extractStartpageScCode(serpBootstrapHtml), 'server-sc-token', 'Startpage search token should be extracted from AppSerpWeb bootstrap');
    console.log('✅ extract Startpage search token');
}

function testParsesBootstrapResults(): void {
    const results = parseStartpageSearchResults(serpBootstrapHtml);
    assertEqual(results.length, 2, 'parsed result count');
    assertEqual(results[0].title, 'Weather - NEA', 'first title should strip html');
    assertEqual(results[0].url, 'https://www.nea.gov.sg/corporate-functions/weather', 'first url');
    assertEqual(results[0].description, 'Warnings & Advisories', 'first description should decode entities');
    assertEqual(results[0].source, 'www.nea.gov.sg', 'first source');
    assertEqual(results[0].engine, 'startpage', 'first engine');
    assertEqual(results[1].title, 'BBC Weather', 'second title');
    assertEqual(results[1].url, 'https://www.bbc.com/weather', 'second url');
    assertEqual(results[1].source, 'www.bbc.com', 'scheme-less display URL should fall back to click URL hostname');

    const resultWithWeakChallengeWords = serpBootstrapHtml.replace(
        'Warnings &amp; Advisories',
        'security check details; blocked=true is part of the snippet'
    );
    const noisyResults = parseStartpageSearchResults(resultWithWeakChallengeWords);
    assertEqual(noisyResults.length, 2, 'weak challenge words inside valid results should not block parsing');
    console.log('✅ parse Startpage bootstrap results');
}

function testParsesLegacyDomResults(): void {
    const html = `
      <html><title>Startpage Search Results</title>
      <a class="result-title result-link" href="https://example.com/page"><h2>Legacy Title</h2></a>
      <p class="description">Legacy snippet</p>
      </html>
    `;
    const results = parseStartpageSearchResults(html);
    assertEqual(results.length, 1, 'legacy result count');
    assertEqual(results[0].title, 'Legacy Title', 'legacy title');
    assertEqual(results[0].url, 'https://example.com/page', 'legacy url');
    console.log('✅ parse Startpage legacy DOM results');
}

function testChallengeDetection(): void {
    assert(isStartpageChallengePage('<script src="/.within.website/x/cmd/anubis/static/js/worker/sha256-webcrypto.mjs"></script>'), 'anubis worker should be a challenge');
    assert(isStartpageChallengeRedirect('https://www.startpage.com/.within.website/x/cmd/anubis/api/pass-challenge?id=abc'), 'anubis pass-challenge redirect should be detected');
    assert(!isStartpageChallengeRedirect('https://www.startpage.com/sp/search?query=verify'), 'challenge words in query parameters should not trigger redirect detection');
    assert(!isStartpageChallengeRedirect('https://example.com/anubis/api/pass-challenge'), 'challenge paths on untrusted hosts should not be classified as Startpage challenges');

    let threw = false;
    try {
        parseStartpageSearchResults('<html><title>Making sure you are not a bot</title><script id="anubis_challenge"></script></html>');
    } catch (error) {
        threw = error instanceof Error && error.message.includes('verification');
    }
    assert(threw, 'Startpage challenge page should throw a verification error');
    console.log('✅ detect Startpage verification page');
}

async function testSearchStartpageHttp(): Promise<void> {
    __setStartpageHttpGetForTests(async (url: string, _options: AxiosRequestConfig) => {
        assert(url.includes('/sp/search?query=weather'), `search url should be GET /sp/search, got ${url}`);
        return makeResponse(200, {}, serpBootstrapHtml);
    });

    try {
        const results = await searchStartpage('weather', 5, { searchMode: 'request' });
        assertEqual(results.length, 2, 'http search result count');
        assertEqual(results[0].title, 'Weather - NEA', 'http search first title');
    } finally {
        __setStartpageHttpGetForTests();
    }

    console.log('✅ Startpage HTTP search uses GET /sp/search and bootstrap JSON');
}

async function testSearchStartpageDetectsChallengeRedirect(): Promise<void> {
    __setStartpageHttpGetForTests(async () => makeResponse(
        302,
        { location: 'https://www.startpage.com/.within.website/x/cmd/anubis/api/pass-challenge?id=abc' },
        ''
    ));

    try {
        let threw = false;
        try {
            await searchStartpage('weather', 5, { searchMode: 'request' });
        } catch (error) {
            threw = error instanceof Error && error.message.includes('verification');
        }
        assert(threw, 'Startpage Anubis redirect should throw a verification error');
    } finally {
        __setStartpageHttpGetForTests();
    }

    console.log('✅ detect Startpage Anubis redirect');
}

async function testSearchStartpageRejectsHttpDowngrade(): Promise<void> {
    __setStartpageHttpGetForTests(async () => makeResponse(
        302,
        { location: 'http://www.startpage.com/sp/search?query=weather' },
        ''
    ));

    try {
        let threw = false;
        try {
            await searchStartpage('weather', 5, { searchMode: 'request' });
        } catch (error) {
            threw = error instanceof Error && error.message.includes('insecure HTTP');
        }
        assert(threw, 'Startpage HTTPS-to-HTTP redirect should be rejected');
    } finally {
        __setStartpageHttpGetForTests();
    }

    console.log('✅ reject Startpage HTTPS downgrade');
}

async function testInterstitialPostCarriesCookies(): Promise<void> {
    let getCalls = 0;
    let redirectedGetCookie: unknown;
    let postCookie: unknown;
    __setStartpageHttpGetForTests(async (_url: string, options: AxiosRequestConfig) => {
        getCalls += 1;
        if (getCalls === 1) {
            return makeResponse(
                302,
                {
                    location: 'https://www.startpage.com/sp/search?query=weather&segment=redirected',
                    'set-cookie': ['session=old; Path=/']
                },
                ''
            );
        }

        redirectedGetCookie = (options.headers as Record<string, unknown> | undefined)?.Cookie;
        return makeResponse(
            200,
            { 'set-cookie': ['session=abc; Path=/', 'gate=1; Path=/'] },
            interstitialHtml
        );
    });
    __setStartpageHttpPostForTests(async (_url: string, _data: string, options: AxiosRequestConfig) => {
        postCookie = (options.headers as Record<string, unknown> | undefined)?.Cookie;
        return makeResponse(200, {}, serpBootstrapHtml);
    });

    try {
        const results = await searchStartpage('weather', 5, { searchMode: 'request' });
        assertEqual(results.length, 2, 'interstitial POST result count');
        assertEqual(redirectedGetCookie, 'session=old', 'redirected GET should carry earlier response cookies');
        assertEqual(postCookie, 'session=abc; gate=1', 'interstitial POST should carry merged GET and redirect cookies');
    } finally {
        __setStartpageHttpGetForTests();
        __setStartpageHttpPostForTests();
    }

    console.log('✅ carry Startpage interstitial cookies into POST');
}

async function testAutoFallsBackOnceOnEmptyHttpResults(): Promise<void> {
    let httpCalls = 0;
    let probeCalls = 0;
    let probeReleaseCalls = 0;
    let playwrightCalls = 0;
    __setStartpageHttpGetForTests(async () => {
        httpCalls += 1;
        return makeResponse(200, {}, '<html><title>Startpage</title><body>No results</body></html>');
    });
    __setStartpagePlaywrightSearchForTests(async () => {
        playwrightCalls += 1;
        return [
            {
                title: 'Browser result',
                url: 'https://browser.example.com/result',
                description: '',
                source: 'browser.example.com',
                engine: 'startpage'
            }
        ];
    });
    __setStartpageBrowserOpenerForTests(async (options) => {
        probeCalls += 1;
        assert(options?.antiBot === true, 'Startpage availability probe should request anti-bot browser mode');
        return {
            browser: {},
            release: async () => {
                probeReleaseCalls += 1;
            }
        };
    });

    try {
        const results = await searchStartpage('weather', 5, { searchMode: 'auto' });
        assertEqual(httpCalls, 1, 'auto mode should make one HTTP search attempt for empty results');
        assertEqual(probeCalls, 1, 'auto mode should probe browser availability once');
        assertEqual(probeReleaseCalls, 1, 'successful browser availability probe should release its session');
        assertEqual(playwrightCalls, 1, 'auto mode should make one Playwright fallback attempt for empty results');
        assertEqual(results.length, 1, 'auto mode should return Playwright fallback results');
    } finally {
        __setStartpageHttpGetForTests();
        __setStartpagePlaywrightSearchForTests();
        __setStartpageBrowserOpenerForTests();
    }

    console.log('✅ auto mode falls back once when HTTP returns no results');
}

async function testAutoStopsAfterEmptyPlaywrightFallback(): Promise<void> {
    let httpCalls = 0;
    let playwrightCalls = 0;
    __setStartpageHttpGetForTests(async () => {
        httpCalls += 1;
        return makeResponse(200, {}, '<html><title>Startpage</title><body>No results</body></html>');
    });
    __setStartpagePlaywrightSearchForTests(async () => {
        playwrightCalls += 1;
        return [];
    });
    __setStartpageBrowserOpenerForTests(async () => ({
        browser: {},
        release: async () => undefined
    }));

    try {
        const results = await searchStartpage('unlikely-result-query', 5, { searchMode: 'auto' });
        assertEqual(results.length, 0, 'genuine no-result search should remain empty after fallback');
        assertEqual(httpCalls, 1, 'genuine no-result search should not repeat HTTP requests');
        assertEqual(playwrightCalls, 1, 'genuine no-result search should not repeat Playwright fallback');
    } finally {
        __setStartpageHttpGetForTests();
        __setStartpagePlaywrightSearchForTests();
        __setStartpageBrowserOpenerForTests();
    }

    console.log('✅ auto mode stops after one empty Playwright fallback');
}

async function testAutoDoesNotRetryFailedPlaywrightFallback(): Promise<void> {
    let httpCalls = 0;
    let playwrightCalls = 0;
    __setStartpageHttpGetForTests(async () => {
        httpCalls += 1;
        return makeResponse(200, {}, '<html><title>Startpage</title><body>No results</body></html>');
    });
    __setStartpagePlaywrightSearchForTests(async () => {
        playwrightCalls += 1;
        throw new Error('synthetic Playwright failure');
    });
    __setStartpageBrowserOpenerForTests(async () => ({
        browser: {},
        release: async () => undefined
    }));

    try {
        let threw = false;
        try {
            await searchStartpage('unlikely-result-query', 5, { searchMode: 'auto' });
        } catch (error) {
            threw = error instanceof Error && error.message.includes('synthetic Playwright failure');
        }
        assert(threw, 'failed Playwright fallback should surface its original error');
        assertEqual(httpCalls, 1, 'failed Playwright fallback should not repeat HTTP search');
        assertEqual(playwrightCalls, 1, 'failed Playwright fallback should not be retried');
    } finally {
        __setStartpageHttpGetForTests();
        __setStartpagePlaywrightSearchForTests();
        __setStartpageBrowserOpenerForTests();
    }

    console.log('✅ auto mode does not retry a failed Playwright fallback');
}

async function testAutoRetriesFailedAvailabilityProbeAndPreservesHttpError(): Promise<void> {
    let httpCalls = 0;
    let probeCalls = 0;
    let playwrightCalls = 0;
    __setStartpageHttpGetForTests(async () => {
        httpCalls += 1;
        throw new Error('original Startpage HTTP failure');
    });
    __setStartpagePlaywrightSearchForTests(async () => {
        playwrightCalls += 1;
        return [];
    });
    __setStartpageBrowserOpenerForTests(async () => {
        probeCalls += 1;
        throw new Error('synthetic browser probe failure');
    });

    try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            let message = '';
            try {
                await searchStartpage('weather', 5, { searchMode: 'auto' });
            } catch (error) {
                message = error instanceof Error ? error.message : String(error);
            }
            assertEqual(message, 'original Startpage HTTP failure', 'unavailable fallback should preserve original HTTP error');
        }

        assertEqual(httpCalls, 2, 'each search should make one HTTP attempt');
        assertEqual(probeCalls, 2, 'failed availability probe should be retried on the next search');
        assertEqual(playwrightCalls, 0, 'failed availability probe should prevent Playwright search fallback');
    } finally {
        __setStartpageHttpGetForTests();
        __setStartpagePlaywrightSearchForTests();
        __setStartpageBrowserOpenerForTests();
    }

    console.log('✅ failed browser availability probe is retried and preserves HTTP error');
}

async function main(): Promise<void> {
    testDetectsBlockedPage();
    testExtractsTokenFromSupportedForms();
    testParsesBootstrapResults();
    testParsesLegacyDomResults();
    testChallengeDetection();
    await testSearchStartpageHttp();
    await testSearchStartpageDetectsChallengeRedirect();
    await testSearchStartpageRejectsHttpDowngrade();
    await testInterstitialPostCarriesCookies();
    await testAutoFallsBackOnceOnEmptyHttpResults();
    await testAutoStopsAfterEmptyPlaywrightFallback();
    await testAutoDoesNotRetryFailedPlaywrightFallback();
    await testAutoRetriesFailedAvailabilityProbeAndPreservesHttpError();
    console.log('\nStartpage logic tests passed.');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
