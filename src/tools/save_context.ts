import { nanoid } from 'nanoid';
import { insertChunk } from '../db.js';
import { embed } from '../embeddings.js';
import { detectRepoRoot, detectBranch } from '../git.js';
import { CONTEXT_TYPES, type ContextType } from '../types.js';

let currentSessionId: string | null = null;

export function getSessionId(): string {
  if (!currentSessionId) {
    currentSessionId = nanoid(10);
  }
  return currentSessionId;
}

interface SaveContextArgs {
  context_type: ContextType;
  content: string;
  related_files?: string[];
  confidence?: 'high' | 'medium' | 'low';
}

export async function saveContext(args: SaveContextArgs): Promise<string> {
  // Runtime validation
  if (!CONTEXT_TYPES.includes(args.context_type)) {
    return `Error: invalid context_type "${args.context_type}". Must be one of: ${CONTEXT_TYPES.join(', ')}`;
  }

  const repoRoot = await detectRepoRoot();
  if (!repoRoot) {
    return 'Error: cortexmem requires a git repository. Run from inside a git project.';
  }

  const sessionId = getSessionId();
  const branchName = await detectBranch(repoRoot);
  const embedding = await embed(args.content);

  const metadata: Record<string, unknown> = {
    confidence: args.confidence || 'high',
    branch: branchName,
  };
  if (args.related_files) {
    metadata.relatedFiles = args.related_files;
  }

  const id = insertChunk(
    repoRoot,
    args.content,
    'user_context',
    args.related_files?.join(', ') || '',
    args.context_type,
    embedding,
    metadata,
    sessionId,
  );

  // No skeleton creation here — hierarchy nodes are created at compaction time
  // This avoids polluting the pyramid with "awaiting compaction" placeholders

  return `Saved ${args.context_type} context (id: ${id}, session: ${sessionId}, branch: ${branchName})`;
}
