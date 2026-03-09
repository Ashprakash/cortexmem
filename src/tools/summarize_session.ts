import { detectRepoRoot, detectBranch } from '../git.js';
import { getSessionId } from './save_context.js';
import { compactSession, compactBranch, compactProject } from '../summarizer.js';

interface SummarizeArgs {
  session_summary?: string;
}

export async function summarizeSession(args: SummarizeArgs): Promise<string> {
  const repoRoot = await detectRepoRoot();
  if (!repoRoot) {
    return 'Error: cortexmem requires a git repository. Run from inside a git project.';
  }

  const sessionId = getSessionId();
  const branchName = await detectBranch(repoRoot);

  const results: string[] = [];

  // 1. Compact current session
  const sessionResult = await compactSession(repoRoot, sessionId, branchName);
  results.push(`Session: ${sessionResult.message}`);

  // 2. Compact branch (rolls up all session summaries)
  const branchResult = await compactBranch(repoRoot, branchName);
  results.push(`Branch (${branchName}): ${branchResult.message}`);

  // 3. Compact project (rolls up all branch summaries)
  const projectResult = await compactProject(repoRoot);
  results.push(`Project: ${projectResult.message}`);

  if (args.session_summary) {
    results.push(`\nSession note: ${args.session_summary}`);
  }

  return `Compaction complete:\n${results.join('\n')}`;
}
