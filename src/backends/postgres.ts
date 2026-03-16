import pg from 'pg';
import { toSql as pgvectorToSql, fromSql as pgvectorFromSql } from 'pgvector';
import type { Chunk, ChunkSource, Summary, SummaryLevel } from '../types.js';
import type { StorageBackend, ChunkInsertParams } from '../storage.js';

const { Pool } = pg;

export class PostgresBackend implements StorageBackend {
  private pool: pg.Pool;
  private initialized = false;

  constructor(connectionUrl: string) {
    this.pool = new Pool({ connectionString: connectionUrl });
  }

  private async init(): Promise<void> {
    if (this.initialized) return;

    const client = await this.pool.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query(`
        CREATE TABLE IF NOT EXISTS chunks (
          id SERIAL PRIMARY KEY,
          project_root TEXT NOT NULL,
          content TEXT NOT NULL,
          source TEXT NOT NULL,
          source_ref TEXT,
          context_type TEXT NOT NULL,
          embedding vector(384),
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          session_id TEXT,
          author TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project_root);
        CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(project_root, source);
        CREATE INDEX IF NOT EXISTS idx_chunks_context_type ON chunks(project_root, context_type);
        CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(project_root, session_id);

        CREATE TABLE IF NOT EXISTS config (
          project_root TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (project_root, key)
        );

        CREATE TABLE IF NOT EXISTS summaries (
          id SERIAL PRIMARY KEY,
          project_root TEXT NOT NULL,
          level TEXT NOT NULL,
          scope TEXT NOT NULL,
          "user" TEXT,
          content TEXT NOT NULL,
          embedding vector(384),
          parent_id INTEGER REFERENCES summaries(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_summaries_project ON summaries(project_root);
        CREATE INDEX IF NOT EXISTS idx_summaries_level ON summaries(project_root, level);
        CREATE INDEX IF NOT EXISTS idx_summaries_scope ON summaries(project_root, scope);
        CREATE INDEX IF NOT EXISTS idx_summaries_parent ON summaries(parent_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_level_scope ON summaries(project_root, level, scope);
      `);
    } finally {
      client.release();
    }
    this.initialized = true;
  }

  close(): void {
    this.pool.end();
  }

  private embeddingToSql(embedding: Float32Array): string {
    return pgvectorToSql(Array.from(embedding));
  }

  private embeddingFromSql(value: string): Float32Array {
    return new Float32Array(pgvectorFromSql(value));
  }

  private rowToChunk(row: any): Chunk {
    return {
      id: row.id,
      content: row.content,
      source: row.source as ChunkSource,
      sourceRef: row.source_ref || '',
      contextType: row.context_type,
      embedding: row.embedding ? this.embeddingFromSql(row.embedding) : null,
      metadata: row.metadata || {},
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      sessionId: row.session_id || null,
    };
  }

  private rowToSummary(row: any): Summary {
    return {
      id: row.id,
      level: row.level as SummaryLevel,
      scope: row.scope,
      user: row.user || null,
      content: row.content,
      embedding: row.embedding ? this.embeddingFromSql(row.embedding) : null,
      parentId: row.parent_id || null,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
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
    await this.init();
    const embeddingVal = embedding ? this.embeddingToSql(embedding) : null;
    const result = await this.pool.query(
      `INSERT INTO chunks (project_root, content, source, source_ref, context_type, embedding, metadata, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [projectRoot, content, source, sourceRef, contextType, embeddingVal, JSON.stringify(metadata), sessionId],
    );
    return result.rows[0].id;
  }

  async insertChunksBatch(
    projectRoot: string,
    chunks: ChunkInsertParams[],
  ): Promise<void> {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const chunk of chunks) {
        const embeddingVal = chunk.embedding ? this.embeddingToSql(chunk.embedding) : null;
        await client.query(
          `INSERT INTO chunks (project_root, content, source, source_ref, context_type, embedding, metadata, session_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [projectRoot, chunk.content, chunk.source, chunk.sourceRef, chunk.contextType, embeddingVal, JSON.stringify(chunk.metadata || {}), chunk.sessionId || null],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getAllEmbeddings(
    projectRoot: string,
  ): Promise<Array<{ id: number; embedding: Float32Array }>> {
    await this.init();
    const result = await this.pool.query(
      'SELECT id, embedding FROM chunks WHERE project_root = $1 AND embedding IS NOT NULL',
      [projectRoot],
    );
    return result.rows.map((row: any) => ({
      id: row.id,
      embedding: this.embeddingFromSql(row.embedding),
    }));
  }

  async getChunksByIds(projectRoot: string, ids: number[]): Promise<Chunk[]> {
    if (ids.length === 0) return [];
    await this.init();
    const placeholders = ids.map((_, i) => `$${i + 2}`).join(',');
    const result = await this.pool.query(
      `SELECT * FROM chunks WHERE project_root = $1 AND id IN (${placeholders})`,
      [projectRoot, ...ids],
    );
    return result.rows.map((row: any) => this.rowToChunk(row));
  }

  async getChunksByType(projectRoot: string, contextType: string): Promise<Chunk[]> {
    await this.init();
    const result = await this.pool.query(
      'SELECT * FROM chunks WHERE project_root = $1 AND context_type = $2 ORDER BY created_at DESC',
      [projectRoot, contextType],
    );
    return result.rows.map((row: any) => this.rowToChunk(row));
  }

  async getChunksBySession(projectRoot: string, sessionId: string): Promise<Chunk[]> {
    await this.init();
    const result = await this.pool.query(
      'SELECT * FROM chunks WHERE project_root = $1 AND session_id = $2 ORDER BY created_at ASC',
      [projectRoot, sessionId],
    );
    return result.rows.map((row: any) => this.rowToChunk(row));
  }

  async getRecentChunksBySource(projectRoot: string, source: ChunkSource, limit: number = 10): Promise<Chunk[]> {
    await this.init();
    const result = await this.pool.query(
      'SELECT * FROM chunks WHERE project_root = $1 AND source = $2 ORDER BY created_at DESC LIMIT $3',
      [projectRoot, source, limit],
    );
    return result.rows.map((row: any) => this.rowToChunk(row));
  }

  async searchChunksByKeywords(
    projectRoot: string,
    tokens: string[],
    topK: number = 20,
    contextTypeFilter?: string[],
    sessionFilter?: string,
  ): Promise<Array<{ chunk: Chunk; matchCount: number }>> {
    if (tokens.length === 0) return [];
    await this.init();

    const caseExprs = tokens
      .map((_, i) => `CASE WHEN lower(content) LIKE $${i + 2} THEN 1 ELSE 0 END`)
      .join(' + ');
    const whereOr = tokens
      .map((_, i) => `lower(content) LIKE $${i + 2}`)
      .join(' OR ');

    const params: (string | number)[] = [projectRoot];
    for (const token of tokens) {
      const escaped = token.replace(/%/g, '\\%').replace(/_/g, '\\_');
      params.push(`%${escaped}%`);
    }

    let sql = `SELECT *, (${caseExprs}) as match_count FROM chunks WHERE project_root = $1 AND (${whereOr})`;
    let paramIdx = params.length + 1;

    if (contextTypeFilter && contextTypeFilter.length > 0) {
      const placeholders = contextTypeFilter.map((_, i) => `$${paramIdx + i}`).join(',');
      sql += ` AND context_type IN (${placeholders})`;
      params.push(...contextTypeFilter);
      paramIdx += contextTypeFilter.length;
    }

    if (sessionFilter) {
      sql += ` AND session_id = $${paramIdx}`;
      params.push(sessionFilter);
      paramIdx++;
    }

    sql += ` ORDER BY match_count DESC LIMIT $${paramIdx}`;
    params.push(topK);

    const result = await this.pool.query(sql, params);
    return result.rows.map((row: any) => ({
      chunk: this.rowToChunk(row),
      matchCount: parseInt(row.match_count, 10),
    }));
  }

  async clearChunksBySource(projectRoot: string, source: ChunkSource): Promise<void> {
    await this.init();
    await this.pool.query(
      'DELETE FROM chunks WHERE project_root = $1 AND source = $2',
      [projectRoot, source],
    );
  }

  async deleteChunksBySourceRef(projectRoot: string, source: ChunkSource, sourceRef: string): Promise<void> {
    await this.init();
    await this.pool.query(
      'DELETE FROM chunks WHERE project_root = $1 AND source = $2 AND source_ref = $3',
      [projectRoot, source, sourceRef],
    );
  }

  async getStats(projectRoot: string): Promise<Record<string, number>> {
    await this.init();
    const result = await this.pool.query(
      'SELECT context_type, COUNT(*) as count FROM chunks WHERE project_root = $1 GROUP BY context_type',
      [projectRoot],
    );
    const stats: Record<string, number> = {};
    for (const row of result.rows) {
      stats[row.context_type] = parseInt(row.count, 10);
    }
    return stats;
  }

  async getTotalChunks(projectRoot: string): Promise<number> {
    await this.init();
    const result = await this.pool.query(
      'SELECT COUNT(*) as count FROM chunks WHERE project_root = $1',
      [projectRoot],
    );
    return parseInt(result.rows[0].count, 10);
  }

  async setConfig(projectRoot: string, key: string, value: string): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO config (project_root, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (project_root, key) DO UPDATE SET value = $3`,
      [projectRoot, key, value],
    );
  }

  async getConfig(projectRoot: string, key: string): Promise<string | null> {
    await this.init();
    const result = await this.pool.query(
      'SELECT value FROM config WHERE project_root = $1 AND key = $2',
      [projectRoot, key],
    );
    return result.rows[0]?.value || null;
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
    await this.init();
    const embeddingVal = embedding ? this.embeddingToSql(embedding) : null;
    const result = await this.pool.query(
      `INSERT INTO summaries (project_root, level, scope, "user", content, embedding, parent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (project_root, level, scope) DO UPDATE SET
         content = EXCLUDED.content,
         embedding = EXCLUDED.embedding,
         parent_id = EXCLUDED.parent_id,
         "user" = EXCLUDED."user",
         updated_at = NOW()
       RETURNING id`,
      [projectRoot, level, scope, user, content, embeddingVal, parentId],
    );
    return result.rows[0].id;
  }

  async getSummary(projectRoot: string, level: SummaryLevel, scope: string): Promise<Summary | null> {
    await this.init();
    const result = await this.pool.query(
      'SELECT * FROM summaries WHERE project_root = $1 AND level = $2 AND scope = $3',
      [projectRoot, level, scope],
    );
    if (result.rows.length === 0) return null;
    return this.rowToSummary(result.rows[0]);
  }

  async getSummariesByLevel(projectRoot: string, level: SummaryLevel): Promise<Summary[]> {
    await this.init();
    const result = await this.pool.query(
      'SELECT * FROM summaries WHERE project_root = $1 AND level = $2 ORDER BY updated_at DESC',
      [projectRoot, level],
    );
    return result.rows.map((row: any) => this.rowToSummary(row));
  }

  async getChildSummaries(projectRoot: string, parentId: number): Promise<Summary[]> {
    await this.init();
    const result = await this.pool.query(
      'SELECT * FROM summaries WHERE project_root = $1 AND parent_id = $2 ORDER BY updated_at DESC',
      [projectRoot, parentId],
    );
    return result.rows.map((row: any) => this.rowToSummary(row));
  }

  async getSummaryEmbeddings(
    projectRoot: string,
    level?: SummaryLevel,
  ): Promise<Array<{ id: number; embedding: Float32Array; scope: string; level: string }>> {
    await this.init();
    let sql = 'SELECT id, embedding, scope, level FROM summaries WHERE project_root = $1 AND embedding IS NOT NULL';
    const params: (string)[] = [projectRoot];
    if (level) {
      sql += ' AND level = $2';
      params.push(level);
    }
    const result = await this.pool.query(sql, params);
    return result.rows.map((row: any) => ({
      id: row.id,
      embedding: this.embeddingFromSql(row.embedding),
      scope: row.scope,
      level: row.level,
    }));
  }

  async getDistinctSessions(projectRoot: string): Promise<string[]> {
    await this.init();
    const result = await this.pool.query(
      "SELECT DISTINCT session_id FROM chunks WHERE project_root = $1 AND session_id IS NOT NULL AND source = 'user_context' ORDER BY session_id DESC",
      [projectRoot],
    );
    return result.rows.map((row: any) => row.session_id);
  }

  // --- Vector search (pgvector native) ---

  async vectorSearch(
    projectRoot: string,
    queryEmbedding: Float32Array,
    topK: number = 20,
    contextTypeFilter?: string[],
    sessionFilter?: string,
  ): Promise<Array<{ chunk: Chunk; score: number }>> {
    await this.init();
    const embeddingVal = this.embeddingToSql(queryEmbedding);

    let sql = `SELECT *, 1 - (embedding <=> $2) as score FROM chunks
               WHERE project_root = $1 AND embedding IS NOT NULL`;
    const params: (string | number)[] = [projectRoot, embeddingVal];
    let paramIdx = 3;

    if (contextTypeFilter && contextTypeFilter.length > 0) {
      const placeholders = contextTypeFilter.map((_, i) => `$${paramIdx + i}`).join(',');
      sql += ` AND context_type IN (${placeholders})`;
      params.push(...contextTypeFilter);
      paramIdx += contextTypeFilter.length;
    }

    if (sessionFilter) {
      sql += ` AND session_id = $${paramIdx}`;
      params.push(sessionFilter);
      paramIdx++;
    }

    sql += ` ORDER BY embedding <=> $2 LIMIT $${paramIdx}`;
    params.push(topK);

    const result = await this.pool.query(sql, params);
    return result.rows.map((row: any) => ({
      chunk: this.rowToChunk(row),
      score: parseFloat(row.score),
    }));
  }
}
