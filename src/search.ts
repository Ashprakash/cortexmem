import { embed, cosineSimilarity, isModelLoaded } from './embeddings.js';
import { getAllEmbeddings, getChunksByIds, searchChunksByKeywords } from './db.js';
import type { SearchResult } from './types.js';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to',
  'for', 'of', 'and', 'or', 'but', 'not', 'with', 'this', 'that', 'it',
  'be', 'as', 'by', 'from', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'shall',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they',
]);

export function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  return [...new Set(tokens)];
}

const MAX_TOP_K = 100;

export async function search(
  projectRoot: string,
  query: string,
  topK: number = 20,
  contextTypeFilter?: string[],
  sessionFilter?: string,
): Promise<SearchResult[]> {
  const safeTopK = Math.min(Math.max(Math.floor(topK), 1), MAX_TOP_K);
  if (isModelLoaded()) {
    return vectorSearch(projectRoot, query, safeTopK, contextTypeFilter, sessionFilter);
  }
  return keywordSearch(projectRoot, query, safeTopK, contextTypeFilter, sessionFilter);
}

export async function keywordSearch(
  projectRoot: string,
  query: string,
  topK: number = 20,
  contextTypeFilter?: string[],
  sessionFilter?: string,
): Promise<SearchResult[]> {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const results = await searchChunksByKeywords(projectRoot, tokens, topK, contextTypeFilter, sessionFilter);

  return results.map(({ chunk, matchCount }) => ({
    chunk,
    score: matchCount / tokens.length,
  }));
}

export async function vectorSearch(
  projectRoot: string,
  query: string,
  topK: number = 20,
  contextTypeFilter?: string[],
  sessionFilter?: string,
): Promise<SearchResult[]> {
  const queryEmbedding = await embed(query);
  const allEmbeddings = await getAllEmbeddings(projectRoot);

  if (allEmbeddings.length === 0) return [];

  const scored = allEmbeddings.map((item) => ({
    id: item.id,
    score: cosineSimilarity(queryEmbedding, item.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);

  const topIds = scored.slice(0, topK * 2).map((s) => s.id);
  const chunks = await getChunksByIds(projectRoot, topIds);

  const chunkMap = new Map(chunks.map((c) => [c.id, c]));
  const results: SearchResult[] = [];

  for (const s of scored.slice(0, topK * 2)) {
    const chunk = chunkMap.get(s.id);
    if (!chunk) continue;
    if (contextTypeFilter && !contextTypeFilter.includes(chunk.contextType)) continue;
    if (sessionFilter && chunk.sessionId !== sessionFilter) continue;

    results.push({ chunk, score: s.score });
    if (results.length >= topK) break;
  }

  return results;
}
