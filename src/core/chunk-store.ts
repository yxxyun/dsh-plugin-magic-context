/**
 * Chunk-vector storage: the read and write side of `memory_chunks`.
 *
 * Design decisions that are not obvious from the SQL:
 *
 * - **Whole-row vectors stay.** `memory_embeddings` continues to hold one vector
 *   per memory. Chunk vectors are additive: a query first ranks rows the way it
 *   always did, then chunk matches can promote a row the whole-row vector missed.
 *   Replacing whole-row vectors would change every ranking at once, including the
 *   short memories where one vector is already correct (70.7% of the corpus).
 *
 * - **A chunk row records its own text.** Storing `chunk_text` duplicates content
 *   that could be re-derived from `memories.content` plus `start_char`. It is
 *   stored anyway because the splitter's boundary search depends on the chunker's
 *   parameters: re-deriving with a different `CHUNK_CHARS` would silently produce
 *   different boundaries than the vector was computed from, and the hit would
 *   point at text the model never saw.
 *
 * - **Write is per (memory, model) and replaces.** A memory's content can change;
 *   its old chunks then describe text that no longer exists. `replaceChunks` writes
 *   the new set in one transaction and deletes any index beyond it, so a memory
 *   that shrank does not leave orphan vectors behind.
 */
import { DatabaseSync } from 'node:sqlite'

/** One stored chunk vector. */
export interface ChunkVectorRow {
  readonly memoryId: number
  readonly chunkIndex: number
  readonly startChar: number
  readonly text: string
  readonly embedding: Float32Array
}

/** A chunk hit, before aggregation into per-memory scores. */
export interface ChunkHit {
  readonly memoryId: number
  readonly chunkIndex: number
  readonly startChar: number
  readonly text: string
  readonly score: number
}

/** Read all chunk vectors for one model, as a map by memory id. */
export function readChunkVectors(
  db: DatabaseSync,
  modelId: string,
  memoryIds?: readonly number[],
): Map<number, ChunkVectorRow[]> {
  const out = new Map<number, ChunkVectorRow[]>()
  const sql = memoryIds === undefined
    ? 'SELECT memory_id, chunk_index, start_char, chunk_text, embedding FROM memory_chunks WHERE model_id = ? ORDER BY memory_id, chunk_index'
    : `SELECT memory_id, chunk_index, start_char, chunk_text, embedding FROM memory_chunks WHERE model_id = ? AND memory_id IN (${memoryIds.map(() => '?').join(', ')}) ORDER BY memory_id, chunk_index`
  const params: Array<string | number> = [modelId, ...memoryIds ?? []]
  const rows = db.prepare(sql).all(...params) as Array<{
    memory_id: number
    chunk_index: number
    start_char: number
    chunk_text: string
    embedding: Uint8Array
  }>
  for (const row of rows) {
    const buffer = row.embedding
    const copy = new Float32Array(buffer.byteLength / 4)
    // Copy rather than alias: the buffer belongs to the statement's result and a
    // caller holding it past the next query would read freed memory.
    new Uint8Array(copy.buffer).set(buffer)
    const list = out.get(row.memory_id) ?? []
    list.push({
      memoryId: row.memory_id,
      chunkIndex: row.chunk_index,
      startChar: row.start_char,
      text: row.chunk_text,
      embedding: copy,
    })
    out.set(row.memory_id, list)
  }
  return out
}

/**
 * Replace every chunk vector of one memory.
 *
 * Runs in one transaction: a reader must never see half of a memory's chunks,
 * because a partial set makes the memory look like it only covers the sections
 * written so far.
 *
 * @param db - the corpus database.
 * @param memoryId - the memory whose chunks are being replaced.
 * @param modelId - the embedding space.
 * @param chunks - the new chunks, in order; an empty list deletes them all.
 */
export function replaceChunks(
  db: DatabaseSync,
  memoryId: number,
  modelId: string,
  chunks: readonly ChunkVectorRow[],
): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM memory_chunks WHERE memory_id = ? AND model_id = ?').run(memoryId, modelId)
    const insert = db.prepare(
      'INSERT INTO memory_chunks(memory_id, chunk_index, model_id, start_char, chunk_text, embedding) '
        + 'VALUES(?, ?, ?, ?, ?, ?)',
    )
    for (const chunk of chunks) {
      insert.run(
        memoryId,
        chunk.chunkIndex,
        modelId,
        chunk.startChar,
        chunk.text,
        Buffer.from(chunk.embedding.buffer, chunk.embedding.byteOffset, chunk.embedding.byteLength),
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Which memories already have chunk vectors in this space. */
export function chunkedMemoryIds(db: DatabaseSync, modelId: string): Set<number> {
  const rows = db.prepare(
    'SELECT DISTINCT memory_id FROM memory_chunks WHERE model_id = ?',
  ).all(modelId) as Array<{ memory_id: number }>
  return new Set(rows.map(row => row.memory_id))
}

/** Cosine similarity, clamped to [0, 1] the way the rest of the lane scores. */
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

/**
 * Rank every memory by its BEST chunk.
 *
 * Best-chunk rather than average-of-chunks, because the question a chunked index
 * answers is "does this memory contain something relevant", not "is this memory on
 * average relevant". Averaging reproduces exactly the dilution chunking removes.
 *
 * @param queryVector - the embedded query.
 * @param byMemory - chunk vectors grouped by memory.
 * @returns memory id → best chunk score, plus the chunk that produced it.
 */
export function rankMemoriesByChunk(
  queryVector: Float32Array,
  byMemory: ReadonlyMap<number, readonly ChunkVectorRow[]>,
): Map<number, ChunkHit> {
  const out = new Map<number, ChunkHit>()
  for (const [memoryId, chunks] of byMemory) {
    let best: ChunkHit | undefined
    for (const chunk of chunks) {
      const score = cosineScore(queryVector, chunk.embedding)
      if (best === undefined || score > best.score) {
        best = {
          memoryId,
          chunkIndex: chunk.chunkIndex,
          startChar: chunk.startChar,
          text: chunk.text,
          score,
        }
      }
    }
    if (best !== undefined) out.set(memoryId, best)
  }
  return out
}
