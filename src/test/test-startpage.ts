type CliArgs = {
  query: string;
  limit: number;
  mode?: 'request' | 'auto' | 'playwright';
  previewChars: number;
};

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {
    query: 'open-websearch',
    limit: 20,
    mode: 'auto',
    previewChars: 100
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
    process.env.SEARCH_MODE = args.mode;
  }

  console.log('Live Startpage test config:', {
    query: args.query,
    limit: args.limit,
    mode: process.env.SEARCH_MODE || '(default)',
    previewChars: args.previewChars,
    useProxy: process.env.USE_PROXY || 'false',
    proxyUrl: process.env.PROXY_URL || '(default)'
  });

  const { searchStartpage } = await import('../engines/startpage/index.js');
  const { shutdownLocalPlaywrightBrowserSessions } = await import('../utils/playwrightClient.js');

  const start = Date.now();
  try {
    const results = await searchStartpage(args.query, args.limit);
    const durationMs = Date.now() - start;

    console.log(`\nStartpage live search completed in ${durationMs}ms`);
    console.log(`Returned ${results.length} results`);

    if (results.length === 0) {
      throw new Error('Startpage returned zero results');
    }

    results.forEach((result, index) => {
      console.log(`\n${index + 1}. ${result.title || '(empty title)'}`);
      console.log(`   url: ${result.url}`);
      console.log(`   source: ${result.source || '(empty source)'}`);
      console.log(`   engine: ${result.engine}`);
      console.log(`   description: ${(result.description || '').slice(0, args.previewChars)}`);
    });

    const invalidResult = results.find((result) => !result.title || !result.url || result.engine !== 'startpage');
    if (invalidResult) {
      throw new Error(`Invalid Startpage result detected: ${JSON.stringify(invalidResult)}`);
    }

    console.log('\nLive Startpage test passed.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('\nLive Startpage test failed:', message);

    if (/playwright|chromium/i.test(message)) {
      console.error('Playwright/Chromium issue detected. Install or point to a Playwright client to use browser mode.');
    }
    if (/EAI_AGAIN|getaddrinfo|TLS|socket|timeout|network/i.test(message)) {
      console.error('Network error/proxy issue detected. If needed, enable proxy: USE_PROXY=true PROXY_URL=http://127.0.0.1:7890');
    }
    if (/captcha|verification|blocked|access denied|anubis|human/i.test(message)) {
      console.error('Startpage anti-bot response detected. Retry later or use --mode=auto / --mode=playwright if available.');
    }
    process.exitCode = 1;
  } finally {
    await shutdownLocalPlaywrightBrowserSessions().catch(() => undefined);
  }
}

main()
  .catch((error) => {
    console.error('Unexpected error:', error);
    process.exitCode = 1;
  });
