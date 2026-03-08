import initSqlJs from 'sql.js';
type SqlJsDatabase = import('sql.js').Database;
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { EMBEDDING_DIMS, type Chunk, type ChunkSource } from './types.js';

let db: SqlJsDatabase | null = null;
let currentDbPath: string | null = null;

export function getDbPath(projectRoot: string): string {
  const engramDir = join(projectRoot, '.engram');
  mkdirSync(engramDir, { recursive: true });
  return join(engramDir, 'store.db');
}

export async function getDb(projectRoot: string): Promise<SqlJsDatabase> {
  if (db) return db;

  const SQL = await initSqlJs();
  const dbPath = getDbPath(projectRoot);
  currentDbPath = dbPath;

  if (existsSync(dbPath)) {
    const fileBuffer = readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  initSchema(db);
  return db;
}

export function saveDb(): void {
  if (!db || !currentDbPath) return;
  const data = db.export();
  writeFileSync(currentDbPath, Buffer.from(data));
}

export function closeDb(): void {
  if (db) {
    saveDb();
    db.close();
    db = null;
    currentDbPath = null;
  }
}

function initSchema(db: SqlJsDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT,
      context_type TEXT NOT NULL,
      embedding BLOB,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      session_id TEXT
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
    CREATE INDEX IF NOT EXISTS idx_chunks_context_type ON chunks(context_type);
  `);
}

function embeddingToBlob(embedding: Float32Array): Uint8Array {
  return new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function blobToEmbedding(blob: Uint8Array): Float32Array {
  const buffer = new ArrayBuffer(blob.length);
  new Uint8Array(buffer).set(blob);
  return new Float32Array(buffer);
}

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
  const d = await getDb(projectRoot);
  const embeddingBlob = embedding ? embeddingToBlob(embedding) : null;

  d.run(
    `INSERT INTO chunks (content, source, source_ref, context_type, embedding, metadata, created_at, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      content,
      source,
      sourceRef,
      contextType,
      embeddingBlob,
      JSON.stringify(metadata),
      new Date().toISOString(),
      sessionId,
    ],
  );

  const result = d.exec('SELECT last_insert_rowid() as id');
  const id = result[0]?.values[0]?.[0] as number;

  saveDb();
  return id;
}

export async function insertChunksBatch(
  projectRoot: string,
  chunks: Array<{
    content: string;
    source: ChunkSource;
    sourceRef: string;
    contextType: string;
    embedding: Float32Array | null;
    metadata?: Record<string, unknown>;
    sessionId?: string | null;
  }>,
): Promise<void> {
  const d = await getDb(projectRoot);
  const now = new Date().toISOString();

  d.run('BEGIN TRANSACTION');
  try {
    for (const chunk of chunks) {
      const embeddingBlob = chunk.embedding ? embeddingToBlob(chunk.embedding) : null;
      d.run(
        `INSERT INTO chunks (content, source, source_ref, context_type, embedding, metadata, created_at, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          chunk.content,
          chunk.source,
          chunk.sourceRef,
          chunk.contextType,
          embeddingBlob,
          JSON.stringify(chunk.metadata || {}),
          now,
          chunk.sessionId || null,
        ],
      );
    }
    d.run('COMMIT');
  } catch (err) {
    d.run('ROLLBACK');
    throw err;
  }

  saveDb();
}

export async function getAllEmbeddings(
  projectRoot: string,
): Promise<Array<{ id: number; embedding: Float32Array }>> {
  const d = await getDb(projectRoot);
  const results = d.exec('SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL');

  if (!results[0]) return [];

  return results[0].values.map(([id, blob]) => ({
    id: id as number,
    embedding: blobToEmbedding(blob as Uint8Array),
  }));
}

export async function getChunksByIds(
  projectRoot: string,
  ids: number[],
): Promise<Chunk[]> {
  if (ids.length === 0) return [];
  const d = await getDb(projectRoot);
  const placeholders = ids.map(() => '?').join(',');
  const results = d.exec(
    `SELECT * FROM chunks WHERE id IN (${placeholders})`,
    ids,
  );

  if (!results[0]) return [];
  return results[0].values.map(rowToChunk);
}

export async function getChunksByType(
  projectRoot: string,
  contextType: string,
): Promise<Chunk[]> {
  const d = await getDb(projectRoot);
  const results = d.exec(
    'SELECT * FROM chunks WHERE context_type = ? ORDER BY created_at DESC',
    [contextType],
  );

  if (!results[0]) return [];
  return results[0].values.map(rowToChunk);
}

export async function getStats(projectRoot: string): Promise<Record<string, number>> {
  const d = await getDb(projectRoot);
  const results = d.exec('SELECT context_type, COUNT(*) as count FROM chunks GROUP BY context_type');

  const stats: Record<string, number> = {};
  if (results[0]) {
    for (const row of results[0].values) {
      stats[row[0] as string] = row[1] as number;
    }
  }
  return stats;
}

export async function getTotalChunks(projectRoot: string): Promise<number> {
  const d = await getDb(projectRoot);
  const results = d.exec('SELECT COUNT(*) as count FROM chunks');
  return (results[0]?.values[0]?.[0] as number) || 0;
}

export async function setConfig(projectRoot: string, key: string, value: string): Promise<void> {
  const d = await getDb(projectRoot);
  d.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [key, value]);
  saveDb();
}

export async function getConfig(projectRoot: string, key: string): Promise<string | null> {
  const d = await getDb(projectRoot);
  const results = d.exec('SELECT value FROM config WHERE key = ?', [key]);
  return (results[0]?.values[0]?.[0] as string) || null;
}

export async function clearChunksBySource(projectRoot: string, source: ChunkSource): Promise<void> {
  const d = await getDb(projectRoot);
  d.run('DELETE FROM chunks WHERE source = ?', [source]);
  saveDb();
}

function rowToChunk(row: unknown[]): Chunk {
  return {
    id: row[0] as number,
    content: row[1] as string,
    source: row[2] as ChunkSource,
    sourceRef: row[3] as string,
    contextType: row[4] as Chunk['contextType'],
    embedding: row[5] ? blobToEmbedding(row[5] as Uint8Array) : null,
    metadata: JSON.parse((row[6] as string) || '{}'),
    createdAt: row[7] as string,
    sessionId: row[8] as string | null,
  };
}
