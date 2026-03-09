import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { insertChunksBatch, closeDb } from '../src/db.js';
import { keywordSearch, tokenize } from '../src/search.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cortexmem-search-'));
});

afterEach(() => {
  closeDb();
  rmSync(testDir, { recursive: true, force: true });
});

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumeric', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world']);
  });

  it('removes stop words', () => {
    const tokens = tokenize('the quick brown fox is not lazy');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('is');
    expect(tokens).not.toContain('not');
    expect(tokens).toContain('quick');
    expect(tokens).toContain('brown');
    expect(tokens).toContain('fox');
    expect(tokens).toContain('lazy');
  });

  it('removes short tokens (< 2 chars)', () => {
    const tokens = tokenize('I am a big cat');
    expect(tokens).not.toContain('i');
    expect(tokens).not.toContain('a');
    expect(tokens).toContain('big');
    expect(tokens).toContain('cat');
  });

  it('deduplicates tokens', () => {
    const tokens = tokenize('cat cat cat dog dog');
    expect(tokens).toEqual(['cat', 'dog']);
  });

  it('handles underscore-connected identifiers', () => {
    const tokens = tokenize('user_service database_connection');
    expect(tokens).toContain('user_service');
    expect(tokens).toContain('database_connection');
  });

  it('returns empty for all stop words', () => {
    expect(tokenize('the is a an')).toEqual([]);
  });

  it('returns empty for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('keywordSearch', () => {
  it('finds matching chunks', async () => {
    await insertChunksBatch(testDir, [
      { content: 'PostgreSQL database setup', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null },
      { content: 'React component rendering', source: 'source_file', sourceRef: '', contextType: 'code', embedding: null },
      { content: 'MongoDB alternative considered', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null },
    ]);

    const results = await keywordSearch(testDir, 'database setup');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.content).toContain('database');
  });

  it('returns empty for no matches', async () => {
    await insertChunksBatch(testDir, [
      { content: 'something unrelated', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null },
    ]);

    const results = await keywordSearch(testDir, 'zebra elephant');
    expect(results).toEqual([]);
  });

  it('scores are between 0 and 1', async () => {
    await insertChunksBatch(testDir, [
      { content: 'auth middleware security check', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null },
    ]);

    const results = await keywordSearch(testDir, 'auth security');
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('respects topK limit', async () => {
    for (let i = 0; i < 10; i++) {
      await insertChunksBatch(testDir, [
        { content: `test entry ${i}`, source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null },
      ]);
    }

    const results = await keywordSearch(testDir, 'test entry', 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('filters by context type', async () => {
    await insertChunksBatch(testDir, [
      { content: 'auth in code', source: 'source_file', sourceRef: '', contextType: 'code', embedding: null },
      { content: 'auth decision made', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null },
    ]);

    const results = await keywordSearch(testDir, 'auth', 10, ['code']);
    expect(results).toHaveLength(1);
    expect(results[0].chunk.contextType).toBe('code');
  });

  it('filters by session', async () => {
    await insertChunksBatch(testDir, [
      { content: 'auth work', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null, sessionId: 'a' },
      { content: 'auth work', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null, sessionId: 'b' },
    ]);

    const results = await keywordSearch(testDir, 'auth', 10, undefined, 'a');
    expect(results).toHaveLength(1);
    expect(results[0].chunk.sessionId).toBe('a');
  });

  it('handles query with only stop words', async () => {
    await insertChunksBatch(testDir, [
      { content: 'some content', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null },
    ]);

    const results = await keywordSearch(testDir, 'the is a');
    expect(results).toEqual([]);
  });
});
