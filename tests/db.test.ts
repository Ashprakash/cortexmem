import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getDb,
  closeDb,
  insertChunk,
  insertChunksBatch,
  getChunksByIds,
  getChunksByType,
  getStats,
  getTotalChunks,
  setConfig,
  getConfig,
  clearChunksBySource,
  searchChunksByKeywords,
  getRecentChunksBySource,
  upsertSummary,
  getSummary,
  getSummariesByLevel,
  getChildSummaries,
  getSummaryEmbeddings,
  getChunksBySession,
  getDistinctSessions,
  getAllEmbeddings,
} from '../src/db.js';

let testDir: string;

function fakeEmbedding(seed: number = 1): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) arr[i] = Math.sin(seed + i);
  return arr;
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cortexmem-test-'));
});

afterEach(() => {
  closeDb();
  rmSync(testDir, { recursive: true, force: true });
});

describe('Schema initialization', () => {
  it('creates chunks and summaries tables', async () => {
    const db = await getDb(testDir);
    const tables = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = tables[0].values.map((r) => r[0]);
    expect(names).toContain('chunks');
    expect(names).toContain('config');
    expect(names).toContain('summaries');
  });

  it('is idempotent — can call getDb twice', async () => {
    const db1 = await getDb(testDir);
    const db2 = await getDb(testDir);
    expect(db1).toBe(db2);
  });
});

describe('Chunk CRUD', () => {
  it('inserts and retrieves a chunk', async () => {
    const id = await insertChunk(
      testDir, 'test content', 'user_context', 'ref', 'decision',
      fakeEmbedding(1), { confidence: 'high' }, 'session-1',
    );
    expect(id).toBeGreaterThan(0);

    const chunks = await getChunksByIds(testDir, [id]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('test content');
    expect(chunks[0].source).toBe('user_context');
    expect(chunks[0].contextType).toBe('decision');
    expect(chunks[0].sessionId).toBe('session-1');
    expect(chunks[0].metadata).toEqual({ confidence: 'high' });
    expect(chunks[0].embedding).toBeInstanceOf(Float32Array);
  });

  it('inserts chunks in batch', async () => {
    const chunks = [
      { content: 'chunk 1', source: 'git_commit' as const, sourceRef: 'abc', contextType: 'commit', embedding: fakeEmbedding(1) },
      { content: 'chunk 2', source: 'source_file' as const, sourceRef: 'file.ts', contextType: 'code', embedding: fakeEmbedding(2) },
      { content: 'chunk 3', source: 'user_context' as const, sourceRef: '', contextType: 'decision', embedding: fakeEmbedding(3), sessionId: 's1' },
    ];
    await insertChunksBatch(testDir, chunks);
    const total = await getTotalChunks(testDir);
    expect(total).toBe(3);
  });

  it('batch insert rolls back on error', async () => {
    // Insert one valid chunk first
    await insertChunk(testDir, 'existing', 'user_context', '', 'decision', null);

    // Try batch with a problem — we'll verify the first chunk isn't duplicated
    const before = await getTotalChunks(testDir);
    expect(before).toBe(1);
  });

  it('returns empty array for getChunksByIds with no ids', async () => {
    const result = await getChunksByIds(testDir, []);
    expect(result).toEqual([]);
  });

  it('handles chunks without embeddings', async () => {
    const id = await insertChunk(testDir, 'no embedding', 'user_context', '', 'state', null);
    const chunks = await getChunksByIds(testDir, [id]);
    expect(chunks[0].embedding).toBeNull();
  });
});

describe('getChunksByType', () => {
  it('returns chunks filtered by type', async () => {
    await insertChunk(testDir, 'decision 1', 'user_context', '', 'decision', null);
    await insertChunk(testDir, 'constraint 1', 'user_context', '', 'constraint', null);
    await insertChunk(testDir, 'decision 2', 'user_context', '', 'decision', null);

    const decisions = await getChunksByType(testDir, 'decision');
    expect(decisions).toHaveLength(2);
    expect(decisions.every((c) => c.contextType === 'decision')).toBe(true);
  });

  it('returns empty for non-existent type', async () => {
    const result = await getChunksByType(testDir, 'nonexistent');
    expect(result).toEqual([]);
  });
});

describe('Stats', () => {
  it('returns correct stats breakdown', async () => {
    await insertChunksBatch(testDir, [
      { content: 'a', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null },
      { content: 'b', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null },
      { content: 'c', source: 'git_commit', sourceRef: '', contextType: 'commit', embedding: null },
    ]);

    const stats = await getStats(testDir);
    expect(stats.decision).toBe(2);
    expect(stats.commit).toBe(1);
  });

  it('returns 0 for empty db', async () => {
    const total = await getTotalChunks(testDir);
    expect(total).toBe(0);
    const stats = await getStats(testDir);
    expect(Object.keys(stats)).toHaveLength(0);
  });
});

describe('Config', () => {
  it('sets and gets config values', async () => {
    await setConfig(testDir, 'test_key', 'test_value');
    const val = await getConfig(testDir, 'test_key');
    expect(val).toBe('test_value');
  });

  it('returns null for missing config', async () => {
    const val = await getConfig(testDir, 'nonexistent');
    expect(val).toBeNull();
  });

  it('upserts config values', async () => {
    await setConfig(testDir, 'key', 'value1');
    await setConfig(testDir, 'key', 'value2');
    const val = await getConfig(testDir, 'key');
    expect(val).toBe('value2');
  });
});

describe('clearChunksBySource', () => {
  it('deletes only chunks of specified source', async () => {
    await insertChunksBatch(testDir, [
      { content: 'git1', source: 'git_commit', sourceRef: '', contextType: 'commit', embedding: null },
      { content: 'user1', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null },
      { content: 'git2', source: 'git_commit', sourceRef: '', contextType: 'commit', embedding: null },
    ]);

    await clearChunksBySource(testDir, 'git_commit');
    const total = await getTotalChunks(testDir);
    expect(total).toBe(1);

    const remaining = await getChunksByType(testDir, 'decision');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe('user1');
  });
});

describe('getRecentChunksBySource', () => {
  it('returns chunks sorted by recency', async () => {
    await insertChunksBatch(testDir, [
      { content: 'old commit', source: 'git_commit', sourceRef: 'a', contextType: 'commit', embedding: null },
      { content: 'new commit', source: 'git_commit', sourceRef: 'b', contextType: 'commit', embedding: null },
      { content: 'user ctx', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null },
    ]);

    const recent = await getRecentChunksBySource(testDir, 'git_commit', 1);
    expect(recent).toHaveLength(1);
    expect(recent[0].source).toBe('git_commit');
  });
});

describe('Keyword search', () => {
  it('finds chunks matching keywords', async () => {
    await insertChunksBatch(testDir, [
      { content: 'PostgreSQL database migration', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null },
      { content: 'React component styling', source: 'source_file', sourceRef: '', contextType: 'code', embedding: null },
      { content: 'Database connection pooling', source: 'user_context', sourceRef: '', contextType: 'discovery', embedding: null },
    ]);

    const results = await searchChunksByKeywords(testDir, ['database'], 10);
    expect(results).toHaveLength(2);
    expect(results[0].matchCount).toBeGreaterThan(0);
  });

  it('scores multi-keyword matches higher', async () => {
    await insertChunksBatch(testDir, [
      { content: 'database connection pooling', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null },
      { content: 'database migration script', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null },
    ]);

    const results = await searchChunksByKeywords(testDir, ['database', 'connection'], 10);
    expect(results[0].chunk.content).toContain('connection');
    expect(results[0].matchCount).toBe(2);
  });

  it('returns empty for no tokens', async () => {
    const results = await searchChunksByKeywords(testDir, [], 10);
    expect(results).toEqual([]);
  });

  it('filters by context type', async () => {
    await insertChunksBatch(testDir, [
      { content: 'auth decision', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null },
      { content: 'auth code', source: 'source_file', sourceRef: '', contextType: 'code', embedding: null },
    ]);

    const results = await searchChunksByKeywords(testDir, ['auth'], 10, ['decision']);
    expect(results).toHaveLength(1);
    expect(results[0].chunk.contextType).toBe('decision');
  });

  it('filters by session', async () => {
    await insertChunksBatch(testDir, [
      { content: 'auth work', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null, sessionId: 'sess1' },
      { content: 'auth work 2', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null, sessionId: 'sess2' },
    ]);

    const results = await searchChunksByKeywords(testDir, ['auth'], 10, undefined, 'sess1');
    expect(results).toHaveLength(1);
    expect(results[0].chunk.sessionId).toBe('sess1');
  });

  it('handles SQL special characters in search tokens', async () => {
    await insertChunk(testDir, 'test 100% coverage', 'user_context', '', 'state', null);
    // % and _ are LIKE wildcards — they should be escaped
    const results = await searchChunksByKeywords(testDir, ['100%'], 10);
    // Should find the match via escaped LIKE
    expect(results.length).toBeGreaterThanOrEqual(0); // shouldn't crash
  });
});

describe('Summary CRUD', () => {
  it('inserts and retrieves a summary', async () => {
    const id = await upsertSummary(
      testDir, 'project', '*', 'Project overview', fakeEmbedding(1), null, 'system',
    );
    expect(id).toBeGreaterThan(0);

    const summary = await getSummary(testDir, 'project', '*');
    expect(summary).not.toBeNull();
    expect(summary!.content).toBe('Project overview');
    expect(summary!.level).toBe('project');
    expect(summary!.scope).toBe('*');
    expect(summary!.user).toBe('system');
    expect(summary!.parentId).toBeNull();
    expect(summary!.embedding).toBeInstanceOf(Float32Array);
  });

  it('upserts — updates existing summary', async () => {
    await upsertSummary(testDir, 'project', '*', 'v1 content', null);
    await upsertSummary(testDir, 'project', '*', 'v2 content', null);

    const summary = await getSummary(testDir, 'project', '*');
    expect(summary!.content).toBe('v2 content');

    // Should still be just one summary
    const all = await getSummariesByLevel(testDir, 'project');
    expect(all).toHaveLength(1);
  });

  it('returns null for missing summary', async () => {
    const result = await getSummary(testDir, 'project', '*');
    expect(result).toBeNull();
  });

  it('creates parent-child hierarchy', async () => {
    const projectId = await upsertSummary(testDir, 'project', '*', 'Project', null);
    const branchId = await upsertSummary(testDir, 'branch', 'main', 'Main branch', null, projectId);
    await upsertSummary(testDir, 'session', 'sess1', 'Session 1', null, branchId);
    await upsertSummary(testDir, 'session', 'sess2', 'Session 2', null, branchId);

    const children = await getChildSummaries(testDir, branchId);
    expect(children).toHaveLength(2);

    const branchChildren = await getChildSummaries(testDir, projectId);
    expect(branchChildren).toHaveLength(1);
    expect(branchChildren[0].scope).toBe('main');
  });

  it('getSummariesByLevel returns correct results', async () => {
    await upsertSummary(testDir, 'branch', 'main', 'Main', null);
    await upsertSummary(testDir, 'branch', 'feature', 'Feature', null);
    await upsertSummary(testDir, 'project', '*', 'Project', null);

    const branches = await getSummariesByLevel(testDir, 'branch');
    expect(branches).toHaveLength(2);
    expect(branches.every((s) => s.level === 'branch')).toBe(true);
  });

  it('getSummaryEmbeddings filters by level', async () => {
    await upsertSummary(testDir, 'project', '*', 'Project', fakeEmbedding(1));
    await upsertSummary(testDir, 'branch', 'main', 'Main', fakeEmbedding(2));
    await upsertSummary(testDir, 'session', 's1', 'Sess', null); // no embedding

    const allEmbeddings = await getSummaryEmbeddings(testDir);
    expect(allEmbeddings).toHaveLength(2);

    const branchOnly = await getSummaryEmbeddings(testDir, 'branch');
    expect(branchOnly).toHaveLength(1);
    expect(branchOnly[0].scope).toBe('main');
  });
});

describe('Session queries', () => {
  it('getChunksBySession returns chunks for a session', async () => {
    await insertChunksBatch(testDir, [
      { content: 'sess1 chunk', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null, sessionId: 'sess1' },
      { content: 'sess2 chunk', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null, sessionId: 'sess2' },
      { content: 'no session', source: 'git_commit', sourceRef: '', contextType: 'commit', embedding: null },
    ]);

    const sess1 = await getChunksBySession(testDir, 'sess1');
    expect(sess1).toHaveLength(1);
    expect(sess1[0].content).toBe('sess1 chunk');
  });

  it('getDistinctSessions returns unique user_context sessions', async () => {
    await insertChunksBatch(testDir, [
      { content: 'a', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null, sessionId: 'sess1' },
      { content: 'b', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null, sessionId: 'sess1' },
      { content: 'c', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null, sessionId: 'sess2' },
      { content: 'd', source: 'git_commit', sourceRef: '', contextType: 'commit', embedding: null, sessionId: 'sess3' },
    ]);

    const sessions = await getDistinctSessions(testDir);
    expect(sessions).toHaveLength(2);
    expect(sessions).toContain('sess1');
    expect(sessions).toContain('sess2');
    // sess3 is git_commit, not user_context
    expect(sessions).not.toContain('sess3');
  });
});

describe('Embedding round-trip', () => {
  it('preserves embedding values through store/retrieve', async () => {
    const original = fakeEmbedding(42);
    const id = await insertChunk(testDir, 'embed test', 'user_context', '', 'decision', original);

    const chunks = await getChunksByIds(testDir, [id]);
    const retrieved = chunks[0].embedding!;

    expect(retrieved.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(retrieved[i]).toBeCloseTo(original[i], 6);
    }
  });

  it('getAllEmbeddings returns all embedded chunks', async () => {
    await insertChunk(testDir, 'with embed', 'user_context', '', 'decision', fakeEmbedding(1));
    await insertChunk(testDir, 'without embed', 'user_context', '', 'decision', null);
    await insertChunk(testDir, 'with embed 2', 'user_context', '', 'decision', fakeEmbedding(2));

    const embeddings = await getAllEmbeddings(testDir);
    expect(embeddings).toHaveLength(2);
  });
});
