# engram

**Persistent memory for AI coding agents -- zero config, works with Cursor, Claude Code, Codex, and any MCP-compatible editor.**

[![npm version](https://img.shields.io/npm/v/engram.svg)](https://www.npmjs.com/package/engram)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

AI coding agents lose all context when a session ends. Engram fixes this by building a semantic memory store from your git history, codebase, and session context -- then making it searchable via MCP tools.

The name comes from neuroscience: an **engram** is a physical memory trace stored in the brain.

## Quick Start

```bash
# 1. Initialize (scans git history + codebase, builds vector store)
cd your-project
npx engram init

# 2. Optionally inject a project spec
npx engram init ./PROJECT.md

# 3. Add to your MCP config (one time)
```

**Cursor** (`~/.cursor/mcp.json`) / **Claude Code** / **Codex**:
```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "engram"],
      "env": {
        "ANTHROPIC_API_KEY": "your-key-here"
      }
    }
  }
}
```

Restart your editor. Engram is running.

> `ANTHROPIC_API_KEY` is optional -- enables LLM-based session compaction. Without it, everything else works.

## How It Works

1. **`engram init`** scans your git commit history and entire codebase
2. Text is chunked, embedded locally (all-MiniLM-L6-v2, runs offline), and stored in a SQLite database
3. Your AI agent uses MCP tools to search and save context
4. Context persists in `.engram/store.db` -- portable across editors and machines

### What Gets Indexed

| Source | What's Extracted |
|--------|-----------------|
| Git log | Commit messages, descriptions, file change patterns |
| Source files | Code structure, functions, classes, patterns |
| Config files | Stack, tooling, dependencies |
| Docs (.md) | Documentation content |
| Project file | Specs, requirements (via `engram init <file>`) |
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

Engram stores everything in a single file: `.engram/store.db`

```bash
# Move to a new machine
scp .engram/store.db user@newmachine:~/project/.engram/

# Share with teammates (commit it)
git add .engram/store.db

# Switch editors -- same file works everywhere
# Claude Code -> Cursor -> Codex -- no migration needed
```

## CLI Commands

```
engram init [project-file]   Scan git history + codebase, build context store
engram inject <file>         Inject/update a project file
engram status                Show what's stored
engram                       Start MCP server (used by AI editors)
```

## Usage Guide

Add to your agent's system prompt or rules:

```
At session start: call engram get_context to load memory from previous sessions.
During session: call engram save_context when you make decisions, discover things, or note constraints.
At session end: call engram summarize_session to compact memory.
```

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Enables LLM compaction in `summarize_session` | none |
| `ENGRAM_MAX_TOKENS` | Default max tokens for `get_context` | `3000` |
| `ENGRAM_MODEL` | Model for compaction | `claude-haiku-4-5-20251001` |

## Architecture

- **Embeddings**: `all-MiniLM-L6-v2` via `@xenova/transformers` -- runs locally, no API key needed
- **Storage**: SQLite via `sql.js` (WASM) -- zero native dependencies, works on any OS
- **Vector search**: Cosine similarity in JS -- fast enough for 100K+ chunks
- **Transport**: MCP stdio -- works with any MCP-compatible editor

## Development

```bash
git clone https://github.com/Ashprakash/engram.git
cd engram
npm install
npm run dev     # run with tsx
npm run build   # compile TypeScript
```

## License

MIT
