// issue #22 活体测试：对 linux.do 发起真实请求，验证反爬拦截与浏览器渲染回退的完整链路。
// 使用方式与 test-article-fetch-live 一致：默认 topic 为真实存在的帖子，可用 --url= 覆盖；代理通过 USE_PROXY/PROXY_URL 环境变量控制，浏览器配置沿用 PLAYWRIGHT_* 环境变量。
import { fetchLinuxDoArticle } from '../engines/linuxdo/fetchLinuxDoArticle.js';

type CliArgs = {
    url: string;
    previewChars: number;
};

const DEFAULT_URL = 'https://linux.do/t/topic/2810651.json';

function parseArgs(argv: string[]): CliArgs {
    const parsed: CliArgs = {
        url: DEFAULT_URL,
        previewChars: 20000
    };

    for (const arg of argv) {
        if (arg.startsWith('--url=')) {
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

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    console.log('Live linux.do article fetch test config:', {
        url: args.url,
        previewChars: args.previewChars,
        useProxy: process.env.USE_PROXY || 'false',
        proxyUrl: process.env.PROXY_URL || '(default)',
        playwrightPackage: process.env.PLAYWRIGHT_PACKAGE || '(auto)',
        playwrightExecutablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '(none)',
        playwrightHeadless: process.env.PLAYWRIGHT_HEADLESS ?? '(default)'
    });

    const start = Date.now();
    try {
        const result = await fetchLinuxDoArticle(args.url);
        const durationMs = Date.now() - start;
        const content = result.content.trim();

        console.log(`\nlinux.do article fetch completed in ${durationMs}ms`);
        console.log(`contentLength: ${content.length}`);

        if (!content) {
            throw new Error('linux.do article content is empty');
        }

        console.log('\nContent preview:\n');
        console.log(content.slice(0, args.previewChars));
        console.log('\nLive linux.do article fetch test passed.');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('\nLive linux.do article fetch test failed:', message);

        if (/playwright|chromium/i.test(message)) {
            console.error('Playwright/Chromium issue detected. Configure PLAYWRIGHT_EXECUTABLE_PATH / PLAYWRIGHT_PACKAGE to enable the browser rendering fallback.');
        }
        if (/EAI_AGAIN|getaddrinfo|TLS|socket|timeout|network|ETIMEDOUT/i.test(message)) {
            console.error('Network/proxy issue detected. If needed, enable proxy: USE_PROXY=true PROXY_URL=http://127.0.0.1:8890');
        }
        if (/captcha|verification|blocked|验证码|人机验证|安全验证|403|429/i.test(message)) {
            console.error('Anti-bot response detected. Verify the browser passed the Cloudflare challenge; configure a real browser binary for managed challenges.');
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
