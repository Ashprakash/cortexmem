import initSqlJs from 'sql.js';
type SqlJsDatabase = import('sql.js').Database;
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { Chunk, ChunkSource, Summary, SummaryLevel } from '../types.js';
import type { StorageBackend, ChunkInsertParams } from '../storage.js';

let db: SqlJsDatabase | null = null;
let currentDbPath: string | null = null;

function getDbPath(projectRoot: string): string {
  const cortexmemDir = join(projectRoot, '.cortexmem');
  mkdirSync(cortexmemDir, { recursive: true });
  return join(cortexmemDir, 'store.db');
}

async function getDb(projectRoot: string): Promise<SqlJsDatabase> {
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

function saveDb(): void {
  if (!db || !currentDbPath) return;
  const data = db.export();
  writeFileSync(currentDbPath, Buffer.from(data));
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
    CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);

    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      scope TEXT NOT NULL,
      user TEXT,
      content TEXT NOT NULL,
      embedding BLOB,
      parent_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES summaries(id)
    );

    CREATE INDEX IF NOT EXISTS idx_summaries_level ON summaries(level);
    CREATE INDEX IF NOT EXISTS idx_summaries_scope ON summaries(scope);
    CREATE INDEX IF NOT EXISTS idx_summaries_parent ON summaries(parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_level_scope ON summaries(level, scope);
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

function safeParseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const safe: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(parsed)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      safe[key] = value;
    }
    return safe;
  } catch {
    return {};
  }
}

function rowToChunk(row: unknown[]): Chunk {
  return {
    id: row[0] as number,
    content: row[1] as string,
    source: row[2] as ChunkSource,
    sourceRef: row[3] as string,
    contextType: row[4] as Chunk['contextType'],
    embedding: row[5] ? blobToEmbedding(row[5] as Uint8Array) : null,
    metadata: safeParseMetadata(row[6] as string),
    createdAt: row[7] as string,
    sessionId: row[8] as string | null,
  };
}

function rowToSummary(row: unknown[]): Summary {
  return {
    id: row[0] as number,
    level: row[1] as SummaryLevel,
    scope: row[2] as string,
    user: row[3] as string | null,
    content: row[4] as string,
    embedding: row[5] ? blobToEmbedding(row[5] as Uint8Array) : null,
    parentId: row[6] as number | null,
    createdAt: row[7] as string,
    updatedAt: row[8] as string,
  };
}

export class SqliteBackend implements StorageBackend {
  close(): void {
    if (db) {
      saveDb();
      db.close();
      db = null;
      currentDbPath = null;
    }
  }

  // Exposed for tests that need direct DB access
  async getRawDb(projectRoot: string): Promise<SqlJsDatabase> {
    return getDb(projectRoot);
  }

  async insertChunk(
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

  async insertChunksBatch(
    projectRoot: string,
    chunks: ChunkInsertParams[],
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

  async getAllEmbeddings(
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

  async getChunksByIds(projectRoot: string, ids: number[]): Promise<Chunk[]> {
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

  async getChunksByType(projectRoot: string, contextType: string): Promise<Chunk[]> {
    const d = await getDb(projectRoot);
    const results = d.exec(
      'SELECT * FROM chunks WHERE context_type = ? ORDER BY created_at DESC',
      [contextType],
    );

    if (!results[0]) return [];
    return results[0].values.map(rowToChunk);
  }

  async getChunksBySession(projectRoot: string, sessionId: string): Promise<Chunk[]> {
    const d = await getDb(projectRoot);
    const results = d.exec(
      'SELECT * FROM chunks WHERE session_id = ? ORDER BY created_at ASC',
      [sessionId],
    );
    if (!results[0]) return [];
    return results[0].values.map(rowToChunk);
  }

  async getRecentChunksBySource(
    projectRoot: string,
    source: ChunkSource,
    limit: number = 10,
  ): Promise<Chunk[]> {
    const d = await getDb(projectRoot);
    const results = d.exec(
      'SELECT * FROM chunks WHERE source = ? ORDER BY created_at DESC LIMIT ?',
      [source, limit],
    );
    if (!results[0]) return [];
    return results[0].values.map(rowToChunk);
  }

  async searchChunksByKeywords(
    projectRoot: string,
    tokens: string[],
    topK: number = 20,
    contextTypeFilter?: string[],
    sessionFilter?: string,
  ): Promise<Array<{ chunk: Chunk; matchCount: number }>> {
    if (tokens.length === 0) return [];

    const d = await getDb(projectRoot);

    const escapedTokens = tokens.map((t) =>
      t.replace(/%/g, '\\%').replace(/_/g, '\\_'),
    );
    const caseExprs = escapedTokens
      .map(() => `CASE WHEN lower(content) LIKE ? THEN 1 ELSE 0 END`)
      .join(' + ');
    const whereOr = escapedTokens.map(() => `lower(content) LIKE ?`).join(' OR ');

    let sql = `SELECT *, (${caseExprs}) as match_count FROM chunks WHERE (${whereOr})`;
    const params: (string | number)[] = [];

    for (const token of escapedTokens) {
      params.push(`%${token}%`);
    }
    for (const token of escapedTokens) {
      params.push(`%${token}%`);
    }

    if (contextTypeFilter && contextTypeFilter.length > 0) {
      const placeholders = contextTypeFilter.map(() => '?').join(',');
      sql += ` AND context_type IN (${placeholders})`;
      params.push(...contextTypeFilter);
    }

    if (sessionFilter) {
      sql += ` AND session_id = ?`;
      params.push(sessionFilter);
    }

    sql += ` ORDER BY match_count DESC LIMIT ?`;
    params.push(topK);

    const results = d.exec(sql, params);
    if (!results[0]) return [];

    return results[0].values.map((row) => {
      const matchCount = row[row.length - 1] as number;
      return { chunk: rowToChunk(row), matchCount };
    });
  }

  async clearChunksBySource(projectRoot: string, source: ChunkSource): Promise<void> {
    const d = await getDb(projectRoot);
    d.run('DELETE FROM chunks WHERE source = ?', [source]);
    saveDb();
  }

  async deleteChunksBySourceRef(projectRoot: string, source: ChunkSource, sourceRef: string): Promise<void> {
    const d = await getDb(projectRoot);
    d.run('DELETE FROM chunks WHERE source = ? AND source_ref = ?', [source, sourceRef]);
    saveDb();
  }

  async getStats(projectRoot: string): Promise<Record<string, number>> {
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

  async getTotalChunks(projectRoot: string): Promise<number> {
    const d = await getDb(projectRoot);
    const results = d.exec('SELECT COUNT(*) as count FROM chunks');
    return (results[0]?.values[0]?.[0] as number) || 0;
  }

  async setConfig(projectRoot: string, key: string, value: string): Promise<void> {
    const d = await getDb(projectRoot);
    d.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [key, value]);
    saveDb();
  }

  async getConfig(projectRoot: string, key: string): Promise<string | null> {
    const d = await getDb(projectRoot);
    const results = d.exec('SELECT value FROM config WHERE key = ?', [key]);
    return (results[0]?.values[0]?.[0] as string) || null;
  }

  async upsertSummary(
    projectRoot: string,
    level: SummaryLevel,
    scope: string,
    content: string,
    embedding: Float32Array | null,
    parentId: number | null = null,
    user: string | null = null,
  ): Promise<number> {
    const d = await getDb(projectRoot);
    const embeddingBlob = embedding ? embeddingToBlob(embedding) : null;
    const now = new Date().toISOString();

    d.run(
      `INSERT INTO summaries (level, scope, user, content, embedding, parent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(level, scope) DO UPDATE SET
         content = excluded.content,
         embedding = excluded.embedding,
         parent_id = excluded.parent_id,
         user = excluded.user,
         updated_at = excluded.updated_at`,
      [level, scope, user, content, embeddingBlob, parentId, now, now],
    );

    const result = d.exec(
      'SELECT id FROM summaries WHERE level = ? AND scope = ?',
      [level, scope],
    );
    const id = result[0]?.values[0]?.[0] as number;
    saveDb();
    return id;
  }

  async getSummary(projectRoot: string, level: SummaryLevel, scope: string): Promise<Summary | null> {
    const d = await getDb(projectRoot);
    const results = d.exec(
      'SELECT * FROM summaries WHERE level = ? AND scope = ?',
      [level, scope],
    );
    if (!results[0]?.values[0]) return null;
    return rowToSummary(results[0].values[0]);
  }

  async getSummariesByLevel(projectRoot: string, level: SummaryLevel): Promise<Summary[]> {
    const d = await getDb(projectRoot);
    const results = d.exec(
      'SELECT * FROM summaries WHERE level = ? ORDER BY updated_at DESC',
      [level],
    );
    if (!results[0]) return [];
    return results[0].values.map(rowToSummary);
  }

  async getChildSummaries(projectRoot: string, parentId: number): Promise<Summary[]> {
    const d = await getDb(projectRoot);
    const results = d.exec(
      'SELECT * FROM summaries WHERE parent_id = ? ORDER BY updated_at DESC',
      [parentId],
    );
    if (!results[0]) return [];
    return results[0].values.map(rowToSummary);
  }

  async getSummaryEmbeddings(
    projectRoot: string,
    level?: SummaryLevel,
  ): Promise<Array<{ id: number; embedding: Float32Array; scope: string; level: string }>> {
    const d = await getDb(projectRoot);
    let sql = 'SELECT id, embedding, scope, level FROM summaries WHERE embedding IS NOT NULL';
    const params: string[] = [];
    if (level) {
      sql += ' AND level = ?';
      params.push(level);
    }
    const results = d.exec(sql, params);
    if (!results[0]) return [];

    return results[0].values.map(([id, blob, scope, lvl]) => ({
      id: id as number,
      embedding: blobToEmbedding(blob as Uint8Array),
      scope: scope as string,
      level: lvl as string,
    }));
  }

  async getDistinctSessions(projectRoot: string): Promise<string[]> {
    const d = await getDb(projectRoot);
    const results = d.exec(
      "SELECT DISTINCT session_id FROM chunks WHERE session_id IS NOT NULL AND source = 'user_context' ORDER BY created_at DESC",
    );
    if (!results[0]) return [];
    return results[0].values.map((row) => row[0] as string);
  }
}
