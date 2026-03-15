type CliArgs = {
    query: string;
    limit: number;
    mode?: 'request' | 'auto' | 'playwright';
    previewChars: number;
};

function parseArgs(argv: string[]): CliArgs {
    const parsed: CliArgs = {
        query: 'openclaw',
        limit: 20,
        previewChars: 140
    };

    for (const arg of argv) {
        if (arg.startsWith('--query=')) {
            parsed.query = arg.slice('--query='.length);
        } else if (arg.startsWith('--limit=')) {
            const value = Number(arg.slice('--limit='.length));
            if (Number.isFinite(value) && value > 0) {
                parsed.limit = value;
            }
        } else if (arg.startsWith('--previewChars=')) {
            const value = Number(arg.slice('--previewChars='.length));
            if (Number.isFinite(value) && value > 0) {
                parsed.previewChars = value;
            }
        } else if (arg.startsWith('--mode=')) {
            const value = arg.slice('--mode='.length);
            if (value === 'request' || value === 'auto' || value === 'playwright') {
                parsed.mode = value;
            }
        }
    }

    return parsed;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    if (args.mode) {
        process.env.BING_SEARCH_MODE = args.mode;
        if (args.mode === 'auto' || args.mode === 'playwright') {
            process.env.PLAYWRIGHT_HEADLESS = 'true';
        }
    }

    console.log('Live Bing test config:', {
        query: args.query,
        limit: args.limit,
        mode: process.env.BING_SEARCH_MODE || '(default)',
        previewChars: args.previewChars,
        useProxy: process.env.USE_PROXY || 'false',
        proxyUrl: process.env.PROXY_URL || '(default)'
    });

    const { searchBing } = await import('../engines/bing/index.js');

    const start = Date.now();
    try {
        const results = await searchBing(args.query, args.limit);
        const durationMs = Date.now() - start;

        console.log(`\nBing live search completed in ${durationMs}ms`);
        console.log(`Returned ${results.length} results`);

        if (results.length === 0) {
            throw new Error('Bing returned zero results');
        }

        results.forEach((result, index) => {
            console.log(`\n${index + 1}. ${result.title || '(empty title)'}`);
            console.log(`   url: ${result.url}`);
            console.log(`   source: ${result.source || '(empty source)'}`);
            console.log(`   engine: ${result.engine}`);
            console.log(`   description: ${(result.description || '').slice(0, args.previewChars)}`);
        });

        const invalidResult = results.find((result) => !result.url || !result.engine);
        if (invalidResult) {
            throw new Error(`Invalid result detected: ${JSON.stringify(invalidResult)}`);
        }

        console.log('\nLive Bing test passed.');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('\nLive Bing test failed:', message);

        if (/playwright|chromium/i.test(message)) {
            console.error('Playwright/Chromium issue detected. Install a client manually if you want browser mode: npm install playwright && npx playwright install chromium');
            console.error('For an existing external client, set PLAYWRIGHT_MODULE_PATH or PLAYWRIGHT_PACKAGE=playwright-core with PLAYWRIGHT_EXECUTABLE_PATH / PLAYWRIGHT_WS_ENDPOINT / PLAYWRIGHT_CDP_ENDPOINT');
        }
        if (/EAI_AGAIN|getaddrinfo|TLS|socket|timeout|network/i.test(message)) {
            console.error('Network/proxy issue detected. If needed, enable proxy: USE_PROXY=true PROXY_URL=http://127.0.0.1:7890');
        }
        if (/captcha|verification|blocked|验证码|人机验证/i.test(message)) {
            console.error('Bing anti-bot response detected. You can retry later or try --mode=auto / --mode=playwright if available.');
        }
        process.exit(1);
    }
}

main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
});
