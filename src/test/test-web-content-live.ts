import { fetchWebContent } from '../engines/web/index.js';

type CliArgs = {
    url: string;
    maxChars: number;
    previewChars: number;
    expectMethod?: 'request' | 'request-with-browser-cookies' | 'browser-html';
};

function parseArgs(argv: string[]): CliArgs {
    const parsed: CliArgs = {
        url: 'https://awiki.ai',
        maxChars: 30000,
        previewChars: 600
    };

    for (const arg of argv) {
        if (arg.startsWith('--url=')) {
            parsed.url = arg.slice('--url='.length);
        } else if (arg.startsWith('--maxChars=')) {
            const value = Number(arg.slice('--maxChars='.length));
            if (Number.isFinite(value) && value > 0) {
                parsed.maxChars = value;
            }
        } else if (arg.startsWith('--previewChars=')) {
            const value = Number(arg.slice('--previewChars='.length));
            if (Number.isFinite(value) && value > 0) {
                parsed.previewChars = value;
            }
        } else if (arg.startsWith('--expectMethod=')) {
            const value = arg.slice('--expectMethod='.length);
            if (value === 'request' || value === 'request-with-browser-cookies' || value === 'browser-html') {
                parsed.expectMethod = value;
            }
        }
    }

    return parsed;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    console.log('Live fetch test config:', {
        ...args,
        useProxy: process.env.USE_PROXY || 'false',
        proxyUrl: process.env.PROXY_URL || '(default)',
        playwrightPackage: process.env.PLAYWRIGHT_PACKAGE || '(auto)',
        playwrightModulePath: process.env.PLAYWRIGHT_MODULE_PATH || '(none)',
        playwrightExecutablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '(none)',
        playwrightWsEndpoint: process.env.PLAYWRIGHT_WS_ENDPOINT || '(none)',
        playwrightCdpEndpoint: process.env.PLAYWRIGHT_CDP_ENDPOINT || '(none)'
    });

    const start = Date.now();
    try {
        const result = await fetchWebContent(args.url, args.maxChars);
        const durationMs = Date.now() - start;

        console.log('\nFetch metadata:');
        console.log(`- url: ${result.url}`);
        console.log(`- finalUrl: ${result.finalUrl}`);
        console.log(`- contentType: ${result.contentType}`);
        console.log(`- title: ${result.title || '(empty)'}`);
        console.log(`- retrievalMethod: ${result.retrievalMethod}`);
        console.log(`- truncated: ${result.truncated}`);
        console.log(`- contentLength: ${result.content.length}`);
        console.log(`- durationMs: ${durationMs}`);

        if (!result.content.trim()) {
            throw new Error('Fetched content is empty');
        }
        if (args.expectMethod && result.retrievalMethod !== args.expectMethod) {
            throw new Error(`Expected retrievalMethod=${args.expectMethod}, got ${result.retrievalMethod}`);
        }

        const preview = result.content.slice(0, args.previewChars);
        console.log('\nContent preview:\n');
        console.log(preview);
        console.log('\nLive fetch test passed.');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('\nLive fetch test failed:', message);

        if (/EAI_AGAIN|getaddrinfo|TLS|socket/i.test(message)) {
            console.error('Network/DNS issue detected. If needed, enable proxy: USE_PROXY=true PROXY_URL=http://127.0.0.1:7890');
        }
        if (/playwright|chromium/i.test(message)) {
            console.error('Playwright/Chromium issue detected. Install or point to a Playwright client if you want browser HTML fallback.');
        }
        if (/captcha|verification|blocked|验证码|人机验证|安全验证/i.test(message)) {
            console.error('Anti-bot response detected. Browser HTML fallback may require a reachable Playwright client or a trusted existing browser session.');
        }
        process.exit(1);
    }
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error('Unexpected error:', error);
        process.exit(1);
    });
