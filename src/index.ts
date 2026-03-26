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
import {config} from "./config.js";
import http from 'node:http';

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

function createServer(): McpServer {
  const server = new McpServer({
    name: 'web-search',
    version: '1.2.0'
  });

  setupTools(server);
  return server;
}

/**
 * Check if a port is available
 * Returns false if timeout (default 800ms) or port is in use
 */
function isPortAvailable(port: number, timeoutMs: number = 800): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        tester.close(() => resolve(false));
      }
    }, timeoutMs);

    const tester = http.createServer();
    tester.once('error', (err: NodeJS.ErrnoException) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(false);
      }
    });
    tester.once('listening', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        tester.close(() => resolve(true));
      }
    });
    tester.listen(port, '0.0.0.0');
  });
}

/**
 * Check if an existing MCP service is running on the port
 */
function checkExistingMcpService(port: number): Promise<{ running: boolean; name?: string; version?: string }> {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'port-checker', version: '1.0.0' }
      }
    });

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 1000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // Handle SSE format: "event: message\ndata: {...}"
          let jsonStr = data;
          if (data.includes('data: ')) {
            const dataMatch = data.match(/data:\s*(\{.*\})/);
            if (dataMatch) {
              jsonStr = dataMatch[1];
            }
          }
          const json = JSON.parse(jsonStr);
          if (json.result?.serverInfo) {
            resolve({
              running: true,
              name: json.result.serverInfo.name,
              version: json.result.serverInfo.version
            });
          } else if (json.error) {
            // Service is responding but returned an error (still a valid MCP service)
            resolve({ running: true });
          } else {
            resolve({ running: true });
          }
        } catch {
          resolve({ running: true });
        }
      });
    });

    req.on('error', () => resolve({ running: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ running: false });
    });
    req.write(postData);
    req.end();
  });
}

async function main() {
  // Enable STDIO mode if MODE is 'both' or 'stdio' or not specified
  if (process.env.MODE === undefined || process.env.MODE === 'both' || process.env.MODE === 'stdio') {
    console.error('🔌 Starting STDIO transport...');
    const server = createServer();
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

    // 是否启用跨域
    if (config.enableCors) {
      app.use(cors({
        origin: config.corsOrigin || '*',
        methods: ['GET', 'POST', 'DELETE'],
      }));
      app.options('*', cors());
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
        const server = createServer();
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
      const server = createServer();
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

    // Check if port is available
    const portAvailable = await isPortAvailable(PORT);

    if (!portAvailable) {
      console.error(`⚠️ Port ${PORT} is already in use`);

      // Check if there's an existing MCP service running
      const existingService = await checkExistingMcpService(PORT);

      if (existingService.running) {
        if (existingService.name === 'web-search') {
          console.error(`✅ Same MCP service (web-search v${existingService.version || 'unknown'}) is already running on port ${PORT}`);
          console.error(`ℹ️ Skipping HTTP server startup - using existing service`);
        } else {
          console.error(`❌ A different MCP service "${existingService.name || 'unknown'}" is running on port ${PORT}`);
          console.error(`💡 Use a different port by setting PORT environment variable`);
        }
      } else {
        console.error(`❌ Port ${PORT} is occupied by a non-MCP service`);
        console.error(`💡 Use a different port by setting PORT environment variable`);
      }
    } else {
      // Port is available, start the server
      const server = app.listen(PORT, '0.0.0.0', () => {
        console.error(`✅ HTTP server running on port ${PORT}`);
      });

      // Handle server errors
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`❌ Port ${PORT} became unavailable during startup`);
        } else {
          console.error(`❌ HTTP server error:`, err.message);
        }
      });
    }
  } else {
    console.error('ℹ️ HTTP server disabled, running in STDIO mode only')
  }
}

main().catch(console.error);
