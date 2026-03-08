# cortexmem

**Persistent memory for AI coding agents -- zero config, works with Cursor, Claude Code, Codex, and any MCP-compatible editor.**

[![npm version](https://img.shields.io/npm/v/cortexmem.svg)](https://www.npmjs.com/package/cortexmem)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

AI coding agents lose all context when a session ends. CortexMem fixes this by building a semantic memory store from your git history, codebase, and session context -- then making it searchable via MCP tools.

The name combines **cortex** (the brain's memory center) with **mem** (memory) -- persistent memory for your AI coding agent.

## Quick Start

```bash
# 1. Initialize (scans git history + codebase, builds vector store)
cd your-project
npx cortexmem init

# 2. Optionally inject a project spec
npx cortexmem init ./PROJECT.md

# 3. Add to your MCP config (one time)
```

**Cursor** (`~/.cursor/mcp.json`) / **Claude Code** / **Codex**:
```json
{
  "mcpServers": {
    "cortexmem": {
      "command": "npx",
      "args": ["-y", "cortexmem"],
      "env": {
        "ANTHROPIC_API_KEY": "your-key-here"
      }
    }
  }
}
```

Restart your editor. CortexMem is running.

> `ANTHROPIC_API_KEY` is optional -- enables LLM-based session compaction. Without it, everything else works.

## How It Works

1. **`cortexmem init`** scans your git commit history and entire codebase
2. Text is chunked, embedded locally (all-MiniLM-L6-v2, runs offline), and stored in a SQLite database
3. Your AI agent uses MCP tools to search and save context
4. Context persists in `.cortexmem/store.db` -- portable across editors and machines

### What Gets Indexed

| Source | What's Extracted |
|--------|-----------------|
| Git log | Commit messages, descriptions, file change patterns |
| Source files | Code structure, functions, classes, patterns |
| Config files | Stack, tooling, dependencies |
| Docs (.md) | Documentation content |
| Project file | Specs, requirements (via `cortexmem init <file>`) |
| Session context | Decisions, constraints, discoveries saved by the agent |

### MCP Tools

| Tool | Purpose |
|------|---------|
| **`get_context`** | Semantic search across all stored memory. Use with `query` for search, without for structured overview. Call at session start. |
| **`save_context`** | Save a decision, constraint, discovery, state, or preference. Embedded and stored instantly. |
| **`summarize_session`** | Compact session entries via LLM -- deduplicates, compresses, discards dead ends. |
| **`get_status`** | Quick stats: chunk counts, storage location, last init time. |

### Context Types

| Type | Purpose | Example |
|------|---------|---------|
| **decision** | Architectural/technical choices | "Chose PostgreSQL over MongoDB for ACID transactions" |
| **constraint** | Hard rules to never violate | "Never modify auth middleware directly" |
| **state** | Current WIP status | "Payment refactor: 2/4 services done" |
| **discovery** | Non-obvious codebase facts | "UserService is called from 6 places, not 3" |
| **preference** | Code style conventions | "Snake_case for variables, PascalCase for classes" |

## Portability

CortexMem stores everything in a single file: `.cortexmem/store.db`

```bash
# Move to a new machine
scp .cortexmem/store.db user@newmachine:~/project/.cortexmem/

# Share with teammates (commit it)
git add .cortexmem/store.db

# Switch editors -- same file works everywhere
# Claude Code -> Cursor -> Codex -- no migration needed
```

## CLI Commands

```
cortexmem init [project-file]   Scan git history + codebase, build context store
cortexmem inject <file>         Inject/update a project file
cortexmem status                Show what's stored
cortexmem                       Start MCP server (used by AI editors)
```

## Usage Guide

Add to your agent's system prompt or rules:

```
At session start: call cortexmem get_context to load memory from previous sessions.
During session: call cortexmem save_context when you make decisions, discover things, or note constraints.
At session end: call cortexmem summarize_session to compact memory.
```

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Enables LLM compaction in `summarize_session` | none |
| `CORTEXMEM_MAX_TOKENS` | Default max tokens for `get_context` | `3000` |
| `CORTEXMEM_MODEL` | Model for compaction | `claude-haiku-4-5-20251001` |

## Architecture

- **Embeddings**: `all-MiniLM-L6-v2` via `@xenova/transformers` -- runs locally, no API key needed
- **Storage**: SQLite via `sql.js` (WASM) -- zero native dependencies, works on any OS
- **Vector search**: Cosine similarity in JS -- fast enough for 100K+ chunks
- **Transport**: MCP stdio -- works with any MCP-compatible editor

## Development

```bash
git clone https://github.com/Ashprakash/cortexmem.git
cd cortexmem
npm install
npm run dev     # run with tsx
npm run build   # compile TypeScript
```

## License

MIT
