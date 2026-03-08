import { readFile, readdir, stat } from 'fs/promises';
import { join, extname, relative } from 'path';

export interface ScannedFile {
  path: string;
  relativePath: string;
  content: string;
  extension: string;
}

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi',
  '.go',
  '.rs',
  '.java', '.kt', '.kts',
  '.c', '.cpp', '.cc', '.h', '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.scala',
  '.clj', '.cljs',
  '.ex', '.exs',
  '.hs',
  '.lua',
  '.r', '.R',
  '.sql',
  '.sh', '.bash', '.zsh',
  '.vue', '.svelte',
  '.astro',
]);

const CONFIG_FILES = new Set([
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'build.gradle',
  'pom.xml',
  'Gemfile',
  'composer.json',
  'Makefile',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  '.env.example',
]);

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst']);

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.engram', 'dist', 'build', 'out',
  '.next', '.nuxt', '.svelte-kit', '__pycache__', '.pytest_cache',
  'target', 'vendor', '.venv', 'venv', 'env',
  'coverage', '.nyc_output', '.cache', '.turbo',
  '.idea', '.vscode',
]);

const SKIP_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'Cargo.lock', 'poetry.lock', 'Gemfile.lock',
  'composer.lock', 'go.sum',
]);

const MAX_FILE_SIZE = 100 * 1024; // 100KB

export async function scanCodebase(repoRoot: string): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  await walkDir(repoRoot, repoRoot, files);
  return files;
}

async function walkDir(
  dir: string,
  repoRoot: string,
  files: ScannedFile[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      await walkDir(fullPath, repoRoot, files);
      continue;
    }

    if (!entry.isFile()) continue;
    if (SKIP_FILES.has(entry.name)) continue;

    const ext = extname(entry.name).toLowerCase();
    const isSource = SOURCE_EXTENSIONS.has(ext);
    const isConfig = CONFIG_FILES.has(entry.name);
    const isDoc = DOC_EXTENSIONS.has(ext);

    if (!isSource && !isConfig && !isDoc) continue;

    try {
      const stats = await stat(fullPath);
      if (stats.size > MAX_FILE_SIZE) continue;
      if (stats.size === 0) continue;

      const content = await readFile(fullPath, 'utf-8');
      const relativePath = relative(repoRoot, fullPath);

      files.push({
        path: fullPath,
        relativePath,
        content,
        extension: ext,
      });
    } catch {
      // Skip unreadable files
    }
  }
}
