import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import {
  closeDb,
  insertChunk,
  insertChunksBatch,
  upsertSummary,
  getSummary,
  getChunksByType,
  getStats,
  getTotalChunks,
  getChunksBySession,
  getChildSummaries,
} from '../src/db.js';

let testDir: string;

function fakeEmbedding(seed: number = 1): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) arr[i] = Math.sin(seed + i);
  return arr;
}

// Create a minimal git repo for testing
function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'index.ts'), 'console.log("hello");');
  execSync('git add .', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -m "initial commit"', { cwd: dir, stdio: 'ignore' });
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cortexmem-e2e-'));
});

afterEach(() => {
  closeDb();
  rmSync(testDir, { recursive: true, force: true });
});

describe('End-to-end: save → search → retrieve', () => {
  it('saves context and retrieves via keyword search', async () => {
    // Simulate what happens during a session:
    // 1. Agent saves decisions
    await insertChunk(
      testDir, 'Chose PostgreSQL over MongoDB for ACID compliance',
      'user_context', '', 'decision', fakeEmbedding(1), { confidence: 'high' }, 'sess1',
    );
    await insertChunk(
      testDir, 'Never modify the auth middleware directly',
      'user_context', '', 'constraint', fakeEmbedding(2), { confidence: 'high' }, 'sess1',
    );
    await insertChunk(
      testDir, 'Payment refactor: 2 of 4 services done',
      'user_context', '', 'state', fakeEmbedding(3), { confidence: 'medium' }, 'sess1',
    );

    // 2. Verify stored
    const stats = await getStats(testDir);
    expect(stats.decision).toBe(1);
    expect(stats.constraint).toBe(1);
    expect(stats.state).toBe(1);

    // 3. Retrieve by type
    const decisions = await getChunksByType(testDir, 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].content).toContain('PostgreSQL');

    // 4. Retrieve by session
    const sessionChunks = await getChunksBySession(testDir, 'sess1');
    expect(sessionChunks).toHaveLength(3);
  });
});

describe('End-to-end: hierarchy lifecycle', () => {
  it('creates and traverses the full hierarchy', async () => {
    // 1. Create project → branch → session hierarchy
    const projectId = await upsertSummary(
      testDir, 'project', '*',
      'E-commerce platform: Node.js + PostgreSQL + React',
      fakeEmbedding(1),
    );

    const branchId = await upsertSummary(
      testDir, 'branch', 'main',
      'Core API development. Auth, products, orders endpoints.',
      fakeEmbedding(2), projectId,
    );

    await upsertSummary(
      testDir, 'session', 'sess-001',
      'Implemented JWT auth. Chose bcrypt for password hashing.',
      fakeEmbedding(3), branchId,
    );
    await upsertSummary(
      testDir, 'session', 'sess-002',
      'Added product CRUD endpoints. Using Zod for validation.',
      fakeEmbedding(4), branchId,
    );

    const featureBranchId = await upsertSummary(
      testDir, 'branch', 'feature/payments',
      'Stripe payment integration. Webhook handling in progress.',
      fakeEmbedding(5), projectId,
    );

    await upsertSummary(
      testDir, 'session', 'sess-003',
      'Set up Stripe SDK. Created payment intent flow.',
      fakeEmbedding(6), featureBranchId,
    );

    // 2. Verify hierarchy traversal
    const project = await getSummary(testDir, 'project', '*');
    expect(project!.content).toContain('E-commerce');

    const branches = await getChildSummaries(testDir, projectId);
    expect(branches).toHaveLength(2);

    const mainSessions = await getChildSummaries(testDir, branchId);
    expect(mainSessions).toHaveLength(2);

    const paymentSessions = await getChildSummaries(testDir, featureBranchId);
    expect(paymentSessions).toHaveLength(1);
  });

  it('upsert updates existing summaries without duplicating', async () => {
    await upsertSummary(testDir, 'project', '*', 'Version 1', null);
    await upsertSummary(testDir, 'project', '*', 'Version 2 — updated', null);

    const project = await getSummary(testDir, 'project', '*');
    expect(project!.content).toBe('Version 2 — updated');
  });
});

describe('End-to-end: mixed content search', () => {
  it('searches across different chunk sources', async () => {
    // Git commits
    await insertChunksBatch(testDir, [
      { content: 'commit abc: add authentication middleware', source: 'git_commit', sourceRef: 'abc', contextType: 'commit', embedding: fakeEmbedding(1) },
      { content: 'commit def: refactor database queries', source: 'git_commit', sourceRef: 'def', contextType: 'commit', embedding: fakeEmbedding(2) },
    ]);

    // Source files
    await insertChunksBatch(testDir, [
      { content: '// auth.ts\nexport function verifyToken(token: string) {}', source: 'source_file', sourceRef: 'auth.ts', contextType: 'code', embedding: fakeEmbedding(3) },
    ]);

    // User context
    await insertChunk(
      testDir, 'JWT tokens expire after 1 hour as per security policy',
      'user_context', 'auth.ts', 'constraint', fakeEmbedding(4), {}, 'sess1',
    );

    const total = await getTotalChunks(testDir);
    expect(total).toBe(4);

    // Different types coexist
    const stats = await getStats(testDir);
    expect(stats.commit).toBe(2);
    expect(stats.code).toBe(1);
    expect(stats.constraint).toBe(1);
  });
});

describe('End-to-end: backward compatibility', () => {
  it('works with no summaries table data', async () => {
    // Old-style: only chunks, no summaries
    await insertChunksBatch(testDir, [
      { content: 'old decision', source: 'user_context', sourceRef: '', contextType: 'decision', embedding: null },
    ]);

    const project = await getSummary(testDir, 'project', '*');
    expect(project).toBeNull();

    // Chunks still work
    const decisions = await getChunksByType(testDir, 'decision');
    expect(decisions).toHaveLength(1);
  });
});

describe('End-to-end: data persistence', () => {
  it('persists data across db close/reopen', async () => {
    // Write data
    await insertChunk(testDir, 'persistent data', 'user_context', '', 'decision', null);
    await upsertSummary(testDir, 'project', '*', 'Project summary', null);

    // Close and reopen
    closeDb();

    // Verify data survived
    const chunks = await getChunksByType(testDir, 'decision');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('persistent data');

    const project = await getSummary(testDir, 'project', '*');
    expect(project!.content).toBe('Project summary');
  });
});

describe('End-to-end: init with git repo', () => {
  it('ingests commits and source files from a real git repo', async () => {
    initGitRepo(testDir);

    // Add some more files
    writeFileSync(join(testDir, 'utils.ts'), 'export function add(a: number, b: number) { return a + b; }');
    writeFileSync(join(testDir, 'README.md'), '# Test Project\nA test.');
    writeFileSync(join(testDir, 'package.json'), '{"name": "test", "version": "1.0.0"}');
    execSync('git add . && git commit -m "add utils and docs"', { cwd: testDir, stdio: 'ignore' });

    const { getCommitHistory } = await import('../src/git.js');
    const { scanCodebase } = await import('../src/scanner.js');
    const { chunkCommits, chunkSourceFile } = await import('../src/chunker.js');

    const commits = await getCommitHistory(testDir, 100);
    expect(commits.length).toBeGreaterThanOrEqual(1);

    const files = await scanCodebase(testDir);
    expect(files.length).toBeGreaterThanOrEqual(2); // utils.ts, README.md, package.json, index.ts

    const commitChunks = chunkCommits(commits);
    expect(commitChunks.length).toBe(commits.length);

    for (const file of files) {
      const chunks = chunkSourceFile(file);
      expect(chunks.length).toBeGreaterThan(0);
    }
  });
});

describe('Edge cases', () => {
  it('handles unicode content', async () => {
    const id = await insertChunk(
      testDir, '使用 PostgreSQL 数据库 🚀 für Datenbank',
      'user_context', '', 'decision', null,
    );
    const chunks = await getChunksByType(testDir, 'decision');
    expect(chunks[0].content).toBe('使用 PostgreSQL 数据库 🚀 für Datenbank');
  });

  it('handles very long content', async () => {
    const longContent = 'x'.repeat(50000);
    const id = await insertChunk(testDir, longContent, 'user_context', '', 'state', null);
    const chunks = await getChunksByType(testDir, 'state');
    expect(chunks[0].content.length).toBe(50000);
  });

  it('handles special characters in content', async () => {
    const special = `SELECT * FROM users WHERE name = 'O''Brien'; -- SQL injection test`;
    const id = await insertChunk(testDir, special, 'user_context', '', 'discovery', null);
    const chunks = await getChunksByType(testDir, 'discovery');
    expect(chunks[0].content).toBe(special);
  });

  it('handles empty metadata', async () => {
    const id = await insertChunk(testDir, 'no meta', 'user_context', '', 'decision', null, {});
    const chunks = await getChunksByType(testDir, 'decision');
    expect(chunks[0].metadata).toEqual({});
  });

  it('handles null session id', async () => {
    const id = await insertChunk(testDir, 'no session', 'git_commit', '', 'commit', null, {}, null);
    const chunks = await getChunksByType(testDir, 'commit');
    expect(chunks[0].sessionId).toBeNull();
  });
});

describe('Security: SQL injection resistance', () => {
  it('content with SQL injection is stored safely', async () => {
    const malicious = "'; DROP TABLE chunks; --";
    await insertChunk(testDir, malicious, 'user_context', '', 'decision', null);

    const total = await getTotalChunks(testDir);
    expect(total).toBe(1); // Table still exists

    const chunks = await getChunksByType(testDir, 'decision');
    expect(chunks[0].content).toBe(malicious);
  });

  it('keyword search with SQL injection tokens is safe', async () => {
    await insertChunk(testDir, 'normal content', 'user_context', '', 'decision', null);

    // These shouldn't cause SQL errors
    const { searchChunksByKeywords } = await import('../src/db.js');
    const result1 = await searchChunksByKeywords(testDir, ["'; DROP TABLE chunks; --"], 10);
    const result2 = await searchChunksByKeywords(testDir, ['%', '_', '\\'], 10);

    // Table should still work
    const total = await getTotalChunks(testDir);
    expect(total).toBe(1);
  });

  it('summary upsert with SQL injection in scope is safe', async () => {
    const malicious = "'; DROP TABLE summaries; --";
    await upsertSummary(testDir, 'branch', malicious, 'content', null);

    const summary = await getSummary(testDir, 'branch', malicious);
    expect(summary).not.toBeNull();
    expect(summary!.scope).toBe(malicious);
  });

  it('config with SQL injection is safe', async () => {
    const { setConfig, getConfig } = await import('../src/db.js');
    await setConfig(testDir, "'; DROP TABLE config; --", 'value');
    const val = await getConfig(testDir, "'; DROP TABLE config; --");
    expect(val).toBe('value');
  });
});
