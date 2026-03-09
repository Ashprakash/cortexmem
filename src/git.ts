import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GitCommit {
  hash: string;
  message: string;
  body: string;
  author: string;
  date: string;
  files: string[];
}

export async function detectRepoRoot(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel']);
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function detectBranch(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
    });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

export async function getCommitHistory(
  repoRoot: string,
  maxCommits: number = 500,
): Promise<GitCommit[]> {
  try {
    // Get main/master branch name
    const branch = await getMainBranch(repoRoot);

    const { stdout } = await execFileAsync(
      'git',
      [
        'log',
        branch,
        `--max-count=${maxCommits}`,
        '--format=%H%x1f%s%x1f%b%x1f%an%x1f%aI%x1f%x1e',
        '--name-only',
      ],
      { cwd: repoRoot, maxBuffer: 50 * 1024 * 1024 },
    );

    const commits: GitCommit[] = [];
    const entries = stdout.split('\x1e').filter((e) => e.trim());

    for (const entry of entries) {
      const lines = entry.trim().split('\n');
      const firstLine = lines[0];
      if (!firstLine) continue;

      const parts = firstLine.split('\x1f');
      if (parts.length < 5) continue;

      const [hash, message, body, author, date] = parts;
      const files = lines.slice(1).filter((f) => f.trim());

      commits.push({
        hash: hash.trim(),
        message: message.trim(),
        body: body.trim(),
        author: author.trim(),
        date: date.trim(),
        files,
      });
    }

    return commits;
  } catch {
    return [];
  }
}

export async function getMainBranch(repoRoot: string): Promise<string> {
  try {
    // Check if 'main' exists
    await execFileAsync('git', ['rev-parse', '--verify', 'main'], { cwd: repoRoot });
    return 'main';
  } catch {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', 'master'], { cwd: repoRoot });
      return 'master';
    } catch {
      // Fall back to current branch
      return await detectBranch(repoRoot);
    }
  }
}

export async function getCommitsSince(
  repoRoot: string,
  sinceHash: string,
  maxCommits: number = 500,
): Promise<GitCommit[]> {
  try {
    const branch = await getMainBranch(repoRoot);
    const { stdout } = await execFileAsync(
      'git',
      [
        'log',
        `${sinceHash}..${branch}`,
        `--max-count=${maxCommits}`,
        '--format=%H%x1f%s%x1f%b%x1f%an%x1f%aI%x1f%x1e',
        '--name-only',
      ],
      { cwd: repoRoot, maxBuffer: 50 * 1024 * 1024 },
    );

    const commits: GitCommit[] = [];
    const entries = stdout.split('\x1e').filter((e) => e.trim());

    for (const entry of entries) {
      const lines = entry.trim().split('\n');
      const firstLine = lines[0];
      if (!firstLine) continue;
      const parts = firstLine.split('\x1f');
      if (parts.length < 5) continue;
      const [hash, message, body, author, date] = parts;
      const files = lines.slice(1).filter((f) => f.trim());
      commits.push({
        hash: hash.trim(),
        message: message.trim(),
        body: body.trim(),
        author: author.trim(),
        date: date.trim(),
        files,
      });
    }

    return commits;
  } catch {
    // If sinceHash is invalid or not an ancestor, fall back to full history
    return getCommitHistory(repoRoot, maxCommits);
  }
}

export async function getChangedFilesSince(
  repoRoot: string,
  sinceHash: string,
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--name-only', sinceHash, 'HEAD'],
      { cwd: repoRoot },
    );
    return stdout.trim().split('\n').filter((f) => f.trim());
  } catch {
    return [];
  }
}

export async function getLatestCommitHash(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    return stdout.trim();
  } catch {
    return null;
  }
}
