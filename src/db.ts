/**
 * Public API for data access. All functions delegate to the active StorageBackend.
 *
 * Default backend is SqliteBackend. Future backends (e.g. PostgreSQL) can be
 * swapped in via setBackend() before any data access calls.
 *
 * Every existing import site continues to work unchanged.
 */

import type { Chunk, ChunkSource, Summary, SummaryLevel } from './types.js';
import type { ChunkInsertParams } from './storage.js';
import { getBackend, setBackend } from './storage.js';
import { SqliteBackend } from './backends/sqlite.js';

function backend(): SqliteBackend {
  let b = getBackend();
  if (!b) {
    b = new SqliteBackend();
    setBackend(b);
  }
  return b as SqliteBackend;
}

// --- Lifecycle ---

export function closeDb(): void {
  const b = getBackend();
  if (b) {
    b.close();
    setBackend(null);
  }
}

// Expose raw DB for tests and security tests that need direct SQL access
export async function getDb(projectRoot: string) {
  return backend().getRawDb(projectRoot);
}

// --- Chunks ---

export async function insertChunk(
  projectRoot: string,
  content: string,
  source: ChunkSource,
  sourceRef: string,
  contextType: string,
  embedding: Float32Array | null,
  metadata: Record<string, unknown> = {},
  sessionId: string | null = null,
): Promise<number> {
  return backend().insertChunk(projectRoot, content, source, sourceRef, contextType, embedding, metadata, sessionId);
}

export async function insertChunksBatch(
  projectRoot: string,
  chunks: ChunkInsertParams[],
): Promise<void> {
  return backend().insertChunksBatch(projectRoot, chunks);
}

export async function getAllEmbeddings(
  projectRoot: string,
): Promise<Array<{ id: number; embedding: Float32Array }>> {
  return backend().getAllEmbeddings(projectRoot);
}

export async function getChunksByIds(projectRoot: string, ids: number[]): Promise<Chunk[]> {
  return backend().getChunksByIds(projectRoot, ids);
}

export async function getChunksByType(projectRoot: string, contextType: string): Promise<Chunk[]> {
  return backend().getChunksByType(projectRoot, contextType);
}

export async function getChunksBySession(projectRoot: string, sessionId: string): Promise<Chunk[]> {
  return backend().getChunksBySession(projectRoot, sessionId);
}

export async function getRecentChunksBySource(
  projectRoot: string,
  source: ChunkSource,
  limit: number = 10,
): Promise<Chunk[]> {
  return backend().getRecentChunksBySource(projectRoot, source, limit);
}

export async function searchChunksByKeywords(
  projectRoot: string,
  tokens: string[],
  topK: number = 20,
  contextTypeFilter?: string[],
  sessionFilter?: string,
): Promise<Array<{ chunk: Chunk; matchCount: number }>> {
  return backend().searchChunksByKeywords(projectRoot, tokens, topK, contextTypeFilter, sessionFilter);
}

export async function clearChunksBySource(projectRoot: string, source: ChunkSource): Promise<void> {
  return backend().clearChunksBySource(projectRoot, source);
}

export async function deleteChunksBySourceRef(projectRoot: string, source: ChunkSource, sourceRef: string): Promise<void> {
  return backend().deleteChunksBySourceRef(projectRoot, source, sourceRef);
}

// --- Stats ---

export async function getStats(projectRoot: string): Promise<Record<string, number>> {
  return backend().getStats(projectRoot);
}

export async function getTotalChunks(projectRoot: string): Promise<number> {
  return backend().getTotalChunks(projectRoot);
}

// --- Config ---

export async function setConfig(projectRoot: string, key: string, value: string): Promise<void> {
  return backend().setConfig(projectRoot, key, value);
}

export async function getConfig(projectRoot: string, key: string): Promise<string | null> {
  return backend().getConfig(projectRoot, key);
}

// --- Summaries ---

export async function upsertSummary(
  projectRoot: string,
  level: SummaryLevel,
  scope: string,
  content: string,
  embedding: Float32Array | null,
  parentId: number | null = null,
  user: string | null = null,
): Promise<number> {
  return backend().upsertSummary(projectRoot, level, scope, content, embedding, parentId, user);
}

export async function getSummary(
  projectRoot: string,
  level: SummaryLevel,
  scope: string,
): Promise<Summary | null> {
  return backend().getSummary(projectRoot, level, scope);
}

export async function getSummariesByLevel(
  projectRoot: string,
  level: SummaryLevel,
): Promise<Summary[]> {
  return backend().getSummariesByLevel(projectRoot, level);
}

export async function getChildSummaries(
  projectRoot: string,
  parentId: number,
): Promise<Summary[]> {
  return backend().getChildSummaries(projectRoot, parentId);
}

export async function getSummaryEmbeddings(
  projectRoot: string,
  level?: SummaryLevel,
): Promise<Array<{ id: number; embedding: Float32Array; scope: string; level: string }>> {
  return backend().getSummaryEmbeddings(projectRoot, level);
}

// --- Sessions ---

export async function getDistinctSessions(projectRoot: string): Promise<string[]> {
  return backend().getDistinctSessions(projectRoot);
}
