import axios from 'axios';
import { __setBrowserHtmlFetcherForTests, fetchWebContent } from '../engines/web/index.js';

type TestCase = {
    name: string;
    run: () => Promise<void>;
};

const originalAxiosGet = axios.get.bind(axios);
const originalAxiosHead = axios.head.bind(axios);
const requestAttempts = new Map<string, number>();

function installAxiosMock(): void {
    requestAttempts.clear();

    (axios as any).head = async (url: string) => {
        if (url.endsWith('/too-large.md')) {
            return {
                headers: { 'content-length': String(5 * 1024 * 1024) },
                request: { res: { responseUrl: url } }
            };
        }
        if (url.endsWith('/long.md')) {
            return {
                headers: { 'content-length': String(1024) },
                request: { res: { responseUrl: url } }
            };
        }
        return {
            headers: {},
            request: { res: { responseUrl: url } }
        };
    };

    (axios as any).get = async (url: string) => {
        requestAttempts.set(url, (requestAttempts.get(url) || 0) + 1);

        if (url.endsWith('/skill.md')) {
            return {
                headers: { 'content-type': 'text/plain; charset=utf-8' },
                data: '# Skill Title\n\nThis is a markdown test document.',
                request: { res: { responseUrl: url } }
            };
        }

        if (url.endsWith('/page')) {
            return {
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
                request: { res: { responseUrl: `${url}?from=test` } }
            };
        }

        if (url.endsWith('/long.md')) {
            return {
                headers: { 'content-type': 'text/markdown; charset=utf-8' },
                data: `# Long\n\n${'x'.repeat(6000)}`,
                request: { res: { responseUrl: url } }
            };
        }

        if (url.endsWith('/too-large.md')) {
            throw new Error('GET should not be called when HEAD indicates oversized response');
        }

        if (url.endsWith('/spa')) {
            return {
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
                request: { res: { responseUrl: url } }
            };
        }

        if (url.endsWith('/browser-spa')) {
            return {
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
                request: { res: { responseUrl: url } }
            };
        }

        if (url.endsWith('/blocked-browser-spa')) {
            const error = new Error('Request failed with status code 403') as Error & { response?: { status: number } };
            error.response = { status: 403 };
            throw error;
        }

        throw new Error(`Unexpected mocked URL: ${url}`);
    };
}

function restoreAxiosMock(): void {
    (axios as any).get = originalAxiosGet;
    (axios as any).head = originalAxiosHead;
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

async function main(): Promise<void> {
    installAxiosMock();

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

    const total = testCases.length;
    console.log(`\nResult: ${passed}/${total} passed`);

    if (passed !== total) {
        process.exit(1);
    }
}

main().catch((error) => {
    restoreAxiosMock();
    console.error('❌ test-web-content failed:', error);
    process.exit(1);
});
