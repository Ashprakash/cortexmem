import type { Chunk, ChunkSource, Summary, SummaryLevel } from './types.js';

export interface ChunkInsertParams {
  content: string;
  source: ChunkSource;
  sourceRef: string;
  contextType: string;
  embedding: Float32Array | null;
  metadata?: Record<string, unknown>;
  sessionId?: string | null;
}

export interface SearchFilters {
  contextTypeFilter?: string[];
  sessionFilter?: string;
}

export interface StorageBackend {
  // Lifecycle
  close(): void;

  // Chunks
  insertChunk(
    projectRoot: string,
    content: string,
    source: ChunkSource,
    sourceRef: string,
    contextType: string,
    embedding: Float32Array | null,
    metadata?: Record<string, unknown>,
    sessionId?: string | null,
  ): Promise<number>;

  insertChunksBatch(
    projectRoot: string,
    chunks: ChunkInsertParams[],
  ): Promise<void>;

  getAllEmbeddings(
    projectRoot: string,
  ): Promise<Array<{ id: number; embedding: Float32Array }>>;

  getChunksByIds(projectRoot: string, ids: number[]): Promise<Chunk[]>;
  getChunksByType(projectRoot: string, contextType: string): Promise<Chunk[]>;
  getChunksBySession(projectRoot: string, sessionId: string): Promise<Chunk[]>;
  getRecentChunksBySource(projectRoot: string, source: ChunkSource, limit?: number): Promise<Chunk[]>;

  searchChunksByKeywords(
    projectRoot: string,
    tokens: string[],
    topK?: number,
    contextTypeFilter?: string[],
    sessionFilter?: string,
  ): Promise<Array<{ chunk: Chunk; matchCount: number }>>;

  clearChunksBySource(projectRoot: string, source: ChunkSource): Promise<void>;
  deleteChunksBySourceRef(projectRoot: string, source: ChunkSource, sourceRef: string): Promise<void>;

  // Stats
  getStats(projectRoot: string): Promise<Record<string, number>>;
  getTotalChunks(projectRoot: string): Promise<number>;

  // Config
  setConfig(projectRoot: string, key: string, value: string): Promise<void>;
  getConfig(projectRoot: string, key: string): Promise<string | null>;

  // Summaries
  upsertSummary(
    projectRoot: string,
    level: SummaryLevel,
    scope: string,
    content: string,
    embedding: Float32Array | null,
    parentId?: number | null,
    user?: string | null,
  ): Promise<number>;

  getSummary(projectRoot: string, level: SummaryLevel, scope: string): Promise<Summary | null>;
  getSummariesByLevel(projectRoot: string, level: SummaryLevel): Promise<Summary[]>;
  getChildSummaries(projectRoot: string, parentId: number): Promise<Summary[]>;
  getSummaryEmbeddings(
    projectRoot: string,
    level?: SummaryLevel,
  ): Promise<Array<{ id: number; embedding: Float32Array; scope: string; level: string }>>;

  // Sessions
  getDistinctSessions(projectRoot: string): Promise<string[]>;
}

let activeBackend: StorageBackend | null = null;

export function setBackend(backend: StorageBackend | null): void {
  activeBackend = backend;
}

export function getBackend(): StorageBackend | null {
  return activeBackend;
}
