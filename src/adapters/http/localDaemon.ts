import express from 'express';
import http from 'node:http';
import { AppConfig } from '../../config.js';
import { OpenWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import { createErrorEnvelope, createSuccessEnvelope } from '../../cli/protocol.js';
import { normalizeEngineName, resolveRequestedEngines, SupportedSearchEngine } from '../../core/search/searchEngines.js';
import { shutdownLocalPlaywrightBrowserSessions } from '../../utils/playwrightClient.js';

export type LocalDaemonOptions = {
    host?: string;
    port?: number;
    version?: string;
};

export type LocalDaemonStatus = {
    daemon: 'running';
    runtime: 'ready';
    activation: 'active';
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

export type LocalDaemonHandle = {
    host: string;
    port: number;
    baseUrl: string;
    server: http.Server;
    getStatus: () => LocalDaemonStatus;
    close: () => Promise<void>;
};

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3210;

function getCapabilities(): string[] {
    return [
        'search',
        'fetch-web',
        'fetch-csdn',
        'fetch-juejin',
        'fetch-github-readme',
        'fetch-linuxdo'
    ];
}

function sendError(
    res: express.Response,
    statusCode: number,
    code: string,
    message: string,
    options: {
        retryable?: boolean;
        details?: Record<string, unknown>;
        hint?: string | null;
    } = {}
): void {
    res.status(statusCode).json(createErrorEnvelope(code, message, options));
}

function parseRequestedEngines(runtime: OpenWebSearchRuntime, engines: unknown): SupportedSearchEngine[] {
    if (engines === undefined) {
        return [runtime.config.defaultSearchEngine as SupportedSearchEngine];
    }

    if (!Array.isArray(engines) || engines.some((engine) => typeof engine !== 'string')) {
        throw new Error('engines must be an array of strings');
    }

    if (engines.length === 0) {
        throw new Error('engines must not be empty');
    }

    const normalized = engines
        .map((engine) => normalizeEngineName(engine))
        .filter(Boolean);

    return resolveRequestedEngines(
        normalized,
        runtime.config.allowedSearchEngines,
        runtime.config.defaultSearchEngine
    ) as SupportedSearchEngine[];
}

function parseLimit(limit: unknown): number {
    if (limit === undefined) {
        return 10;
    }

    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new Error('limit must be an integer between 1 and 50');
    }

    return limit;
}

function parseSearchMode(searchMode: unknown): AppConfig['searchMode'] | undefined {
    if (searchMode === undefined) {
        return undefined;
    }

    if (searchMode !== 'request' && searchMode !== 'auto' && searchMode !== 'playwright') {
        throw new Error('searchMode must be one of: request, auto, playwright');
    }

    return searchMode;
}

function parseUrl(url: unknown): string {
    if (typeof url !== 'string' || !url.trim()) {
        throw new Error('url must be a non-empty string');
    }

    return url.trim();
}

function parseMaxChars(maxChars: unknown): number {
    if (maxChars === undefined) {
        return 30000;
    }

    if (typeof maxChars !== 'number' || !Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 200000) {
        throw new Error('maxChars must be an integer between 1000 and 200000');
    }

    return maxChars;
}

function parseBooleanFlag(value: unknown, name: string): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'boolean') {
        throw new Error(`${name} must be a boolean`);
    }
    return value;
}

export async function startLocalDaemon(
    runtime: OpenWebSearchRuntime,
    options: LocalDaemonOptions = {}
): Promise<LocalDaemonHandle> {
    const host = options.host ?? DEFAULT_HOST;
    const requestedPort = options.port ?? Number(process.env.OPEN_WEBSEARCH_DAEMON_PORT || DEFAULT_PORT);
    const version = options.version ?? 'unknown';

    const app = express();
    app.use(express.json());

    let baseUrl = '';

    const getStatus = (): LocalDaemonStatus => ({
        daemon: 'running',
        runtime: 'ready',
        activation: 'active',
        version,
        capabilities: getCapabilities(),
        baseUrl,
        configSummary: {
            defaultSearchEngine: runtime.config.defaultSearchEngine,
            allowedSearchEngines: runtime.config.allowedSearchEngines,
            searchMode: runtime.config.searchMode,
            useProxy: runtime.config.useProxy,
            fetchWebAllowInsecureTls: runtime.config.fetchWebAllowInsecureTls
        }
    });

    app.get('/health', (_req, res) => {
        res.json(createSuccessEnvelope({
            daemon: 'running'
        }));
    });

    app.get('/status', (_req, res) => {
        res.json(createSuccessEnvelope(getStatus()));
    });

    app.post('/search', async (req, res) => {
        try {
            const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
            if (!query) {
                sendError(
                    res,
                    400,
                    'invalid_request',
                    'query must be a non-empty string',
                    { hint: 'Provide a search query and optionally limit and engines.' }
                );
                return;
            }

            const limit = parseLimit(req.body?.limit);
            const engines = parseRequestedEngines(runtime, req.body?.engines);
            const searchMode = parseSearchMode(req.body?.searchMode);
            const result = await runtime.services.search.execute({
                query,
                limit,
                engines,
                searchMode
            });
            res.json(createSuccessEnvelope(result));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const statusCode = message.includes('must') || message.includes('empty') ? 400 : 500;
            sendError(
                res,
                statusCode,
                statusCode === 400 ? 'invalid_request' : 'engine_error',
                message,
                {
                    hint: statusCode === 400
                        ? 'Use a non-empty query, a limit between 1 and 50, valid engine names, and an optional searchMode of request/auto/playwright.'
                        : 'Retry with a different engine or inspect daemon/runtime configuration.'
                }
            );
        }
    });

    app.post('/fetch-web', async (req, res) => {
        try {
            const url = parseUrl(req.body?.url);
            const maxChars = parseMaxChars(req.body?.maxChars);
            const readability = parseBooleanFlag(req.body?.readability, 'readability');
            const includeLinks = parseBooleanFlag(req.body?.includeLinks, 'includeLinks');
            const result = await runtime.services.fetchWeb.execute({ url, maxChars, readability, includeLinks });
            res.json(createSuccessEnvelope(result));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendError(res, 400, 'validation_failed', message, {
                hint: 'Use a public HTTP(S) URL, keep maxChars within the supported range, and pass readability/includeLinks only as booleans.'
            });
        }
    });

    app.post('/fetch-github-readme', async (req, res) => {
        try {
            const url = parseUrl(req.body?.url);
            const result = await runtime.services.fetchGithubReadme.execute({ url });

            if (!result) {
                sendError(res, 404, 'not_found', 'README not found or repository does not exist', {
                    hint: 'Verify the repository URL and default branch contents.'
                });
                return;
            }

            res.json(createSuccessEnvelope({
                url,
                content: result
            }));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendError(res, 400, 'validation_failed', message, {
                hint: 'Use a valid GitHub repository URL in HTTPS or SSH form.'
            });
        }
    });

    app.post('/fetch-csdn', async (req, res) => {
        try {
            const url = parseUrl(req.body?.url);
            const result = await runtime.services.fetchCsdnArticle.execute({ url });
            res.json(createSuccessEnvelope({
                url,
                content: result.content
            }));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendError(res, 400, 'validation_failed', message, {
                hint: 'Use a valid blog.csdn.net article URL.'
            });
        }
    });

    app.post('/fetch-juejin', async (req, res) => {
        try {
            const url = parseUrl(req.body?.url);
            const result = await runtime.services.fetchJuejinArticle.execute({ url });
            res.json(createSuccessEnvelope({
                url,
                content: result.content
            }));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendError(res, 400, 'validation_failed', message, {
                hint: 'Use a valid juejin.cn post URL.'
            });
        }
    });

    app.post('/fetch-linuxdo', async (req, res) => {
        try {
            const url = parseUrl(req.body?.url);
            const result = await runtime.services.fetchLinuxDoArticle.execute({ url });
            res.json(createSuccessEnvelope({
                url,
                content: result.content
            }));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendError(res, 400, 'validation_failed', message, {
                hint: 'Use a valid linux.do topic JSON URL.'
            });
        }
    });

    const server = await new Promise<http.Server>((resolve, reject) => {
        const startedServer = app.listen(requestedPort, host, () => resolve(startedServer));
        startedServer.on('error', reject);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Failed to resolve local daemon address');
    }

    baseUrl = `http://${host}:${address.port}`;

    return {
        host,
        port: address.port,
        baseUrl,
        server,
        getStatus,
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });

            // 修复本地 daemon 结束后浏览器残留的问题：
            // daemon 原来只关闭 HTTP server，没有显式销毁共享 Playwright 浏览器会话。
            // 这里在服务停止后同步回收当前进程持有的浏览器实例，确保 Edge 根进程一并退出。
            await shutdownLocalPlaywrightBrowserSessions();
        }
    };
}
