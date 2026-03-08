import { getStats, getTotalChunks, getConfig } from '../db.js';
import { detectRepoRoot, detectBranch } from '../git.js';
import { CONTEXT_TYPE_LABELS } from '../types.js';
import { join } from 'path';

export async function getStatus(): Promise<string> {
  const repoRoot = await detectRepoRoot();
  if (!repoRoot) {
    return 'Error: engram requires a git repository. Run from inside a git project.';
  }

  const branch = await detectBranch(repoRoot);
  const repoName = repoRoot.split('/').pop() || repoRoot;
  const stats = await getStats(repoRoot);
  const total = await getTotalChunks(repoRoot);

  const lastInit = await getConfig(repoRoot, 'last_init_at');
  const lastCommit = await getConfig(repoRoot, 'last_commit_hash');

  let output = 'Engram Status\n';
  output += `Repo: ${repoName} (${repoRoot})\n`;
  output += `Branch: ${branch}\n`;
  output += `Storage: ${join(repoRoot, '.engram', 'store.db')}\n`;
  output += `Total chunks: ${total}\n`;

  if (lastInit) output += `Last initialized: ${lastInit}\n`;
  if (lastCommit) output += `Last commit indexed: ${lastCommit.slice(0, 8)}\n`;

  output += '\nBreakdown:\n';
  for (const [type, count] of Object.entries(stats)) {
    const label = CONTEXT_TYPE_LABELS[type] || type;
    output += `  ${label}: ${count}\n`;
  }

  return output;
}
