import { AppConfig } from '../config.js';
import { runCli } from '../cli/runCli.js';
import { createOpenWebSearchRuntime } from '../runtime/createRuntime.js';
import { startLocalDaemon } from '../adapters/http/localDaemon.js';
import http from 'node:http';
import { EventEmitter } from 'node:events';

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

function createStubRuntime() {
    return createOpenWebSearchRuntime({
        config: createTestConfig(),
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

async function testLocalDaemonRoutes(): Promise<void> {
    const runtime = createStubRuntime();
    const daemon = await startLocalDaemon(runtime, {
        port: 0,
        version: 'test-version'
    });

    try {
        const healthResponse = await fetch(`${daemon.baseUrl}/health`);
        const healthPayload = await healthResponse.json() as {
            status: string;
            data: { daemon: string };
        };
        assertEqual(healthPayload.status, 'ok', 'daemon /health status');
        assertEqual(healthPayload.data.daemon, 'running', 'daemon /health daemon state');

        const statusResponse = await fetch(`${daemon.baseUrl}/status`);
        const statusPayload = await statusResponse.json() as {
            status: string;
            data: {
                daemon: string;
                runtime: string;
                activation: string;
                version: string;
                capabilities: string[];
                baseUrl: string;
                configSummary: {
                    defaultSearchEngine: string;
                    allowedSearchEngines: string[];
                    searchMode: string;
                    useProxy: boolean;
                    fetchWebAllowInsecureTls: boolean;
                };
            };
        };
        assertEqual(statusPayload.status, 'ok', 'daemon /status status');
        assertEqual(statusPayload.data.daemon, 'running', 'daemon /status daemon state');
        assertEqual(statusPayload.data.runtime, 'ready', 'daemon /status runtime state');
        assertEqual(statusPayload.data.activation, 'active', 'daemon /status activation state');
        assertEqual(statusPayload.data.version, 'test-version', 'daemon /status version');
        assertEqual(statusPayload.data.baseUrl, daemon.baseUrl, 'daemon /status baseUrl');
        assert(statusPayload.data.capabilities.includes('search'), 'daemon /status capabilities');
        assertEqual(statusPayload.data.configSummary.defaultSearchEngine, 'bing', 'daemon /status config default engine');
        assertEqual(statusPayload.data.configSummary.searchMode, 'request', 'daemon /status config search mode');
        assertEqual(statusPayload.data.configSummary.useProxy, false, 'daemon /status config proxy');

        console.log('✅ local daemon health and status routes');
    } finally {
        await daemon.close();
    }
}

async function postJson<T>(baseUrl: string, path: string, body: Record<string, unknown>) {
    const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    const payload = await response.json() as T;
    return { response, payload };
}

async function testLocalDaemonOperationRoutes(): Promise<void> {
    const runtime = createStubRuntime();
    const daemon = await startLocalDaemon(runtime, {
        port: 0,
        version: 'operation-version'
    });

    try {
        const searchResult = await postJson<{
            status: string;
            data: {
                query: string;
                totalResults: number;
                engines: string[];
                results: Array<{ description: string }>;
                partialFailures: Array<{ engine: string; code: string; message: string }>;
            };
        }>(daemon.baseUrl, '/search', {
            query: 'Open WebSearch',
            limit: 3,
            engines: ['Bing', 'startpage']
        });
        assertEqual(searchResult.response.status, 200, 'daemon /search http status');
        assertEqual(searchResult.payload.status, 'ok', 'daemon /search payload status');
        assertEqual(searchResult.payload.data.query, 'Open WebSearch', 'daemon /search query');
        assertEqual(searchResult.payload.data.totalResults, 2, 'daemon /search totalResults');
        assert(searchResult.payload.data.results.some((item) => item.description === 'Open WebSearch:2'), 'daemon /search result content');

        const fetchWebResult = await postJson<{
            status: string;
            data: { url: string; title: string; content: string };
        }>(daemon.baseUrl, '/fetch-web', {
            url: 'https://example.com',
            maxChars: 1234
        });
        assertEqual(fetchWebResult.response.status, 200, 'daemon /fetch-web http status');
        assertEqual(fetchWebResult.payload.status, 'ok', 'daemon /fetch-web payload status');
        assertEqual(fetchWebResult.payload.data.url, 'https://example.com', 'daemon /fetch-web url');
        assertEqual(fetchWebResult.payload.data.content, 'ok:1234', 'daemon /fetch-web content');

        const fetchGithubResult = await postJson<{
            status: string;
            data: { url: string; content: string };
        }>(daemon.baseUrl, '/fetch-github-readme', {
            url: 'https://github.com/Aas-ee/open-webSearch'
        });
        assertEqual(fetchGithubResult.response.status, 200, 'daemon /fetch-github-readme http status');
        assertEqual(fetchGithubResult.payload.status, 'ok', 'daemon /fetch-github-readme payload status');
        assertEqual(fetchGithubResult.payload.data.content, '# README', 'daemon /fetch-github-readme content');

        const fetchCsdnResult = await postJson<{
            status: string;
            data: { url: string; content: string };
        }>(daemon.baseUrl, '/fetch-csdn', {
            url: 'https://blog.csdn.net/test/article/details/123456'
        });
        assertEqual(fetchCsdnResult.response.status, 200, 'daemon /fetch-csdn http status');
        assertEqual(fetchCsdnResult.payload.status, 'ok', 'daemon /fetch-csdn payload status');
        assertEqual(fetchCsdnResult.payload.data.content, 'csdn', 'daemon /fetch-csdn content');

        const fetchJuejinResult = await postJson<{
            status: string;
            data: { url: string; content: string };
        }>(daemon.baseUrl, '/fetch-juejin', {
            url: 'https://juejin.cn/post/1234567890'
        });
        assertEqual(fetchJuejinResult.response.status, 200, 'daemon /fetch-juejin http status');
        assertEqual(fetchJuejinResult.payload.status, 'ok', 'daemon /fetch-juejin payload status');
        assertEqual(fetchJuejinResult.payload.data.content, 'juejin', 'daemon /fetch-juejin content');

        const fetchLinuxDoResult = await postJson<{
            status: string;
            data: { url: string; content: string };
        }>(daemon.baseUrl, '/fetch-linuxdo', {
            url: 'https://linux.do/t/topic/123.json'
        });
        assertEqual(fetchLinuxDoResult.response.status, 200, 'daemon /fetch-linuxdo http status');
        assertEqual(fetchLinuxDoResult.payload.status, 'ok', 'daemon /fetch-linuxdo payload status');
        assertEqual(fetchLinuxDoResult.payload.data.content, 'linuxdo', 'daemon /fetch-linuxdo content');

        const invalidFetchWebResult = await postJson<{
            status: string;
            error: { code: string; message: string };
            hint: string;
        }>(daemon.baseUrl, '/fetch-web', {
            url: 'http://127.0.0.1/private'
        });
        assertEqual(invalidFetchWebResult.response.status, 400, 'daemon /fetch-web invalid http status');
        assertEqual(invalidFetchWebResult.payload.status, 'error', 'daemon /fetch-web invalid payload status');
        assertEqual(invalidFetchWebResult.payload.error.code, 'validation_failed', 'daemon /fetch-web invalid error code');
        assert(invalidFetchWebResult.payload.hint.includes('public HTTP(S) URL'), 'daemon /fetch-web invalid hint');

        const invalidSearchResult = await postJson<{
            status: string;
            error: { code: string; message: string };
        }>(daemon.baseUrl, '/search', {
            limit: 3
        });
        assertEqual(invalidSearchResult.response.status, 400, 'daemon /search invalid http status');
        assertEqual(invalidSearchResult.payload.status, 'error', 'daemon /search invalid payload status');
        assertEqual(invalidSearchResult.payload.error.code, 'invalid_request', 'daemon /search invalid error code');

        console.log('✅ local daemon operation routes');
    } finally {
        await daemon.close();
    }
}

async function testCliStatusJson(): Promise<void> {
    const runtime = createStubRuntime();
    const daemon = await startLocalDaemon(runtime, {
        port: 0,
        version: 'cli-status-version'
    });

    try {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const exitCode = await runCli(
            ['status', '--base-url', daemon.baseUrl, '--json'],
            runtime,
            {
                stdout: (text) => stdout.push(text),
                stderr: (text) => stderr.push(text)
            }
        );

        assertEqual(exitCode, 0, 'CLI status exit code');
        assertEqual(stderr.length, 0, 'CLI status stderr');
        const payload = JSON.parse(stdout[0]) as {
            status: string;
            data: {
                version: string;
                daemon: string;
                runtime: string;
                activation: string;
                configSummary: {
                    defaultSearchEngine: string;
                    useProxy: boolean;
                };
            };
        };
        assertEqual(payload.status, 'ok', 'CLI status payload status');
        assertEqual(payload.data.version, 'cli-status-version', 'CLI status payload version');
        assertEqual(payload.data.daemon, 'running', 'CLI status payload daemon state');
        assertEqual(payload.data.runtime, 'ready', 'CLI status payload runtime state');
        assertEqual(payload.data.activation, 'active', 'CLI status payload activation state');
        assertEqual(payload.data.configSummary.defaultSearchEngine, 'bing', 'CLI status payload default engine');
        assertEqual(payload.data.configSummary.useProxy, false, 'CLI status payload proxy state');

        console.log('✅ CLI status json success');
    } finally {
        await daemon.close();
    }
}

async function testCliStatusUnavailable(): Promise<void> {
    const runtime = createStubRuntime();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
        ['status', '--base-url', 'http://127.0.0.1:65530', '--json'],
        runtime,
        {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text)
        }
    );

    assertEqual(exitCode, 1, 'CLI unavailable status exit code');
    assertEqual(stderr.length, 0, 'CLI unavailable status stderr');
    const payload = JSON.parse(stdout[0]) as {
        status: string;
        error: { code: string; message: string };
        hint: string;
    };
    assertEqual(payload.status, 'error', 'CLI unavailable status payload status');
    assertEqual(payload.error.code, 'daemon_unavailable', 'CLI unavailable status payload code');
    assert(payload.error.message.includes('not reachable'), 'CLI unavailable status payload message');
    assert(payload.hint.includes('serve'), 'CLI unavailable status hint');

    console.log('✅ CLI status unavailable path');
}

async function testCliStatusErrorEnvelope(): Promise<void> {
    const runtime = createStubRuntime();
    const server = await new Promise<http.Server>((resolve) => {
        const started = http.createServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                status: 'error',
                data: null,
                error: {
                    code: 'daemon_error',
                    message: 'status temporarily unavailable',
                    retryable: true
                },
                hint: 'retry after daemon warmup'
            }));
        });
        started.listen(0, '127.0.0.1', () => resolve(started));
    });

    try {
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('failed to bind temporary status test server');
        }

        const stdout: string[] = [];
        const stderr: string[] = [];
        const exitCode = await runCli(
            ['status', '--base-url', `http://127.0.0.1:${address.port}`],
            runtime,
            {
                stdout: (text) => stdout.push(text),
                stderr: (text) => stderr.push(text)
            }
        );

        assertEqual(exitCode, 1, 'CLI status error-envelope exit code');
        assertEqual(stdout.length, 0, 'CLI status error-envelope stdout');
        assert(stderr[0].includes('status temporarily unavailable'), 'CLI status error-envelope message');
        assert(stderr[1].includes('retry after daemon warmup'), 'CLI status error-envelope hint');

        console.log('✅ CLI status error envelope');
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
}

async function testCliServeWaitsForSignal(): Promise<void> {
    const runtime = createStubRuntime();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const signals = new EventEmitter();

    const runPromise = runCli(
        ['serve', '--port', '0'],
        runtime,
        {
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text)
        },
        {
            signalSource: signals
        }
    );

    const deadline = Date.now() + 4000;
    while (stdout.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert(stdout.length > 0, 'CLI serve should print startup message');
    const match = stdout[0].match(/(http:\/\/127\.0\.0\.1:\d+)/);
    assert(match, 'CLI serve should report daemon baseUrl');
    const baseUrl = match[1];

    const statusResponse = await fetch(`${baseUrl}/status`);
    const statusPayload = await statusResponse.json() as { status: string; data: { daemon: string } };
    assertEqual(statusPayload.status, 'ok', 'CLI serve should keep daemon alive until signal');
    assertEqual(statusPayload.data.daemon, 'running', 'CLI serve daemon state before signal');

    signals.emit('SIGINT');
    const exitCode = await runPromise;
    assertEqual(exitCode, 0, 'CLI serve exit code after signal');
    assertEqual(stderr.length, 0, 'CLI serve stderr');

    console.log('✅ CLI serve waits for signal');
}

async function main(): Promise<void> {
    await testLocalDaemonRoutes();
    await testLocalDaemonOperationRoutes();
    await testCliStatusJson();
    await testCliStatusUnavailable();
    await testCliStatusErrorEnvelope();
    await testCliServeWaitsForSignal();
    console.log('\nLocal daemon tests passed.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
