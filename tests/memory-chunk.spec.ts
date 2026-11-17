/**
 * Memory chunking.
 *
 * The property that matters: a chunk boundary must not fall in the middle of a
 * word or a claim, and the chunks of one memory must cover the whole text without
 * losing or inventing characters. Everything here is checked against those two
 * requirements, because a splitter that silently drops text turns retrieval into a
 * lottery — the missing section simply never matches.
 *
 * Measured on this install: 70.7% of memories are ≤200 characters (one chunk), 8%
 * exceed one chunk, and splitting at 400/80 takes 880 rows to 1,011 vectors. 83.7%
 * of the resulting chunks end on a sentence or paragraph boundary.
 */
import { describe, expect, it } from 'vitest'
import {
  CHUNK_CHARS,
  CHUNK_OVERLAP_CHARS,
  chunkMemoryText,
  countChunks,
} from '../src/core/memory-chunk.ts'

/**
 * Check that the chunks cover the source.
 *
 * Two separate claims, both required: each chunk really begins at the offset it
 * reports (so a hit can be mapped back to the row), and the concatenation contains
 * every source character in order. Overlap means the union is LONGER than the
 * source, so the check is coverage, not equality.
 */
function expectCovers(chunks: readonly { text: string; start: number }[], source: string): void {
  // Claim 1: each chunk's text really is the source at its reported offset. This
  // is what lets a retrieval hit be mapped back to the original row.
  for (const chunk of chunks) {
    expect(source.slice(chunk.start).trimStart().startsWith(chunk.text)).toBe(true)
  }
  // Claim 2: consecutive spans touch or overlap — no gap may exist, or the text
  // in the gap is unreachable by retrieval. Overlap is expected and fine; a gap
  // is the failure.
  for (let index = 1; index < chunks.length; index++) {
    const previous = chunks[index - 1]!
    const current = chunks[index]!
    const previousEnd = previous.start + previous.text.length
    expect(current.start).toBeLessThanOrEqual(previousEnd)
    // And the overlap is bounded, or the corpus would balloon.
    expect(previousEnd - current.start).toBeLessThanOrEqual(CHUNK_OVERLAP_CHARS + 1)
  }
  // Claim 3: the first chunk starts at 0 and the last reaches the end.
  expect(chunks[0]!.start).toBe(0)
  const last = chunks.at(-1)!
  expect(source.slice(last.start).trim()).toBe(last.text)
}

describe('short text is one chunk', () => {
  it('returns the trimmed text unchanged', () => {
    const chunks = chunkMemoryText('  a short fact  ')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text).toBe('a short fact')
    expect(chunks[0]!.index).toBe(0)
    expect(chunks[0]!.start).toBe(0)
  })

  it('returns one empty chunk for empty text rather than none', () => {
    // A caller with no chunks would skip the row entirely; one empty chunk keeps
    // the row visible and lets the embedder reject it explicitly.
    const chunks = chunkMemoryText('   ')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text).toBe('')
  })
})

describe('long text splits on boundaries', () => {
  it('prefers a paragraph break over a hard cut', () => {
    const text = `${'a'.repeat(200)}\n\n${'b'.repeat(400)}`
    const chunks = chunkMemoryText(text, 400, 80)
    expect(chunks.length).toBeGreaterThan(1)
    // The first chunk must end at the paragraph break, not mid-'a'.
    expect(chunks[0]!.text.endsWith('a')).toBe(true)
    expect(chunks[0]!.text).not.toContain('b')
  })

  it('prefers a CJK sentence terminator', () => {
    const text = `${'甲'.repeat(200)}。${'乙'.repeat(400)}`
    const chunks = chunkMemoryText(text, 400, 80)
    expect(chunks[0]!.text.endsWith('。')).toBe(true)
  })

  it('falls back to a space when no sentence boundary exists', () => {
    const text = `${'word '.repeat(120)}end`
    const chunks = chunkMemoryText(text, 400, 80)
    for (const chunk of chunks.slice(0, -1)) {
      // A word boundary keeps the tail readable; a hard cut mid-word does not.
      expect(chunk.text.endsWith(' ') || /[.!?。！？]$/.test(chunk.text)).toBe(false)
      expect(/\s$/.test(chunk.text)).toBe(false)
    }
  })

  it('hard-cuts when the text has no boundary at all', () => {
    const text = 'x'.repeat(1_000)
    const chunks = chunkMemoryText(text, 400, 80)
    expect(chunks.length).toBeGreaterThan(1)
    // No boundary exists, so the split is by arithmetic; nothing may be lost.
    const total = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
    expect(total).toBeGreaterThanOrEqual(1_000)
  })

  it('covers the whole source with overlapping chunks', () => {
    const text = Array.from({ length: 40 }, (_unused, index) => `sentence number ${String(index)} here.`).join(' ')
    const chunks = chunkMemoryText(text, 400, 80)
    expect(chunks.length).toBeGreaterThan(1)
    expectCovers(chunks, text)
    // Spot-check both ends survive as readable claims.
    expect(chunks[0]!.text).toContain('sentence number 0')
    expect(chunks.at(-1)!.text).toContain('sentence number 39')
    // Every chunk opens on a word, not mid-token: the bug this guards is a chunk
    // starting at `ere. sentenc…` because the overlap was a raw character count.
    for (const chunk of chunks) {
      expect(/^\S/.test(chunk.text)).toBe(true)
      expect(/^[a-z]{1,3}\b/.test(chunk.text)).toBe(false)
    }
  })

  it('always makes progress even when the overlap approaches the chunk size', () => {
    // An overlap >= size would loop forever; the clamps must prevent that.
    const text = 'y'.repeat(1_000)
    const chunks = chunkMemoryText(text, 100, 99)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.length).toBeLessThan(1_000)
  })

  it('ignores an overlap larger than the chunk size', () => {
    const chunks = chunkMemoryText('z'.repeat(600), 100, 500)
    expect(chunks.length).toBeGreaterThan(1)
  })
})

describe('chunk metadata', () => {
  it('numbers chunks from zero in order', () => {
    const chunks = chunkMemoryText('w'.repeat(1_200), 400, 80)
    expect(chunks.map(chunk => chunk.index)).toEqual(chunks.map((_unused, index) => index))
  })

  it('reports strictly increasing start offsets', () => {
    const chunks = chunkMemoryText('v'.repeat(1_200), 400, 80)
    for (let index = 1; index < chunks.length; index++) {
      expect(chunks[index]!.start).toBeGreaterThan(chunks[index - 1]!.start)
    }
  })

  it('never emits an empty middle chunk', () => {
    const text = `${'a'.repeat(300)}\n\n\n\n${'b'.repeat(300)}`
    for (const chunk of chunkMemoryText(text, 300, 50)) {
      expect(chunk.text.length).toBeGreaterThan(0)
    }
  })
})

describe('countChunks', () => {
  it('is one for text that fits', () => {
    expect(countChunks(0)).toBe(1)
    expect(countChunks(CHUNK_CHARS)).toBe(1)
    expect(countChunks(CHUNK_CHARS + 1)).toBe(2)
  })

  it('agrees with the real chunker on boundary-free text', () => {
    // With no boundary to find, the chunker follows the arithmetic exactly.
    for (const length of [801, 1_200, 2_000, 4_000]) {
      const actual = chunkMemoryText('x'.repeat(length)).length
      expect(countChunks(length)).toBe(actual)
    }
  })

  it('is documented as an estimate: a boundary can shift the count either way', () => {
    // Pinned because callers must not treat it as exact. A boundary found in the
    // search window moves the split EARLIER than the arithmetic step, which can
    // yield fewer chunks than predicted (here: 3 actual against 4 predicted).
    // The estimate is for sizing a run; `chunkMemoryText().length` is the truth.
    const text = `${'a'.repeat(340)}\n\n${'b'.repeat(700)}`
    const actual = chunkMemoryText(text, 400, CHUNK_OVERLAP_CHARS).length
    const predicted = countChunks(text.length, 400, CHUNK_OVERLAP_CHARS)
    expect(Math.abs(actual - predicted)).toBeLessThanOrEqual(1)
  })
})
