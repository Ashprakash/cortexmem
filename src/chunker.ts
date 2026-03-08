import type { GitCommit } from './git.js';
import type { ScannedFile } from './scanner.js';

export interface TextChunk {
  content: string;
  source: 'git_commit' | 'source_file' | 'project_file';
  sourceRef: string;
  contextType: string;
  metadata: Record<string, unknown>;
}

const MAX_CHUNK_CHARS = 1500; // ~375 tokens

export function chunkCommits(commits: GitCommit[]): TextChunk[] {
  const chunks: TextChunk[] = [];

  for (const commit of commits) {
    const parts = [`commit ${commit.hash.slice(0, 8)}: ${commit.message}`];
    if (commit.body) parts.push(commit.body);
    if (commit.files.length > 0) {
      parts.push(`files: ${commit.files.slice(0, 10).join(', ')}`);
    }

    chunks.push({
      content: parts.join('\n'),
      source: 'git_commit',
      sourceRef: commit.hash,
      contextType: 'commit',
      metadata: { author: commit.author, date: commit.date },
    });
  }

  return chunks;
}

export function chunkSourceFile(file: ScannedFile): TextChunk[] {
  const chunks: TextChunk[] = [];
  const lines = file.content.split('\n');

  // For small files, keep as single chunk
  if (file.content.length <= MAX_CHUNK_CHARS) {
    chunks.push({
      content: `// ${file.relativePath}\n${file.content}`,
      source: 'source_file',
      sourceRef: file.relativePath,
      contextType: isDocFile(file.extension) ? 'doc' : 'code',
      metadata: { extension: file.extension },
    });
    return chunks;
  }

  // Split at logical boundaries (functions, classes, blank lines between blocks)
  const boundaries = findSplitPoints(lines);
  let currentChunk: string[] = [];
  let currentLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    currentChunk.push(line);
    currentLen += line.length + 1;

    const isAtBoundary = boundaries.has(i);
    const isOverLimit = currentLen >= MAX_CHUNK_CHARS;

    if ((isAtBoundary && currentLen > MAX_CHUNK_CHARS / 3) || isOverLimit) {
      const chunkContent = `// ${file.relativePath} (part ${chunks.length + 1})\n${currentChunk.join('\n')}`;
      chunks.push({
        content: chunkContent,
        source: 'source_file',
        sourceRef: file.relativePath,
        contextType: isDocFile(file.extension) ? 'doc' : 'code',
        metadata: {
          extension: file.extension,
          part: chunks.length + 1,
          lineStart: i - currentChunk.length + 2,
          lineEnd: i + 1,
        },
      });
      currentChunk = [];
      currentLen = 0;
    }
  }

  // Remaining lines
  if (currentChunk.length > 0) {
    const chunkContent = `// ${file.relativePath} (part ${chunks.length + 1})\n${currentChunk.join('\n')}`;
    chunks.push({
      content: chunkContent,
      source: 'source_file',
      sourceRef: file.relativePath,
      contextType: isDocFile(file.extension) ? 'doc' : 'code',
      metadata: {
        extension: file.extension,
        part: chunks.length + 1,
      },
    });
  }

  return chunks;
}

export function chunkProjectFile(content: string, filePath: string): TextChunk[] {
  const chunks: TextChunk[] = [];

  // Split by markdown headers
  const sections = content.split(/(?=^#{1,3}\s)/m);

  for (const section of sections) {
    if (!section.trim()) continue;

    if (section.length <= MAX_CHUNK_CHARS) {
      chunks.push({
        content: section.trim(),
        source: 'project_file',
        sourceRef: filePath,
        contextType: 'doc',
        metadata: {},
      });
    } else {
      // Split long sections at paragraph boundaries
      const paragraphs = section.split(/\n\n+/);
      let current = '';
      for (const para of paragraphs) {
        if (current.length + para.length > MAX_CHUNK_CHARS && current) {
          chunks.push({
            content: current.trim(),
            source: 'project_file',
            sourceRef: filePath,
            contextType: 'doc',
            metadata: {},
          });
          current = '';
        }
        current += para + '\n\n';
      }
      if (current.trim()) {
        chunks.push({
          content: current.trim(),
          source: 'project_file',
          sourceRef: filePath,
          contextType: 'doc',
          metadata: {},
        });
      }
    }
  }

  return chunks;
}

function findSplitPoints(lines: string[]): Set<number> {
  const points = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Empty lines between blocks
    if (line === '' && i > 0 && i < lines.length - 1) {
      points.add(i);
    }

    // Function/class/method declarations
    if (
      /^(export\s+)?(async\s+)?function\s/.test(line) ||
      /^(export\s+)?(abstract\s+)?class\s/.test(line) ||
      /^(export\s+)?interface\s/.test(line) ||
      /^(export\s+)?type\s/.test(line) ||
      /^def\s/.test(line) ||
      /^class\s/.test(line) ||
      /^func\s/.test(line) ||
      /^fn\s/.test(line) ||
      /^pub\s/.test(line)
    ) {
      if (i > 0) points.add(i - 1);
    }
  }

  return points;
}

function isDocFile(ext: string): boolean {
  return ['.md', '.mdx', '.txt', '.rst'].includes(ext);
}
