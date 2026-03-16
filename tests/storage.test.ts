import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SqliteBackend } from '../src/backends/sqlite.js';
import { PostgresBackend } from '../src/backends/postgres.js';
import { setBackend, getBackend } from '../src/storage.js';
import type { StorageBackend } from '../src/storage.js';

let testDir: string;
let backend: SqliteBackend;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cortexmem-storage-'));
  backend = new SqliteBackend();
  setBackend(backend);
});

afterEach(() => {
  backend.close();
  setBackend(null);
  rmSync(testDir, { recursive: true, force: true });
});

describe('StorageBackend interface', () => {
  it('SqliteBackend implements all required methods', () => {
    const requiredMethods: (keyof StorageBackend)[] = [
      'close',
      'insertChunk',
      'insertChunksBatch',
      'getAllEmbeddings',
      'getChunksByIds',
      'getChunksByType',
      'getChunksBySession',
      'getRecentChunksBySource',
      'searchChunksByKeywords',
      'clearChunksBySource',
      'deleteChunksBySourceRef',
      'getStats',
      'getTotalChunks',
      'setConfig',
      'getConfig',
      'upsertSummary',
      'getSummary',
      'getSummariesByLevel',
      'getChildSummaries',
      'getSummaryEmbeddings',
      'getDistinctSessions',
    ];

    for (const method of requiredMethods) {
      expect(typeof backend[method]).toBe('function');
    }
  });

  it('PostgresBackend implements all required methods', () => {
    const pgBackend = new PostgresBackend('postgresql://fake:fake@localhost/fake');

    const requiredMethods: (keyof StorageBackend)[] = [
      'close',
      'insertChunk',
      'insertChunksBatch',
      'getAllEmbeddings',
      'getChunksByIds',
      'getChunksByType',
      'getChunksBySession',
      'getRecentChunksBySource',
      'searchChunksByKeywords',
      'clearChunksBySource',
      'deleteChunksBySourceRef',
      'getStats',
      'getTotalChunks',
      'setConfig',
      'getConfig',
      'upsertSummary',
      'getSummary',
      'getSummariesByLevel',
      'getChildSummaries',
      'getSummaryEmbeddings',
      'getDistinctSessions',
    ];

    for (const method of requiredMethods) {
      expect(typeof pgBackend[method]).toBe('function');
    }

    // Also has vectorSearch as a bonus method
    expect(typeof pgBackend.vectorSearch).toBe('function');

    pgBackend.close();
  });
});

describe('Backend switching', () => {
  it('setBackend/getBackend round-trips', () => {
    expect(getBackend()).toBe(backend);

    const newBackend = new SqliteBackend();
    setBackend(newBackend);
    expect(getBackend()).toBe(newBackend);

    newBackend.close();
    setBackend(backend); // restore
  });

  it('setBackend(null) clears the backend', () => {
    setBackend(null);
    expect(getBackend()).toBeNull();
    setBackend(backend); // restore
  });
});

describe('SqliteBackend via interface', () => {
  it('insertChunk and getChunksByType work through backend', async () => {
    const id = await backend.insertChunk(
      testDir, 'test content', 'user_context', '', 'decision', null, {}, 'sess-1',
    );
    expect(id).toBeGreaterThan(0);

    const chunks = await backend.getChunksByType(testDir, 'decision');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('test content');
    expect(chunks[0].sessionId).toBe('sess-1');
  });

  it('config operations work through backend', async () => {
    await backend.setConfig(testDir, 'test_key', 'test_value');
    const value = await backend.getConfig(testDir, 'test_key');
    expect(value).toBe('test_value');
  });

  it('summary operations work through backend', async () => {
    const id = await backend.upsertSummary(
      testDir, 'project', '*', 'Project summary', null, null, null,
    );
    expect(id).toBeGreaterThan(0);

    const summary = await backend.getSummary(testDir, 'project', '*');
    expect(summary).not.toBeNull();
    expect(summary!.content).toBe('Project summary');
  });

  it('stats work through backend', async () => {
    await backend.insertChunk(testDir, 'a', 'user_context', '', 'decision', null);
    await backend.insertChunk(testDir, 'b', 'user_context', '', 'decision', null);
    await backend.insertChunk(testDir, 'c', 'user_context', '', 'constraint', null);

    const stats = await backend.getStats(testDir);
    expect(stats.decision).toBe(2);
    expect(stats.constraint).toBe(1);

    const total = await backend.getTotalChunks(testDir);
    expect(total).toBe(3);
  });

  it('deleteChunksBySourceRef works through backend', async () => {
    await backend.insertChunk(testDir, 'file a', 'source_file', '/a.ts', 'code_summary', null);
    await backend.insertChunk(testDir, 'file b', 'source_file', '/b.ts', 'code_summary', null);

    await backend.deleteChunksBySourceRef(testDir, 'source_file', '/a.ts');

    const total = await backend.getTotalChunks(testDir);
    expect(total).toBe(1);
  });

  it('keyword search works through backend', async () => {
    await backend.insertChunk(testDir, 'authentication with JWT tokens', 'user_context', '', 'decision', null);
    await backend.insertChunk(testDir, 'database migration strategy', 'user_context', '', 'decision', null);

    const results = await backend.searchChunksByKeywords(testDir, ['jwt', 'authentication']);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.content).toContain('JWT');
  });
});
