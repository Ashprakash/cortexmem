import { embed, cosineSimilarity } from './embeddings.js';
import { getAllEmbeddings, getChunksByIds } from './db.js';
import type { SearchResult } from './types.js';

export async function search(
  projectRoot: string,
  query: string,
  topK: number = 20,
  contextTypeFilter?: string[],
): Promise<SearchResult[]> {
  const queryEmbedding = await embed(query);
  const allEmbeddings = await getAllEmbeddings(projectRoot);

  if (allEmbeddings.length === 0) return [];

  // Compute similarities
  const scored = allEmbeddings.map((item) => ({
    id: item.id,
    score: cosineSimilarity(queryEmbedding, item.embedding),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Take top candidates
  const topIds = scored.slice(0, topK * 2).map((s) => s.id);
  const chunks = await getChunksByIds(projectRoot, topIds);

  // Build results with optional filter
  const chunkMap = new Map(chunks.map((c) => [c.id, c]));
  const results: SearchResult[] = [];

  for (const s of scored.slice(0, topK * 2)) {
    const chunk = chunkMap.get(s.id);
    if (!chunk) continue;
    if (contextTypeFilter && !contextTypeFilter.includes(chunk.contextType)) continue;

    results.push({ chunk, score: s.score });
    if (results.length >= topK) break;
  }

  return results;
}
