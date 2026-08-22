import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import {
    __setBrowserFetcherForTests,
    __setBrowserHtmlFetcherForTests,
    __setBrowserSessionOpenerForTests,
    fetchWebContent
} from '../engines/web/index.js';
import { __setReadabilityParserForTests } from '../engines/web/fetchWebContent.js';
import { __setAxiosRequestForTests } from '../utils/httpRequest.js';
import { __resetPlaywrightClientForTests } from '../utils/playwrightClient.js';
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

    // 修复测试桩覆盖不到 requestWithSafeRedirects 的问题：生产代码现在统一走 axios.request，因此测试也必须替换同一层入口，避免误打到真实网络造成 404 和不稳定失败。
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
    __setBrowserFetcherForTests();
    __setBrowserHtmlFetcherForTests();
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

// 假竞速浏览器：只实现竞速层用到的方法面（route/CDP 会话/cookies/goto/content 等），驱动 fetchWithCookiesRaceViaPlaywright 的真实竞速逻辑，无需启动真实浏览器即可断言 HTTP 臂胜出时的返回行为。导航守卫在这里是 no-op：公网 URL 校验已由测试 DNS 桩覆盖的 assertPublicHttpUrlResolved 调用链承担。
function makeFakeRaceBrowser(): any {
    let nextTargetSeq = 1;

    const makeSession = (targetId: string) => ({
        send: async (method: string) => {
            if (method === 'Target.getTargetInfo') {
                return { targetInfo: { targetId } };
            }
            if (method === 'Browser.getWindowForTarget') {
                return { windowId: 1 };
            }
            if (method === 'Browser.getWindowBounds') {
                return { bounds: { left: 0, top: 0, width: 800, height: 600, windowState: 'normal' } };
            }
            return {};
        }
    });

    const makePage = (targetId: string): any => {
        let currentUrl = '';
        return {
            _targetId: targetId,
            isClosed: () => false,
            context: () => context,
            route: async () => undefined,
            goto: async (targetUrl: string) => { currentUrl = targetUrl; },
            // 渲染臂刻意带真实延迟：真实浏览器渲染远慢于 HTTP，竞速层因此应由 HTTP 臂先胜出；若渲染臂即时返回，它会无条件抢先胜出而掩盖本用例要验证的 HTTP 臂重定向行为。
            waitForLoadState: async () => new Promise<void>((resolve) => setTimeout(resolve, 400)),
            waitForTimeout: async () => undefined,
            content: async () => '<html><head><title>Fake Race Page</title></head><body>fake race render</body></html>',
            url: () => currentUrl,
            title: async () => 'Fake Race Page',
            evaluate: async () => undefined
        };
    };

    const context: any = {
        pages: () => [],
        newPage: async () => {
            const page = makePage(`FAKE-RACE-${nextTargetSeq}`);
            nextTargetSeq += 1;
            return page;
        },
        newCDPSession: async (page: any) => makeSession(page._targetId),
        cookies: async () => [{ name: 'race-cookie', value: '1' }]
    };

    return {
        contexts: () => [context],
        newContext: async () => context,
        close: async () => undefined
    };
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
        if (hostname === 'redirected.example') {
            return [{ address: '93.184.216.35' }];
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
                __setBrowserFetcherForTests(async () => {
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
                __setBrowserFetcherForTests(async () => ({
                    contentType: 'text/html; charset=utf-8',
                    raw: `
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
                    title: 'Browser SPA',
                    retrievalMethod: 'browser-html' as const
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
                // 合并后的 auto 回退主路径是 Cookie+HTTP/渲染竞速层（browserFetcher），竞速层失败时保留 HTTP 请求的提取结果。
                __setBrowserFetcherForTests(async () => {
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
                let raceCalled = false;
                let browserCalled = false;
                __setBrowserFetcherForTests(async () => {
                    raceCalled = true;
                    throw new Error('request mode must not use the browser race layer');
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
                assert(raceCalled === false, 'request mode should not invoke the browser race layer');
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
                __setBrowserFetcherForTests(async () => ({
                    contentType: 'text/html; charset=utf-8',
                    raw: `
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
                    title: 'Blocked Browser SPA',
                    retrievalMethod: 'browser-html' as const
                }));

                const result = await fetchWebContent('https://example.com/blocked-browser-spa', 5000);
                assert(result.retrievalMethod === 'browser-html', 'blocked request should end in browser html fallback');
                assert((requestAttempts.get('https://example.com/blocked-browser-spa') || 0) >= 1, 'blocked url should attempt request path first');
                assert(result.content.includes('Recovered after blocked request'), 'browser fallback should recover readable content');
            }
        },
        {
            name: 'should fallback to browser html when connection times out',
            run: async () => {
                __setAxiosRequestForTests(async (config) => {
                    const url = String(config.url || '');
                    if (url.endsWith('/timeout-site')) {
                        const error: any = new Error('connect ETIMEDOUT 34.117.97.190:443');
                        error.code = 'ETIMEDOUT';
                        throw error;
                    }
                    throw new Error(`Unexpected mocked URL: ${url}`);
                });

                __setBrowserFetcherForTests(async () => ({
                    contentType: 'text/html; charset=utf-8',
                    raw: `
                    <html>
                      <head><title>Timeout Site</title></head>
                      <body>
                        <main>
                          <h1>Timeout Site</h1>
                          <p>${'Content recovered via browser after timeout '.repeat(10)}</p>
                        </main>
                      </body>
                    </html>
                    `,
                    finalUrl: 'https://example.com/timeout-site',
                    title: 'Timeout Site',
                    retrievalMethod: 'browser-html' as const
                }));

                const result = await fetchWebContent('https://example.com/timeout-site', 5000);
                assert(result.retrievalMethod === 'browser-html', 'timeout should trigger browser fallback');
                assert(result.content.includes('Content recovered via browser after timeout'), 'browser should recover content after transport timeout');

                installAxiosMock();
            }
        },
        {
            name: 'should fallback to browser html when TLS handshake fails',
            run: async () => {
                __setAxiosRequestForTests(async (config) => {
                    const url = String(config.url || '');
                    if (url.endsWith('/tls-fail-site')) {
                        const error: any = new Error('Client network socket disconnected before secure TLS connection was established');
                        error.code = 'ECONNRESET';
                        throw error;
                    }
                    throw new Error(`Unexpected mocked URL: ${url}`);
                });

                __setBrowserFetcherForTests(async () => ({
                    contentType: 'text/html; charset=utf-8',
                    raw: `
                    <html>
                      <head><title>TLS Fail Site</title></head>
                      <body>
                        <main>
                          <h1>TLS Fail Site</h1>
                          <p>${'Content recovered via browser after TLS failure '.repeat(10)}</p>
                        </main>
                      </body>
                    </html>
                    `,
                    finalUrl: 'https://example.com/tls-fail-site',
                    title: 'TLS Fail Site',
                    retrievalMethod: 'browser-html' as const
                }));

                const result = await fetchWebContent('https://example.com/tls-fail-site', 5000);
                assert(result.retrievalMethod === 'browser-html', 'TLS handshake failure should trigger browser fallback');
                assert(result.content.includes('Content recovered via browser after TLS failure'), 'browser should recover content after TLS failure');

                installAxiosMock();
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
        },
        {
            name: 'should not use browser fallback to bypass safety errors',
            run: async () => {
                let browserWasCalled = false;
                __setBrowserFetcherForTests(async () => {
                    browserWasCalled = true;
                    return {
                        contentType: 'text/html; charset=utf-8',
                        raw: '<html><body><main><p>should never be reached</p></main></body></html>',
                        finalUrl: 'https://example.com/ssrf-target',
                        title: 'Should Not Happen',
                        retrievalMethod: 'browser-html' as const
                    };
                });

                __setAxiosRequestForTests(async (config) => {
                    const url = String(config.url || '');
                    if (url.endsWith('/ssrf-target')) {
                        throw new Error('Redirect target points to a private or local network address');
                    }
                    throw new Error(`Unexpected mocked URL: ${url}`);
                });

                let failed = false;
                try {
                    await fetchWebContent('https://example.com/ssrf-target', 5000);
                } catch {
                    failed = true;
                }

                assert(failed, 'safety error should stay fatal');
                assert(browserWasCalled === false, 'browser fallback must not be used to bypass safety errors');

                installAxiosMock();
            }
        },
        {
            name: 'race layer should follow redirects and keep the final URL when HTTP wins',
            run: async () => {
                const previousModulePath = config.playwrightModulePath;
                const previousProxyEnabled = config.useProxy;
                config.useProxy = false;
                config.playwrightModulePath = fileURLToPath(new URL('../../test-assets/fake-playwright-launch-client.cjs', import.meta.url));
                __resetPlaywrightClientForTests();

                // 重置为真实竞速层：前面的测试可能留下返回固定内容的 __setBrowserFetcherForTests 桩，不重置会被 fetchWebContent 的回退入口直接命中，绕过本用例要验证的真实竞速逻辑。
                __setBrowserFetcherForTests();
                __setBrowserSessionOpenerForTests(async () => ({
                    browser: makeFakeRaceBrowser(),
                    release: async () => undefined
                }));

                installAxiosMock();
                // 主请求（无 Cookie）被模拟成反爬拦截返回 403，强制进入竞速层；竞速层带页面 Cookie 的 GET 则走通重定向链，以此验证 HTTP 臂胜出时 finalUrl 跟随重定向后的地址。
                __setAxiosRequestForTests(async (requestConfig) => {
                    const url = String(requestConfig.url || '');
                    const method = String(requestConfig.method || 'GET').toUpperCase();
                    const cookie = String((requestConfig.headers as Record<string, unknown> | undefined)?.Cookie || '');
                    if (method === 'HEAD') {
                        return makeResponse(requestConfig, { headers: {}, finalUrl: url });
                    }
                    if (method === 'GET' && url.endsWith('/race-redirect')) {
                        if (cookie.includes('race-cookie')) {
                            return makeResponse(requestConfig, {
                                status: 301,
                                headers: { location: 'https://redirected.example/race-landing' },
                                data: ''
                            });
                        }
                        return makeResponse(requestConfig, {
                            status: 403,
                            headers: { 'content-type': 'text/html; charset=utf-8' },
                            data: '',
                            finalUrl: url
                        });
                    }
                    if (method === 'GET' && url.endsWith('/race-landing')) {
                        return makeResponse(requestConfig, {
                            headers: { 'content-type': 'text/html; charset=utf-8' },
                            data: `
                            <html>
                              <head><title>Race Landing</title></head>
                              <body>
                                <main>
                                  <h1>Race Landing</h1>
                                  <p>${'Race redirect landed content '.repeat(12)}</p>
                                </main>
                              </body>
                            </html>
                            `,
                            finalUrl: url
                        });
                    }
                    throw new Error(`Unexpected mocked URL: ${url}`);
                });

                try {
                    const result = await fetchWebContent('https://example.com/race-redirect', 5000);
                    assert(result.retrievalMethod === 'request-with-browser-cookies', 'race layer HTTP arm should win with browser cookies');
                    assert(result.finalUrl === 'https://redirected.example/race-landing', 'race HTTP win should keep the redirected final URL');
                    assert(result.content.includes('Race redirect landed content'), 'redirected content should be extracted');
                } finally {
                    config.useProxy = previousProxyEnabled;
                    config.playwrightModulePath = previousModulePath;
                    __resetPlaywrightClientForTests();
                    __setBrowserSessionOpenerForTests();
                    installAxiosMock();
                    __setBrowserFetcherForTests();
                }
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
    __setBrowserFetcherForTests();
    __setBrowserHtmlFetcherForTests();
    __setBrowserSessionOpenerForTests();
    __resetPlaywrightClientForTests();

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
    __setBrowserFetcherForTests();
    __setBrowserHtmlFetcherForTests();
    __setBrowserSessionOpenerForTests();
    __resetPlaywrightClientForTests();
    console.error('❌ test-web-content failed:', error);
    process.exit(1);
});
