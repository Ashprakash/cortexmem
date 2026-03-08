import Anthropic from '@anthropic-ai/sdk';
import { getChunksByType, clearChunksBySource, insertChunksBatch } from '../db.js';
import { embed, embedBatch } from '../embeddings.js';
import { detectRepoRoot } from '../git.js';
import type { ContextType } from '../types.js';

const COMPACTION_PROMPT = `You are compacting an AI coding agent's session memory. Below are the context entries saved during sessions. Your job is to:

1. DEDUPLICATE — merge entries that say the same thing
2. COMPRESS — rewrite verbose entries concisely without losing meaning
3. DISCARD — remove exploratory dead ends, wrong assumptions that were corrected
4. ELEVATE — if a discovery was later confirmed as a decision, classify it as a decision

Return JSON only:
{
  "decision": ["entry1", "entry2"],
  "constraint": ["entry1"],
  "state": ["entry1"],
  "discovery": ["entry1"],
  "preference": ["entry1"],
  "discarded_count": 3
}

Entries:
<entries>
{{ENTRIES}}
</entries>`;

interface SummarizeArgs {
  session_summary?: string;
}

export async function summarizeSession(args: SummarizeArgs): Promise<string> {
  const repoRoot = await detectRepoRoot();
  if (!repoRoot) {
    return 'Error: engram requires a git repository. Run from inside a git project.';
  }

  // Gather all user_context entries
  const types: ContextType[] = ['decision', 'constraint', 'state', 'discovery', 'preference'];
  const entries: Array<{ type: string; content: string }> = [];

  for (const type of types) {
    const chunks = await getChunksByType(repoRoot, type);
    const userChunks = chunks.filter((c) => c.source === 'user_context');
    for (const chunk of userChunks) {
      entries.push({ type, content: chunk.content });
    }
  }

  if (entries.length === 0) {
    return 'No user context entries to summarize.';
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return `Found ${entries.length} entries but ANTHROPIC_API_KEY not set. Set it to enable compaction.`;
  }

  const model = process.env.ENGRAM_MODEL || 'claude-haiku-4-5-20251001';
  const entriesText = entries.map((e) => `[${e.type}] ${e.content}`).join('\n');
  const prompt = COMPACTION_PROMPT.replace('{{ENTRIES}}', entriesText);

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return 'Compaction failed: could not parse LLM response.';
    }

    const compacted = JSON.parse(jsonMatch[0]) as Record<string, string[] | number>;

    // Clear old user_context, re-insert compacted entries
    await clearChunksBySource(repoRoot, 'user_context');

    const newChunks: Array<{
      content: string;
      source: 'user_context';
      sourceRef: string;
      contextType: string;
      embedding: Float32Array | null;
    }> = [];

    let totalKept = 0;
    for (const type of types) {
      const items = compacted[type];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const embedding = await embed(item);
        newChunks.push({
          content: item,
          source: 'user_context',
          sourceRef: '',
          contextType: type,
          embedding,
        });
        totalKept++;
      }
    }

    await insertChunksBatch(repoRoot, newChunks);

    const discarded = typeof compacted.discarded_count === 'number' ? compacted.discarded_count : 0;
    let result = `Compaction complete: ${totalKept} entries kept, ${discarded} discarded.`;
    if (args.session_summary) {
      result += `\nSession: ${args.session_summary}`;
    }
    return result;
  } catch (err) {
    return `Compaction failed: ${err instanceof Error ? err.message : 'unknown error'}`;
  }
}
