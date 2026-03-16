import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { saveContext } from './tools/save_context.js';
import { getContext } from './tools/get_context.js';
import { getStatus } from './tools/get_status.js';
import { summarizeSession } from './tools/summarize_session.js';

export function createServer(): Server {
  const server = new Server(
    { name: 'cortexmem', version: '0.2.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'save_context',
        description:
          'Save context to persistent memory. Call this whenever you make a decision, discover something non-obvious about the codebase, agree on a constraint with the user, note WIP state, or learn a coding preference. Saved context persists across sessions and editors. Call proactively — future sessions depend on what you save now.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            context_type: {
              type: 'string',
              enum: ['decision', 'constraint', 'state', 'discovery', 'preference'],
              description: 'Category: decision (architectural choices), constraint (hard rules), state (WIP progress), discovery (non-obvious facts), preference (code style conventions)',
            },
            content: {
              type: 'string',
              description: 'The context to save. Be specific and include rationale. Example: "Chose PostgreSQL over MongoDB because we need ACID transactions for payment processing."',
            },
            related_files: {
              type: 'array',
              items: { type: 'string' },
              description: 'File paths related to this context',
            },
            confidence: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
              description: 'How confident you are in this context (default: high)',
            },
          },
          required: ['context_type', 'content'],
        },
      },
      {
        name: 'get_context',
        description:
          'Retrieve persistent memory from previous sessions. Call at session start with no arguments to get the context pyramid: project overview, current branch summary, and recent session summaries — all in ~500-800 tokens. Use with a query to do hierarchical search: matches project → branch → session summaries first, then drills into raw chunks only when needed. Use depth to control how deep to search. Always call this first in a new session.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            query: {
              type: 'string',
              description: 'Search query. Searches hierarchically: project → branches → sessions → raw chunks. Omit for a full project overview pyramid.',
            },
            depth: {
              type: 'number',
              description: 'Search depth: 0=project summary only, 1=+branch summaries, 2=+session summaries (default), 3=+raw chunks. Start shallow, go deeper if needed.',
            },
            types: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['decision', 'constraint', 'state', 'discovery', 'preference', 'code', 'commit', 'doc'],
              },
              description: 'Filter results by context type (only applies to raw chunk search at depth 3)',
            },
            max_tokens: {
              type: 'number',
              description: 'Max tokens to return (default 3000)',
            },
          },
        },
      },
      {
        name: 'summarize_session',
        description:
          'Compact and persist session memory into the context pyramid. Creates a session summary from saved context, rolls it up into a branch summary, then updates the project overview. Call at end of session. Works best with ANTHROPIC_API_KEY for LLM-powered compaction; falls back to deterministic summarization without it.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            session_summary: {
              type: 'string',
              description: 'Brief description of what was accomplished this session',
            },
          },
        },
      },
      {
        name: 'get_status',
        description:
          'Quick stats on cortexmem: total chunks stored, breakdown by type, storage location, last init time, last indexed commit.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: string;

      switch (name) {
        case 'save_context':
          result = await saveContext(args as unknown as Parameters<typeof saveContext>[0]);
          break;
        case 'get_context':
          result = await getContext((args || {}) as unknown as Parameters<typeof getContext>[0]);
          break;
        case 'summarize_session':
          result = await summarizeSession((args || {}) as unknown as Parameters<typeof summarizeSession>[0]);
          break;
        case 'get_status':
          result = await getStatus();
          break;
        default:
          result = `Unknown tool: ${name}`;
      }

      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
