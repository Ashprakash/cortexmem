import { cosineSimilarity, embed, isModelLoaded } from './embeddings.js';
import {
  getSummary,
  getSummariesByLevel,
  getChildSummaries,
  getSummaryEmbeddings,
} from './db.js';
import { search, tokenize } from './search.js';
import { detectBranch } from './git.js';
import type { HierarchicalResult, Summary } from './types.js';

const RELEVANCE_THRESHOLD = 0.25;

export async function hierarchicalSearch(
  projectRoot: string,
  query: string,
  maxDepth: number = 3,
  topKPerLevel: number = 3,
): Promise<HierarchicalResult[]> {
  const results: HierarchicalResult[] = [];

  // Level 0: Project
  const projectSummary = await getSummary(projectRoot, 'project', '*');
  if (!projectSummary) return [];

  const projectScore = await scoreSummary(projectSummary, query);
  if (projectScore < RELEVANCE_THRESHOLD && maxDepth === 0) {
    return [];
  }

  if (maxDepth === 0) {
    results.push({
      breadcrumb: 'project',
      summary: projectSummary,
      score: projectScore,
    });
    return results;
  }

  // Level 1: Branches
  const branchSummaries = await getSummariesByLevel(projectRoot, 'branch');
  const scoredBranches = await scoreSummaries(branchSummaries, query);
  const topBranches = scoredBranches
    .sort((a, b) => b.score - a.score)
    .slice(0, topKPerLevel);

  if (maxDepth === 1) {
    results.push({
      breadcrumb: 'project',
      summary: projectSummary,
      score: projectScore,
    });
    for (const { summary, score } of topBranches) {
      results.push({
        breadcrumb: `project > branch:${summary.scope}`,
        summary,
        score,
      });
    }
    return results;
  }

  // Level 2: Sessions within matched branches
  for (const { summary: branchSummary, score: branchScore } of topBranches) {
    const sessionSummaries = await getChildSummaries(projectRoot, branchSummary.id);
    const scoredSessions = await scoreSummaries(sessionSummaries, query);
    const topSessions = scoredSessions
      .sort((a, b) => b.score - a.score)
      .slice(0, topKPerLevel);

    if (maxDepth === 2) {
      results.push({
        breadcrumb: `project > branch:${branchSummary.scope}`,
        summary: branchSummary,
        score: branchScore,
      });
      for (const { summary, score } of topSessions) {
        results.push({
          breadcrumb: `project > branch:${branchSummary.scope} > session:${summary.scope}`,
          summary,
          score,
        });
      }
      continue;
    }

    // Level 3: Drill into raw chunks for matched sessions
    for (const { summary: sessionSummary, score: sessionScore } of topSessions) {
      const chunks = await search(
        projectRoot,
        query,
        5,
        undefined,
        sessionSummary.scope,
      );

      results.push({
        breadcrumb: `project > branch:${branchSummary.scope} > session:${sessionSummary.scope}`,
        summary: sessionSummary,
        chunks: chunks.length > 0 ? chunks : undefined,
        score: sessionScore,
      });
    }
  }

  // Also search unscoped chunks (git_commit, source_file, project_file) at depth 3
  // Deduplicate against chunks already returned from session-scoped searches
  if (maxDepth >= 3) {
    const seenChunkIds = new Set<number>();
    for (const r of results) {
      if (r.chunks) {
        for (const c of r.chunks) seenChunkIds.add(c.chunk.id);
      }
    }

    const unscopedResults = await search(projectRoot, query, 5 + seenChunkIds.size, undefined);
    const deduped = unscopedResults.filter((r) => !seenChunkIds.has(r.chunk.id)).slice(0, 5);
    if (deduped.length > 0) {
      results.push({
        breadcrumb: 'project > indexed',
        summary: projectSummary,
        chunks: deduped,
        score: deduped[0].score,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

export async function buildPyramid(
  projectRoot: string,
  branchName?: string,
  maxSessions: number = 3,
): Promise<string | null> {
  const currentBranch = branchName || await detectBranch(projectRoot);

  const projectSummary = await getSummary(projectRoot, 'project', '*');
  if (!projectSummary) return null;

  let output = `### Project Overview\n${projectSummary.content}\n\n`;

  // Current branch summary
  const branchSummary = await getSummary(projectRoot, 'branch', currentBranch);
  if (branchSummary && !branchSummary.content.includes('awaiting compaction')) {
    output += `### Branch: ${currentBranch}\n${branchSummary.content}\n\n`;
  }

  // Other active branches (brief mention)
  const allBranches = await getSummariesByLevel(projectRoot, 'branch');
  const otherBranches = allBranches.filter(
    (b) => b.scope !== currentBranch && !b.content.includes('awaiting compaction'),
  );
  if (otherBranches.length > 0) {
    output += `### Other Branches\n`;
    for (const b of otherBranches.slice(0, 5)) {
      // One-line summary per branch
      const firstLine = b.content.split('\n')[0].slice(0, 150);
      output += `- **${b.scope}**: ${firstLine}\n`;
    }
    output += '\n';
  }

  // Recent sessions on current branch
  if (branchSummary) {
    const sessions = await getChildSummaries(projectRoot, branchSummary.id);
    const recent = sessions.slice(0, maxSessions);
    if (recent.length > 0) {
      output += `### Recent Sessions (${currentBranch})\n`;
      for (const s of recent) {
        const date = s.updatedAt.split('T')[0];
        output += `#### Session ${s.scope.slice(0, 8)} (${date})\n${s.content}\n\n`;
      }
    }
  }

  return output;
}

// --- Scoring helpers ---

async function scoreSummary(summary: Summary, query: string): Promise<number> {
  // Try embedding-based scoring if model is loaded and summary has embedding
  if (isModelLoaded() && summary.embedding) {
    const queryEmbedding = await embed(query);
    return cosineSimilarity(queryEmbedding, summary.embedding);
  }

  // Keyword-based scoring
  return keywordScore(summary.content, query);
}

async function scoreSummaries(
  summaries: Summary[],
  query: string,
): Promise<Array<{ summary: Summary; score: number }>> {
  const results: Array<{ summary: Summary; score: number }> = [];
  for (const summary of summaries) {
    const score = await scoreSummary(summary, query);
    results.push({ summary, score });
  }
  return results;
}

function keywordScore(text: string, query: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const lowerText = text.toLowerCase();
  let matches = 0;
  for (const token of queryTokens) {
    if (lowerText.includes(token)) matches++;
  }
  return matches / queryTokens.length;
}
