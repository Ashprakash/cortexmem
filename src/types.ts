export type ContextType =
  | 'decision'
  | 'constraint'
  | 'state'
  | 'discovery'
  | 'preference';

export type ChunkSource =
  | 'git_commit'
  | 'source_file'
  | 'project_file'
  | 'user_context';

export interface Chunk {
  id: number;
  content: string;
  source: ChunkSource;
  sourceRef: string;
  contextType: ContextType | 'code' | 'commit' | 'doc';
  embedding: Float32Array | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  sessionId: string | null;
}

export interface SearchResult {
  chunk: Chunk;
  score: number;
}

export interface InitConfig {
  repoPath: string;
  branch: string;
  lastCommitHash: string | null;
  lastInitAt: string;
  modelId: string;
  embeddingDims: number;
}

export const CONTEXT_TYPES: ContextType[] = [
  'decision',
  'constraint',
  'state',
  'discovery',
  'preference',
];

export const CONTEXT_TYPE_LABELS: Record<string, string> = {
  constraint: 'Constraints',
  decision: 'Decisions',
  state: 'Current State',
  discovery: 'Discoveries',
  preference: 'Preferences',
  code: 'Code Context',
  commit: 'Git History',
  doc: 'Documentation',
};

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMS = 384;
