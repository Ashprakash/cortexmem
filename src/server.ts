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

export async function startServer(): Promise<void> {
  const server = new Server(
    { name: 'cortexmem', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'save_context',
        description:
          'Save context to persistent memory. Call when you make a decision, discover something about the codebase, agree on a constraint, note WIP state, or learn a preference. Memory persists across sessions and editors.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            context_type: {
              type: 'string',
              enum: ['decision', 'constraint', 'state', 'discovery', 'preference'],
              description: 'Category of context',
            },
            content: {
              type: 'string',
              description: 'The context to save. Be specific, include rationale.',
            },
            related_files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Relevant file paths',
            },
            confidence: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
              description: 'Confidence level',
            },
          },
          required: ['context_type', 'content'],
        },
      },
      {
        name: 'get_context',
        description:
          'Retrieve persistent memory. Use with a query for semantic search across all stored context (code, git history, decisions, docs). Without a query, returns structured overview of saved context. Call at session start.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            query: {
              type: 'string',
              description: 'Semantic search query. Returns most relevant chunks.',
            },
            types: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['decision', 'constraint', 'state', 'discovery', 'preference', 'code', 'commit', 'doc'],
              },
              description: 'Filter by context types',
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
          'Compact session context by deduplicating, compressing, and discarding dead ends. Requires ANTHROPIC_API_KEY.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            session_summary: {
              type: 'string',
              description: 'Brief description of what was accomplished',
            },
          },
        },
      },
      {
        name: 'get_status',
        description:
          'Check cortexmem status: stored chunks, types, last init time, storage location.',
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
