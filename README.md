# cortexmem

**Persistent memory for AI coding agents. Zero config, works with Cursor, Claude Code, Codex, and any MCP-compatible editor.**

[![npm version](https://img.shields.io/npm/v/cortexmem.svg)](https://www.npmjs.com/package/cortexmem)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

AI coding agents lose all context when a session ends. CortexMem fixes this by building a semantic memory store from your git history, codebase, and session context, then making it searchable via MCP tools.

## Setup

### Step 1: Initialize your project

```bash
cd your-project
npx cortexmem init
```

This scans your git history and codebase, embeds everything locally, and stores it in `.cortexmem/store.db`. It also generates editor config files (`CLAUDE.md`, `.cursorrules`, `codex.md`) that instruct AI agents to use cortexmem automatically.

First run downloads the embedding model (~30MB, one-time). Subsequent runs are **incremental** and only re-index new commits and changed files.

```
$ npx cortexmem init

CortexMem — initializing context for /Users/you/my-project

Full scan — first-time initialization...
  Found 142 commits → 87 chunks
  Found 38 files → 52 chunks

Embedding 139 chunks...
Storing in database...
Building project summary...
Generating editor configs...
  Created: CLAUDE.md, .cursorrules, codex.md
Done!

Summary:
  Git commits indexed: 142
  Source files scanned: 38
  Total chunks stored: 139

Storage: /Users/you/my-project/.cortexmem/store.db

Add to your MCP config to start using cortexmem with your AI agent.
```

You can optionally include a project spec or requirements doc:

```bash
npx cortexmem init ./PROJECT.md
```

### Step 2: Add to your editor's MCP config

**Cursor** (add to `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "cortexmem": {
      "command": "npx",
      "args": ["-y", "cortexmem"]
    }
  }
}
```

**Claude Code** (add to `~/.claude.json` or project settings):

```json
{
  "mcpServers": {
    "cortexmem": {
      "command": "npx",
      "args": ["-y", "cortexmem"]
    }
  }
}
```

**With LLM-powered compaction** (optional, add your Anthropic API key):

```json
{
  "mcpServers": {
    "cortexmem": {
      "command": "npx",
      "args": ["-y", "cortexmem"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Restart your editor. CortexMem is running.

> `ANTHROPIC_API_KEY` is optional. It enables LLM-based session compaction via `summarize_session`. Without it, everything else works and compaction uses a deterministic fallback.

### Step 3: There is no step 3

The generated editor config files (`CLAUDE.md`, `.cursorrules`, `codex.md`) instruct your AI agent to use cortexmem automatically. It will:

- Load context from previous sessions on startup
- Save decisions, discoveries, and constraints as you work
- Compact memory at session end

No manual tool calls needed.

## Example: What a session looks like

### Session 1: You start working on auth

Your AI agent automatically calls `get_context` at session start:

```
## CortexMem Context — my-project
Initialized: 2026-03-08T10:30:00Z

### Project Overview
my-project: Node.js/TypeScript API server. 142 commits, 38 files.
Stack: Express, PostgreSQL, Jest. Main modules: auth, payments, users.

### Index Stats
- Commit Summaries: 87 chunks
- Code Summaries: 52 chunks
```

During work, the agent saves context automatically:

```
save_context({
  context_type: "decision",
  content: "Using JWT with refresh tokens for auth. Access tokens expire in 15min, refresh tokens in 7 days. Stored in httpOnly cookies, not localStorage.",
  related_files: ["src/auth/jwt.ts", "src/middleware/auth.ts"]
})
→ Saved decision context (id: 12, session: a1b2c3, branch: main)

save_context({
  context_type: "constraint",
  content: "Auth middleware must never be modified directly. Extend via plugins in src/auth/plugins/",
  related_files: ["src/middleware/auth.ts"]
})
→ Saved constraint context (id: 13, session: a1b2c3, branch: main)

save_context({
  context_type: "state",
  content: "Auth implementation: JWT service done, middleware done, refresh token rotation TODO",
  related_files: ["src/auth/jwt.ts"]
})
→ Saved state context (id: 14, session: a1b2c3, branch: main)
```

At session end, the agent calls `summarize_session`:

```
summarize_session({ session_summary: "Implemented JWT auth with refresh tokens" })
→ Compaction complete:
  Session: Compacted 3 entries into session summary
  Branch (main): Updated branch summary
  Project: Updated project overview
```

### Session 2: Different day, context is preserved

The agent calls `get_context` and immediately has full context:

```
## CortexMem Context — my-project

### Project Overview
my-project: Node.js/TypeScript API with JWT auth (access + refresh tokens),
PostgreSQL, Express. Auth module complete, payment refactor in progress.

### Branch: main
JWT auth implemented with httpOnly cookies. Auth middleware uses plugin
architecture (never modify directly). Refresh token rotation still TODO.

### Recent Sessions (main)
#### Session a1b2c3 (2026-03-08)
Implemented JWT authentication with refresh tokens. Access tokens expire
in 15min, refresh in 7 days. Created plugin-based auth middleware.
Refresh token rotation is the next task.

### Index Stats
- Decisions: 1 chunks
- Constraints: 1 chunks
- State: 1 chunks
- Commit Summaries: 87 chunks
- Code Summaries: 52 chunks
```

The agent can also search for specific context:

```
get_context({ query: "auth middleware", depth: 3 })
→ ## CortexMem Context — my-project
  Query: "auth middleware" | depth: 3

  ### [project > branch:main > session:a1b2c3] (87% match)
  JWT auth with refresh tokens. Plugin-based middleware architecture.

  **Details:**
  - [Constraint] Auth middleware must never be modified directly. Extend via plugins
  - [Decision] Using JWT with refresh tokens for auth. Access tokens expire in 15min...
```

### Re-running init (incremental)

When you come back after more commits:

```
$ npx cortexmem init

CortexMem — initializing context for /Users/you/my-project

Incremental update — scanning changes since last init...
  8 new commits → 6 chunks
  3 files changed
  3 changed files → 4 chunks

Embedding 10 chunks...
Storing in database...
Building project summary...
Done!

Summary (incremental):
  Git commits indexed: 8 (new)
  Source files scanned: 38
  Total chunks stored: 10 (new)
```

## How It Works

1. **`cortexmem init`** scans your git history and codebase, chunks and embeds everything locally
2. Everything is stored in `.cortexmem/store.db`, a single SQLite file portable across editors and machines
3. Your AI agent uses 4 MCP tools to search, save, and compact context
4. Context is organized in a **pyramid**: project, branch, and session summaries with raw chunks underneath

### The Context Pyramid

```
Project Summary              ← "What is this project about?"
├── Branch: main             ← "What's happening on main?"
│   ├── Session a1b2c3       ← "What did we do 2 days ago?"
│   └── Session d4e5f6       ← "What did we do yesterday?"
└── Branch: feature/payments ← "What's the payments work?"
    └── Session g7h8i9
```

- `get_context()` returns the pyramid overview (~500-800 tokens)
- `get_context({ query: "..." })` searches hierarchically, matching summaries first and drilling into raw chunks only when needed
- `summarize_session()` rolls up: session chunks → session summary → branch summary → project summary

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

| Tool | When to use | What it does |
|------|-------------|-------------|
| **`get_context`** | Session start, or when you need specific context | Returns pyramid overview (no args) or hierarchical search (with `query`). Depth 0-3 controls granularity. |
| **`save_context`** | When the agent makes a decision, discovers something, notes a constraint | Embeds and stores instantly. Types: `decision`, `constraint`, `state`, `discovery`, `preference`. |
| **`summarize_session`** | End of session | Compacts saved context into the pyramid. Uses Claude Haiku if `ANTHROPIC_API_KEY` is set, deterministic fallback otherwise. |
| **`get_status`** | Anytime | Quick stats: chunk counts by type, storage location, last init time. |

### Context Types

| Type | Purpose | Example |
|------|---------|---------|
| **decision** | Architectural/technical choices | "Chose PostgreSQL over MongoDB for ACID transactions" |
| **constraint** | Hard rules to never violate | "Never modify auth middleware directly" |
| **state** | Current WIP status | "Payment refactor: 2/4 services done" |
| **discovery** | Non-obvious codebase facts | "UserService is called from 6 places, not 3" |
| **preference** | Code style conventions | "Snake_case for variables, PascalCase for classes" |

## CLI Commands

```
cortexmem init [project-file]   Scan git history + codebase, build context store
                                 Incremental on re-run, only indexes new changes
cortexmem inject <file>         Inject/update a project file (spec, requirements)
cortexmem status                Show what's stored
cortexmem                       Start MCP server (used by AI editors)
```

## Portability

CortexMem stores everything in a single file: `.cortexmem/store.db`

```bash
# Move to a new machine
scp .cortexmem/store.db user@newmachine:~/project/.cortexmem/

# Share with teammates (commit it)
git add .cortexmem/store.db

# Switch editors, same file works everywhere
# Claude Code -> Cursor -> Codex, no migration needed
```

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Enables LLM compaction in `summarize_session` | none (deterministic fallback) |
| `CORTEXMEM_MAX_TOKENS` | Default max tokens for `get_context` | `3000` |
| `CORTEXMEM_MODEL` | Model for compaction | `claude-haiku-4-5-20251001` |

## Architecture

- **Embeddings**: `all-MiniLM-L6-v2` via `@xenova/transformers`. Runs locally, no API key needed, ~30MB model
- **Storage**: SQLite via `sql.js` (WASM). Zero native dependencies, works on any OS
- **Search**: Hybrid keyword + vector search. Keywords by default, vector when model is warm. Both work offline.
- **Transport**: MCP stdio. Works with any MCP-compatible editor

## Development

```bash
git clone https://github.com/Ashprakash/cortexmem.git
cd cortexmem
npm install
npm test          # run 106 tests
npm run dev       # run with tsx
npm run build     # compile TypeScript
```

## License

MIT
