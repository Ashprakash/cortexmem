import { nanoid } from 'nanoid';
import { embed } from '../embeddings.js';
import { insertChunk } from '../db.js';
import { detectRepoRoot } from '../git.js';
import type { ContextType } from '../types.js';

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
  const repoRoot = await detectRepoRoot();
  if (!repoRoot) {
    return 'Error: engram requires a git repository. Run from inside a git project.';
  }

  const sessionId = getSessionId();
  const embedding = await embed(args.content);

  const metadata: Record<string, unknown> = {
    confidence: args.confidence || 'high',
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

  return `Saved ${args.context_type} context (id: ${id})`;
}
