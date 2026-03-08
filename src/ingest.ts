import { getCommitHistory, getLatestCommitHash, detectBranch } from './git.js';
import { scanCodebase } from './scanner.js';
import { chunkCommits, chunkSourceFile, chunkProjectFile, type TextChunk } from './chunker.js';
import { embedBatch } from './embeddings.js';
import { insertChunksBatch, clearChunksBySource, setConfig, getConfig } from './db.js';
import { readFile } from 'fs/promises';

export async function ingestAll(
  repoRoot: string,
  options: { maxCommits?: number; projectFile?: string } = {},
): Promise<{ commits: number; files: number; chunks: number; projectChunks: number }> {
  const maxCommits = options.maxCommits || 500;

  console.log('Scanning git history...');
  const commits = await getCommitHistory(repoRoot, maxCommits);
  const commitChunks = chunkCommits(commits);
  console.log(`  Found ${commits.length} commits → ${commitChunks.length} chunks`);

  console.log('Scanning codebase...');
  const files = await scanCodebase(repoRoot);
  const fileChunks: TextChunk[] = [];
  for (const file of files) {
    fileChunks.push(...chunkSourceFile(file));
  }
  console.log(`  Found ${files.length} files → ${fileChunks.length} chunks`);

  let projectChunks: TextChunk[] = [];
  if (options.projectFile) {
    console.log(`Reading project file: ${options.projectFile}`);
    try {
      const content = await readFile(options.projectFile, 'utf-8');
      projectChunks = chunkProjectFile(content, options.projectFile);
      console.log(`  → ${projectChunks.length} chunks`);
    } catch (err) {
      console.error(`  Failed to read project file: ${err}`);
    }
  }

  const allChunks = [...commitChunks, ...fileChunks, ...projectChunks];
  console.log(`\nEmbedding ${allChunks.length} total chunks...`);

  // Embed all chunks
  const texts = allChunks.map((c) => c.content);
  const embeddings = await embedBatch(texts);

  console.log('Storing in database...');

  // Clear existing ingested data (keep user_context)
  await clearChunksBySource(repoRoot, 'git_commit');
  await clearChunksBySource(repoRoot, 'source_file');
  await clearChunksBySource(repoRoot, 'project_file');

  // Insert all chunks
  const dbChunks = allChunks.map((chunk, i) => ({
    content: chunk.content,
    source: chunk.source,
    sourceRef: chunk.sourceRef,
    contextType: chunk.contextType,
    embedding: embeddings[i],
    metadata: chunk.metadata,
  }));

  await insertChunksBatch(repoRoot, dbChunks);

  // Save config
  const branch = await detectBranch(repoRoot);
  const latestHash = await getLatestCommitHash(repoRoot);
  await setConfig(repoRoot, 'repo_path', repoRoot);
  await setConfig(repoRoot, 'branch', branch);
  await setConfig(repoRoot, 'last_commit_hash', latestHash || '');
  await setConfig(repoRoot, 'last_init_at', new Date().toISOString());

  console.log('Done!\n');

  return {
    commits: commits.length,
    files: files.length,
    chunks: allChunks.length,
    projectChunks: projectChunks.length,
  };
}

export async function ingestProjectFile(
  repoRoot: string,
  filePath: string,
): Promise<number> {
  const content = await readFile(filePath, 'utf-8');
  const chunks = chunkProjectFile(content, filePath);

  console.log(`Embedding ${chunks.length} chunks from project file...`);
  const texts = chunks.map((c) => c.content);
  const embeddings = await embedBatch(texts);

  // Clear previous project file chunks
  await clearChunksBySource(repoRoot, 'project_file');

  const dbChunks = chunks.map((chunk, i) => ({
    content: chunk.content,
    source: chunk.source,
    sourceRef: chunk.sourceRef,
    contextType: chunk.contextType,
    embedding: embeddings[i],
    metadata: chunk.metadata,
  }));

  await insertChunksBatch(repoRoot, dbChunks);
  return chunks.length;
}
