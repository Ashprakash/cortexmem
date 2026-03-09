import { describe, it, expect } from 'vitest';
import { chunkCommits, chunkSourceFile, chunkProjectFile } from '../src/chunker.js';
import type { GitCommit } from '../src/git.js';
import type { ScannedFile } from '../src/scanner.js';

describe('chunkCommits', () => {
  it('creates one chunk per commit', () => {
    const commits: GitCommit[] = [
      { hash: 'abc123def456', message: 'feat: add auth', body: '', author: 'dev', date: '2024-01-01', files: ['auth.ts'] },
      { hash: 'def456abc789', message: 'fix: login bug', body: 'Fixed issue #42', author: 'dev', date: '2024-01-02', files: [] },
    ];

    const chunks = chunkCommits(commits);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].source).toBe('git_commit');
    expect(chunks[0].contextType).toBe('commit');
    expect(chunks[0].content).toContain('abc123de');
    expect(chunks[0].content).toContain('feat: add auth');
    expect(chunks[0].content).toContain('auth.ts');
    expect(chunks[0].metadata.author).toBe('dev');
  });

  it('includes commit body when present', () => {
    const commits: GitCommit[] = [
      { hash: 'abc123', message: 'feat', body: 'Detailed description', author: 'dev', date: '2024-01-01', files: [] },
    ];
    const chunks = chunkCommits(commits);
    expect(chunks[0].content).toContain('Detailed description');
  });

  it('limits files listed to 10', () => {
    const files = Array.from({ length: 20 }, (_, i) => `file${i}.ts`);
    const commits: GitCommit[] = [
      { hash: 'abc123', message: 'big change', body: '', author: 'dev', date: '2024-01-01', files },
    ];
    const chunks = chunkCommits(commits);
    // Should contain at most 10 file references
    const fileMatches = chunks[0].content.match(/file\d+\.ts/g) || [];
    expect(fileMatches.length).toBeLessThanOrEqual(10);
  });

  it('handles empty commits array', () => {
    const chunks = chunkCommits([]);
    expect(chunks).toEqual([]);
  });
});

describe('chunkSourceFile', () => {
  it('keeps small files as single chunk', () => {
    const file: ScannedFile = {
      path: '/project/src/small.ts',
      relativePath: 'src/small.ts',
      content: 'const x = 1;\nconst y = 2;',
      extension: '.ts',
    };
    const chunks = chunkSourceFile(file);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('src/small.ts');
    expect(chunks[0].source).toBe('source_file');
    expect(chunks[0].contextType).toBe('code');
  });

  it('splits large files at logical boundaries', () => {
    // Create a file larger than MAX_CHUNK_CHARS (1500)
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) {
      lines.push(`export function func${i}() {`);
      lines.push(`  const data = "some padding text to make this chunk bigger for testing purposes";`);
      lines.push(`  const more = "additional content to ensure we exceed the 1500 char threshold easily";`);
      lines.push(`  return ${i};`);
      lines.push('}');
      lines.push('');
    }
    const file: ScannedFile = {
      path: '/project/src/large.ts',
      relativePath: 'src/large.ts',
      content: lines.join('\n'),
      extension: '.ts',
    };
    const chunks = chunkSourceFile(file);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].metadata.part).toBe(1);
  });

  it('classifies .md files as doc', () => {
    const file: ScannedFile = {
      path: '/project/README.md',
      relativePath: 'README.md',
      content: '# Title\nSome docs',
      extension: '.md',
    };
    const chunks = chunkSourceFile(file);
    expect(chunks[0].contextType).toBe('doc');
  });
});

describe('chunkProjectFile', () => {
  it('splits by markdown headers', () => {
    const content = `# Project Spec\nOverview of the project.\n\n## Requirements\nMust do X.\n\n## Architecture\nUses Y.`;
    const chunks = chunkProjectFile(content, 'SPEC.md');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.source === 'project_file')).toBe(true);
    expect(chunks.every((c) => c.contextType === 'doc')).toBe(true);
  });

  it('handles content without headers', () => {
    const content = 'Just a plain text file with no markdown headers.';
    const chunks = chunkProjectFile(content, 'notes.txt');
    expect(chunks).toHaveLength(1);
  });

  it('handles empty content', () => {
    const chunks = chunkProjectFile('', 'empty.md');
    expect(chunks).toEqual([]);
  });

  it('splits very long sections at paragraph boundaries', () => {
    const longSection = '# Big Section\n\n' + Array(100).fill('This is a paragraph with enough text to make it substantial.').join('\n\n');
    const chunks = chunkProjectFile(longSection, 'long.md');
    expect(chunks.length).toBeGreaterThan(1);
  });
});
