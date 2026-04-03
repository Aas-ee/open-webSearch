import { SupportedSearchEngine, normalizeEngineName, resolveRequestedEngines } from '../core/search/searchEngines.js';
import { OpenWebSearchRuntime } from '../runtime/runtimeTypes.js';
import { CliEnvelope, createErrorEnvelope, createSuccessEnvelope } from './protocol.js';
import { startLocalDaemon } from '../adapters/http/localDaemon.js';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { AppConfig } from '../config.js';

export type CliIo = {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
};

const COMMANDS_REQUIRING_RUNTIME = new Set([
    'search',
    'fetch-web',
    'fetch-github-readme',
    'fetch-csdn',
    'fetch-juejin',
    'fetch-linuxdo',
    'serve'
]);

export function commandNeedsRuntime(argv: string[]): boolean {
    if (argv.length === 0) {
        return false;
    }

    const [command] = argv;
    return COMMANDS_REQUIRING_RUNTIME.has(command);
}

export type ParsedSearchArgs = {
    query: string;
    limit: number;
    engines: SupportedSearchEngine[];
    searchMode?: AppConfig['searchMode'];
    json: boolean;
};

export type ParsedFetchWebArgs = {
    url: string;
    maxChars: number;
    json: boolean;
};

export type ParsedFetchGithubArgs = {
    url: string;
    json: boolean;
};

export type ParsedStatusArgs = {
    baseUrl: string;
    json: boolean;
};

export type ParsedServeArgs = {
    host: string;
    port: number;
};

type DaemonTransportArgs = {
    argv: string[];
    daemonUrl: string;
    daemonUrlExplicit: boolean;
    spawn: boolean;
};

class DaemonUnavailableError extends Error {}

export type RunCliOptions = {
    spawnDaemon?: (args: ParsedServeArgs) => Promise<void> | void;
    signalSource?: Pick<EventEmitter, 'once' | 'removeListener'>;
};

function isFlag(value: string): boolean {
    return value.startsWith('--');
}

function getDefaultDaemonBaseUrl(): string {
    return process.env.OPEN_WEBSEARCH_DAEMON_URL || `http://127.0.0.1:${process.env.OPEN_WEBSEARCH_DAEMON_PORT || '3210'}`;
}

function extractDaemonTransportArgs(argv: string[]): DaemonTransportArgs {
    const passthrough: string[] = [];
    let daemonUrl = getDefaultDaemonBaseUrl();
    let daemonUrlExplicit = false;
    let shouldSpawn = false;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '--spawn') {
            shouldSpawn = true;
            continue;
        }

        if (arg === '--daemon-url') {
            const next = argv[index + 1];
            if (!next || isFlag(next)) {
                throw new Error('Missing value for --daemon-url');
            }

            daemonUrl = next;
            daemonUrlExplicit = true;
            index += 1;
            continue;
        }

        passthrough.push(arg);
    }

    return {
        argv: passthrough,
        daemonUrl,
        daemonUrlExplicit,
        spawn: shouldSpawn
    };
}

export function parseSearchArgs(argv: string[], runtime: OpenWebSearchRuntime): ParsedSearchArgs {
    const positional: string[] = [];
    const requestedEngines: string[] = [];
    let limit = 10;
    let searchMode: AppConfig['searchMode'] | undefined;
    let json = false;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '--json') {
            json = true;
            continue;
        }

        if (arg === '--limit') {
            const next = argv[index + 1];
            if (!next || isFlag(next)) {
                throw new Error('Missing value for --limit');
            }
            limit = Number(next);
            index += 1;
            continue;
        }

        if (arg === '--engine') {
            const next = argv[index + 1];
            if (!next || isFlag(next)) {
                throw new Error('Missing value for --engine');
            }
            requestedEngines.push(normalizeEngineName(next));
            index += 1;
            continue;
        }

        if (arg === '--engines') {
            const next = argv[index + 1];
            if (!next || isFlag(next)) {
                throw new Error('Missing value for --engines');
            }
            requestedEngines.push(...next.split(',').map((value) => normalizeEngineName(value.trim())).filter(Boolean));
            index += 1;
            continue;
        }

        if (arg === '--search-mode') {
            const next = argv[index + 1];
            if (!next || isFlag(next)) {
                throw new Error('Missing value for --search-mode');
            }
            if (next !== 'request' && next !== 'auto' && next !== 'playwright') {
                throw new Error('search mode must be one of: request, auto, playwright');
            }
            searchMode = next;
            index += 1;
            continue;
        }

        if (isFlag(arg)) {
            throw new Error(`Unknown argument: ${arg}`);
        }

        positional.push(arg);
    }

    const query = positional.join(' ').trim();
    if (!query) {
        throw new Error('Search query is required');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new Error('Limit must be an integer between 1 and 50');
    }

    const normalizedRequestedEngines = requestedEngines.length > 0
        ? requestedEngines
        : [runtime.config.defaultSearchEngine];
    const resolvedEngines = resolveRequestedEngines(
        normalizedRequestedEngines,
        runtime.config.allowedSearchEngines,
        runtime.config.defaultSearchEngine
    ) as SupportedSearchEngine[];

    return {
        query,
        limit,
        engines: resolvedEngines,
        searchMode,
        json
    };
}

export function parseFetchWebArgs(argv: string[]): ParsedFetchWebArgs {
    const positional: string[] = [];
    let maxChars = 30000;
    let json = false;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '--json') {
            json = true;
            continue;
        }

        if (arg === '--max-chars') {
            const next = argv[index + 1];
            if (!next || isFlag(next)) {
                throw new Error('Missing value for --max-chars');
            }
            maxChars = Number(next);
            index += 1;
            continue;
        }

        if (isFlag(arg)) {
            throw new Error(`Unknown argument: ${arg}`);
        }

        positional.push(arg);
    }

    const url = positional.join(' ').trim();
    if (!url) {
        throw new Error('Target URL is required');
    }
    if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 200000) {
        throw new Error('maxChars must be an integer between 1000 and 200000');
    }

    return {
        url,
        maxChars,
        json
    };
}

export function parseFetchGithubArgs(argv: string[]): ParsedFetchGithubArgs {
    const positional: string[] = [];
    let json = false;

    for (const arg of argv) {
        if (arg === '--json') {
            json = true;
            continue;
        }

        if (isFlag(arg)) {
            throw new Error(`Unknown argument: ${arg}`);
        }

        positional.push(arg);
    }

    const url = positional.join(' ').trim();
    if (!url) {
        throw new Error('Target URL is required');
    }

    return {
        url,
        json
    };
}

export function parseStatusArgs(argv: string[]): ParsedStatusArgs {
    let baseUrl = process.env.OPEN_WEBSEARCH_DAEMON_URL || `http://127.0.0.1:${process.env.OPEN_WEBSEARCH_DAEMON_PORT || '3210'}`;
    let json = false;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '--json') {
            json = true;
            continue;
        }

        if (arg === '--base-url') {
            const next = argv[index + 1];
            if (!next || isFlag(next)) {
                throw new Error('Missing value for --base-url');
            }
            baseUrl = next;
            index += 1;
            continue;
        }

        if (isFlag(arg)) {
            throw new Error(`Unknown argument: ${arg}`);
        }

        throw new Error(`Unexpected positional argument: ${arg}`);
    }

    return {
        baseUrl,
        json
    };
}

export function parseServeArgs(argv: string[]): ParsedServeArgs {
    let host = process.env.OPEN_WEBSEARCH_DAEMON_HOST || '127.0.0.1';
    let port = Number(process.env.OPEN_WEBSEARCH_DAEMON_PORT || '3210');

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '--host') {
            const next = argv[index + 1];
            if (!next || isFlag(next)) {
                throw new Error('Missing value for --host');
            }
            host = next;
            index += 1;
            continue;
        }

        if (arg === '--port') {
            const next = argv[index + 1];
            if (!next || isFlag(next)) {
                throw new Error('Missing value for --port');
            }
            port = Number(next);
            index += 1;
            continue;
        }

        if (isFlag(arg)) {
            throw new Error(`Unknown argument: ${arg}`);
        }

        throw new Error(`Unexpected positional argument: ${arg}`);
    }

    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('Port must be an integer between 0 and 65535');
    }

    return {
        host,
        port
    };
}

function formatSearchHumanReadable(result: Awaited<ReturnType<OpenWebSearchRuntime['services']['search']['execute']>>): string {
    const lines = [
        `Search completed for "${result.query}"`,
        `Engines: ${result.engines.join(', ')}`,
        `Results: ${result.totalResults}`
    ];

    if (result.partialFailures.length > 0) {
        lines.push(`Partial failures: ${result.partialFailures.length}`);
    }

    result.results.forEach((item, index) => {
        lines.push('');
        lines.push(`${index + 1}. ${item.title}`);
        lines.push(`   ${item.url}`);
        lines.push(`   ${item.description}`);
    });

    return lines.join('\n');
}

function formatFetchWebHumanReadable(result: Awaited<ReturnType<OpenWebSearchRuntime['services']['fetchWeb']['execute']>>): string {
    const lines = [
        `Fetched web content from ${result.finalUrl}`,
        `Title: ${result.title ?? '(none)'}`,
        `Content-Type: ${result.contentType}`,
        `Retrieval: ${result.retrievalMethod}`,
        `Truncated: ${result.truncated ? 'yes' : 'no'}`,
        '',
        result.content
    ];

    return lines.join('\n');
}

function formatGithubReadmeHumanReadable(url: string, content: string): string {
    return `Fetched GitHub README from ${url}\n\n${content}`;
}

function formatArticleHumanReadable(label: string, url: string, content: string): string {
    return `Fetched ${label} article from ${url}\n\n${content}`;
}

function formatStatusHumanReadable(status: {
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
}): string {
    return [
        `Daemon: ${status.daemon}`,
        `Runtime: ${status.runtime}`,
        `Activation: ${status.activation}`,
        `Version: ${status.version}`,
        `Base URL: ${status.baseUrl}`,
        `Capabilities: ${status.capabilities.join(', ')}`,
        `Default engine: ${status.configSummary.defaultSearchEngine}`,
        `Allowed engines: ${status.configSummary.allowedSearchEngines.length > 0 ? status.configSummary.allowedSearchEngines.join(', ') : '(all)'}`,
        `Search mode: ${status.configSummary.searchMode}`,
        `Proxy enabled: ${status.configSummary.useProxy ? 'yes' : 'no'}`,
        `Fetch web insecure TLS: ${status.configSummary.fetchWebAllowInsecureTls ? 'yes' : 'no'}`
    ].join('\n');
}

type StatusPayload = CliEnvelope<{
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
}>;

async function requestJsonWithTimeout<T>(
    url: string,
    options: {
        method?: 'GET' | 'POST';
        body?: Record<string, unknown>;
        timeoutMs: number;
    }
): Promise<T> {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const payload = options.body ? JSON.stringify(options.body) : null;
    const method = options.method ?? 'GET';

    return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            req.destroy(new Error(`Timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);

        const req = transport.request(target, {
            method,
            timeout: options.timeoutMs,
            headers: payload ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload)
            } : undefined
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                clearTimeout(timer);
                try {
                    resolve(JSON.parse(data) as T);
                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error(`Timed out after ${options.timeoutMs}ms`));
        });
        req.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<T> {
    return requestJsonWithTimeout<T>(url, {
        method: 'GET',
        timeoutMs
    });
}

async function requestDaemonEnvelope<T>(
    transport: DaemonTransportArgs,
    path: string,
    body: Record<string, unknown>
): Promise<CliEnvelope<T>> {
    try {
        return await requestJsonWithTimeout<CliEnvelope<T>>(new URL(path, transport.daemonUrl).toString(), {
            method: 'POST',
            body,
            timeoutMs: transport.daemonUrlExplicit ? 2000 : 300
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new DaemonUnavailableError(`Local daemon at ${transport.daemonUrl} is not reachable: ${message}`);
    }
}

async function tryDaemonRequest<T>(
    transport: DaemonTransportArgs,
    path: string,
    body: Record<string, unknown>,
    options: RunCliOptions = {}
): Promise<CliEnvelope<T> | null> {
    try {
        return await requestDaemonEnvelope<T>(transport, path, body);
    } catch (error) {
        if (error instanceof DaemonUnavailableError && transport.spawn) {
            const serveArgs = resolveServeArgsFromDaemonUrl(transport.daemonUrl);
            await (options.spawnDaemon ?? defaultSpawnDaemon)(serveArgs);
            await waitForDaemonReady(transport.daemonUrl, 4000);
            return await requestDaemonEnvelope<T>(transport, path, body);
        }

        if (error instanceof DaemonUnavailableError && !transport.daemonUrlExplicit) {
            return null;
        }
        throw error;
    }
}

function isSuccessEnvelope<T>(envelope: CliEnvelope<T>): envelope is CliEnvelope<T> & { status: 'ok'; data: T } {
    return envelope.status === 'ok' && envelope.data !== null;
}

function formatEnvelopeError(envelope: CliEnvelope<unknown>): string {
    return envelope.error?.message ?? 'Unknown daemon error';
}

function resolveServeArgsFromDaemonUrl(daemonUrl: string): ParsedServeArgs {
    const parsed = new URL(daemonUrl);
    if (parsed.protocol !== 'http:') {
        throw new Error('Only local HTTP daemon URLs can be auto-started');
    }
    if (parsed.pathname !== '/' && parsed.pathname !== '') {
        throw new Error('Daemon URL for --spawn must not include a path');
    }
    if (!parsed.port) {
        throw new Error('Daemon URL for --spawn must include an explicit port');
    }

    const hostname = parsed.hostname;
    const isLocalHost = hostname === '127.0.0.1' || hostname === 'localhost';
    if (!isLocalHost) {
        throw new Error('Only localhost daemon URLs can be auto-started');
    }

    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Daemon URL for --spawn must include a valid port');
    }

    return {
        host: hostname === 'localhost' ? '127.0.0.1' : hostname,
        port
    };
}

async function waitForDaemonReady(baseUrl: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const payload = await fetchJsonWithTimeout<CliEnvelope<{ daemon: string }>>(
                new URL('/health', baseUrl).toString(),
                300
            );
            if (payload.status === 'ok') {
                return;
            }
        } catch {
            // Retry until timeout expires.
        }

        await new Promise((resolve) => setTimeout(resolve, 150));
    }

    throw new Error(`Timed out waiting for local daemon at ${baseUrl}`);
}

async function defaultSpawnDaemon(args: ParsedServeArgs): Promise<void> {
    const entrypoint = process.argv[1];
    if (!entrypoint) {
        throw new Error('Cannot determine CLI entrypoint for --spawn');
    }

    const child = spawn(process.execPath, [entrypoint, 'serve', '--host', args.host, '--port', String(args.port)], {
        detached: true,
        stdio: 'ignore'
    });

    child.unref();
}

export async function runCli(
    argv: string[],
    runtime: OpenWebSearchRuntime,
    io: CliIo,
    options: RunCliOptions = {}
): Promise<number | null> {
    if (argv.length === 0) {
        return null;
    }

    const [command, ...rest] = argv;

    if (command === 'search') {
        let transport: DaemonTransportArgs;
        let parsed: ParsedSearchArgs;
        try {
            transport = extractDaemonTransportArgs(rest);
            parsed = parseSearchArgs(transport.argv, runtime);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (rest.includes('--json')) {
                io.stdout(JSON.stringify(createErrorEnvelope(
                    'invalid_arguments',
                    message,
                    { hint: 'Use `open-websearch search <query> [--limit N] [--engine NAME] [--search-mode MODE] [--json]`.' }
                ), null, 2));
            } else {
                io.stderr(message);
                io.stderr('Usage: open-websearch search <query> [--limit N] [--engine NAME] [--engines a,b] [--search-mode MODE] [--json]');
            }
            return 1;
        }

        try {
            const daemonResult = await tryDaemonRequest<Awaited<ReturnType<OpenWebSearchRuntime['services']['search']['execute']>>>(
                transport,
                '/search',
                {
                    query: parsed.query,
                    engines: parsed.engines,
                    limit: parsed.limit,
                    searchMode: parsed.searchMode
                },
                options
            );
            if (daemonResult) {
                if (parsed.json) {
                    io.stdout(JSON.stringify(daemonResult, null, 2));
                } else if (isSuccessEnvelope(daemonResult)) {
                    io.stdout(formatSearchHumanReadable(daemonResult.data));
                } else {
                    io.stderr(`Search failed: ${daemonResult.error?.message ?? 'Unknown error'}`);
                    if (daemonResult.hint) {
                        io.stderr(daemonResult.hint);
                    }
                }
                return daemonResult.status === 'ok' ? 0 : 1;
            }

            const result = await runtime.services.search.execute({
                query: parsed.query,
                engines: parsed.engines,
                limit: parsed.limit,
                searchMode: parsed.searchMode
            });

            if (parsed.json) {
                io.stdout(JSON.stringify(createSuccessEnvelope(result), null, 2));
            } else {
                io.stdout(formatSearchHumanReadable(result));
            }
            return 0;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (parsed.json) {
                io.stdout(JSON.stringify(createErrorEnvelope(
                    error instanceof DaemonUnavailableError ? 'daemon_unavailable' : 'engine_error',
                    message,
                    { hint: error instanceof DaemonUnavailableError
                        ? 'Start the local daemon with `open-websearch serve`, or remove --daemon-url to use direct execution.'
                        : 'Retry with a different engine, or inspect proxy and search mode settings.' }
                ), null, 2));
            } else {
                io.stderr(`${error instanceof DaemonUnavailableError ? 'Local daemon unavailable' : 'Search failed'}: ${message}`);
            }
            return 1;
        }
    }

    if (command === 'fetch-web') {
        let transport: DaemonTransportArgs;
        let parsed: ParsedFetchWebArgs;
        try {
            transport = extractDaemonTransportArgs(rest);
            parsed = parseFetchWebArgs(transport.argv);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (rest.includes('--json')) {
                io.stdout(JSON.stringify(createErrorEnvelope(
                    'invalid_arguments',
                    message,
                    { hint: 'Use `open-websearch fetch-web <url> [--max-chars N] [--json]`.' }
                ), null, 2));
            } else {
                io.stderr(message);
                io.stderr('Usage: open-websearch fetch-web <url> [--max-chars N] [--json]');
            }
            return 1;
        }

        try {
            const daemonResult = await tryDaemonRequest<Awaited<ReturnType<OpenWebSearchRuntime['services']['fetchWeb']['execute']>>>(
                transport,
                '/fetch-web',
                {
                    url: parsed.url,
                    maxChars: parsed.maxChars
                },
                options
            );
            if (daemonResult) {
                if (parsed.json) {
                    io.stdout(JSON.stringify(daemonResult, null, 2));
                } else if (isSuccessEnvelope(daemonResult)) {
                    io.stdout(formatFetchWebHumanReadable(daemonResult.data));
                } else {
                    io.stderr(`Fetch failed: ${daemonResult.error?.message ?? 'Unknown error'}`);
                    if (daemonResult.hint) {
                        io.stderr(daemonResult.hint);
                    }
                }
                return daemonResult.status === 'ok' ? 0 : 1;
            }

            const result = await runtime.services.fetchWeb.execute({
                url: parsed.url,
                maxChars: parsed.maxChars
            });

            if (parsed.json) {
                io.stdout(JSON.stringify(createSuccessEnvelope(result), null, 2));
            } else {
                io.stdout(formatFetchWebHumanReadable(result));
            }
            return 0;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (parsed.json) {
                io.stdout(JSON.stringify(createErrorEnvelope(
                    error instanceof DaemonUnavailableError ? 'daemon_unavailable' : 'validation_failed',
                    message,
                    { hint: error instanceof DaemonUnavailableError
                        ? 'Start the local daemon with `open-websearch serve`, or remove --daemon-url to use direct execution.'
                        : 'Use a public HTTP(S) URL and keep maxChars within the supported range.' }
                ), null, 2));
            } else {
                io.stderr(`Fetch failed: ${message}`);
            }
            return 1;
        }
    }

    if (command === 'fetch-github-readme') {
        let transport: DaemonTransportArgs;
        let parsed: ParsedFetchGithubArgs;
        try {
            transport = extractDaemonTransportArgs(rest);
            parsed = parseFetchGithubArgs(transport.argv);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (rest.includes('--json')) {
                io.stdout(JSON.stringify(createErrorEnvelope(
                    'invalid_arguments',
                    message,
                    { hint: 'Use `open-websearch fetch-github-readme <repository-url> [--json]`.' }
                ), null, 2));
            } else {
                io.stderr(message);
                io.stderr('Usage: open-websearch fetch-github-readme <repository-url> [--json]');
            }
            return 1;
        }

        try {
            const daemonResult = await tryDaemonRequest<{ url: string; content: string }>(
                transport,
                '/fetch-github-readme',
                { url: parsed.url },
                options
            );
            if (daemonResult) {
                if (parsed.json) {
                    io.stdout(JSON.stringify(daemonResult, null, 2));
                } else if (isSuccessEnvelope(daemonResult)) {
                    io.stdout(formatGithubReadmeHumanReadable(daemonResult.data.url, daemonResult.data.content));
                } else {
                    io.stderr(daemonResult.error?.message ?? 'README not found or repository does not exist');
                    if (daemonResult.hint) {
                        io.stderr(daemonResult.hint);
                    }
                }
                return daemonResult.status === 'ok' ? 0 : 1;
            }

            const result = await runtime.services.fetchGithubReadme.execute({ url: parsed.url });
            if (!result) {
                if (parsed.json) {
                    io.stdout(JSON.stringify(createErrorEnvelope(
                        'not_found',
                        'README not found or repository does not exist',
                        { hint: 'Verify the repository URL and default branch contents.' }
                    ), null, 2));
                } else {
                    io.stderr('README not found or repository does not exist');
                }
                return 1;
            }

            if (parsed.json) {
                io.stdout(JSON.stringify(createSuccessEnvelope({
                    url: parsed.url,
                    content: result
                }), null, 2));
            } else {
                io.stdout(formatGithubReadmeHumanReadable(parsed.url, result));
            }
            return 0;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (parsed.json) {
                io.stdout(JSON.stringify(createErrorEnvelope(
                    error instanceof DaemonUnavailableError ? 'daemon_unavailable' : 'validation_failed',
                    message,
                    { hint: error instanceof DaemonUnavailableError
                        ? 'Start the local daemon with `open-websearch serve`, or remove --daemon-url to use direct execution.'
                        : 'Use a valid GitHub repository URL in HTTPS or SSH form.' }
                ), null, 2));
            } else {
                io.stderr(`Fetch failed: ${message}`);
            }
            return 1;
        }
    }

    if (command === 'fetch-csdn') {
        let transport: DaemonTransportArgs;
        let parsed: ParsedFetchGithubArgs;
        try {
            transport = extractDaemonTransportArgs(rest);
            parsed = parseFetchGithubArgs(transport.argv);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (rest.includes('--json')) {
                io.stdout(JSON.stringify(createErrorEnvelope(
                    'invalid_arguments',
                    message,
                    { hint: 'Use `open-websearch fetch-csdn <article-url> [--json]`.' }
                ), null, 2));
            } else {
                io.stderr(message);
                io.stderr('Usage: open-websearch fetch-csdn <article-url> [--json]');
            }
            return 1;
        }

        try {
            const daemonResult = await tryDaemonRequest<{ url: string; content: string }>(
                transport,
                '/fetch-csdn',
                { url: parsed.url },
                options
            );
            if (daemonResult) {
                if (parsed.json) {
                    io.stdout(JSON.stringify(daemonResult, null, 2));
                } else if (isSuccessEnvelope(daemonResult)) {
                    io.stdout(formatArticleHumanReadable('CSDN', daemonResult.data.url, daemonResult.data.content));
                } else {
                    io.stderr(`Fetch failed: ${daemonResult.error?.message ?? 'Unknown error'}`);
                    if (daemonResult.hint) {
                        io.stderr(daemonResult.hint);
                    }
                }
                return daemonResult.status === 'ok' ? 0 : 1;
            }

            const result = await runtime.services.fetchCsdnArticle.execute({ url: parsed.url });
            if (parsed.json) {
                io.stdout(JSON.stringify(createSuccessEnvelope({
                    url: parsed.url,
                    content: result.content
                }), null, 2));
            } else {
                io.stdout(formatArticleHumanReadable('CSDN', parsed.url, result.content));
            }
            return 0;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (parsed.json) {
                io.stdout(JSON.stringify(createErrorEnvelope(
                    error instanceof DaemonUnavailableError ? 'daemon_unavailable' : 'validation_failed',
                    message,
                    { hint: error instanceof DaemonUnavailableError
                        ? 'Start the local daemon with `open-websearch serve`, or remove --daemon-url to use direct execution.'
                        : 'Use a valid blog.csdn.net article URL.' }
                ), null, 2));
            } else {
                io.stderr(`Fetch failed: ${message}`);
            }
            return 1;
        }
    }

    if (command === 'fetch-juejin') {
        let transport: DaemonTransportArgs;
        let parsed: ParsedFetchGithubArgs;
        try {
            transport = extractDaemonTransportArgs(rest);
            parsed = parseFetchGithubArgs(transport.argv);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (rest.includes('--json')) {
                io.stdout(JSON.stringify(createErrorEnvelope(
                    'invalid_arguments',
                    message,
                    { hint: 'Use `open-websearch fetch-juejin <article-url> [--json]`.' }
                ), null, 2));
            } else {
                io.stderr(message);
                io.stderr('Usage: open-websearch fetch-juejin <article-url> [--json]');
            }
            return 1;
        }

        try {
            const daemonResult = await tryDaemonRequest<{ url: string; content: string }>(
                transport,
                '/fetch-juejin',
                { url: parsed.url },
                options
            );
            if (daemonResult) {
                if (parsed.json) {
                    io.stdout(JSON.stringify(daemonResult, null, 2));
                } else if (isSuccessEnvelope(daemonResult)) {
                    io.stdout(formatArticleHumanReadable('Juejin', daemonResult.data.url, daemonResult.data.content));
                } else {
                    io.stderr(`Fetch failed: ${daemonResult.error?.message ?? 'Unknown error'}`);
                    if (daemonResult.hint) {
                        io.stderr(daemonResult.hint);
                    }
                }
                return daemonResult.status === 'ok' ? 0 : 1;
            }

            const result = await runtime.services.fetchJuejinArticle.execute({ url: parsed.url });
            if (parsed.json) {
                io.stdout(JSON.stringify(createSuccessEnvelope({
                    url: parsed.url,
                    content: result.content
                }), null, 2));
            } else {
                io.stdout(formatArticleHumanReadable('Juejin', parsed.url, result.content));
            }
            return 0;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (parsed.json) {
                io.stdout(JSON.stringify(createErrorEnvelope(
                    error instanceof DaemonUnavailableError ? 'daemon_unavailable' : 'validation_failed',
                    message,
                    { hint: error instanceof DaemonUnavailableError
                        ? 'Start the local daemon with `open-websearch serve`, or remove --daemon-url to use direct execution.'
                        : 'Use a valid juejin.cn post URL.' }
                ), null, 2));
            } else {
                io.stderr(`Fetch failed: ${message}`);
            }
            return 1;
        }
    }

    if (command === 'fetch-linuxdo') {
        let transport: DaemonTransportArgs;
        let parsed: ParsedFetchGithubArgs;
        try {
            transport = extractDaemonTransportArgs(rest);
            parsed = parseFetchGithubArgs(transport.argv);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (rest.includes('--json')) {
                io.stdout(JSON.stringify(createErrorEnvelope(
                    'invalid_arguments',
                    message,
                    { hint: 'Use `open-websearch fetch-linuxdo <article-url> [--json]`.' }
                ), null, 2));
            } else {
                io.stderr(message);
                io.stderr('Usage: open-websearch fetch-linuxdo <article-url> [--json]');
            }
            return 1;
        }

        try {
            const daemonResult = await tryDaemonRequest<{ url: string; content: string }>(
                transport,
                '/fetch-linuxdo',
                { url: parsed.url },
                options
            );
            if (daemonResult) {
                if (parsed.json) {
                    io.stdout(JSON.stringify(daemonResult, null, 2));
                } else if (isSuccessEnvelope(daemonResult)) {
                    io.stdout(formatArticleHumanReadable('Linux.do', daemonResult.data.url, daemonResult.data.content));
                } else {
                    io.stderr(`Fetch failed: ${daemonResult.error?.message ?? 'Unknown error'}`);
                    if (daemonResult.hint) {
                        io.stderr(daemonResult.hint);
                    }
                }
                return daemonResult.status === 'ok' ? 0 : 1;
            }

            const result = await runtime.services.fetchLinuxDoArticle.execute({ url: parsed.url });
            if (parsed.json) {
                io.stdout(JSON.stringify(createSuccessEnvelope({
                    url: parsed.url,
                    content: result.content
                }), null, 2));
            } else {
                io.stdout(formatArticleHumanReadable('Linux.do', parsed.url, result.content));
            }
            return 0;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (parsed.json) {
                io.stdout(JSON.stringify(createErrorEnvelope(
                    error instanceof DaemonUnavailableError ? 'daemon_unavailable' : 'validation_failed',
                    message,
                    { hint: error instanceof DaemonUnavailableError
                        ? 'Start the local daemon with `open-websearch serve`, or remove --daemon-url to use direct execution.'
                        : 'Use a valid linux.do topic JSON URL.' }
                ), null, 2));
            } else {
                io.stderr(`Fetch failed: ${message}`);
            }
            return 1;
        }
    }

    if (command === 'status') {
        let parsed: ParsedStatusArgs;
        try {
            parsed = parseStatusArgs(rest);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (rest.includes('--json')) {
                io.stdout(JSON.stringify(createErrorEnvelope(
                    'invalid_arguments',
                    message,
                    { hint: 'Use `open-websearch status [--base-url URL] [--json]`.' }
                ), null, 2));
            } else {
                io.stderr(message);
                io.stderr('Usage: open-websearch status [--base-url URL] [--json]');
            }
            return 1;
        }

        try {
            const payload = await fetchJsonWithTimeout<StatusPayload>(
                `${parsed.baseUrl}/status`,
                Number(process.env.OPEN_WEBSEARCH_DAEMON_TIMEOUT_MS || '2000')
            );
            if (parsed.json) {
                io.stdout(JSON.stringify(payload, null, 2));
            } else if (isSuccessEnvelope(payload)) {
                io.stdout(formatStatusHumanReadable(payload.data));
            } else {
                io.stderr(`Local open-websearch daemon returned an error: ${formatEnvelopeError(payload)}`);
                if (payload.hint) {
                    io.stderr(payload.hint);
                }
                return 1;
            }
            return 0;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (parsed.json) {
                io.stdout(JSON.stringify(createErrorEnvelope(
                    'daemon_unavailable',
                    `Local open-websearch daemon is not reachable: ${message}`,
                    {
                        retryable: true,
                        hint: 'Run `open-websearch serve` first, or point `--base-url` to a reachable daemon.'
                    }
                ), null, 2));
            } else {
                io.stderr(`Local open-websearch daemon is not reachable: ${message}`);
                io.stderr('Run `open-websearch serve` first, or point `--base-url` to a reachable daemon.');
            }
            return 1;
        }
    }

    if (command === 'serve') {
        let parsed: ParsedServeArgs;
        try {
            parsed = parseServeArgs(rest);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            io.stderr(message);
            io.stderr('Usage: open-websearch serve [--host HOST] [--port PORT]');
            return 1;
        }

        try {
            const daemon = await startLocalDaemon(runtime, {
                host: parsed.host,
                port: parsed.port
            });

            io.stdout(`Local open-websearch daemon running at ${daemon.baseUrl}`);
            const signalSource = options.signalSource ?? process;

            return await new Promise<number>((resolve) => {
                let closing = false;

                const cleanup = () => {
                    signalSource.removeListener('SIGINT', shutdown);
                    signalSource.removeListener('SIGTERM', shutdown);
                };

                const shutdown = () => {
                    if (closing) {
                        return;
                    }
                    closing = true;
                    void daemon.close()
                        .catch((closeError) => {
                            io.stderr(`Failed to close local daemon cleanly: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
                        })
                        .finally(() => {
                            cleanup();
                            resolve(0);
                        });
                };

                signalSource.once('SIGINT', shutdown);
                signalSource.once('SIGTERM', shutdown);
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            io.stderr(`Failed to start local daemon: ${message}`);
            return 1;
        }
    }

    if (rest.includes('--json')) {
        io.stdout(JSON.stringify(createErrorEnvelope(
            'invalid_arguments',
            `Unknown CLI command: ${command}`,
            {
                hint: 'Supported commands: search, fetch-web, fetch-github-readme, fetch-csdn, fetch-juejin, fetch-linuxdo, status, serve.'
            }
        ), null, 2));
    } else {
        io.stderr(`Unknown CLI command: ${command}`);
    }
    return 1;
}
