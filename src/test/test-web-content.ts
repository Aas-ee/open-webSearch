import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { config } from '../config.js';
import { __setBrowserHtmlFetcherForTests, fetchWebContent } from '../engines/web/index.js';
import {
    __setBrowserCookieHeaderFetcherForTests,
    __setReadabilityParserForTests
} from '../engines/web/fetchWebContent.js';
import { __setAxiosRequestForTests } from '../utils/httpRequest.js';
import { __setDnsLookupForTests } from '../utils/urlSafety.js';

type TestCase = {
    name: string;
    run: () => Promise<void>;
};

const requestAttempts = new Map<string, number>();
const requestConfigs = new Map<string, any[]>();

function makeResponse(
    config: AxiosRequestConfig,
    response: {
        status?: number;
        headers?: Record<string, string>;
        data?: unknown;
        finalUrl?: string;
    }
): AxiosResponse {
    return {
        status: response.status ?? 200,
        statusText: '',
        headers: response.headers ?? {},
        data: response.data ?? '',
        config,
        request: { res: { responseUrl: response.finalUrl ?? config.url } }
    } as AxiosResponse;
}

function installAxiosMock(): void {
    requestAttempts.clear();
    requestConfigs.clear();

    // 修复测试桩覆盖不到 requestWithSafeRedirects 的问题：生产代码现在统一走 axios.request，
    // 因此测试也必须替换同一层入口，避免误打到真实网络造成 404 和不稳定失败。
    __setAxiosRequestForTests(async (config) => {
        const url = String(config.url || '');
        const method = String(config.method || 'GET').toUpperCase();
        const configs = requestConfigs.get(url) || [];
        configs.push({ method, options: config });
        requestConfigs.set(url, configs);

        if (method === 'HEAD') {
            if (url.endsWith('/too-large.md')) {
                return makeResponse(config, {
                    headers: { 'content-length': String(5 * 1024 * 1024) },
                    finalUrl: url
                });
            }
            if (url.endsWith('/long.md')) {
                return makeResponse(config, {
                    headers: { 'content-length': String(1024) },
                    finalUrl: url
                });
            }
            return makeResponse(config, { headers: {}, finalUrl: url });
        }

        if (method !== 'GET') {
            throw new Error(`Unexpected mocked method: ${method}`);
        }

        requestAttempts.set(url, (requestAttempts.get(url) || 0) + 1);

        if (url.endsWith('/skill.md')) {
            return makeResponse(config, {
                headers: { 'content-type': 'text/plain; charset=utf-8' },
                data: '# Skill Title\n\nThis is a markdown test document.',
                finalUrl: url
            });
        }

        if (url.endsWith('/page')) {
            return makeResponse(config, {
                headers: { 'content-type': 'text/html; charset=utf-8' },
                data: `
                <html>
                  <head><title>Skill Page</title></head>
                  <body>
                    <main>
                      <h1>Skill Page</h1>
                      <p>${'Skill body content '.repeat(12)}</p>
                    </main>
                  </body>
                </html>
                `,
                finalUrl: `${url}?from=test`
            });
        }

        if (url.endsWith('/long.md')) {
            return makeResponse(config, {
                headers: { 'content-type': 'text/markdown; charset=utf-8' },
                data: `# Long\n\n${'x'.repeat(6000)}`,
                finalUrl: url
            });
        }

        if (url.endsWith('/too-large.md')) {
            throw new Error('GET should not be called when HEAD indicates oversized response');
        }

        if (url.endsWith('/spa')) {
            return makeResponse(config, {
                headers: { 'content-type': 'text/html; charset=utf-8' },
                data: `
                <html>
                  <head>
                    <title>SPA Site</title>
                    <meta name="description" content="Rendered by JS runtime">
                  </head>
                  <body>
                    <div id="root"></div>
                  </body>
                </html>
                `,
                finalUrl: url
            });
        }

        if (url.endsWith('/browser-spa')) {
            return makeResponse(config, {
                headers: { 'content-type': 'text/html; charset=utf-8' },
                data: `
                <html>
                  <head>
                    <title>Browser SPA</title>
                    <meta name="description" content="JS bootstrap shell">
                  </head>
                  <body>
                    <div id="app"></div>
                  </body>
                </html>
                `,
                finalUrl: url
            });
        }

        if (url.endsWith('/blocked-browser-spa')) {
            return makeResponse(config, {
                status: 403,
                headers: { 'content-type': 'text/html; charset=utf-8' },
                data: '',
                finalUrl: url
            });
        }

        throw new Error(`Unexpected mocked URL: ${url}`);
    });
}

function restoreAxiosMock(): void {
    __setAxiosRequestForTests();
    __setBrowserHtmlFetcherForTests();
    __setBrowserCookieHeaderFetcherForTests();
}

function assert(condition: unknown, message: string): void {
    if (!condition) {
        throw new Error(message);
    }
}

async function runCase(testCase: TestCase): Promise<boolean> {
    try {
        await testCase.run();
        console.log(`✅ ${testCase.name}`);
        return true;
    } catch (error) {
        console.error(`❌ ${testCase.name}:`, error);
        return false;
    }
}

async function main(): Promise<void> {
    const originalFetchWebAllowInsecureTls = config.fetchWebAllowInsecureTls;
    installAxiosMock();
    __setDnsLookupForTests(async (hostname) => {
        if (hostname === 'example.com') {
            return [{ address: '93.184.216.34' }];
        }
        if (hostname === 'private-final.example') {
            return [{ address: '127.0.0.1' }];
        }
        throw new Error(`unexpected hostname: ${hostname}`);
    });
    config.fetchWebAllowInsecureTls = false;

    const testCases: TestCase[] = [
        {
            name: 'should parse markdown content by .md URL',
            run: async () => {
                const result = await fetchWebContent('https://example.com/skill.md', 5000);
                assert(result.title === '', 'markdown title should be empty');
                assert(result.content.includes('Skill Title'), 'markdown content should keep source text');
                assert(result.truncated === false, 'markdown should not be truncated');
            }
        },
        {
            name: 'should extract text and title from html page',
            run: async () => {
                const result = await fetchWebContent('https://example.com/page', 5000);
                assert(result.title === 'Skill Page', 'html title should be extracted');
                assert(result.retrievalMethod === 'request', 'plain html should use request mode');
                assert(result.finalUrl.endsWith('/page?from=test'), 'finalUrl should follow redirect target');
                assert(result.content.includes('Skill body content'), 'html content should be extracted');
                const configs = requestConfigs.get('https://example.com/page') || [];
                const firstConfig = configs[0]?.options;
                assert(firstConfig?.proxy === false, 'axios env proxy resolution should be disabled');
                assert(firstConfig?.httpsAgent, 'httpsAgent should always be configured for direct https requests');
            }
        },
        {
            name: 'should truncate long content when maxChars is small',
            run: async () => {
                const result = await fetchWebContent('https://example.com/long.md', 1200);
                assert(result.truncated === true, 'long content should be truncated');
                assert(result.content.includes('[...truncated '), 'truncation marker should exist');
            }
        },
        {
            name: 'should fallback to metadata for js-rendered html pages',
            run: async () => {
                __setBrowserHtmlFetcherForTests(async () => {
                    throw new Error('browser fallback disabled for metadata-only test');
                });
                const result = await fetchWebContent('https://example.com/spa', 5000);
                assert(result.title === 'SPA Site', 'title should be extracted from html');
                assert(result.retrievalMethod === 'request', 'metadata fallback should still report request mode');
                assert(result.content.includes('Rendered by JS runtime'), 'meta description fallback should be used');
            }
        },
        {
            name: 'should fallback to browser html when html only contains shell metadata',
            run: async () => {
                __setBrowserHtmlFetcherForTests(async () => ({
                    html: `
                    <html>
                      <head><title>Browser SPA</title></head>
                      <body>
                        <main>
                          <h1>Browser SPA</h1>
                          <p>${'Rendered browser content '.repeat(12)}</p>
                        </main>
                      </body>
                    </html>
                    `,
                    finalUrl: 'https://example.com/browser-spa?rendered=1',
                    title: 'Browser SPA'
                }));

                const result = await fetchWebContent('https://example.com/browser-spa', 5000);
                assert(result.title === 'Browser SPA', 'browser fallback title should be preserved');
                assert(result.retrievalMethod === 'browser-html', 'browser html fallback should be reported');
                assert(result.finalUrl.endsWith('rendered=1'), 'browser fallback finalUrl should be used');
                assert(result.content.includes('Rendered browser content'), 'browser html content should replace shell metadata');
            }
        },
        {
            name: 'auto mode should keep request metadata when browser fallback fails',
            run: async () => {
                let browserCalls = 0;
                __setBrowserHtmlFetcherForTests(async () => {
                    browserCalls += 1;
                    throw new Error('browser unavailable');
                });

                const result = await fetchWebContent('https://example.com/browser-spa', 5000, {
                    renderMode: 'auto'
                });
                assert(result.retrievalMethod === 'request', 'failed auto fallback should retain request retrieval');
                assert(result.content.includes('JS bootstrap shell'), 'failed auto fallback should retain request metadata');
                assert(browserCalls === 1, 'auto mode should attempt browser fallback exactly once');
            }
        },
        {
            name: 'request mode should never invoke browser fallback for shell html',
            run: async () => {
                let browserCalled = false;
                __setBrowserHtmlFetcherForTests(async () => {
                    browserCalled = true;
                    throw new Error('request mode must not use browser');
                });

                const result = await fetchWebContent('https://example.com/browser-spa', 5000, {
                    renderMode: 'request'
                });
                assert(result.retrievalMethod === 'request', 'request mode should report request retrieval');
                assert(result.content.includes('JS bootstrap shell'), 'request mode should preserve request metadata result');
                assert(browserCalled === false, 'request mode should not invoke browser fetcher');
            }
        },
        {
            name: 'request mode should not use browser assistance for blocked responses',
            run: async () => {
                let cookieCalled = false;
                let browserCalled = false;
                __setBrowserCookieHeaderFetcherForTests(async () => {
                    cookieCalled = true;
                    return 'session=unexpected';
                });
                __setBrowserHtmlFetcherForTests(async () => {
                    browserCalled = true;
                    throw new Error('request mode must not use browser');
                });

                let failed = false;
                try {
                    await fetchWebContent('https://example.com/blocked-browser-spa', 5000, {
                        renderMode: 'request'
                    });
                } catch {
                    failed = true;
                }
                assert(failed, 'request mode should surface the blocked request error');
                assert(cookieCalled === false, 'request mode should not request browser cookies');
                assert(browserCalled === false, 'request mode should not invoke browser html fallback');
            }
        },
        {
            name: 'browser mode should render directly without request traffic',
            run: async () => {
                __setBrowserHtmlFetcherForTests(async () => ({
                    html: `
                    <html>
                      <head><title>Direct Browser Page</title></head>
                      <body><main><p>${'Direct rendered content '.repeat(12)}</p></main></body>
                    </html>
                    `,
                    finalUrl: 'https://example.com/direct-browser?rendered=1',
                    title: 'Direct Browser Page'
                }));

                const requestsBefore = Array.from(requestConfigs.values()).reduce((sum, calls) => sum + calls.length, 0);
                const result = await fetchWebContent('https://example.com/direct-browser', 5000, {
                    renderMode: 'browser'
                });
                const requestsAfter = Array.from(requestConfigs.values()).reduce((sum, calls) => sum + calls.length, 0);

                assert(requestsAfter === requestsBefore, 'browser mode should not issue HEAD or GET requests');
                assert(result.retrievalMethod === 'browser-html', 'browser mode should report browser-html retrieval');
                assert(result.title === 'Direct Browser Page', 'browser mode should preserve rendered title');
                assert(result.finalUrl.endsWith('rendered=1'), 'browser mode should preserve final browser URL');
                assert(result.content.includes('Direct rendered content'), 'browser mode should extract rendered content');
            }
        },
        {
            name: 'browser mode should extract browser html for markdown-looking paths',
            run: async () => {
                __setBrowserHtmlFetcherForTests(async () => ({
                    html: `<html><head><title>Rendered Markdown Route</title></head><body><main><p>${'Rendered route body '.repeat(12)}</p></main></body></html>`,
                    finalUrl: 'https://example.com/rendered.md',
                    title: 'Rendered Markdown Route'
                }));

                const result = await fetchWebContent('https://example.com/rendered.md', 5000, {
                    renderMode: 'browser'
                });
                assert(result.content.includes('Rendered route body'), 'browser .md route should extract html text');
                assert(!result.content.includes('<html>'), 'browser .md route should not return raw html as markdown');
            }
        },
        {
            name: 'browser mode should surface browser availability errors',
            run: async () => {
                __setBrowserHtmlFetcherForTests(async () => {
                    throw new Error('Playwright client is not available for browser HTML fetch');
                });

                let message = '';
                try {
                    await fetchWebContent('https://example.com/browser-required', 5000, {
                        renderMode: 'browser'
                    });
                } catch (error) {
                    message = error instanceof Error ? error.message : String(error);
                }
                assert(message.includes('Playwright client is not available'), 'browser mode should surface Playwright errors');
            }
        },
        {
            name: 'browser mode should reject a final URL that resolves to a private address',
            run: async () => {
                __setBrowserHtmlFetcherForTests(async () => ({
                    html: '<html><body><main>private redirect</main></body></html>',
                    finalUrl: 'https://private-final.example/page',
                    title: 'Private Redirect'
                }));

                let failed = false;
                try {
                    await fetchWebContent('https://example.com/browser-redirect', 5000, {
                        renderMode: 'browser'
                    });
                } catch {
                    failed = true;
                }
                assert(failed, 'browser mode should reject DNS-resolved private final URLs');
            }
        },
        {
            name: 'browser mode should reject oversized rendered html',
            run: async () => {
                __setBrowserHtmlFetcherForTests(async () => ({
                    html: `<html><body>${'x'.repeat(2 * 1024 * 1024)}</body></html>`,
                    finalUrl: 'https://example.com/oversized-browser',
                    title: 'Oversized'
                }));

                let failed = false;
                try {
                    await fetchWebContent('https://example.com/oversized-browser', 5000, {
                        renderMode: 'browser'
                    });
                } catch {
                    failed = true;
                }
                assert(failed, 'browser mode should enforce the rendered html byte limit');
            }
        },
        {
            name: 'should apply readability extraction and preserve links when requested',
            run: async () => {
                __setReadabilityParserForTests(async () => ({
                    title: 'Readable Skill Page',
                    byline: 'Aasee',
                    excerpt: 'Readable excerpt',
                    siteName: 'Example Docs',
                    content: `
                    <article>
                      <h1>Readable Skill Page</h1>
                      <p>Readability content with a <a href="/guide">Guide</a>.</p>
                    </article>
                    `,
                    textContent: 'Readable Skill Page\n\nReadability content with a Guide.'
                }));

                const result = await fetchWebContent('https://example.com/page', 5000, {
                    readability: true,
                    includeLinks: true
                });
                assert(result.readabilityApplied === true, 'readability flag should be true');
                assert(result.title === 'Readable Skill Page', 'readability title should override page title');
                assert(result.content.includes('Readability content with a Guide.'), 'readability text should be used');
                assert(result.readableHtml?.includes('<article>'), 'readable html should be returned');
                assert(result.links?.[0]?.href === 'https://example.com/guide', 'relative links should be resolved');
                assert(result.byline === 'Aasee', 'byline should be returned');
                assert(result.excerpt === 'Readable excerpt', 'excerpt should be returned');
                assert(result.siteName === 'Example Docs', 'siteName should be returned');
            }
        },
        {
            name: 'should fallback to existing extractor when readability returns null',
            run: async () => {
                __setReadabilityParserForTests(async () => null);

                const result = await fetchWebContent('https://example.com/page', 5000, {
                    readability: true,
                    includeLinks: true
                });
                assert(result.readabilityApplied === false, 'readability should fall back when parser returns null');
                assert(result.title === 'Skill Page', 'fallback title should use existing extractor');
                assert(result.content.includes('Skill body content'), 'fallback should keep existing extracted text');
                assert(result.links === undefined, 'fallback should not synthesize readability links');
            }
        },
        {
            name: 'should fallback to browser html after cookie-assisted retry still fails',
            run: async () => {
                __setBrowserHtmlFetcherForTests(async () => ({
                    html: `
                    <html>
                      <head><title>Blocked Browser SPA</title></head>
                      <body>
                        <main>
                          <h1>Blocked Browser SPA</h1>
                          <p>${'Recovered after blocked request '.repeat(12)}</p>
                        </main>
                      </body>
                    </html>
                    `,
                    finalUrl: 'https://example.com/blocked-browser-spa?rendered=1',
                    title: 'Blocked Browser SPA'
                }));

                const result = await fetchWebContent('https://example.com/blocked-browser-spa', 5000);
                assert(result.retrievalMethod === 'browser-html', 'blocked request should end in browser html fallback');
                assert((requestAttempts.get('https://example.com/blocked-browser-spa') || 0) >= 1, 'blocked url should attempt request path first');
                assert(result.content.includes('Recovered after blocked request'), 'browser fallback should recover readable content');
            }
        },
        {
            name: 'should reject non-http protocol',
            run: async () => {
                let failed = false;
                try {
                    await fetchWebContent('file:///tmp/skill.md', 5000);
                } catch {
                    failed = true;
                }
                assert(failed, 'file protocol should be rejected');
            }
        },
        {
            name: 'should reject private/local network targets',
            run: async () => {
                let failed = false;
                try {
                    await fetchWebContent('http://127.0.0.1/private', 5000);
                } catch {
                    failed = true;
                }
                assert(failed, 'private network target should be rejected');
            }
        },
        {
            name: 'should reject oversized response by content-length',
            run: async () => {
                let failed = false;
                try {
                    await fetchWebContent('https://example.com/too-large.md', 5000);
                } catch {
                    failed = true;
                }
                assert(failed, 'oversized response should be rejected');
            }
        }
    ];

    let passed = 0;
    for (const testCase of testCases) {
        if (await runCase(testCase)) {
            passed += 1;
        }
    }

    restoreAxiosMock();
    __setDnsLookupForTests();
    config.fetchWebAllowInsecureTls = originalFetchWebAllowInsecureTls;
    __setReadabilityParserForTests();
    __setBrowserHtmlFetcherForTests();
    __setBrowserCookieHeaderFetcherForTests();

    const total = testCases.length;
    console.log(`\nResult: ${passed}/${total} passed`);

    if (passed !== total) {
        process.exit(1);
    }

    process.exit(0);
}

main().catch((error) => {
    restoreAxiosMock();
    __setDnsLookupForTests();
    config.fetchWebAllowInsecureTls = false;
    __setReadabilityParserForTests();
    __setBrowserHtmlFetcherForTests();
    __setBrowserCookieHeaderFetcherForTests();
    console.error('❌ test-web-content failed:', error);
    process.exit(1);
});
