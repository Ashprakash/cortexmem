# engram

**Persistent memory for AI coding agents — zero config, works with Cursor, Claude Code, and GitHub Copilot.**

[![npm version](https://img.shields.io/npm/v/engram.svg)](https://www.npmjs.com/package/engram)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

AI coding agents lose all context when a session ends. Developers waste 10-20 minutes every session re-explaining their codebase, constraints, and decisions. Engram fixes this by acting as a persistent memory layer that any MCP-compatible agent can read from and write to.

The name comes from neuroscience: an **engram** is a physical memory trace stored in the brain.

## Quick Start

Add to your MCP config (one-time setup):

**Cursor** (`~/.cursor/mcp.json`):
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

**Claude Code** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
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

> `ANTHROPIC_API_KEY` is optional. It enables LLM-based session compaction via `summarize_session`. Without it, raw session logs are archived instead.

## How It Works

Engram stores memory as plain markdown files in `~/.engram/`, scoped per repo and branch. No database, no black box.

### Memory Types

| Type | Purpose | Example |
|------|---------|---------|
| **decision** | Architectural/technical choices | "Chose PostgreSQL over MongoDB for ACID transactions" |
| **constraint** | Hard rules to never violate | "Never modify auth middleware directly" |
| **state** | Current WIP status | "Payment refactor: 2/4 services done" |
| **discovery** | Non-obvious codebase facts | "UserService is called from 6 places, not 3" |
| **preference** | Code style conventions | "Snake_case for variables, PascalCase for classes" |

### MCP Tools

- **`get_context`** — Retrieve all stored memory for the current repo/branch. Call at session start.
- **`save_context`** — Save a new memory entry. Call whenever you learn something worth remembering.
- **`summarize_session`** — Compact and deduplicate session entries. Call at session end.
- **`get_status`** — Quick overview of what's stored without loading content.

## Usage Guide

Add this to your agent's system prompt or rules file:

```
At session start: call engram get_context to restore memory from previous sessions.
During session: call engram save_context to record decisions, constraints, discoveries, state, and preferences.
At session end: call engram summarize_session to compact and preserve memory.
```

### Cursor Rules Example (`.cursor/rules/engram.mdc`)

```
At session start: use the engram get_context tool and read the output carefully.
During session: use engram save_context to record decisions, constraints, and discoveries.
At session end or when asked: use engram summarize_session.
```

## Storage Layout

```
~/.engram/
  a3f9b2c1/                    # hash of /Users/dev/myproject
    main/
      decisions.md
      constraints.md
      state.md
      discoveries.md
      preferences.md
      session_log.jsonl
      meta.json
    feature/auth-refactor/
      ...
```

All files are human-readable markdown. You can edit them directly.

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Enables LLM compaction in `summarize_session` | none |
| `ENGRAM_STORAGE_DIR` | Override storage location | `~/.engram/` |
| `ENGRAM_MAX_TOKENS` | Default max tokens for `get_context` | `3000` |
| `ENGRAM_MODEL` | Model for compaction | `claude-haiku-4-5-20251001` |

## Development

```bash
git clone https://github.com/AjiteshSK/engram.git
cd engram
npm install
npm run dev     # run with tsx
npm run build   # compile TypeScript
```

## License

MIT
