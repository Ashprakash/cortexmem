import { search } from '../search.js';
import { getChunksByType, getStats, getConfig } from '../db.js';
import { detectRepoRoot } from '../git.js';
import { CONTEXT_TYPE_LABELS } from '../types.js';

interface GetContextArgs {
  query?: string;
  types?: string[];
  max_tokens?: number;
}

export async function getContext(args: GetContextArgs): Promise<string> {
  const repoRoot = await detectRepoRoot();
  if (!repoRoot) {
    return 'Error: cortexmem requires a git repository. Run from inside a git project.';
  }

  const maxTokens = args.max_tokens || Number(process.env.CORTEXMEM_MAX_TOKENS) || 3000;
  const maxChars = maxTokens * 4;
  const repoName = repoRoot.split('/').pop() || repoRoot;

  // If a query is provided, do semantic search
  if (args.query) {
    const results = await search(repoRoot, args.query, 20, args.types);

    if (results.length === 0) {
      return `No relevant context found for: "${args.query}"`;
    }

    let output = `## CortexMem Context — ${repoName}\nQuery: "${args.query}" | ${results.length} results\n\n`;
    let totalChars = output.length;

    for (const result of results) {
      const typeLabel = CONTEXT_TYPE_LABELS[result.chunk.contextType] || result.chunk.contextType;
      const score = (result.score * 100).toFixed(0);
      const entry = `### [${typeLabel}] (${score}% match)\n${result.chunk.content}\n\n`;

      if (totalChars + entry.length > maxChars) {
        output += `_...truncated to stay within ${maxTokens} token limit_\n`;
        break;
      }

      output += entry;
      totalChars += entry.length;
    }

    return output;
  }

  // No query — return structured overview
  const stats = await getStats(repoRoot);
  const priorityTypes = ['constraint', 'decision', 'state', 'discovery', 'preference'];

  let output = `## CortexMem Context — ${repoName}\n`;
  const lastInit = await getConfig(repoRoot, 'last_init_at');
  if (lastInit) {
    output += `Initialized: ${lastInit}\n`;
  }
  output += '\n';

  let totalChars = output.length;

  for (const type of priorityTypes) {
    if (args.types && !args.types.includes(type)) continue;
    if (!stats[type]) continue;

    const chunks = await getChunksByType(repoRoot, type);
    const label = CONTEXT_TYPE_LABELS[type] || type;
    let section = `### ${label}\n`;

    for (const chunk of chunks) {
      section += `- ${chunk.content}\n`;
    }
    section += '\n';

    if (totalChars + section.length > maxChars) {
      output += `_...truncated to stay within ${maxTokens} token limit_\n`;
      break;
    }

    output += section;
    totalChars += section.length;
  }

  if (Object.keys(stats).length === 0) {
    output += '_No context stored yet. Use save_context to start building memory, or run `cortexmem init` to ingest codebase._\n';
  }

  return output;
}
