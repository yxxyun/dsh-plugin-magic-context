/**
 * Vector arithmetic shared by every lane that scores embeddings.
 *
 * This lived in `chunk-store.ts` — a module that also carried the
 * `memory_chunks` table (an adapter-only invention with no reader). Cosine
 * similarity has nothing to do with chunking, and keeping it there meant that
 * deleting the dead chain would have taken eight live call sites with it.
 *
 * Pure and total.
 */

/**
 * Cosine similarity in [0, 1].
 *
 * A zero-magnitude vector scores 0 rather than NaN: an empty or all-zero
 * embedding carries no information, and propagating NaN through a ranking turns
 * "unscored" into "compared favorably".
 *
 * Lengths that differ are compared over the shorter prefix — the callers read
 * vectors from one model space, so a mismatch means a corrupt row, not a
 * meaningful comparison.
 */
export function cosineScore(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < length; index += 1) {
    const x = a[index] as number
    const y = b[index] as number
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return Math.min(1, Math.max(0, dot / Math.sqrt(normA * normB)))
}
