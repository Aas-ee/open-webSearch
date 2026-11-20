import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import axios, { type AxiosRequestConfig } from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { SearchExecutionResult } from '../core/search/searchService.js';
import { packageVersion } from '../version.js';

const parallelUrl = 'https://mcp.parallel.ai/mcp';
const originalUrl = 'https://example.org/sqlite?b=2&a=1#wal';
const userAgent = `open-websearch/${packageVersion}`;

// Preloaded only in the child processes so the real HTTP adapter can reach the fixture.
function routeToFixture(origin: string): void {
    const request = axios.request.bind(axios);
    axios.request = (config: AxiosRequestConfig) => {
        assert.equal(config.url, parallelUrl);
        assert.equal(config.maxRedirects, 0);
        assert.equal(config.proxy, false);
        return request({ ...config, url: `${origin}/mcp` });
    };
    // Keep the built-in Bing default check offline as well.
    axios.get = async (url: string) => {
        assert.equal(url, 'https://cn.bing.com/search');
        throw new Error('Bing fixture');
    };
}

async function runTests(): Promise<void> {
    const captured: Array<{
        method: string | undefined;
        rpc: string | undefined;
        tool: string | undefined;
        agent: string | undefined;
        authenticated: boolean;
        session: string | string[] | undefined;
        resume: string | string[] | undefined;
    }> = [];
    let sessionCount = 0;
    let redirected = false;
    let longRetryFixture = false;
    const resumed = new Map<string, number>();
    const results = [
        { url: 'file:///etc/hosts' },
        { url: 'http://127.0.0.1/a' },
        { url: 'https://someone@example.org/a' },
        { url: 'https:example.org/relative' },
        { url: 'https://example.org/line\nbreak' },
        { url: originalUrl, title: 'SQLite\u0007 WAL', excerpts: ['A public\u0007 excerpt.', 'Second excerpt.'] },
        { url: 'https://example.org/another' }
    ];

    const server = createServer(async (request, response) => {
        if (request.url === '/redirected') {
            redirected = true;
            response.writeHead(500).end();
            return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
            chunks.push(chunk);
        }
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        const resume = request.headers['last-event-id'];
        captured.push({
            method: request.method,
            rpc: body.method,
            tool: body.params?.name,
            agent: request.headers['user-agent'],
            authenticated: ['authorization', 'x-api-key', 'cookie'].some(name => name in request.headers),
            session: request.headers['mcp-session-id'],
            resume
        });
        const json = (result: object, id = body.id) => response.writeHead(200, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ jsonrpc: '2.0', id, result }));
        const success = { content: [], structuredContent: { results } };
        const longRetry = (id: string) => response.writeHead(200, { 'Content-Type': 'text/event-stream' })
            .end(`retry: 30000\nid: ${id}\ndata:\n\n`);
        if (request.method === 'GET') {
            const id = typeof resume === 'string' ? resumed.get(resume) : undefined;
            if (longRetryFixture && !resume) {
                longRetry('idle-stream');
            } else if (id !== undefined) {
                // The resumed SSE result has multiline data, just like a split JSON event.
                response.writeHead(200, { 'Content-Type': 'text/event-stream' })
                    .end(`event: message\ndata: {"jsonrpc":"2.0","id":${id},\ndata: "result":${JSON.stringify(success)}}\n\n`);
            } else {
                response.writeHead(405).end();
            }
        } else if (request.method === 'DELETE') {
            response.writeHead(204).end();
        } else if (body.method === 'initialize') {
            response.setHeader('Mcp-Session-Id', `fixture-${++sessionCount}`);
            json({
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'fixture', version: '1' }
            });
        } else if (body.method === 'notifications/initialized') {
            response.writeHead(202).end();
        } else if (body.method === 'tools/list') {
            json(body.params?.cursor === 'second-page'
                ? { tools: [{ name: 'web_search', inputSchema: { type: 'object' } }] }
                : {
                    tools: [{
                        name: 'extract',
                        inputSchema: { type: 'object' },
                        outputSchema: {
                            type: 'object',
                            properties: { page: { $ref: 'https://example.org/schemas/page.json' } }
                        }
                    }],
                    nextCursor: 'second-page'
                });
        } else if (body.method === 'tools/call') {
            const query = body.params.arguments.objective;
            assert.deepEqual(body.params.arguments, { objective: query, search_queries: [query] });
            assert.equal(body.params.name, 'web_search');
            switch (query) {
                case 'resume': {
                    const eventId = `event-${sessionCount}`;
                    resumed.set(eventId, body.id);
                    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
                        .end(`retry: 1\nid: ${eventId}\ndata:\n\n`);
                    break;
                }
                case 'long SSE retry':
                    // Give the optional idle GET time to schedule its own reconnect, if opened.
                    setTimeout(() => longRetry('request-stream'), 250);
                    break;
                case 'rate limited':
                    response.writeHead(429).end('fixture error body');
                    break;
                case 'redirect':
                    response.writeHead(302, { Location: '/redirected' }).end();
                    break;
                case 'rpc error':
                    response.writeHead(200, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'fixture error body' } }));
                    break;
                case 'malformed JSON':
                    response.writeHead(200, { 'Content-Type': 'application/json' }).end('fixture error body');
                    break;
                case 'tool error':
                    json({ ...success, isError: true });
                    break;
                case 'invalid':
                    json({ content: [{ type: 'text', text: 'not JSON' }] });
                    break;
                case 'oversized':
                    json({ content: [{ type: 'text', text: 'a'.repeat(2 * 1024 * 1024) }] });
                    break;
                case 'empty':
                    json({ content: [{ type: 'text', text: JSON.stringify({ results: [] }) }] });
                    break;
                default:
                    json(success);
            }
        } else {
            response.writeHead(500).end();
        }
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const args = ['--import', fileURLToPath(import.meta.url), fileURLToPath(new URL('../index.js', import.meta.url))];
    const env = {
        PARALLEL_FIXTURE_ORIGIN: `http://127.0.0.1:${address.port}`,
        SEARCH_MODE: 'request',
        MODE: 'stdio',
        OPEN_WEBSEARCH_DAEMON_PORT: '1',
        OPEN_WEBSEARCH_QUIET_STARTUP: 'true'
    };
    const cli = async (engineArgs: string[] = [], overrides: Record<string, string> = {}, query = 'sqlite') => {
        const { stdout } = await promisify(execFile)(process.execPath, [
            ...args, 'search', query, '--json', '--limit', '1', ...engineArgs
        ], { env: { ...env, ...overrides }, timeout: 20_000 });
        return JSON.parse(stdout).data as SearchExecutionResult;
    };
    const mcp = new Client({ name: 'open-websearch-fixture', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args, env, stderr: 'ignore' });
    const search = async (query: string) => {
        const result = await mcp.callTool({ name: 'search', arguments: { query, engines: ['parallel'], limit: 1 } });
        assert(!result.isError);
        assert(Array.isArray(result.content) && result.content[0]?.type === 'text');
        return JSON.parse(result.content[0].text) as SearchExecutionResult;
    };

    try {
        assert.deepEqual((await cli()).engines, ['bing']);
        assert.deepEqual((await cli(['--engine', 'parallel'], { ALLOWED_SEARCH_ENGINES: 'bing' })).engines, ['bing']);
        assert.equal(captured.length, 0, 'unselected and excluded Parallel send no requests');
        assert.deepEqual((await cli(['--engine', 'parallel'])).results, [{
            title: 'SQLite WAL', url: originalUrl, description: 'A public excerpt. Second excerpt.',
            source: 'example.org', engine: 'parallel'
        }]);
        assert.equal((await cli([], { DEFAULT_SEARCH_ENGINE: 'parallel', ALLOWED_SEARCH_ENGINES: 'parallel' })).totalResults, 1);

        await mcp.connect(transport);
        const tool = (await mcp.listTools()).tools.find(tool => tool.name === 'search');
        assert(tool?.description?.includes('Parallel'));
        const resumedResult = await search('resume');
        assert.deepEqual(resumedResult.partialFailures, []);
        assert.equal(resumedResult.results[0]?.url, originalUrl);
        assert.equal((await search('empty')).partialFailures.length, 0);
        for (const [query, error] of [
            ['rate limited', 'HTTP 429'], ['redirect', 'request failed'], ['rpc error', 'request failed'],
            ['malformed JSON', 'request failed'], ['tool error', 'tool error'], ['invalid', 'missing a results array'], ['oversized', 'request failed']
        ]) {
            const result = await search(query);
            assert.equal(result.totalResults, 0);
            assert.equal(result.partialFailures[0]?.engine, 'parallel');
            assert.equal(result.partialFailures[0]?.code, 'engine_error');
            assert(result.partialFailures[0]?.message.includes(error), result.partialFailures[0]?.message);
            assert(!result.partialFailures[0]?.message.includes('fixture error body'));
        }
        assert(!redirected);
        longRetryFixture = true;
        const timeout = await cli(['--engine', 'parallel'], {}, 'long SSE retry');
        assert.deepEqual(timeout.partialFailures, [{
            engine: 'parallel', code: 'engine_error', message: 'Parallel search timed out'
        }]);

        const calls = captured.filter(request => request.tool === 'web_search');
        assert.equal(calls.length, 12);
        assert.equal(new Set(calls.map(request => request.session)).size, calls.length);
        assert(captured.some(request => request.method === 'GET' && request.resume));
        assert(captured.every(request => request.method !== 'GET' || request.resume));
        assert.equal(captured.filter(request => request.method === 'DELETE').length, calls.length - 1);
        for (const request of captured) {
            assert.equal(request.agent, userAgent);
            assert.equal(request.authenticated, false);
        }
        console.log(`Parallel CLI and MCP fixtures passed. Captured ${calls.length} web_search POSTs and SSE resumption with User-Agent ${userAgent}.`);
    } finally {
        await mcp.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

const fixtureOrigin = process.env.PARALLEL_FIXTURE_ORIGIN;
if (fixtureOrigin) {
    routeToFixture(fixtureOrigin);
} else {
    await runTests();
}
