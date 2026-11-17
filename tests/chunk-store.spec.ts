/**
 * Chunk-vector storage and ranking.
 *
 * The properties that matter, each a silent-wrong-answer if broken:
 *
 *  - `replaceChunks` is atomic and REPLACES: a memory that shrank must not leave
 *    orphan vectors, or a query matches text that no longer exists.
 *  - ranking is by BEST chunk, not the average. Averaging reproduces exactly the
 *    dilution that chunking exists to remove.
 *  - a stored embedding round-trips byte-for-byte. A `Float32Array` view into a
 *    statement buffer is freed by the next query, so the reader must copy.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chunkedMemoryIds,
  cosineScore,
  rankMemoriesByChunk,
  readChunkVectors,
  replaceChunks,
  type ChunkVectorRow,
} from '../src/core/chunk-store.ts'

let dir: string
let db: DatabaseSync

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-chunks-'))
  db = new DatabaseSync(join(dir, 'corpus.db'))
  db.exec(`
    CREATE TABLE memories(id INTEGER PRIMARY KEY, content TEXT NOT NULL);
    CREATE TABLE memory_chunks(
      memory_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      start_char INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      PRIMARY KEY(memory_id, chunk_index, model_id)
    );
  `)
  for (const id of [1, 2, 3]) {
    db.prepare('INSERT INTO memories(id, content) VALUES(?, ?)').run(id, `memory ${String(id)}`)
  }
})

afterEach(() => {
  try { db.close() } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true })
})

function chunk(memoryId: number, index: number, vector: number[], text = `chunk ${String(index)}`): ChunkVectorRow {
  return {
    memoryId,
    chunkIndex: index,
    startChar: index * 400,
    text,
    embedding: Float32Array.from(vector),
  }
}

const MODEL = 'test-model'

describe('replaceChunks', () => {
  it('stores and reads back the same vectors', () => {
    replaceChunks(db, 1, MODEL, [chunk(1, 0, [1, 0, 0]), chunk(1, 1, [0, 1, 0])])
    const read = readChunkVectors(db, MODEL, [1]).get(1)
    expect(read).toHaveLength(2)
    expect(Array.from(read![0]!.embedding)).toEqual([1, 0, 0])
    expect(Array.from(read![1]!.embedding)).toEqual([0, 1, 0])
    // Metadata survives too, so a hit can point back at the source text.
    expect(read![1]!.startChar).toBe(400)
    expect(read![1]!.text).toBe('chunk 1')
  })

  it('replaces rather than appends, so a shrunk memory leaves no orphans', () => {
    replaceChunks(db, 1, MODEL, [chunk(1, 0, [1, 0]), chunk(1, 1, [0, 1]), chunk(1, 2, [1, 1])])
    expect(readChunkVectors(db, MODEL, [1]).get(1)).toHaveLength(3)
    // The memory shrank to one chunk.
    replaceChunks(db, 1, MODEL, [chunk(1, 0, [1, 0])])
    expect(readChunkVectors(db, MODEL, [1]).get(1)).toHaveLength(1)
  })

  it('clears every chunk when given an empty list', () => {
    replaceChunks(db, 1, MODEL, [chunk(1, 0, [1, 0])])
    replaceChunks(db, 1, MODEL, [])
    expect(readChunkVectors(db, MODEL, [1]).get(1)).toBeUndefined()
  })

  it('keeps spaces separate', () => {
    replaceChunks(db, 1, MODEL, [chunk(1, 0, [1, 0])])
    replaceChunks(db, 1, 'other-model', [chunk(1, 0, [0, 1]), chunk(1, 1, [0, 0, 1])])
    expect(readChunkVectors(db, MODEL, [1]).get(1)).toHaveLength(1)
    expect(readChunkVectors(db, 'other-model', [1]).get(1)).toHaveLength(2)
  })

  it('atomics: a failure leaves the previous set intact', () => {
    replaceChunks(db, 1, MODEL, [chunk(1, 0, [1, 0])])
    // A chunk with a non-numeric embedding length cannot be built, so simulate a
    // failure by making the insert itself invalid.
    const broken = { ...chunk(1, 5, [1, 0]), text: null as unknown as string }
    expect(() => replaceChunks(db, 1, MODEL, [broken])).toThrow()
    // The old row must still be there: a half-written set would make the memory
    // look like it only covers the sections written so far.
    const read = readChunkVectors(db, MODEL, [1]).get(1)
    expect(read).toHaveLength(1)
    expect(read![0]!.chunkIndex).toBe(0)
  })
})

describe('chunkedMemoryIds', () => {
  it('reports only the memories with chunks in this space', () => {
    replaceChunks(db, 1, MODEL, [chunk(1, 0, [1, 0])])
    replaceChunks(db, 2, MODEL, [chunk(2, 0, [0, 1])])
    expect(chunkedMemoryIds(db, MODEL)).toEqual(new Set([1, 2]))
    expect(chunkedMemoryIds(db, 'unused')).toEqual(new Set())
  })
})

describe('cosineScore', () => {
  it('is 1 for identical directions and 0 for orthogonal ones', () => {
    expect(cosineScore(Float32Array.from([1, 0]), Float32Array.from([2, 0]))).toBeCloseTo(1, 5)
    expect(cosineScore(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 5)
  })

  it('is 0 rather than NaN for a zero vector', () => {
    expect(cosineScore(Float32Array.from([0, 0]), Float32Array.from([1, 0]))).toBe(0)
  })

  it('clamps a negative similarity to 0', () => {
    // The lane's contract is [0, 1]; a negative score would sort below "no match"
    // and later clamp it anyway, so clamp once here.
    expect(cosineScore(Float32Array.from([1, 0]), Float32Array.from([-1, 0]))).toBe(0)
  })

  it('tolerates a dimension mismatch by using the shorter length', () => {
    expect(() => cosineScore(Float32Array.from([1, 0, 0]), Float32Array.from([1, 0]))).not.toThrow()
  })
})

describe('rankMemoriesByChunk', () => {
  it('scores each memory by its BEST chunk, not the average', () => {
    // Memory 1 has one strong chunk and two irrelevant ones. Its average would be
    // weak; its best is strong, and the best is what answers "does this memory
    // contain something relevant".
    const byMemory = new Map([
      [1, [
        { memoryId: 1, chunkIndex: 0, startChar: 0, text: 'a', embedding: Float32Array.from([1, 0]) },
        { memoryId: 1, chunkIndex: 1, startChar: 400, text: 'b', embedding: Float32Array.from([0, 1]) },
        { memoryId: 1, chunkIndex: 2, startChar: 800, text: 'c', embedding: Float32Array.from([0, 1]) },
      ]],
      [2, [
        { memoryId: 2, chunkIndex: 0, startChar: 0, text: 'd', embedding: Float32Array.from([0.7, 0.7]) },
      ]],
    ])
    const ranked = rankMemoriesByChunk(Float32Array.from([1, 0]), byMemory)
    expect(ranked.get(1)!.score).toBeCloseTo(1, 5)
    expect(ranked.get(1)!.chunkIndex).toBe(0)
    expect(ranked.get(2)!.score).toBeLessThan(ranked.get(1)!.score)
  })

  it('reports the chunk that produced the score, so a hit can be expanded', () => {
    const byMemory = new Map([
      [1, [
        { memoryId: 1, chunkIndex: 0, startChar: 0, text: 'first section', embedding: Float32Array.from([0, 1]) },
        { memoryId: 1, chunkIndex: 1, startChar: 417, text: 'the relevant section', embedding: Float32Array.from([1, 0]) },
      ]],
    ])
    const hit = rankMemoriesByChunk(Float32Array.from([1, 0]), byMemory).get(1)!
    expect(hit.chunkIndex).toBe(1)
    expect(hit.startChar).toBe(417)
    expect(hit.text).toBe('the relevant section')
  })

  it('returns an empty map for no input', () => {
    expect(rankMemoriesByChunk(Float32Array.from([1, 0]), new Map())).toEqual(new Map())
  })
})
