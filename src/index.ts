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
      console.log(`\nEngram — initializing context for ${repoRoot}\n`);

      const { ingestAll } = await import('./ingest.js');
      const result = await ingestAll(repoRoot, {
        projectFile: projectFile || undefined,
      });

      console.log(`Summary:`);
      console.log(`  Git commits indexed: ${result.commits}`);
      console.log(`  Source files scanned: ${result.files}`);
      console.log(`  Total chunks stored: ${result.chunks}`);
      if (result.projectChunks > 0) {
        console.log(`  Project file chunks: ${result.projectChunks}`);
      }
      console.log(`\nStorage: ${repoRoot}/.engram/store.db`);
      console.log(`\nAdd to your MCP config to start using engram with your AI agent.`);
      closeDb();
      break;
    }

    case 'inject': {
      const filePath = process.argv[3];
      if (!filePath) {
        console.error('Usage: engram inject <file>');
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

    case 'help':
    case '--help':
    case '-h': {
      console.log(`
engram — persistent memory for AI coding agents

Commands:
  engram init [project-file]   Scan git history + codebase, build context store
  engram inject <file>         Inject a project file (spec, requirements, etc.)
  engram status                Show what's stored
  engram                       Start MCP server (used by AI editors)

Setup:
  Add to your MCP config (e.g. ~/.cursor/mcp.json):
  {
    "mcpServers": {
      "engram": {
        "command": "npx",
        "args": ["-y", "engram"]
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
  console.error('engram error:', err);
  process.exit(1);
});
