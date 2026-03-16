#!/usr/bin/env node

import { detectRepoRoot } from './git.js';
import { closeDb } from './db.js';

const command = process.argv[2];

async function main() {
  switch (command) {
    case 'init': {
      const repoRoot = await detectRepoRoot();
      if (!repoRoot) {
        console.error('Error: not inside a git repository.');
        process.exit(1);
      }

      const projectFile = process.argv[3];
      console.log(`\nCortexMem — initializing context for ${repoRoot}\n`);

      const { ingestAll } = await import('./ingest.js');
      const result = await ingestAll(repoRoot, {
        projectFile: projectFile || undefined,
      });

      console.log(`Summary${result.incremental ? ' (incremental)' : ''}:`);
      console.log(`  Git commits indexed: ${result.commits}${result.incremental ? ' (new)' : ''}`);
      console.log(`  Source files scanned: ${result.files}`);
      console.log(`  Total chunks stored: ${result.chunks}${result.incremental ? ' (new)' : ''}`);
      if (result.projectChunks > 0) {
        console.log(`  Project file chunks: ${result.projectChunks}`);
      }
      console.log(`\nStorage: ${repoRoot}/.cortexmem/store.db`);
      console.log(`\nAdd to your MCP config to start using cortexmem with your AI agent.`);
      closeDb();
      break;
    }

    case 'inject': {
      const filePath = process.argv[3];
      if (!filePath) {
        console.error('Usage: cortexmem inject <file>');
        process.exit(1);
      }

      const repoRoot = await detectRepoRoot();
      if (!repoRoot) {
        console.error('Error: not inside a git repository.');
        process.exit(1);
      }

      const { ingestProjectFile } = await import('./ingest.js');
      const count = await ingestProjectFile(repoRoot, filePath);
      console.log(`Injected ${count} chunks from ${filePath}`);
      closeDb();
      break;
    }

    case 'status': {
      const repoRoot = await detectRepoRoot();
      if (!repoRoot) {
        console.error('Error: not inside a git repository.');
        process.exit(1);
      }

      const { getStatus } = await import('./tools/get_status.js');
      const status = await getStatus();
      console.log(status);
      closeDb();
      break;
    }

    case 'serve': {
      const postgresUrl = process.env.CORTEXMEM_POSTGRES_URL;
      if (!postgresUrl) {
        console.error('Error: CORTEXMEM_POSTGRES_URL environment variable is required for collaborative mode.');
        console.error('Example: CORTEXMEM_POSTGRES_URL=postgresql://user:pass@localhost:5432/cortexmem cortexmem serve');
        process.exit(1);
      }

      const portArg = process.argv.indexOf('--port');
      const port = portArg !== -1 && process.argv[portArg + 1]
        ? parseInt(process.argv[portArg + 1], 10)
        : 7437;

      const { startHttpServer } = await import('./server-http.js');
      await startHttpServer({ port, postgresUrl });
      break;
    }

    case 'help':
    case '--help':
    case '-h': {
      console.log(`
cortexmem — persistent memory for AI coding agents

Commands:
  cortexmem init [project-file]   Scan git history + codebase, build context store
  cortexmem inject <file>         Inject a project file (spec, requirements, etc.)
  cortexmem status                Show what's stored
  cortexmem serve [--port 7437]   Start collaborative HTTP server (requires CORTEXMEM_POSTGRES_URL)
  cortexmem                       Start MCP server (used by AI editors)

Local mode (default):
  Add to your MCP config (e.g. ~/.cursor/mcp.json):
  {
    "mcpServers": {
      "cortexmem": {
        "command": "npx",
        "args": ["-y", "cortexmem"]
      }
    }
  }

Collaborative mode:
  1. Start the server:
     CORTEXMEM_POSTGRES_URL=postgresql://localhost/cortexmem cortexmem serve

  2. Point your editor to the server:
     {
       "mcpServers": {
         "cortexmem": {
           "url": "http://localhost:7437/mcp"
         }
       }
     }
`);
      break;
    }

    default: {
      // No command = start MCP server
      const { startServer } = await import('./server.js');
      await startServer();
    }
  }
}

main().catch((err) => {
  console.error('cortexmem error:', err);
  process.exit(1);
});
