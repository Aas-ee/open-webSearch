import axios from 'axios';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { isPrivateOrLocalHostname } from '../../utils/urlSafety.js';
import { packageVersion } from '../../version.js';

const endpoint = new URL('https://mcp.parallel.ai/mcp');
const projectName = 'open-websearch';
const version = packageVersion === 'unknown' ? '' : packageVersion;
const userAgent = version ? `${projectName}/${version}` : projectName;
const searchTimeoutMs = 12_000;
const maxResponseBytes = 2 * 1024 * 1024;

class ParallelSearchError extends Error {}

// Use the existing proxy and TLS options while letting the SDK handle MCP and SSE.
function createParallelFetch(deadline: AbortSignal) {
    return async (input: string | URL, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        // Search uses request streams and their resumption, so decline the SDK's optional idle stream.
        if (init?.method === 'GET' && !headers.has('last-event-id')) {
            return new Response(null, { status: 405 });
        }

        const response = await axios.request<Readable>({
            ...buildAxiosRequestOptions({
                trustedStaticHost: true,
                headers: Object.fromEntries(headers),
                responseType: 'stream',
                maxContentLength: maxResponseBytes,
                validateStatus: () => true
            }),
            url: input.toString(),
            method: init?.method,
            data: init?.body,
            signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline
        });

        // Cancel the socket too if the SDK discards a body before Axios starts reading it.
        response.data.once('close', () => {
            if (!response.data.readableEnded) {
                response.request.destroy();
            }
        });

        // Discard HTTP error bodies and headers the SDK doesn't need. In particular,
        // upstream cookies and error details should not enter tool output or logs.
        const responseHeaders = new Headers();
        for (const name of ['content-type', 'mcp-session-id']) {
            const value: unknown = response.headers[name];
            if (typeof value === 'string') {
                responseHeaders.set(name, value);
            }
        }
        if (response.status >= 300 || [202, 204, 205].includes(response.status) || init?.method === 'DELETE') {
            response.data.destroy();
            return new Response(null, { status: response.status, headers: responseHeaders });
        }
        return new Response(Readable.toWeb(response.data) as ReadableStream<Uint8Array>, {
            status: response.status,
            headers: responseHeaders
        });
    };
}

function mapResult(hit: unknown): SearchResult | undefined {
    if (!hit || typeof hit !== 'object') {
        return undefined;
    }
    const { url, title, excerpts } = hit as Record<string, unknown>;
    if (typeof url !== 'string') {
        return undefined;
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password
        || isPrivateOrLocalHostname(parsed.hostname)) {
        return undefined;
    }
    const description = Array.isArray(excerpts)
        ? excerpts.filter((text): text is string => typeof text === 'string').join(' ').replace(/\s+/g, ' ').trim().slice(0, 500)
        : '';
    return {
        title: (typeof title === 'string' ? title.trim().slice(0, 500) : '') || parsed.hostname,
        url,
        description,
        source: parsed.hostname,
        engine: 'parallel'
    };
}

function parseResult(result: CallToolResult, limit: number): SearchResult[] {
    if (result.isError) {
        throw new ParallelSearchError('Parallel web_search returned a tool error');
    }
    let payload: unknown = result.structuredContent;
    if (payload === undefined) {
        const content = result.content.find(block => block.type === 'text');
        if (content) {
            try {
                payload = JSON.parse(content.text);
            } catch {
                // Report a malformed tool result below.
            }
        }
    }
    const hits = (payload as { results?: unknown } | undefined)?.results;
    if (!Array.isArray(hits)) {
        throw new ParallelSearchError('Parallel web_search response is missing a results array');
    }
    const results: SearchResult[] = [];
    for (const hit of hits) {
        const mapped = mapResult(hit);
        if (mapped) {
            results.push(mapped);
            if (results.length === limit) {
                break;
            }
        }
    }
    return results;
}

export async function searchParallel(query: string, limit: number): Promise<SearchResult[]> {
    const maxResults = Math.floor(limit);
    if (!Number.isFinite(maxResults) || maxResults <= 0) {
        return [];
    }

    const signal = AbortSignal.timeout(searchTimeoutMs);
    const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { 'User-Agent': userAgent } },
        fetch: createParallelFetch(signal),
        // Avoid a retry timer being scheduled after close if an in-flight resume fails.
        reconnectionOptions: {
            initialReconnectionDelay: 1_000,
            maxReconnectionDelay: 1_000,
            reconnectionDelayGrowFactor: 1,
            maxRetries: 1
        }
    });
    const client = new Client({ name: projectName, version });
    try {
        await client.connect(transport, { signal });
        let cursor: string | undefined;
        do {
            const page = await client.listTools(cursor ? { cursor } : undefined, { signal });
            if (page.tools.some(tool => tool.name === 'web_search')) {
                const result = await client.callTool({
                    name: 'web_search',
                    arguments: { objective: query, search_queries: [query] }
                }, CallToolResultSchema, { signal });
                return parseResult(CallToolResultSchema.parse(result), maxResults);
            }
            cursor = page.nextCursor;
        } while (cursor);
        throw new ParallelSearchError('Parallel MCP did not advertise web_search');
    } catch (error) {
        if (signal.aborted) {
            throw new Error('Parallel search timed out');
        }
        // MCP and Axios failures can include upstream text and request metadata.
        const status = error instanceof StreamableHTTPError ? error.code : undefined;
        if (status !== undefined && status >= 400 && status < 600) {
            throw new Error(`Parallel MCP request failed (HTTP ${status})`);
        }
        if (error instanceof ParallelSearchError) {
            throw error;
        }
        throw new Error('Parallel MCP request failed');
    } finally {
        await transport.terminateSession().catch(() => undefined);
        await client.close();
    }
}
