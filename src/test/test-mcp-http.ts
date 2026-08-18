import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { OPEN_WEBSEARCH_VERSION } from '../version.js';

type JsonRpcResponse = {
    id?: string | number | null;
    result?: Record<string, any>;
    error?: { message?: string };
};

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

async function getAvailablePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        server.close();
        throw new Error('failed to reserve a test port');
    }

    await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
    return address.port;
}

async function parseMcpResponse(response: Response): Promise<JsonRpcResponse | undefined> {
    const text = await response.text();
    if (!text.trim()) {
        return undefined;
    }

    if (response.headers.get('content-type')?.includes('text/event-stream')) {
        const payloads = text
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice('data:'.length).trim())
            .filter(Boolean);
        assert(payloads.length > 0, `MCP SSE response did not contain data: ${text}`);
        return JSON.parse(payloads[payloads.length - 1]) as JsonRpcResponse;
    }

    return JSON.parse(text) as JsonRpcResponse;
}

async function postMcp(baseUrl: string, body: unknown, sessionId?: string): Promise<{
    response: Response;
    payload?: JsonRpcResponse;
}> {
    const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
        },
        body: JSON.stringify(body)
    });
    return {
        response,
        payload: await parseMcpResponse(response)
    };
}

async function waitForHealth(baseUrl: string, getProcessError: () => string | undefined): Promise<Response> {
    const deadline = Date.now() + 8000;
    let lastError = '';

    while (Date.now() < deadline) {
        const processError = getProcessError();
        if (processError) {
            throw new Error(processError);
        }

        try {
            const response = await fetch(`${baseUrl}/health`);
            if (response.ok) {
                return response;
            }
            lastError = `HTTP ${response.status}`;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(`MCP HTTP server did not become healthy: ${lastError}`);
}

async function main(): Promise<void> {
    const port = await getAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['build/index.js'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            MODE: 'http',
            PORT: String(port),
            OPEN_WEBSEARCH_QUIET_STARTUP: 'true',
            ALLOWED_SEARCH_ENGINES: 'bing',
            SEARCH_MODE: 'request'
        },
        stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
    });

    try {
        const healthResponse = await waitForHealth(baseUrl, () =>
            child.exitCode === null ? undefined : `MCP HTTP process exited with ${child.exitCode}: ${stderr}`
        );
        const health = await healthResponse.json() as {
            status: string;
            data: { service: string; transport: string; version: string };
        };
        assert(health.status === 'ok', 'MCP /health should return status=ok');
        assert(health.data.service === 'open-websearch', 'MCP /health should identify the service');
        assert(health.data.transport === 'mcp-http', 'MCP /health should identify the transport');
        assert(health.data.version === OPEN_WEBSEARCH_VERSION, 'MCP /health should report package version');

        const initialized = await postMcp(baseUrl, {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'open-websearch-test', version: '1.0.0' }
            }
        });
        assert(initialized.response.ok, `MCP initialize failed with HTTP ${initialized.response.status}`);
        assert(!initialized.payload?.error, `MCP initialize returned an error: ${initialized.payload?.error?.message}`);
        assert(
            initialized.payload?.result?.serverInfo?.version === OPEN_WEBSEARCH_VERSION,
            `MCP initialize should report package version ${OPEN_WEBSEARCH_VERSION}`
        );

        const sessionId = initialized.response.headers.get('mcp-session-id');
        assert(sessionId, 'MCP initialize should return a session id');
        const notification = await postMcp(baseUrl, {
            jsonrpc: '2.0',
            method: 'notifications/initialized'
        }, sessionId);
        assert(notification.response.ok, `MCP initialized notification failed with HTTP ${notification.response.status}`);

        const toolList = await postMcp(baseUrl, {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {}
        }, sessionId);
        assert(toolList.response.ok, `MCP tools/list failed with HTTP ${toolList.response.status}`);
        assert(Array.isArray(toolList.payload?.result?.tools), 'MCP tools/list should return tools');
        assert(toolList.payload?.result?.tools.some((tool: { name?: string }) => tool.name === 'search'), 'MCP tools/list should keep search');

        console.log('MCP HTTP health and initialize tests passed.');
    } finally {
        if (child.exitCode === null) {
            const closed = once(child, 'close');
            child.kill('SIGTERM');
            const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
            await closed;
            clearTimeout(timeout);
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
