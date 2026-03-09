import { EMBEDDING_MODEL } from './types.js';

let pipeline: any = null;
let extractor: any = null;

async function getExtractor() {
  if (extractor) return extractor;

  // Dynamic import to avoid top-level loading
  const { pipeline: createPipeline } = await import('@xenova/transformers');
  pipeline = createPipeline;
  extractor = await createPipeline('feature-extraction', EMBEDDING_MODEL, {
    quantized: true,
  });
  return extractor;
}

export async function embed(text: string): Promise<Float32Array> {
  const ext = await getExtractor();
  const output = await ext(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const ext = await getExtractor();
  const results: Float32Array[] = [];

  // Process in batches of 32 for memory efficiency
  const batchSize = 32;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    for (const text of batch) {
      const output = await ext(text, { pooling: 'mean', normalize: true });
      results.push(new Float32Array(output.data));
    }
  }

  return results;
}

export function isModelLoaded(): boolean {
  return extractor !== null;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
