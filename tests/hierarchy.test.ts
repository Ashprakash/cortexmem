import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  closeDb,
  upsertSummary,
  insertChunksBatch,
} from '../src/db.js';

// Mock git module to avoid needing a real repo
vi.mock('../src/git.js', () => ({
  detectRepoRoot: vi.fn(async () => null),
  detectBranch: vi.fn(async () => 'main'),
  getCommitHistory: vi.fn(async () => []),
  getLatestCommitHash: vi.fn(async () => null),
  getMainBranch: vi.fn(async () => 'main'),
}));

// Mock embeddings to avoid loading the ML model
vi.mock('../src/embeddings.js', () => ({
  embed: vi.fn(async () => new Float32Array(384)),
  embedBatch: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384))),
  cosineSimilarity: vi.fn(() => 0.5),
  isModelLoaded: vi.fn(() => false),
}));

import { buildPyramid, hierarchicalSearch } from '../src/hierarchy.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cortexmem-hier-'));
});

afterEach(() => {
  closeDb();
  rmSync(testDir, { recursive: true, force: true });
});

// Override detectBranch for this module
const { detectBranch } = await import('../src/git.js');

describe('buildPyramid', () => {
  it('returns null when no summaries exist', async () => {
    const result = await buildPyramid(testDir);
    expect(result).toBeNull();
  });

  it('returns project overview when only project summary exists', async () => {
    await upsertSummary(testDir, 'project', '*', 'A TypeScript project for testing', null);
    const result = await buildPyramid(testDir);
    expect(result).toContain('Project Overview');
    expect(result).toContain('TypeScript project');
  });

  it('includes branch summary when available', async () => {
    const pid = await upsertSummary(testDir, 'project', '*', 'Test project', null);
    await upsertSummary(testDir, 'branch', 'main', 'Working on auth module', null, pid);

    const result = await buildPyramid(testDir, 'main');
    expect(result).toContain('Branch: main');
    expect(result).toContain('auth module');
  });

  it('excludes branches awaiting compaction', async () => {
    const pid = await upsertSummary(testDir, 'project', '*', 'Test project', null);
    await upsertSummary(testDir, 'branch', 'main', 'Branch: main — awaiting compaction', null, pid);

    const result = await buildPyramid(testDir, 'main');
    expect(result).not.toContain('Branch: main');
  });

  it('includes session summaries under branch', async () => {
    const pid = await upsertSummary(testDir, 'project', '*', 'Test project', null);
    const bid = await upsertSummary(testDir, 'branch', 'main', 'Main branch work', null, pid);
    await upsertSummary(testDir, 'session', 'sess123abc', 'Fixed auth bugs', null, bid);

    const result = await buildPyramid(testDir, 'main');
    expect(result).toContain('Recent Sessions');
    expect(result).toContain('Fixed auth bugs');
    expect(result).toContain('sess123a'); // truncated to 8 chars
  });

  it('limits sessions to maxSessions', async () => {
    const pid = await upsertSummary(testDir, 'project', '*', 'Project', null);
    const bid = await upsertSummary(testDir, 'branch', 'main', 'Branch', null, pid);
    for (let i = 0; i < 5; i++) {
      await upsertSummary(testDir, 'session', `sess${i}`, `Session ${i}`, null, bid);
    }

    const result = await buildPyramid(testDir, 'main', 2);
    // Should only show 2 sessions
    const sessionHeaders = (result!.match(/#### Session/g) || []).length;
    expect(sessionHeaders).toBeLessThanOrEqual(2);
  });

  it('shows other branches briefly', async () => {
    const pid = await upsertSummary(testDir, 'project', '*', 'Project', null);
    await upsertSummary(testDir, 'branch', 'main', 'Main work', null, pid);
    await upsertSummary(testDir, 'branch', 'feature/payments', 'Stripe integration', null, pid);

    const result = await buildPyramid(testDir, 'main');
    expect(result).toContain('Other Branches');
    expect(result).toContain('feature/payments');
    expect(result).toContain('Stripe');
  });
});

describe('hierarchicalSearch', () => {
  it('returns empty when no project summary', async () => {
    const results = await hierarchicalSearch(testDir, 'anything');
    expect(results).toEqual([]);
  });

  it('returns project summary at depth 0', async () => {
    await upsertSummary(testDir, 'project', '*', 'TypeScript REST API project', null);

    const results = await hierarchicalSearch(testDir, 'typescript', 0);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].breadcrumb).toBe('project');
  });

  it('includes branch summaries at depth 1', async () => {
    const pid = await upsertSummary(testDir, 'project', '*', 'Project overview', null);
    await upsertSummary(testDir, 'branch', 'main', 'Auth module development', null, pid);

    const results = await hierarchicalSearch(testDir, 'auth', 1);
    const breadcrumbs = results.map((r) => r.breadcrumb);
    expect(breadcrumbs).toContain('project');
    expect(breadcrumbs.some((b) => b.includes('branch:main'))).toBe(true);
  });

  it('includes session summaries at depth 2', async () => {
    const pid = await upsertSummary(testDir, 'project', '*', 'Project', null);
    const bid = await upsertSummary(testDir, 'branch', 'main', 'Main', null, pid);
    await upsertSummary(testDir, 'session', 'sess1', 'Session about auth', null, bid);

    const results = await hierarchicalSearch(testDir, 'auth', 2);
    const hasSession = results.some((r) => r.breadcrumb.includes('session:'));
    expect(hasSession).toBe(true);
  });

  it('drills into chunks at depth 3', async () => {
    const pid = await upsertSummary(testDir, 'project', '*', 'Project', null);
    const bid = await upsertSummary(testDir, 'branch', 'main', 'Auth work', null, pid);
    await upsertSummary(testDir, 'session', 'sess1', 'Auth session', null, bid);

    // Add some searchable chunks
    await insertChunksBatch(testDir, [
      { content: 'auth middleware implementation', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null, sessionId: 'sess1' },
    ]);

    const results = await hierarchicalSearch(testDir, 'auth middleware', 3);
    expect(results.length).toBeGreaterThan(0);
  });

  it('results include breadcrumb paths', async () => {
    const pid = await upsertSummary(testDir, 'project', '*', 'Test project', null);
    const bid = await upsertSummary(testDir, 'branch', 'main', 'Main branch', null, pid);
    await upsertSummary(testDir, 'session', 's1', 'Session', null, bid);

    const results = await hierarchicalSearch(testDir, 'test', 2);
    for (const r of results) {
      expect(r.breadcrumb).toBeTruthy();
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });

  it('results are sorted by score descending', async () => {
    const pid = await upsertSummary(testDir, 'project', '*', 'Project about auth and payments', null);
    await upsertSummary(testDir, 'branch', 'main', 'Auth work', null, pid);
    await upsertSummary(testDir, 'branch', 'feature', 'Payments work', null, pid);

    const results = await hierarchicalSearch(testDir, 'auth payments', 1);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });
});
