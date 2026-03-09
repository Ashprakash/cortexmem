import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { closeDb, getConfig, setConfig, getTotalChunks, deleteChunksBySourceRef, getChunksByType } from '../src/db.js';

let testDir: string;

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cortexmem-inc-'));
  initGitRepo(testDir);
});

afterEach(() => {
  closeDb();
  rmSync(testDir, { recursive: true, force: true });
});

describe('Incremental init support', () => {
  it('getConfig returns null when no last_commit_hash exists', async () => {
    const hash = await getConfig(testDir, 'last_commit_hash');
    expect(hash).toBeNull();
  });

  it('setConfig stores and retrieves last_commit_hash', async () => {
    await setConfig(testDir, 'last_commit_hash', 'abc123');
    const hash = await getConfig(testDir, 'last_commit_hash');
    expect(hash).toBe('abc123');
  });

  it('deleteChunksBySourceRef removes only matching chunks', async () => {
    const { insertChunk } = await import('../src/db.js');
    await insertChunk(testDir, 'file A content', 'source_file', '/path/a.ts', 'code_summary', null, {});
    await insertChunk(testDir, 'file B content', 'source_file', '/path/b.ts', 'code_summary', null, {});
    await insertChunk(testDir, 'commit content', 'git_commit', 'abc123', 'commit_summary', null, {});

    await deleteChunksBySourceRef(testDir, 'source_file', '/path/a.ts');

    const total = await getTotalChunks(testDir);
    expect(total).toBe(2); // b.ts + commit remain
  });
});

describe('Editor config generation', () => {
  it('creates CLAUDE.md, .cursorrules, codex.md on fresh repo', async () => {
    const { generateEditorConfigs } = await import('../src/editor-config.js');
    const generated = await generateEditorConfigs(testDir);

    expect(generated).toContain('CLAUDE.md');
    expect(generated).toContain('.cursorrules');
    expect(generated).toContain('codex.md');

    const claudeMd = readFileSync(join(testDir, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('cortexmem');
    expect(claudeMd).toContain('get_context');
    expect(claudeMd).toContain('save_context');
    expect(claudeMd).toContain('summarize_session');
  });

  it('appends to existing CLAUDE.md without overwriting', async () => {
    writeFileSync(join(testDir, 'CLAUDE.md'), '# My Project\n\nExisting instructions.');

    const { generateEditorConfigs } = await import('../src/editor-config.js');
    await generateEditorConfigs(testDir);

    const content = readFileSync(join(testDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('# My Project');
    expect(content).toContain('Existing instructions.');
    expect(content).toContain('cortexmem');
  });

  it('replaces existing cortexmem block on re-run', async () => {
    const { generateEditorConfigs } = await import('../src/editor-config.js');
    await generateEditorConfigs(testDir);
    await generateEditorConfigs(testDir);

    const content = readFileSync(join(testDir, 'CLAUDE.md'), 'utf-8');
    const markers = content.match(/cortexmem-auto-generated/g);
    expect(markers).toHaveLength(2); // opening + closing marker, not duplicated
  });
});

describe('Git utilities for incremental', () => {
  it('getCommitsSince returns only new commits', async () => {
    // Create initial commit
    writeFileSync(join(testDir, 'a.txt'), 'hello');
    execSync('git add a.txt && git commit -m "first"', { cwd: testDir, stdio: 'ignore' });

    const firstHash = execSync('git rev-parse HEAD', { cwd: testDir }).toString().trim();

    // Create second commit
    writeFileSync(join(testDir, 'b.txt'), 'world');
    execSync('git add b.txt && git commit -m "second"', { cwd: testDir, stdio: 'ignore' });

    const { getCommitsSince } = await import('../src/git.js');
    const newCommits = await getCommitsSince(testDir, firstHash);

    expect(newCommits.length).toBe(1);
    expect(newCommits[0].message).toBe('second');
  });

  it('getChangedFilesSince returns files changed since hash', async () => {
    writeFileSync(join(testDir, 'a.txt'), 'hello');
    execSync('git add a.txt && git commit -m "first"', { cwd: testDir, stdio: 'ignore' });

    const firstHash = execSync('git rev-parse HEAD', { cwd: testDir }).toString().trim();

    writeFileSync(join(testDir, 'b.txt'), 'world');
    writeFileSync(join(testDir, 'a.txt'), 'updated');
    execSync('git add -A && git commit -m "second"', { cwd: testDir, stdio: 'ignore' });

    const { getChangedFilesSince } = await import('../src/git.js');
    const changed = await getChangedFilesSince(testDir, firstHash);

    expect(changed).toContain('a.txt');
    expect(changed).toContain('b.txt');
  });

  it('getCommitsSince falls back to full history on invalid hash', async () => {
    writeFileSync(join(testDir, 'a.txt'), 'hello');
    execSync('git add a.txt && git commit -m "first"', { cwd: testDir, stdio: 'ignore' });

    const { getCommitsSince } = await import('../src/git.js');
    const commits = await getCommitsSince(testDir, 'invalid-hash-000');

    expect(commits.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Depth 3 deduplication', () => {
  it('hierarchicalSearch does not return duplicate chunks at depth 3', async () => {
    const { insertChunk, upsertSummary } = await import('../src/db.js');

    // Create project and branch summaries
    const projectId = await upsertSummary(testDir, 'project', '*', 'Test project about authentication', null, null);
    const branchId = await upsertSummary(testDir, 'branch', 'main', 'Main branch with auth features', null, projectId);
    const sessionId = 'test-session-1';
    await upsertSummary(testDir, 'session', sessionId, 'Session working on auth login', null, branchId);

    // Insert chunks — some session-scoped, some not
    await insertChunk(testDir, 'auth login with JWT tokens', 'user_context', '', 'decision', null, {}, sessionId);
    await insertChunk(testDir, 'auth middleware configuration', 'source_file', 'auth.ts', 'code_summary', null, {});
    await insertChunk(testDir, 'auth route handler setup', 'git_commit', 'abc', 'commit_summary', null, {});

    const { hierarchicalSearch } = await import('../src/hierarchy.js');
    const results = await hierarchicalSearch(testDir, 'auth', 3);

    // Collect all chunk IDs across all results
    const allChunkIds: number[] = [];
    for (const r of results) {
      if (r.chunks) {
        for (const c of r.chunks) allChunkIds.push(c.chunk.id);
      }
    }

    // No duplicates
    const uniqueIds = new Set(allChunkIds);
    expect(uniqueIds.size).toBe(allChunkIds.length);
  });
});
