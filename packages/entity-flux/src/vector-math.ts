/**
 * Vector math — the one embedding-space helper everything shares.
 *
 * Deliberately layer-neutral (no imports): organs, the promotion filter,
 * familiarity, and the tier stores all embed text into the same space and
 * need cosine similarity. This module exists so a Sensory Organ never
 * imports Subconscious machinery to do arithmetic — the org is
 * self-contained down to its math.
 */

/** Cosine similarity for L2-normalized embeddings (dot product). The shared
 * embedder (`all-MiniLM-L6-v2`) returns normalized vectors, so this is
 * correct and cheap. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}
