import { getCommitHistory, getCommitsSince, getChangedFilesSince, getLatestCommitHash, detectBranch } from './git.js';
import { scanCodebase, type ScannedFile } from './scanner.js';
import { chunkCommits, chunkSourceFile, chunkProjectFile, type TextChunk } from './chunker.js';
import { embed, embedBatch } from './embeddings.js';
import { insertChunksBatch, clearChunksBySource, setConfig, getConfig, upsertSummary, deleteChunksBySourceRef } from './db.js';
import { buildProjectMetadata } from './summarizer.js';
import { generateEditorConfigs } from './editor-config.js';
import { readFile } from 'fs/promises';
import { resolve } from 'path';

export async function ingestAll(
  repoRoot: string,
  options: { maxCommits?: number; projectFile?: string } = {},
): Promise<{ commits: number; files: number; chunks: number; projectChunks: number; incremental: boolean }> {
  const maxCommits = options.maxCommits || 500;

  // Check if we can do an incremental update
  const lastHash = await getConfig(repoRoot, 'last_commit_hash');
  const isIncremental = !!lastHash;

  let commits;
  let commitChunks: TextChunk[];
  let files: ScannedFile[];
  let fileChunks: TextChunk[];

  if (isIncremental) {
    console.log('Incremental update — scanning changes since last init...');

    // Only fetch new commits since last indexed hash
    commits = await getCommitsSince(repoRoot, lastHash, maxCommits);
    commitChunks = chunkCommits(commits);
    console.log(`  ${commits.length} new commits → ${commitChunks.length} chunks`);

    // Only re-scan files changed since last hash
    const changedPaths = await getChangedFilesSince(repoRoot, lastHash);
    console.log(`  ${changedPaths.length} files changed`);

    files = await scanCodebase(repoRoot);
    const changedSet = new Set(changedPaths);
    const changedFiles = files.filter((f) => changedSet.has(f.relativePath));

    fileChunks = [];
    for (const file of changedFiles) {
      fileChunks.push(...chunkSourceFile(file));
    }
    console.log(`  ${changedFiles.length} changed files → ${fileChunks.length} chunks`);

    // Remove old chunks for changed files only
    for (const file of changedFiles) {
      await deleteChunksBySourceRef(repoRoot, 'source_file', file.path);
    }
    // Append new commit chunks (don't clear old ones)
  } else {
    console.log('Full scan — first-time initialization...');

    commits = await getCommitHistory(repoRoot, maxCommits);
    commitChunks = chunkCommits(commits);
    console.log(`  Found ${commits.length} commits → ${commitChunks.length} chunks`);

    files = await scanCodebase(repoRoot);
    fileChunks = [];
    for (const file of files) {
      fileChunks.push(...chunkSourceFile(file));
    }
    console.log(`  Found ${files.length} files → ${fileChunks.length} chunks`);

    // Clear all ingested data on full scan
    await clearChunksBySource(repoRoot, 'git_commit');
    await clearChunksBySource(repoRoot, 'source_file');
    await clearChunksBySource(repoRoot, 'project_file');
  }

  let projectChunks: TextChunk[] = [];
  if (options.projectFile) {
    console.log(`Reading project file: ${options.projectFile}`);
    try {
      const content = await readFile(options.projectFile, 'utf-8');
      projectChunks = chunkProjectFile(content, options.projectFile);
      console.log(`  → ${projectChunks.length} chunks`);
      // Always replace project file chunks
      await clearChunksBySource(repoRoot, 'project_file');
    } catch (err) {
      console.error(`  Failed to read project file: ${err}`);
    }
  }

  const allChunks = [...commitChunks, ...fileChunks, ...projectChunks];

  if (allChunks.length === 0) {
    console.log('No new changes to index.');
  } else {
    console.log(`\nEmbedding ${allChunks.length} chunks...`);
    const texts = allChunks.map((c) => c.content);
    const embeddings = await embedBatch(texts);

    console.log('Storing in database...');
    const dbChunks = allChunks.map((chunk, i) => ({
      content: chunk.content,
      source: chunk.source,
      sourceRef: chunk.sourceRef,
      contextType: chunk.contextType,
      embedding: embeddings[i],
      metadata: chunk.metadata,
    }));
    await insertChunksBatch(repoRoot, dbChunks);
  }

  // Save config
  const branch = await detectBranch(repoRoot);
  const latestHash = await getLatestCommitHash(repoRoot);
  await setConfig(repoRoot, 'repo_path', repoRoot);
  await setConfig(repoRoot, 'branch', branch);
  await setConfig(repoRoot, 'last_commit_hash', latestHash || '');
  await setConfig(repoRoot, 'last_init_at', new Date().toISOString());

  // Build initial project summary (deterministic, no API key needed)
  console.log('Building project summary...');
  const metadata = await buildProjectMetadata(repoRoot);
  const metaEmbedding = await embed(metadata);
  const projectId = await upsertSummary(repoRoot, 'project', '*', metadata, metaEmbedding, null);

  // Create/update branch node
  const totalCommits = isIncremental ? `+${commits.length} new` : `${commits.length}`;
  await upsertSummary(
    repoRoot, 'branch', branch,
    `Branch: ${branch} — ${totalCommits} commits, ${files.length} files indexed`,
    null, projectId,
  );

  // Generate editor config files on first init
  if (!isIncremental) {
    console.log('Generating editor configs...');
    const configs = await generateEditorConfigs(repoRoot);
    if (configs.length > 0) {
      console.log(`  Created: ${configs.join(', ')}`);
    }
  }

  console.log('Done!\n');

  return {
    commits: commits.length,
    files: files.length,
    chunks: allChunks.length,
    projectChunks: projectChunks.length,
    incremental: isIncremental,
  };
}

export async function ingestProjectFile(
  repoRoot: string,
  filePath: string,
): Promise<number> {
  // Validate path is within the repo (prevent path traversal)
  const resolvedPath = resolve(filePath);
  const resolvedRoot = resolve(repoRoot);
  if (!resolvedPath.startsWith(resolvedRoot + '/') && resolvedPath !== resolvedRoot) {
    throw new Error(`Project file must be within the repository. Got: ${filePath}`);
  }

  const content = await readFile(resolvedPath, 'utf-8');
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
