import Anthropic from '@anthropic-ai/sdk';
import { embed } from './embeddings.js';
import {
  getChunksBySession,
  getSummary,
  getSummariesByLevel,
  getChildSummaries,
  upsertSummary,
  getDistinctSessions,
} from './db.js';
import { detectBranch, getCommitHistory } from './git.js';
import { scanCodebase } from './scanner.js';

const SESSION_PROMPT = `You are compacting an AI coding agent's session memory into a concise summary.

Below are context entries saved during a coding session. Create a summary that captures:
- Key decisions made and their rationale
- Constraints established
- Current state of work in progress
- Important discoveries about the codebase
- Preferences noted

Write a concise narrative summary (200-400 tokens). Preserve actionable information. Discard exploratory dead ends and wrong assumptions that were corrected.

Entries:
<entries>
{{ENTRIES}}
</entries>`;

const BRANCH_PROMPT = `You are compacting session summaries for a git branch into a branch-level overview.

Below are summaries from individual coding sessions on this branch. Create a unified branch summary that captures:
- What work is being done on this branch
- Key decisions and constraints
- Current progress and state
- Important patterns or discoveries

Write a concise summary (150-300 tokens). Merge overlapping information. Keep the most recent state.

Branch: {{BRANCH}}

Session summaries:
<sessions>
{{SESSIONS}}
</sessions>`;

const PROJECT_PROMPT = `You are creating a project overview from branch summaries and project metadata.

Create a high-level project summary (~100 tokens) that captures:
- What this project is and does
- Tech stack and architecture
- Active work areas
- Key constraints or conventions

Project metadata:
<metadata>
{{METADATA}}
</metadata>

Branch summaries:
<branches>
{{BRANCHES}}
</branches>`;

function escapeForPrompt(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey });
}

function getModel(): string {
  return process.env.CORTEXMEM_MODEL || 'claude-haiku-4-5-20251001';
}

async function llmSummarize(prompt: string): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  const response = await client.messages.create({
    model: getModel(),
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].type === 'text' ? response.content[0].text : null;
}

export async function compactSession(
  projectRoot: string,
  sessionId: string,
  branchName: string,
): Promise<{ success: boolean; message: string }> {
  const chunks = await getChunksBySession(projectRoot, sessionId);
  const userChunks = chunks.filter((c) => c.source === 'user_context');

  if (userChunks.length === 0) {
    return { success: false, message: 'No user context in session' };
  }

  // Ensure branch node exists
  const branchSummary = await ensureBranchNode(projectRoot, branchName);

  // Build entries text — escape to prevent prompt injection
  const entriesText = userChunks
    .map((c) => `[${c.contextType}] ${escapeForPrompt(c.content)}`)
    .join('\n');

  const prompt = SESSION_PROMPT.replace('{{ENTRIES}}', entriesText);
  const summary = await llmSummarize(prompt);

  if (!summary) {
    // No API key — store a deterministic summary
    const fallback = userChunks
      .map((c) => `${c.contextType}: ${c.content}`)
      .join('; ');
    const truncated = fallback.length > 500 ? fallback.slice(0, 497) + '...' : fallback;
    const embedding = await embed(truncated);
    await upsertSummary(projectRoot, 'session', sessionId, truncated, embedding, branchSummary.id);
    return { success: true, message: `Session compacted (deterministic, ${userChunks.length} entries)` };
  }

  const embedding = await embed(summary);
  await upsertSummary(projectRoot, 'session', sessionId, summary, embedding, branchSummary.id);

  return { success: true, message: `Session compacted (${userChunks.length} entries → summary)` };
}

export async function compactBranch(
  projectRoot: string,
  branchName: string,
): Promise<{ success: boolean; message: string }> {
  const branchSummary = await getSummary(projectRoot, 'branch', branchName);
  if (!branchSummary) {
    return { success: false, message: `No branch node for ${branchName}` };
  }

  const sessionSummaries = await getChildSummaries(projectRoot, branchSummary.id);
  if (sessionSummaries.length === 0) {
    return { success: false, message: 'No session summaries to compact' };
  }

  const sessionsText = sessionSummaries
    .map((s) => `[Session ${s.scope}, ${s.updatedAt}]\n${escapeForPrompt(s.content)}`)
    .join('\n\n');

  const prompt = BRANCH_PROMPT
    .replace('{{BRANCH}}', branchName)
    .replace('{{SESSIONS}}', sessionsText);

  const summary = await llmSummarize(prompt);

  if (!summary) {
    // Deterministic: concatenate session summaries
    const fallback = sessionSummaries.map((s) => s.content).join(' | ');
    const truncated = fallback.length > 500 ? fallback.slice(0, 497) + '...' : fallback;
    const embedding = await embed(truncated);
    await upsertSummary(projectRoot, 'branch', branchName, truncated, embedding, branchSummary.parentId);
    return { success: true, message: `Branch compacted (deterministic, ${sessionSummaries.length} sessions)` };
  }

  const embedding = await embed(summary);
  // Ensure project node exists for parent link
  const projectNode = await ensureProjectNode(projectRoot);
  await upsertSummary(projectRoot, 'branch', branchName, summary, embedding, projectNode.id);

  return { success: true, message: `Branch compacted (${sessionSummaries.length} sessions → summary)` };
}

export async function compactProject(
  projectRoot: string,
): Promise<{ success: boolean; message: string }> {
  const branchSummaries = await getSummariesByLevel(projectRoot, 'branch');
  const metadata = await buildProjectMetadata(projectRoot);

  const branchesText = branchSummaries.length > 0
    ? branchSummaries.map((s) => `[${s.scope}] ${escapeForPrompt(s.content)}`).join('\n\n')
    : 'No branch summaries yet.';

  const prompt = PROJECT_PROMPT
    .replace('{{METADATA}}', metadata)
    .replace('{{BRANCHES}}', branchesText);

  const summary = await llmSummarize(prompt);

  if (!summary) {
    // Deterministic project summary from metadata
    const embedding = await embed(metadata);
    await upsertSummary(projectRoot, 'project', '*', metadata, embedding, null);
    return { success: true, message: 'Project summary generated (deterministic)' };
  }

  const embedding = await embed(summary);
  await upsertSummary(projectRoot, 'project', '*', summary, embedding, null);

  return { success: true, message: 'Project summary generated' };
}

export async function compactAll(
  projectRoot: string,
): Promise<{ sessions: number; branches: number }> {
  const branchName = await detectBranch(projectRoot);
  const sessionIds = await getDistinctSessions(projectRoot);

  let sessionCount = 0;
  for (const sessionId of sessionIds) {
    const existing = await getSummary(projectRoot, 'session', sessionId);
    if (!existing) {
      const result = await compactSession(projectRoot, sessionId, branchName);
      if (result.success) sessionCount++;
    }
  }

  let branchCount = 0;
  const branchResult = await compactBranch(projectRoot, branchName);
  if (branchResult.success) branchCount++;

  await compactProject(projectRoot);

  return { sessions: sessionCount, branches: branchCount };
}

// --- Helpers ---

async function ensureBranchNode(
  projectRoot: string,
  branchName: string,
): Promise<{ id: number }> {
  const existing = await getSummary(projectRoot, 'branch', branchName);
  if (existing) return { id: existing.id };

  const projectNode = await ensureProjectNode(projectRoot);
  const id = await upsertSummary(
    projectRoot,
    'branch',
    branchName,
    `Branch: ${branchName} — awaiting compaction`,
    null,
    projectNode.id,
  );
  return { id };
}

async function ensureProjectNode(
  projectRoot: string,
): Promise<{ id: number }> {
  const existing = await getSummary(projectRoot, 'project', '*');
  if (existing) return { id: existing.id };

  const metadata = await buildProjectMetadata(projectRoot);
  const id = await upsertSummary(projectRoot, 'project', '*', metadata, null, null);
  return { id };
}

export async function buildProjectMetadata(projectRoot: string): Promise<string> {
  const repoName = projectRoot.split('/').pop() || projectRoot;

  // Gather file stats
  let fileStats = '';
  try {
    const files = await scanCodebase(projectRoot);
    const extCounts: Record<string, number> = {};
    for (const file of files) {
      const ext = file.extension || 'other';
      extCounts[ext] = (extCounts[ext] || 0) + 1;
    }
    const sorted = Object.entries(extCounts).sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 5).map(([ext, count]) => `${ext}: ${count} files`);
    fileStats = `Files: ${files.length} total (${top.join(', ')})`;
  } catch {
    fileStats = 'Files: unable to scan';
  }

  // Recent commits
  let commitInfo = '';
  try {
    const commits = await getCommitHistory(projectRoot, 5);
    if (commits.length > 0) {
      commitInfo = 'Recent commits:\n' + commits
        .map((c) => `- ${c.message}`)
        .join('\n');
    }
  } catch {
    commitInfo = '';
  }

  return `Project: ${repoName}\n${fileStats}\n${commitInfo}`.trim();
}
