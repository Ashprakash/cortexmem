import { createServer as createHttpServer } from 'http';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { setBackend } from './storage.js';
import { PostgresBackend } from './backends/postgres.js';

export async function startHttpServer(options: {
  port: number;
  postgresUrl: string;
}): Promise<void> {
  const { port, postgresUrl } = options;

  // Initialize PostgreSQL backend
  const backend = new PostgresBackend(postgresUrl);
  setBackend(backend);

  // Track transports per session for cleanup
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    // Health check
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', backend: 'postgres' }));
      return;
    }

    // MCP endpoint
    if (url.pathname === '/mcp') {
      // Check for existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && transports.has(sessionId)) {
        // Reuse existing transport for this session
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }

      // New session: create transport and server
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) transports.delete(sid);
      };

      const server = createServer();
      await server.connect(transport);

      // Store transport for session reuse
      const sid = transport.sessionId;
      if (sid) transports.set(sid, transport);

      await transport.handleRequest(req, res);
      return;
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Use /mcp for MCP requests or /health for status.' }));
  });

  httpServer.listen(port, () => {
    console.log(`\nCortexMem collaborative server running`);
    console.log(`  MCP endpoint:  http://localhost:${port}/mcp`);
    console.log(`  Health check:  http://localhost:${port}/health`);
    console.log(`  Backend:       PostgreSQL`);
    console.log(`\nAdd to your editor's MCP config:`);
    console.log(JSON.stringify({
      mcpServers: {
        cortexmem: {
          url: `http://localhost:${port}/mcp`,
        },
      },
    }, null, 2));
    console.log('');
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down...');
    for (const transport of transports.values()) {
      transport.close();
    }
    backend.close();
    httpServer.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
