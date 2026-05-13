import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { __setSogouHttpGetForTests, parseSogouSearchResults, searchSogou } from '../engines/sogou/index.js';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
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

function testParseSogouResults(): void {
    const html = `
        <html>
          <body>
            <div id="main">
              <div class="vrwrap">
                <h3 class="vr-title">
                  <a href="https://example.com/open-websearch"> Open-WebSearch </a>
                </h3>
                <div class="str_info"> MCP server and CLI search demo. </div>
                <cite>example.com</cite>
              </div>
              <div class="vrwrap">
                <h3 class="vr-title">
                  <a href="/link?url=https%3A%2F%2Fdocs.example.com%2Fguide"> Docs Guide </a>
                </h3>
                <p> Project documentation and setup guide. </p>
              </div>
              <div class="vrwrap">
                <h3 class="vr-title">
                  <a href="https://example.com/open-websearch"> Duplicate </a>
                </h3>
                <div class="str_info">Duplicate should be skipped.</div>
              </div>
              <div class="vrwrap">
                <h3 class="vr-title"><a href=""> Missing URL </a></h3>
              </div>
              <div class="vrwrap">
                <h3 class="vr-title"><a href="javascript:void(0)"> Script URL </a></h3>
              </div>
            </div>
          </body>
        </html>
    `;

    const results = parseSogouSearchResults(html);

    assertEqual(results.length, 2, 'parsed result count');
    assertEqual(results[0].title, 'Open-WebSearch', 'first title');
    assertEqual(results[0].url, 'https://example.com/open-websearch', 'first url');
    assertEqual(results[0].description, 'MCP server and CLI search demo.', 'first description');
    assertEqual(results[0].source, 'example.com', 'first source');
    assertEqual(results[0].engine, 'sogou', 'first engine');
    assertEqual(results[1].title, 'Docs Guide', 'second title');
    assertEqual(results[1].url, 'https://docs.example.com/guide', 'decoded redirect url');
    assertEqual(results[1].source, 'docs.example.com', 'second source falls back to hostname');

    console.log('✅ parse Sogou HTML results');
}

function testSogouChallengeDetection(): void {
    let threw = false;
    try {
        parseSogouSearchResults('<html><title>搜狗搜索验证</title><body>请输入验证码</body></html>');
    } catch (error) {
        threw = error instanceof Error && error.message.includes('verification');
    }

    assert(threw, 'Sogou challenge page should throw a verification error');
    console.log('✅ detect Sogou verification page');
}

async function testSearchSogouFollowsRedirects(): Promise<void> {
    const requestedUrls: string[] = [];
    const requestedCookies: Array<string | undefined> = [];

    __setSogouHttpGetForTests(async (url: string, options: AxiosRequestConfig) => {
        requestedUrls.push(url);
        requestedCookies.push((options.headers as Record<string, string> | undefined)?.Cookie);

        if (requestedUrls.length === 1) {
            return makeResponse(
                302,
                {
                    location: '/web?query=%E5%8C%97%E4%BA%AC&page=1&ie=utf8',
                    'set-cookie': ['SNUID=test-cookie; path=/']
                },
                ''
            );
        }

        return makeResponse(
            200,
            {},
            `
                <div id="main">
                  <div class="vrwrap">
                    <h3 class="vr-title"><a href="https://example.com/beijing">Beijing</a></h3>
                    <div class="str_info">Capital city.</div>
                  </div>
                </div>
            `
        );
    });

    try {
        const results = await searchSogou('北京', 1);
        assertEqual(results.length, 1, 'redirect search result count');
        assertEqual(results[0].title, 'Beijing', 'redirect search result title');
        assertEqual(requestedUrls.length, 2, 'Sogou search should follow one redirect');
        assert(requestedUrls[0].startsWith('https://www.sogou.com/web?'), 'first request should use Sogou web endpoint');
        assertEqual(requestedCookies[1], 'SNUID=test-cookie', 'redirect request should carry Sogou cookie');
        console.log('✅ Sogou search follows safe redirects');
    } finally {
        __setSogouHttpGetForTests();
    }
}

async function main(): Promise<void> {
    testParseSogouResults();
    testSogouChallengeDetection();
    await testSearchSogouFollowsRedirects();
    console.log('\nSogou tests passed.');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
