import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { __setBaiduHttpGetForTests, parseBaiduSearchResults, searchBaidu } from '../engines/baidu/index.js';

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
        config: {} as AxiosResponse['config'],
    };
}

function testParseBaiduResults(): void {
    const html = `
        <html>
          <body>
            <div id="content_left">
              <div class="result c-container new-pmd">
                <h3><a href="http://www.baidu.com/link?url=first">First Result</a></h3>
                <div class="cos-row">First snippet.</div>
                <div class="cosc-source">example.com</div>
              </div>
              <div class="result c-container new-pmd">
                <h3><a href="http://www.baidu.com/link?url=second">Second Result</a></h3>
                <div class="cos-row">Second snippet.</div>
                <div class="cosc-source">docs.example.com</div>
              </div>
              <div class="result c-container new-pmd">
                <h3>No link here</h3>
              </div>
              <div class="result c-container new-pmd">
                <h3><a href="javascript:void(0)">Script link</a></h3>
              </div>
            </div>
          </body>
        </html>
    `;

    const results = parseBaiduSearchResults(html);

    assertEqual(results.length, 2, 'parsed result count');
    assertEqual(results[0].title, 'First Result', 'first title');
    assertEqual(results[0].url, 'http://www.baidu.com/link?url=first', 'first url');
    assertEqual(results[0].description, 'First snippet.', 'first description');
    assertEqual(results[0].source, 'example.com', 'first source');
    assertEqual(results[0].engine, 'baidu', 'first engine');
    assertEqual(results[1].title, 'Second Result', 'second title');

    console.log('✅ parse Baidu HTML results');
}

function testBaiduChallengePageDetection(): void {
    let threw = false;
    try {
        parseBaiduSearchResults('<html><title>百度安全验证</title><body>请输入验证码</body></html>');
    } catch (error) {
        threw = error instanceof Error && error.message.includes('verification');
    }

    assert(threw, 'Baidu challenge page should throw a verification error');
    console.log('✅ detect Baidu verification page');
}

async function testSearchBaiduDetectsCaptchaRedirect(): Promise<void> {
    __setBaiduHttpGetForTests(async () => makeResponse(
        302,
        { location: 'https://wappass.baidu.com/static/captcha/tuxing_v2.html?ak=abc' },
        '',
    ));

    try {
        await searchBaidu('test', 10);
        throw new Error('searchBaidu should throw on a captcha redirect');
    } catch (error) {
        assert(
            error instanceof Error && error.message.includes('verification'),
            'captcha redirect should surface a verification error',
        );
    } finally {
        __setBaiduHttpGetForTests();
    }

    console.log('✅ Baidu search surfaces captcha redirect');
}

async function testSearchBaiduParsesResults(): Promise<void> {
    const requestedUrls: string[] = [];
    __setBaiduHttpGetForTests(async (url: string, _options: AxiosRequestConfig) => {
        requestedUrls.push(url);
        return makeResponse(
            200,
            {},
            `
              <div id="content_left">
                <div class="result c-container new-pmd">
                  <h3><a href="http://www.baidu.com/link?url=hello">Hello</a></h3>
                  <div class="cos-row">Greeting snippet.</div>
                </div>
              </div>
            `,
        );
    });

    try {
        const results = await searchBaidu('你好', 5);
        assertEqual(results.length, 1, 'search result count');
        assertEqual(results[0].title, 'Hello', 'search result title');
        assert(requestedUrls.length === 1, 'Baidu search should make one request');
        assert(requestedUrls[0].startsWith('https://www.baidu.com/s?'), 'request should use Baidu search endpoint');
        assert(requestedUrls[0].includes('tn=88093251_62_hao_pg'), 'request should carry the stable hao123 tn');
        console.log('✅ Baidu search parses results and keeps the stable tn');
    } finally {
        __setBaiduHttpGetForTests();
    }
}

async function main(): Promise<void> {
    testParseBaiduResults();
    testBaiduChallengePageDetection();
    await testSearchBaiduDetectsCaptchaRedirect();
    await testSearchBaiduParsesResults();
    console.log('\nBaidu tests passed.');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
