import { search } from '../search.js';
import { getChunksByType, getStats, getConfig, getRecentChunksBySource } from '../db.js';
import { detectRepoRoot, getCommitHistory } from '../git.js';
import { CONTEXT_TYPE_LABELS } from '../types.js';
import { buildPyramid, hierarchicalSearch } from '../hierarchy.js';

interface GetContextArgs {
  query?: string;
  types?: string[];
  max_tokens?: number;
  depth?: number;
}

export async function getContext(args: GetContextArgs): Promise<string> {
  const repoRoot = await detectRepoRoot();
  if (!repoRoot) {
    return 'Error: cortexmem requires a git repository. Run from inside a git project.';
  }

  const envTokens = Number(process.env.CORTEXMEM_MAX_TOKENS);
  const rawMaxTokens = args.max_tokens || (Number.isFinite(envTokens) ? envTokens : 0) || 3000;
  const maxTokens = Math.min(Math.max(rawMaxTokens, 100), 50000);
  const maxChars = maxTokens * 4;
  const repoName = repoRoot.split('/').pop() || repoRoot;
  const rawDepth = Number.isFinite(args.depth) ? args.depth! : 2;
  const depth = Math.min(Math.max(Math.floor(rawDepth), 0), 3);

  // --- Query mode: hierarchical search ---
  if (args.query) {
    // Try hierarchical search first
    const hierarchicalResults = await hierarchicalSearch(repoRoot, args.query, depth);

    if (hierarchicalResults.length > 0) {
      let output = `## CortexMem Context — ${repoName}\nQuery: "${args.query}" | depth: ${depth}\n\n`;
      let totalChars = output.length;

      for (const result of hierarchicalResults) {
        const score = (result.score * 100).toFixed(0);
        let entry = `### [${result.breadcrumb}] (${score}% match)\n${result.summary.content}\n`;

        // Include drill-down chunks if present
        if (result.chunks && result.chunks.length > 0) {
          entry += '\n**Details:**\n';
          for (const chunk of result.chunks) {
            const typeLabel = CONTEXT_TYPE_LABELS[chunk.chunk.contextType] || chunk.chunk.contextType;
            entry += `- [${typeLabel}] ${chunk.chunk.content.slice(0, 200)}\n`;
          }
        }
        entry += '\n';

        if (totalChars + entry.length > maxChars) {
          output += `_...truncated to stay within ${maxTokens} token limit. Use depth:${Math.min(depth + 1, 3)} for more._\n`;
          break;
        }

        output += entry;
        totalChars += entry.length;
      }

      return output;
    }

    // Fallback: flat keyword/vector search (no pyramid built yet)
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

  // --- No query: return pyramid overview ---
  const stats = await getStats(repoRoot);
  const lastInit = await getConfig(repoRoot, 'last_init_at');

  let output = `## CortexMem Context — ${repoName}\n`;
  if (lastInit) {
    output += `Initialized: ${lastInit}\n`;
  }
  output += '\n';

  let totalChars = output.length;

  // Try pyramid first (hierarchical summaries)
  const pyramid = await buildPyramid(repoRoot);
  if (pyramid) {
    if (totalChars + pyramid.length <= maxChars) {
      output += pyramid;
      totalChars += pyramid.length;
    } else {
      // Truncate pyramid to fit
      const available = maxChars - totalChars - 50;
      output += pyramid.slice(0, available) + '\n_...pyramid truncated_\n';
      totalChars = maxChars;
    }
  }

  // Stats breakdown
  if (Object.keys(stats).length > 0 && totalChars < maxChars - 200) {
    let section = '### Index Stats\n';
    for (const [type, count] of Object.entries(stats)) {
      const label = CONTEXT_TYPE_LABELS[type] || type;
      section += `- ${label}: ${count} chunks\n`;
    }
    section += '\n';

    if (totalChars + section.length <= maxChars) {
      output += section;
      totalChars += section.length;
    }
  }

  // If no pyramid exists, fall back to flat overview
  if (!pyramid) {
    // User-saved context
    const priorityTypes = ['constraint', 'decision', 'state', 'discovery', 'preference'];
    for (const type of priorityTypes) {
      if (args.types && !args.types.includes(type)) continue;
      if (!stats[type]) continue;

      const chunks = await getChunksByType(repoRoot, type);
      if (chunks.length === 0) continue;

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

    // Recent git activity
    try {
      const commits = await getCommitHistory(repoRoot, 10);
      if (commits.length > 0 && totalChars < maxChars - 300) {
        let section = '### Recent Git Activity\n';
        for (const commit of commits) {
          const shortHash = commit.hash.slice(0, 8);
          section += `- \`${shortHash}\` ${commit.message}\n`;
        }
        section += '\n';

        if (totalChars + section.length <= maxChars) {
          output += section;
          totalChars += section.length;
        }
      }
    } catch {
      // Skip
    }

    // Project docs
    const docChunks = await getRecentChunksBySource(repoRoot, 'project_file', 3);
    if (docChunks.length > 0 && totalChars < maxChars - 200) {
      let section = '### Project Documentation\n';
      for (const chunk of docChunks) {
        const preview = chunk.content.length > 200
          ? chunk.content.slice(0, 200) + '...'
          : chunk.content;
        section += `- ${preview}\n`;
      }
      section += '\n';

      if (totalChars + section.length <= maxChars) {
        output += section;
        totalChars += section.length;
      }
    }
  }

  if (Object.keys(stats).length === 0 && !pyramid) {
    output += '_No context stored yet. Use save_context to start building memory, or run `cortexmem init` to ingest codebase._\n';
  }

  return output;
}
