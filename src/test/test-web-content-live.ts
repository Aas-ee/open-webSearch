import { fetchWebContent } from '../engines/web/index.js';

type CliArgs = {
    url: string;
    maxChars: number;
    previewChars: number;
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
        }
    }

    return parsed;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    console.log('Live fetch test config:', args);

    const start = Date.now();
    try {
        const result = await fetchWebContent(args.url, args.maxChars);
        const durationMs = Date.now() - start;

        console.log('\nFetch metadata:');
        console.log(`- url: ${result.url}`);
        console.log(`- finalUrl: ${result.finalUrl}`);
        console.log(`- contentType: ${result.contentType}`);
        console.log(`- title: ${result.title || '(empty)'}`);
        console.log(`- truncated: ${result.truncated}`);
        console.log(`- contentLength: ${result.content.length}`);
        console.log(`- durationMs: ${durationMs}`);

        if (!result.content.trim()) {
            throw new Error('Fetched content is empty');
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
        process.exit(1);
    }
}

main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
});
