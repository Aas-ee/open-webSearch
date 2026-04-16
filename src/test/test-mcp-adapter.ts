import { execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppConfig } from '../config.js';
import { createOpenWebSearchRuntime } from '../runtime/createRuntime.js';
import { setupTools } from '../tools/setupTools.js';

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

function createStubRuntime() {
    return createOpenWebSearchRuntime({
        dependencies: {
            searchExecutors: {
                bing: async (query, limit) => [{
                    title: 'Result',
                    url: 'https://example.com',
                    description: `${query}:${limit}`,
                    source: 'example.com',
                    engine: 'bing'
                }]
            },
            fetchGithubReadme: async () => '# README',
            fetchWebContent: async (url, maxChars, options) => ({
                url,
                finalUrl: url,
                contentType: 'text/plain',
                title: 'Example',
                retrievalMethod: 'request' as const,
                truncated: false,
                content: `ok:${maxChars}:${options?.readability ? 'readability' : 'plain'}`,
                readabilityApplied: options?.readability ?? false,
                links: options?.includeLinks ? [{ text: 'Doc', href: 'https://example.com/doc' }] : undefined
            }),
            fetchCsdnArticle: async () => ({ content: 'csdn' }),
            fetchJuejinArticle: async () => ({ content: 'juejin' }),
            fetchLinuxDoArticle: async () => ({ content: 'linuxdo' })
        }
    });
}

function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
        defaultSearchEngine: 'bing',
        allowedSearchEngines: [],
        searchMode: 'request',
        proxyUrl: '',
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

function parseJsonBlock(text: string): unknown {
    const jsonStart = text.indexOf('{');
    if (jsonStart === -1) {
        throw new Error(`No JSON block found in output: ${text}`);
    }
    return JSON.parse(text.slice(jsonStart));
}

function runModuleWithEnv(code: string, env: Record<string, string>): string {
    return execFileSync(
        process.execPath,
        ['--input-type=module', '-e', code],
        {
            cwd: process.cwd(),
            env: {
                ...process.env,
                ...env
            },
            encoding: 'utf8'
        }
    );
}

async function testSearchToolReturnsCompatiblePayload(): Promise<void> {
    const runtime = createStubRuntime();
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    setupTools(server, runtime);

    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    const response = await tools.search.handler({
        query: 'Open WebSearch',
        limit: 3,
        engines: ['bing']
    });
    const payload = JSON.parse(response.content[0].text) as {
        query: string;
        engines: string[];
        totalResults: number;
        results: Array<{ title: string; url: string; description: string; source: string; engine: string }>;
        partialFailures: Array<{ engine: string; code: string; message: string }>;
    };

    assertEqual(payload.query, 'Open WebSearch', 'search payload query');
    assertEqual(payload.engines[0], 'bing', 'search payload engine');
    assertEqual(payload.totalResults, 1, 'search payload totalResults');
    assertEqual(payload.results[0].description, 'Open WebSearch:3', 'search payload result description');
    assert(Array.isArray(payload.partialFailures), 'search payload should expose partialFailures');
    assertEqual(payload.partialFailures.length, 0, 'search payload partialFailures length');

    console.log('✅ MCP search tool returns compatible payload');
}

async function testSetupToolsUsesRuntimeConfigDefaults(): Promise<void> {
    const runtime = createOpenWebSearchRuntime({
        config: createTestConfig({
            defaultSearchEngine: 'startpage',
            allowedSearchEngines: ['startpage', 'bing']
        }),
        dependencies: {
            searchExecutors: {
                startpage: async (query, limit) => [{
                    title: 'Startpage Result',
                    url: 'https://startpage.example.com',
                    description: `${query}:${limit}`,
                    source: 'startpage.example.com',
                    engine: 'startpage'
                }],
                bing: async (query, limit) => [{
                    title: 'Bing Result',
                    url: 'https://example.com',
                    description: `${query}:${limit}`,
                    source: 'example.com',
                    engine: 'bing'
                }]
            },
            fetchGithubReadme: async () => '# README',
            fetchWebContent: async (url, maxChars, options) => ({
                url,
                finalUrl: url,
                contentType: 'text/plain',
                title: 'Example',
                retrievalMethod: 'request' as const,
                truncated: false,
                content: `ok:${maxChars}:${options?.readability ? 'readability' : 'plain'}`,
                readabilityApplied: options?.readability ?? false,
                links: options?.includeLinks ? [{ text: 'Doc', href: 'https://example.com/doc' }] : undefined
            }),
            fetchCsdnArticle: async () => ({ content: 'csdn' }),
            fetchJuejinArticle: async () => ({ content: 'juejin' }),
            fetchLinuxDoArticle: async () => ({ content: 'linuxdo' })
        }
    });
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    setupTools(server, runtime);

    const tools = (server as unknown as {
        _registeredTools: Record<string, {
            description: string;
            handler: (input: unknown) => Promise<{ content: Array<{ text: string }> }>;
        }>;
    })._registeredTools;

    const response = await tools.search.handler({
        query: 'Open WebSearch'
    });
    const payload = JSON.parse(response.content[0].text) as {
        engines: string[];
        results: Array<{ engine: string }>;
    };

    assertEqual(payload.engines[0], 'startpage', 'search handler should use runtime default engine');
    assertEqual(payload.results[0].engine, 'startpage', 'search execution should respect runtime default engine');
    assert(tools.search.description.includes('Startpage'), 'search description should use runtime-config allowed engines');

    console.log('✅ setupTools uses runtime.config defaults');
}

async function testSearchToolPassesSearchModeOverride(): Promise<void> {
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
            fetchWebContent: async (url, maxChars, options) => ({
                url,
                finalUrl: url,
                contentType: 'text/plain',
                title: 'Example',
                retrievalMethod: 'request' as const,
                truncated: false,
                content: `ok:${maxChars}:${options?.readability ? 'readability' : 'plain'}`,
                readabilityApplied: options?.readability ?? false,
                links: options?.includeLinks ? [{ text: 'Doc', href: 'https://example.com/doc' }] : undefined
            }),
            fetchCsdnArticle: async () => ({ content: 'csdn' }),
            fetchJuejinArticle: async () => ({ content: 'juejin' }),
            fetchLinuxDoArticle: async () => ({ content: 'linuxdo' })
        }
    });
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    setupTools(server, runtime);

    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    const response = await tools.search.handler({
        query: 'Open WebSearch',
        limit: 2,
        searchMode: 'playwright',
        engines: ['bing']
    });
    const payload = JSON.parse(response.content[0].text) as {
        results: Array<{ description: string }>;
    };

    assertEqual(payload.results[0].description, 'Open WebSearch:2:playwright', 'MCP search should pass request-level search mode');
    assertEqual(seenCalls[0].searchMode, 'playwright', 'MCP handler should forward search mode');

    console.log('✅ MCP search tool passes search-mode override');
}

async function testFetchWebToolPassesReadabilityFlags(): Promise<void> {
    const seenCalls: Array<{ readability?: boolean; includeLinks?: boolean }> = [];
    const runtime = createOpenWebSearchRuntime({
        config: createTestConfig(),
        dependencies: {
            searchExecutors: {
                bing: async (query, limit) => [{
                    title: 'Result',
                    url: 'https://example.com',
                    description: `${query}:${limit}`,
                    source: 'example.com',
                    engine: 'bing'
                }]
            },
            fetchGithubReadme: async () => '# README',
            fetchWebContent: async (url, maxChars, options) => {
                seenCalls.push({
                    readability: options?.readability,
                    includeLinks: options?.includeLinks
                });
                return {
                    url,
                    finalUrl: url,
                    contentType: 'text/plain',
                    title: 'Example',
                    retrievalMethod: 'request' as const,
                    truncated: false,
                    content: `ok:${maxChars}`,
                    readabilityApplied: options?.readability ?? false,
                    links: options?.includeLinks ? [{ text: 'Doc', href: 'https://example.com/doc' }] : undefined
                };
            },
            fetchCsdnArticle: async () => ({ content: 'csdn' }),
            fetchJuejinArticle: async () => ({ content: 'juejin' }),
            fetchLinuxDoArticle: async () => ({ content: 'linuxdo' })
        }
    });
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    setupTools(server, runtime);

    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    const response = await tools.fetchWebContent.handler({
        url: 'https://example.com',
        maxChars: 3000,
        readability: true,
        includeLinks: true
    });
    const payload = JSON.parse(response.content[0].text) as {
        readabilityApplied?: boolean;
        links?: Array<{ href: string }>;
    };

    assertEqual(seenCalls[0].readability, true, 'MCP fetch-web should pass readability');
    assertEqual(seenCalls[0].includeLinks, true, 'MCP fetch-web should pass includeLinks');
    assertEqual(payload.readabilityApplied, true, 'MCP fetch-web should expose readabilityApplied');
    assertEqual(payload.links?.[0]?.href, 'https://example.com/doc', 'MCP fetch-web should expose links');

    console.log('✅ MCP fetch-web tool passes readability flags');
}

function testCustomToolNamesAndFallbacks(): void {
    const validOutput = runModuleWithEnv(
        `
            import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
            const { createOpenWebSearchRuntime } = await import('./build/runtime/createRuntime.js');
            const { setupTools } = await import('./build/tools/setupTools.js');
            const runtime = createOpenWebSearchRuntime();
            const server = new McpServer({ name: 'test', version: '1.0.0' });
            setupTools(server, runtime);
            console.log(JSON.stringify({ names: Object.keys(server._registeredTools) }, null, 2));
        `,
        {
            MCP_TOOL_SEARCH_NAME: 'webSearch',
            MCP_TOOL_FETCH_GITHUB_NAME: 'repoReadme'
        }
    );
    const validPayload = parseJsonBlock(validOutput) as { names: string[] };
    assert(validPayload.names.includes('webSearch'), 'valid custom search tool name should be registered');
    assert(validPayload.names.includes('repoReadme'), 'valid custom GitHub tool name should be registered');

    const invalidOutput = runModuleWithEnv(
        `
            import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
            const { createOpenWebSearchRuntime } = await import('./build/runtime/createRuntime.js');
            const { setupTools } = await import('./build/tools/setupTools.js');
            const runtime = createOpenWebSearchRuntime();
            const server = new McpServer({ name: 'test', version: '1.0.0' });
            setupTools(server, runtime);
            console.log(JSON.stringify({ names: Object.keys(server._registeredTools) }, null, 2));
        `,
        {
            MCP_TOOL_SEARCH_NAME: '123bad',
            MCP_TOOL_FETCH_WEB_NAME: 'bad name'
        }
    );
    const invalidPayload = parseJsonBlock(invalidOutput) as { names: string[] };
    assert(invalidPayload.names.includes('search'), 'invalid custom search tool name should fall back to default');
    assert(invalidPayload.names.includes('fetchWebContent'), 'invalid custom web fetch tool name should fall back to default');

    console.log('✅ MCP tool names respect custom overrides and fallback rules');
}

function testConfigDrivenEngineSelectionAndMode(): void {
    const configOutput = runModuleWithEnv(
        `
            const { config, getProxyUrl } = await import('./build/config.js');
            console.log(JSON.stringify({
                defaultSearchEngine: config.defaultSearchEngine,
                allowedSearchEngines: config.allowedSearchEngines,
                searchMode: config.searchMode,
                useProxy: config.useProxy,
                proxyUrl: config.proxyUrl,
                getProxyUrl: getProxyUrl(),
                fetchWebAllowInsecureTls: config.fetchWebAllowInsecureTls,
                enableHttpServer: config.enableHttpServer
            }, null, 2));
        `,
        {
            MODE: 'stdio',
            DEFAULT_SEARCH_ENGINE: 'duckduckgo',
            ALLOWED_SEARCH_ENGINES: 'duckduckgo,bing,exa',
            SEARCH_MODE: 'auto',
            USE_PROXY: 'true',
            PROXY_URL: 'http://127.0.0.1:7890',
            FETCH_WEB_INSECURE_TLS: 'true'
        }
    );
    const configPayload = parseJsonBlock(configOutput) as {
        defaultSearchEngine: string;
        allowedSearchEngines: string[];
        searchMode: string;
        useProxy: boolean;
        proxyUrl: string;
        getProxyUrl: string;
        fetchWebAllowInsecureTls: boolean;
        enableHttpServer: boolean;
    };

    assertEqual(configPayload.defaultSearchEngine, 'duckduckgo', 'configured default search engine');
    assertEqual(configPayload.allowedSearchEngines.join(','), 'duckduckgo,bing,exa', 'configured allowed search engines');
    assertEqual(configPayload.searchMode, 'auto', 'configured search mode');
    assertEqual(configPayload.useProxy, true, 'configured useProxy');
    assertEqual(configPayload.proxyUrl, 'http://127.0.0.1:7890', 'configured proxyUrl');
    assertEqual(configPayload.getProxyUrl, 'http://127.0.0.1:7890', 'configured getProxyUrl');
    assertEqual(configPayload.fetchWebAllowInsecureTls, true, 'configured fetchWebAllowInsecureTls');
    assertEqual(configPayload.enableHttpServer, false, 'MODE=stdio should disable HTTP server');

    const fallbackOutput = runModuleWithEnv(
        `
            const { config } = await import('./build/config.js');
            console.log(JSON.stringify({
                defaultSearchEngine: config.defaultSearchEngine,
                allowedSearchEngines: config.allowedSearchEngines
            }, null, 2));
        `,
        {
            DEFAULT_SEARCH_ENGINE: 'startpage',
            ALLOWED_SEARCH_ENGINES: 'bing,exa'
        }
    );
    const fallbackPayload = parseJsonBlock(fallbackOutput) as {
        defaultSearchEngine: string;
        allowedSearchEngines: string[];
    };
    assertEqual(fallbackPayload.defaultSearchEngine, 'bing', 'default engine should fall back to first allowed engine');
    assertEqual(fallbackPayload.allowedSearchEngines.join(','), 'bing,exa', 'allowed search engines should remain stable');

    const descriptionOutput = runModuleWithEnv(
        `
            import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
            const { createOpenWebSearchRuntime } = await import('./build/runtime/createRuntime.js');
            const { setupTools } = await import('./build/tools/setupTools.js');
            const runtime = createOpenWebSearchRuntime();
            const server = new McpServer({ name: 'test', version: '1.0.0' });
            setupTools(server, runtime);
            console.log(JSON.stringify({
                names: Object.keys(server._registeredTools),
                searchDescription: server._registeredTools.search.description
            }, null, 2));
        `,
        {
            ALLOWED_SEARCH_ENGINES: 'duckduckgo,bing',
            DEFAULT_SEARCH_ENGINE: 'duckduckgo'
        }
    );
    const descriptionPayload = parseJsonBlock(descriptionOutput) as {
        names: string[];
        searchDescription: string;
    };
    assert(descriptionPayload.names.includes('search'), 'default search tool should still be registered');
    assert(
        descriptionPayload.searchDescription.includes('Duckduckgo') &&
        descriptionPayload.searchDescription.includes('Bing'),
        'search description should reflect allowed engines'
    );

    console.log('✅ MCP config-driven engine and mode behavior remains compatible');
}

async function main(): Promise<void> {
    await testSearchToolReturnsCompatiblePayload();
    await testSetupToolsUsesRuntimeConfigDefaults();
    await testSearchToolPassesSearchModeOverride();
    await testFetchWebToolPassesReadabilityFlags();
    testCustomToolNamesAndFallbacks();
    testConfigDrivenEngineSelectionAndMode();
    console.log('\nMCP adapter tests passed.');
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
