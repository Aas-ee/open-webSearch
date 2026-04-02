import { AppConfig } from '../config.js';
import { createOpenWebSearchRuntime } from '../runtime/createRuntime.js';
import { startLocalDaemon } from '../adapters/http/localDaemon.js';
import type { LocalDaemonHandle } from '../adapters/http/localDaemon.js';
import {
    parseFetchGithubArgs,
    parseFetchWebArgs,
    parseSearchArgs,
    runCli
} from '../cli/runCli.js';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
}

function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
        defaultSearchEngine: 'bing',
        allowedSearchEngines: [],
        searchMode: 'request',
        proxyUrl: 'http://127.0.0.1:7890',
        useProxy: false,
        fetchWebAllowInsecureTls: false,
        playwrightPackage: 'auto',
        playwrightModulePath: undefined,
        playwrightExecutablePath: undefined,
        playwrightWsEndpoint: undefined,
        playwrightCdpEndpoint: undefined,
        playwrightHeadless: true,
        playwrightNavigationTimeoutMs: 20000,
        enableCors: false,
        corsOrigin: '*',
        enableHttpServer: true,
        ...overrides
    };
}

function createStubRuntime(configOverrides: Partial<AppConfig> = {}) {
    return createOpenWebSearchRuntime({
        config: createTestConfig(configOverrides),
        dependencies: {
            searchExecutors: {
                bing: async (query, limit) => [{
                    title: 'Result',
                    url: 'https://example.com',
                    description: `${query}:${limit}`,
                    source: 'example.com',
                    engine: 'bing'
                }],
                startpage: async (query, limit) => [{
                    title: 'Startpage Result',
                    url: 'https://startpage.example.com',
                    description: `${query}:${limit}`,
                    source: 'startpage.example.com',
                    engine: 'startpage'
                }]
            },
            fetchGithubReadme: async () => '# README',
            fetchWebContent: async (url, maxChars) => ({
                url,
                finalUrl: url,
                contentType: 'text/plain',
                title: 'Example',
                retrievalMethod: 'request' as const,
                truncated: false,
                content: `ok:${maxChars}`
            }),
            fetchCsdnArticle: async () => ({ content: 'csdn' }),
            fetchJuejinArticle: async () => ({ content: 'juejin' }),
            fetchLinuxDoArticle: async () => ({ content: 'linuxdo' })
        }
    });
}

async function withEnv<T>(key: string, value: string | undefined, callback: () => Promise<T>): Promise<T> {
    const previous = process.env[key];
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }

    try {
        return await callback();
    } finally {
        if (previous === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = previous;
        }
    }
}

function testParseSearchArgs(): void {
    const runtime = createStubRuntime({
        defaultSearchEngine: 'duckduckgo',
        allowedSearchEngines: ['bing', 'startpage']
    });
    const parsed = parseSearchArgs(
        ['Open', 'WebSearch', '--limit', '3', '--engine', 'Bing', '--engines', 'startpage'],
        runtime
    );

    assertEqual(parsed.query, 'Open WebSearch', 'parsed query');
    assertEqual(parsed.limit, 3, 'parsed limit');
    assertEqual(parsed.engines.join(','), 'bing,startpage', 'parsed engines');
    assertEqual(parsed.json, false, 'parsed json flag');

    const parsedWithSearchMode = parseSearchArgs(
        ['Open', 'WebSearch', '--search-mode', 'playwright', '--json'],
        createStubRuntime()
    );
    assertEqual(parsedWithSearchMode.searchMode, 'playwright', 'parsed search mode');

    console.log('✅ CLI parseSearchArgs');
}

function testParseFetchArgs(): void {
    const parsedWeb = parseFetchWebArgs([
        'https://example.com',
        '--max-chars',
        '5000',
        '--json'
    ]);
    assertEqual(parsedWeb.url, 'https://example.com', 'parsed fetch-web url');
    assertEqual(parsedWeb.maxChars, 5000, 'parsed fetch-web maxChars');
    assertEqual(parsedWeb.json, true, 'parsed fetch-web json flag');

    const parsedGithub = parseFetchGithubArgs([
        'https://github.com/Aas-ee/open-webSearch',
        '--json'
    ]);
    assertEqual(parsedGithub.url, 'https://github.com/Aas-ee/open-webSearch', 'parsed fetch-github-readme url');
    assertEqual(parsedGithub.json, true, 'parsed fetch-github-readme json flag');

    console.log('✅ CLI parse fetch args');
}

async function testRunCliJsonSuccess(): Promise<void> {
    const runtime = createStubRuntime();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
        ['search', 'Open WebSearch', '--limit', '2', '--engine', 'bing', '--json'],
        runtime,
        {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text)
        }
    );

    assertEqual(exitCode, 0, 'CLI json success exit code');
    assertEqual(stderr.length, 0, 'CLI json success stderr');
    const payload = JSON.parse(stdout[0]) as {
        status: string;
        data: {
            query: string;
            totalResults: number;
            results: Array<{ description: string }>;
        };
    };
    assertEqual(payload.status, 'ok', 'CLI json status');
    assertEqual(payload.data.query, 'Open WebSearch', 'CLI json query');
    assertEqual(payload.data.totalResults, 1, 'CLI json totalResults');
    assertEqual(payload.data.results[0].description, 'Open WebSearch:2', 'CLI json description');

    console.log('✅ CLI runCli json success');
}

async function testRunCliSearchModeOverride(): Promise<void> {
    const seenCalls: Array<{ searchMode?: string }> = [];
    const runtime = createOpenWebSearchRuntime({
        config: createTestConfig(),
        dependencies: {
            searchExecutors: {
                bing: async (query, limit, context) => {
                    seenCalls.push({ searchMode: context?.searchMode });
                    return [{
                        title: 'Result',
                        url: 'https://example.com',
                        description: `${query}:${limit}:${context?.searchMode ?? 'none'}`,
                        source: 'example.com',
                        engine: 'bing'
                    }];
                }
            },
            fetchGithubReadme: async () => '# README',
            fetchWebContent: async (url, maxChars) => ({
                url,
                finalUrl: url,
                contentType: 'text/plain',
                title: 'Example',
                retrievalMethod: 'request' as const,
                truncated: false,
                content: `ok:${maxChars}`
            }),
            fetchCsdnArticle: async () => ({ content: 'csdn' }),
            fetchJuejinArticle: async () => ({ content: 'juejin' }),
            fetchLinuxDoArticle: async () => ({ content: 'linuxdo' })
        }
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
        ['search', 'Open WebSearch', '--engine', 'bing', '--search-mode', 'playwright', '--json'],
        runtime,
        {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text)
        }
    );

    assertEqual(exitCode, 0, 'CLI search-mode override exit code');
    assertEqual(stderr.length, 0, 'CLI search-mode override stderr');
    const payload = JSON.parse(stdout[0]) as {
        status: string;
        data: {
            results: Array<{ description: string }>;
        };
    };
    assertEqual(payload.status, 'ok', 'CLI search-mode override status');
    assertEqual(payload.data.results[0].description, 'Open WebSearch:10:playwright', 'CLI search-mode override description');
    assertEqual(seenCalls[0].searchMode, 'playwright', 'CLI should pass search mode to runtime');

    console.log('✅ CLI runCli search-mode override');
}

async function testRunCliHumanReadable(): Promise<void> {
    const runtime = createStubRuntime();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
        ['search', 'Open WebSearch', '--engine', 'bing'],
        runtime,
        {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text)
        }
    );

    assertEqual(exitCode, 0, 'CLI human-readable exit code');
    assertEqual(stderr.length, 0, 'CLI human-readable stderr');
    assert(stdout[0].includes('Search completed for "Open WebSearch"'), 'CLI human-readable should include summary');
    assert(stdout[0].includes('https://example.com'), 'CLI human-readable should include result URL');

    console.log('✅ CLI runCli human-readable success');
}

async function testRunCliInvalidArguments(): Promise<void> {
    const runtime = createStubRuntime();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
        ['search', '--json'],
        runtime,
        {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text)
        }
    );

    assertEqual(exitCode, 1, 'CLI invalid arguments exit code');
    const payload = JSON.parse(stdout[0]) as {
        status: string;
        error: { code: string; message: string };
        hint: string;
    };
    assertEqual(payload.status, 'error', 'CLI invalid arguments status');
    assertEqual(payload.error.code, 'invalid_arguments', 'CLI invalid arguments code');
    assert(payload.error.message.includes('Search query is required'), 'CLI invalid arguments message');
    assert(payload.hint.includes('open-websearch search'), 'CLI invalid arguments hint');

    console.log('✅ CLI runCli invalid arguments');
}

async function testRunCliUnknownArgument(): Promise<void> {
    const runtime = createStubRuntime();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
        ['search', 'Open WebSearch', '--bad-flag', '--json'],
        runtime,
        {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text)
        }
    );

    assertEqual(exitCode, 1, 'CLI unknown argument exit code');
    const payload = JSON.parse(stdout[0]) as {
        status: string;
        error: { code: string; message: string };
    };
    assertEqual(payload.status, 'error', 'CLI unknown argument status');
    assertEqual(payload.error.code, 'invalid_arguments', 'CLI unknown argument code');
    assert(payload.error.message.includes('--bad-flag'), 'CLI unknown argument message');

    console.log('✅ CLI runCli unknown argument');
}

async function testRunCliFetchWebJsonSuccess(): Promise<void> {
    const runtime = createStubRuntime();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
        ['fetch-web', 'https://example.com', '--max-chars', '4321', '--json'],
        runtime,
        {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text)
        }
    );

    assertEqual(exitCode, 0, 'CLI fetch-web json success exit code');
    assertEqual(stderr.length, 0, 'CLI fetch-web json success stderr');
    const payload = JSON.parse(stdout[0]) as {
        status: string;
        data: { url: string; title: string; content: string };
    };
    assertEqual(payload.status, 'ok', 'CLI fetch-web json status');
    assertEqual(payload.data.url, 'https://example.com', 'CLI fetch-web json url');
    assertEqual(payload.data.title, 'Example', 'CLI fetch-web json title');
    assertEqual(payload.data.content, 'ok:4321', 'CLI fetch-web json content');

    console.log('✅ CLI runCli fetch-web json success');
}

async function testRunCliFetchGithubReadmeJsonSuccess(): Promise<void> {
    const runtime = createStubRuntime();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
        ['fetch-github-readme', 'https://github.com/Aas-ee/open-webSearch', '--json'],
        runtime,
        {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text)
        }
    );

    assertEqual(exitCode, 0, 'CLI fetch-github-readme json success exit code');
    assertEqual(stderr.length, 0, 'CLI fetch-github-readme json success stderr');
    const payload = JSON.parse(stdout[0]) as {
        status: string;
        data: { url: string; content: string };
    };
    assertEqual(payload.status, 'ok', 'CLI fetch-github-readme json status');
    assertEqual(payload.data.url, 'https://github.com/Aas-ee/open-webSearch', 'CLI fetch-github-readme json url');
    assertEqual(payload.data.content, '# README', 'CLI fetch-github-readme json content');

    console.log('✅ CLI runCli fetch-github-readme json success');
}

async function testRunCliFetchWebValidationFailure(): Promise<void> {
    const runtime = createStubRuntime();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
        ['fetch-web', 'http://localhost:3000/secret', '--json'],
        runtime,
        {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text)
        }
    );

    assertEqual(exitCode, 1, 'CLI fetch-web validation exit code');
    assertEqual(stderr.length, 0, 'CLI fetch-web validation stderr');
    const payload = JSON.parse(stdout[0]) as {
        status: string;
        error: { code: string; message: string };
    };
    assertEqual(payload.status, 'error', 'CLI fetch-web validation status');
    assertEqual(payload.error.code, 'validation_failed', 'CLI fetch-web validation code');
    assert(payload.error.message.includes('Invalid public HTTP(S) URL'), 'CLI fetch-web validation message');

    console.log('✅ CLI runCli fetch-web validation failure');
}

async function testRunCliFetchCsdnJsonSuccess(): Promise<void> {
    const runtime = createStubRuntime();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
        ['fetch-csdn', 'https://blog.csdn.net/user/article/details/123456', '--json'],
        runtime,
        {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text)
        }
    );

    assertEqual(exitCode, 0, 'CLI fetch-csdn json success exit code');
    assertEqual(stderr.length, 0, 'CLI fetch-csdn json success stderr');
    const payload = JSON.parse(stdout[0]) as {
        status: string;
        data: { url: string; content: string };
    };
    assertEqual(payload.status, 'ok', 'CLI fetch-csdn json status');
    assertEqual(payload.data.url, 'https://blog.csdn.net/user/article/details/123456', 'CLI fetch-csdn json url');
    assertEqual(payload.data.content, 'csdn', 'CLI fetch-csdn json content');

    console.log('✅ CLI runCli fetch-csdn json success');
}

async function testRunCliFetchJuejinJsonSuccess(): Promise<void> {
    const runtime = createStubRuntime();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
        ['fetch-juejin', 'https://juejin.cn/post/7520959840199360563', '--json'],
        runtime,
        {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text)
        }
    );

    assertEqual(exitCode, 0, 'CLI fetch-juejin json success exit code');
    assertEqual(stderr.length, 0, 'CLI fetch-juejin json success stderr');
    const payload = JSON.parse(stdout[0]) as {
        status: string;
        data: { url: string; content: string };
    };
    assertEqual(payload.status, 'ok', 'CLI fetch-juejin json status');
    assertEqual(payload.data.url, 'https://juejin.cn/post/7520959840199360563', 'CLI fetch-juejin json url');
    assertEqual(payload.data.content, 'juejin', 'CLI fetch-juejin json content');

    console.log('✅ CLI runCli fetch-juejin json success');
}

async function testRunCliFetchCsdnValidationFailure(): Promise<void> {
    const runtime = createStubRuntime();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
        ['fetch-csdn', 'https://example.com/not-csdn', '--json'],
        runtime,
        {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text)
        }
    );

    assertEqual(exitCode, 1, 'CLI fetch-csdn validation exit code');
    assertEqual(stderr.length, 0, 'CLI fetch-csdn validation stderr');
    const payload = JSON.parse(stdout[0]) as {
        status: string;
        error: { code: string; message: string };
    };
    assertEqual(payload.status, 'error', 'CLI fetch-csdn validation status');
    assertEqual(payload.error.code, 'validation_failed', 'CLI fetch-csdn validation code');
    assert(payload.error.message.includes('Invalid csdn article URL'), 'CLI fetch-csdn validation message');

    console.log('✅ CLI runCli fetch-csdn validation failure');
}

async function testRunCliFetchLinuxDoJsonSuccess(): Promise<void> {
    const runtime = createStubRuntime();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
        ['fetch-linuxdo', 'https://linux.do/t/topic/123.json', '--json'],
        runtime,
        {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text)
        }
    );

    assertEqual(exitCode, 0, 'CLI fetch-linuxdo json success exit code');
    assertEqual(stderr.length, 0, 'CLI fetch-linuxdo json success stderr');
    const payload = JSON.parse(stdout[0]) as {
        status: string;
        data: { url: string; content: string };
    };
    assertEqual(payload.status, 'ok', 'CLI fetch-linuxdo json status');
    assertEqual(payload.data.url, 'https://linux.do/t/topic/123.json', 'CLI fetch-linuxdo json url');
    assertEqual(payload.data.content, 'linuxdo', 'CLI fetch-linuxdo json content');

    console.log('✅ CLI runCli fetch-linuxdo json success');
}

async function testRunCliFetchLinuxDoValidationFailure(): Promise<void> {
    const runtime = createStubRuntime();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
        ['fetch-linuxdo', 'https://linux.do/t/topic/123', '--json'],
        runtime,
        {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text)
        }
    );

    assertEqual(exitCode, 1, 'CLI fetch-linuxdo validation exit code');
    assertEqual(stderr.length, 0, 'CLI fetch-linuxdo validation stderr');
    const payload = JSON.parse(stdout[0]) as {
        status: string;
        error: { code: string; message: string };
    };
    assertEqual(payload.status, 'error', 'CLI fetch-linuxdo validation status');
    assertEqual(payload.error.code, 'validation_failed', 'CLI fetch-linuxdo validation code');
    assert(payload.error.message.includes('Invalid linuxdo article URL'), 'CLI fetch-linuxdo validation message');

    console.log('✅ CLI runCli fetch-linuxdo validation failure');
}

async function testRunCliPrefersDaemonWhenAvailable(): Promise<void> {
    const localRuntime = createStubRuntime();
    const daemonRuntime = createOpenWebSearchRuntime({
        config: createTestConfig(),
        dependencies: {
            searchExecutors: {
                bing: async () => [{
                    title: 'Daemon Result',
                    url: 'https://daemon.example.com',
                    description: 'served-by-daemon',
                    source: 'daemon.example.com',
                    engine: 'bing'
                }]
            },
            fetchGithubReadme: async () => '# README',
            fetchWebContent: async (url, maxChars) => ({
                url,
                finalUrl: url,
                contentType: 'text/plain',
                title: 'Example',
                retrievalMethod: 'request' as const,
                truncated: false,
                content: `daemon:${maxChars}`
            }),
            fetchCsdnArticle: async () => ({ content: 'daemon-csdn' }),
            fetchJuejinArticle: async () => ({ content: 'daemon-juejin' }),
            fetchLinuxDoArticle: async () => ({ content: 'daemon-linuxdo' })
        }
    });

    const daemon = await startLocalDaemon(daemonRuntime, { port: 0, version: 'daemon-test' });
    try {
        await withEnv('OPEN_WEBSEARCH_DAEMON_URL', daemon.baseUrl, async () => {
            const stdout: string[] = [];
            const stderr: string[] = [];
            const exitCode = await runCli(
                ['search', 'Open WebSearch', '--json'],
                localRuntime,
                {
                    stdout: (text) => stdout.push(text),
                    stderr: (text) => stderr.push(text)
                }
            );

            assertEqual(exitCode, 0, 'CLI daemon preferred exit code');
            assertEqual(stderr.length, 0, 'CLI daemon preferred stderr');
            const payload = JSON.parse(stdout[0]) as {
                status: string;
                data: { results: Array<{ description: string }> };
            };
            assertEqual(payload.status, 'ok', 'CLI daemon preferred payload status');
            assertEqual(payload.data.results[0].description, 'served-by-daemon', 'CLI should prefer daemon result');
        });

        console.log('✅ CLI prefers daemon when available');
    } finally {
        await daemon.close();
    }
}

async function testRunCliExplicitDaemonUnavailable(): Promise<void> {
    const runtime = createStubRuntime();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
        ['search', 'Open WebSearch', '--daemon-url', 'http://127.0.0.1:65530', '--json'],
        runtime,
        {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text)
        }
    );

    assertEqual(exitCode, 1, 'CLI explicit daemon unavailable exit code');
    assertEqual(stderr.length, 0, 'CLI explicit daemon unavailable stderr');
    const payload = JSON.parse(stdout[0]) as {
        status: string;
        error: { code: string; message: string };
        hint: string;
    };
    assertEqual(payload.status, 'error', 'CLI explicit daemon unavailable payload status');
    assertEqual(payload.error.code, 'daemon_unavailable', 'CLI explicit daemon unavailable code');
    assert(payload.error.message.includes('not reachable'), 'CLI explicit daemon unavailable message');
    assert(payload.hint.includes('serve'), 'CLI explicit daemon unavailable hint');

    console.log('✅ CLI explicit daemon unavailable');
}

async function testRunCliSpawnStartsDaemon(): Promise<void> {
    const runtime = createStubRuntime();
    const daemonRuntime = createOpenWebSearchRuntime({
        config: createTestConfig(),
        dependencies: {
            searchExecutors: {
                bing: async () => [{
                    title: 'Spawned Result',
                    url: 'https://spawned.example.com',
                    description: 'served-after-spawn',
                    source: 'spawned.example.com',
                    engine: 'bing'
                }]
            },
            fetchGithubReadme: async () => '# README',
            fetchWebContent: async (url, maxChars) => ({
                url,
                finalUrl: url,
                contentType: 'text/plain',
                title: 'Example',
                retrievalMethod: 'request' as const,
                truncated: false,
                content: `spawned:${maxChars}`
            }),
            fetchCsdnArticle: async () => ({ content: 'spawned-csdn' }),
            fetchJuejinArticle: async () => ({ content: 'spawned-juejin' }),
            fetchLinuxDoArticle: async () => ({ content: 'spawned-linuxdo' })
        }
    });

    let daemonHandle: LocalDaemonHandle | null = null;

    try {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const exitCode = await runCli(
            ['search', 'Open WebSearch', '--daemon-url', 'http://127.0.0.1:3217', '--spawn', '--json'],
            runtime,
            {
                stdout: (text) => stdout.push(text),
                stderr: (text) => stderr.push(text)
            },
            {
                spawnDaemon: async ({ host, port }) => {
                    daemonHandle = await startLocalDaemon(daemonRuntime, { host, port, version: 'spawned' });
                }
            }
        );

        assertEqual(exitCode, 0, 'CLI spawn exit code');
        assertEqual(stderr.length, 0, 'CLI spawn stderr');
        const payload = JSON.parse(stdout[0]) as {
            status: string;
            data: { results: Array<{ description: string }> };
        };
        assertEqual(payload.status, 'ok', 'CLI spawn payload status');
        assertEqual(payload.data.results[0].description, 'served-after-spawn', 'CLI spawn should use newly started daemon');

        console.log('✅ CLI spawn starts daemon');
    } finally {
        const handle = daemonHandle as LocalDaemonHandle | null;
        if (handle) {
            await handle.close();
        }
    }
}

async function testRunCliUnknownCommandJson(): Promise<void> {
    const runtime = createStubRuntime();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
        ['not-a-command', '--json'],
        runtime,
        {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text)
        }
    );

    assertEqual(exitCode, 1, 'CLI unknown command exit code');
    assertEqual(stderr.length, 0, 'CLI unknown command stderr');
    const payload = JSON.parse(stdout[0]) as {
        status: string;
        error: { code: string; message: string };
        hint: string;
    };
    assertEqual(payload.status, 'error', 'CLI unknown command status');
    assertEqual(payload.error.code, 'invalid_arguments', 'CLI unknown command code');
    assert(payload.error.message.includes('Unknown CLI command'), 'CLI unknown command message');
    assert(payload.hint.includes('search'), 'CLI unknown command hint');

    console.log('✅ CLI runCli unknown command json');
}

async function testRunCliNoArgsFallsThrough(): Promise<void> {
    const runtime = createStubRuntime();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
        [],
        runtime,
        {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text)
        }
    );

    assertEqual(exitCode, null, 'CLI no-args should fall through to MCP startup path');
    assertEqual(stdout.length, 0, 'CLI no-args stdout');
    assertEqual(stderr.length, 0, 'CLI no-args stderr');

    console.log('✅ CLI runCli no-args fallthrough');
}

async function main(): Promise<void> {
    testParseSearchArgs();
    testParseFetchArgs();
    await testRunCliJsonSuccess();
    await testRunCliSearchModeOverride();
    await testRunCliHumanReadable();
    await testRunCliInvalidArguments();
    await testRunCliUnknownArgument();
    await testRunCliFetchWebJsonSuccess();
    await testRunCliFetchGithubReadmeJsonSuccess();
    await testRunCliFetchWebValidationFailure();
    await testRunCliFetchCsdnJsonSuccess();
    await testRunCliFetchJuejinJsonSuccess();
    await testRunCliFetchCsdnValidationFailure();
    await testRunCliFetchLinuxDoJsonSuccess();
    await testRunCliFetchLinuxDoValidationFailure();
    await testRunCliPrefersDaemonWhenAvailable();
    await testRunCliExplicitDaemonUnavailable();
    await testRunCliSpawnStartsDaemon();
    await testRunCliUnknownCommandJson();
    await testRunCliNoArgsFallsThrough();
    console.log('\nCLI command tests passed.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
