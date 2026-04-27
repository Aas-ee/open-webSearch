#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setupTools } from './tools/setupTools.js';
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { randomUUID } from "node:crypto";
import cors from 'cors';
import type { CorsOptions } from 'cors';
import { runCli } from './cli/runCli.js';
import type { OpenWebSearchRuntime } from './runtime/runtimeTypes.js';
import { shouldCreateFullRuntimeForInvocation } from './runtime/runtimeSelection.js';
import { shutdownLocalPlaywrightBrowserSessions } from './utils/playwrightClient.js';

type StreamableSession = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  closed: boolean;
};

type SseSession = {
  server: McpServer;
  transport: SSEServerTransport;
  closed: boolean;
};

function createServer(runtime: OpenWebSearchRuntime): McpServer {
  const server = new McpServer({
    name: 'web-search',
    version: '1.2.0'
  });

  setupTools(server, runtime);
  return server;
}

function shouldSuppressStartupLogs(argv: string[]): boolean {
  if (argv.length === 0) {
    return false;
  }

  const [command] = argv;
  if (command === '--help' || command === '-h' || command === 'help' || command === 'status') {
    return true;
  }

  return argv.includes('--json');
}

async function main() {
  const argv = process.argv.slice(2);
  if (shouldSuppressStartupLogs(argv)) {
    process.env.OPEN_WEBSEARCH_QUIET_STARTUP = 'true';
  }
  const { config } = await import('./config.js');
  const runtime = shouldCreateFullRuntimeForInvocation(argv)
    ? (await import('./runtime/createRuntime.js')).createOpenWebSearchRuntime()
    : ({
        config,
        services: {} as OpenWebSearchRuntime['services']
      } satisfies OpenWebSearchRuntime);
  const cliExitCode = await runCli(argv, runtime, {
    stdout: (text) => console.log(text),
    stderr: (text) => console.error(text)
  });

  if (cliExitCode !== null) {
    // best-effort 清理：shutdown 失败不应覆盖 CLI 本身的退出码
    try {
      await shutdownLocalPlaywrightBrowserSessions();
    } catch (error) {
      console.error('Failed to shut down local Playwright browser sessions:', error);
    }
    process.exitCode = cliExitCode;
    return;
  }

  // Enable STDIO mode if MODE is 'both' or 'stdio' or not specified
  if (process.env.MODE === undefined || process.env.MODE === 'both' || process.env.MODE === 'stdio') {
    console.error('🔌 Starting STDIO transport...');
    const server = createServer(runtime);
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport).then(() => {
      console.error('✅ STDIO transport enabled');
    }).catch(error => {
      console.error('❌ Failed to initialize STDIO transport:', error);
    });
  }

  // Only set up HTTP server if enabled
  if (config.enableHttpServer) {
    console.error('🔌 Starting HTTP server...');
    // 创建 Express 应用
    const app = express();
    app.use(express.json());

    const mcpCorsOptions: CorsOptions = {
      origin: config.corsOrigin || '*',
      methods: ['GET', 'POST', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Mcp-Session-Id'],
      exposedHeaders: ['Mcp-Session-Id'],
    };

    // 是否启用跨域
    if (config.enableCors) {
      app.use(cors(mcpCorsOptions));
      app.options('*', cors(mcpCorsOptions));
    }

    // Store transports for each session type
    const transports = {
      streamable: {} as Record<string, StreamableSession>,
      sse: {} as Record<string, SseSession>
    };

    // Handle POST requests for client-to-server communication
    app.post('/mcp', async (req, res) => {
      // Check for existing session ID
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.streamable[sessionId]) {
        // Reuse existing transport
        transport = transports.streamable[sessionId].transport;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request
        const server = createServer(runtime);
        const session = {} as StreamableSession;

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => {
            // Store the transport by session ID
            transports.streamable[sessionId] = session;
          },
          // DNS rebinding protection is disabled by default for backwards compatibility. If you are running this server
          // locally, make sure to set:
          // enableDnsRebindingProtection: true,
          // allowedHosts: ['127.0.0.1'],
        });

        session.server = server;
        session.transport = transport;
        session.closed = false;

        // Clean up transport when closed
        transport.onclose = () => {
          if (transport.sessionId && transports.streamable[transport.sessionId] === session) {
            delete transports.streamable[transport.sessionId];
          }

          if (session.closed) {
            return;
          }

          session.closed = true;
          void server.close().catch(error => {
            console.error('❌ Failed to close streamable MCP server:', error);
          });
        };

        // Connect to the MCP server
        try {
          await server.connect(transport);
        } catch (error) {
          session.closed = true;
          void server.close().catch(closeError => {
            console.error('❌ Failed to close streamable MCP server after connect error:', closeError);
          });
          throw error;
        }
      } else {
        // Invalid request
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      // Handle the request
      await transport.handleRequest(req, res, req.body);
    });

    // Reusable handler for GET and DELETE requests
    const handleSessionRequest = async (req: express.Request, res: express.Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !transports.streamable[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }

      const transport = transports.streamable[sessionId];
      await transport.transport.handleRequest(req, res);
    };

    // Handle GET requests for server-to-client notifications via SSE
    app.get('/mcp', handleSessionRequest);

    // Handle DELETE requests for session termination
    app.delete('/mcp', handleSessionRequest);

    // Legacy SSE endpoint for older clients
    app.get('/sse', async (req, res) => {
      // Create SSE transport for legacy clients
      const transport = new SSEServerTransport('/messages', res);
      const server = createServer(runtime);
      const session: SseSession = {
        server,
        transport,
        closed: false
      };

      transports.sse[transport.sessionId] = session;

      transport.onclose = () => {
        if (transports.sse[transport.sessionId] === session) {
          delete transports.sse[transport.sessionId];
        }

        if (session.closed) {
          return;
        }

        session.closed = true;
        void server.close().catch(error => {
          console.error('❌ Failed to close SSE MCP server:', error);
        });
      };

      try {
        await server.connect(transport);
      } catch (error) {
        delete transports.sse[transport.sessionId];
        session.closed = true;
        void server.close().catch(closeError => {
          console.error('❌ Failed to close SSE MCP server after connect error:', closeError);
        });
        throw error;
      }
    });

    // Legacy message endpoint for older clients
    app.post('/messages', async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const session = transports.sse[sessionId];
      if (session) {
        await session.transport.handlePostMessage(req, res, req.body);
      } else {
        res.status(400).send('No transport found for sessionId');
      }
    });

    // Read the port number from the environment variable; use the default port 3000 if it is not set.
    const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

    app.listen(PORT, '0.0.0.0', () => {
      console.error(`✅ HTTP server running on port ${PORT}`)
    });
  } else {
    console.error('ℹ️ HTTP server disabled, running in STDIO mode only')
  }
}

main().catch(console.error);
