type SupportedEngine = 'csdn' | 'zhihu';

type CliArgs = {
    engine: SupportedEngine;
    url: string;
    previewChars: number;
};

const DEFAULT_URLS: Record<SupportedEngine, string> = {
    csdn: 'https://blog.csdn.net/weixin_45801664/article/details/149000138',
    zhihu: 'https://zhuanlan.zhihu.com/p/1906730696836350163'
};

function parseArgs(argv: string[]): CliArgs {
    const parsed: CliArgs = {
        engine: 'csdn',
        url: DEFAULT_URLS.csdn,
        previewChars: 20000
    };

    for (const arg of argv) {
        if (arg.startsWith('--engine=')) {
            const value = arg.slice('--engine='.length);
            if (value === 'csdn' || value === 'zhihu') {
                parsed.engine = value;
                parsed.url = DEFAULT_URLS[value];
            }
        } else if (arg.startsWith('--url=')) {
            parsed.url = arg.slice('--url='.length);
        } else if (arg.startsWith('--previewChars=')) {
            const value = Number(arg.slice('--previewChars='.length));
            if (Number.isFinite(value) && value > 0) {
                parsed.previewChars = value;
            }
        }
    }

    return parsed;
}

async function fetchArticle(args: CliArgs): Promise<{ content: string }> {
    if (args.engine === 'csdn') {
        const { fetchCsdnArticle } = await import('../engines/csdn/fetchCsdnArticle.js');
        return fetchCsdnArticle(args.url);
    }

    const { fetchZhiHuArticle } = await import('../engines/zhihu/fetchZhihuArticle.js');
    return fetchZhiHuArticle(args.url);
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    console.log('Live article fetch test config:', {
        engine: args.engine,
        url: args.url,
        previewChars: args.previewChars,
        useProxy: process.env.USE_PROXY || 'false',
        proxyUrl: process.env.PROXY_URL || '(default)',
        playwrightPackage: process.env.PLAYWRIGHT_PACKAGE || '(auto)',
        playwrightModulePath: process.env.PLAYWRIGHT_MODULE_PATH || '(none)'
    });

    const start = Date.now();
    try {
        const result = await fetchArticle(args);
        const durationMs = Date.now() - start;
        const content = result.content.trim();

        console.log(`\n${args.engine} article fetch completed in ${durationMs}ms`);
        console.log(`contentLength: ${content.length}`);

        if (!content) {
            throw new Error(`${args.engine} article content is empty`);
        }

        console.log('\nContent preview:\n');
        console.log(content.slice(0, args.previewChars));
        console.log('\nLive article fetch test passed.');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('\nLive article fetch test failed:', message);

        if (/playwright|chromium/i.test(message)) {
            console.error('Playwright/Chromium issue detected. Install or point to a Playwright client if you want browser-assisted cookie retries.');
        }
        if (/EAI_AGAIN|getaddrinfo|TLS|socket|timeout|network/i.test(message)) {
            console.error('Network/proxy issue detected. If needed, enable proxy: USE_PROXY=true PROXY_URL=http://127.0.0.1:7890');
        }
        if (/captcha|verification|blocked|验证码|人机验证|安全验证/i.test(message)) {
            console.error('Anti-bot response detected. If available, configure Playwright so the fetcher can retry with browser-acquired cookies.');
        }
        process.exit(1);
    }
}

main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
});
