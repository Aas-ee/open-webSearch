import axios from 'axios';
import { fetchWebContent } from '../engines/web/index.js';

type TestCase = {
    name: string;
    run: () => Promise<void>;
};

const originalAxiosGet = axios.get.bind(axios);

function installAxiosMock(): void {
    (axios as any).get = async (url: string) => {
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

        throw new Error(`Unexpected mocked URL: ${url}`);
    };
}

function restoreAxiosMock(): void {
    (axios as any).get = originalAxiosGet;
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
                assert(result.content.includes('Rendered by JS runtime'), 'meta description fallback should be used');
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
