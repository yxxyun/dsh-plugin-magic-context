/**
 * Chunking for memory embeddings.
 *
 * ## Why
 *
 * A memory row is embedded as ONE vector. A 3,000-character fact covering five
 * unrelated things therefore becomes the average of those five, and a query that
 * matches one section clearly can still lose to a shorter memory whose whole
 * content is on-topic. Measured on this install: 70.7% of memories are ≤200
 * characters and are already at the right granularity, but 8% exceed one chunk —
 * and those are exactly the rows a query is most likely to need.
 *
 * ## Cost
 *
 * Splitting at 400 characters with 80 of overlap takes the corpus from 880 vectors
 * to 1,011 (1.15×). That is cheap enough to do for every memory rather than only
 * for long ones, which keeps one code path instead of two.
 *
 * ## Boundaries
 *
 * A chunk boundary in the middle of a word or a sentence hurts retrieval, because
 * the fragment on either side is on-topic but neither reads as a complete claim.
 * So the splitter prefers, in order: a paragraph break, a line break, a sentence
 * terminator (both ASCII and CJK punctuation), a space, and only then a hard cut.
 * The search window for a boundary is the last `OVERLAP` characters of the chunk,
 * so a boundary is never far enough back to waste the budget.
 */

/** Target chunk size in characters. */
export const CHUNK_CHARS = 400
/** Characters of the previous chunk repeated at the start of the next. */
export const CHUNK_OVERLAP_CHARS = 80

/**
 * Boundary candidates, strongest first. A match closer to the end of the window
 * wins within the same strength class.
 */
const BOUNDARIES: ReadonlyArray<readonly [string, string]> = [
  ['paragraph', '\n\n'],
  ['line', '\n'],
  // ASCII terminators, then the CJK fullwidth forms — both appear in this corpus.
  ['sentence', '. '],
  ['sentence', '! '],
  ['sentence', '? '],
  ['sentence', '。'],
  ['sentence', '！'],
  ['sentence', '？'],
  ['sentence', '；'],
  ['space', ' '],
]

/** One chunk of a memory's text. */
export interface MemoryChunk {
  /** 0-based position within the memory. */
  readonly index: number
  /** The chunk text, already trimmed. */
  readonly text: string
  /** Character offset of the chunk's first character in the source. */
  readonly start: number
}

/**
 * Split one memory's text into chunks.
 *
 * A short memory yields exactly one chunk equal to its (trimmed) text, so callers
 * never need a "chunked or not" branch: `chunks.length === 1` is the whole-row case
 * and the vector it produces is what was stored before.
 *
 * @param text - the memory's content.
 * @param chunkChars - target size; defaults to {@link CHUNK_CHARS}.
 * @param overlapChars - repeated characters between neighbours.
 * @returns at least one chunk; empty text yields one empty chunk.
 */
export function chunkMemoryText(
  text: string,
  chunkChars: number = CHUNK_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
): readonly MemoryChunk[] {
  const source = text.trim()
  if (source.length === 0) return [{ index: 0, text: '', start: 0 }]
  if (source.length <= chunkChars) return [{ index: 0, text: source, start: 0 }]

  const size = Math.max(1, chunkChars)
  // An overlap at or above the chunk size would never advance the cursor.
  const overlap = Math.max(0, Math.min(overlapChars, size - 1))

  const chunks: MemoryChunk[] = []
  let cursor = 0
  while (cursor < source.length) {
    const hardEnd = Math.min(cursor + size, source.length)
    let end = hardEnd
    if (hardEnd < source.length) {
      // Search for a boundary in the SAME window the step-back will use, so a
      // boundary the splitter picks is always one the next chunk can honour.
      //
      // The earlier version searched only the last `overlap` characters. A
      // paragraph break 200 characters in, with a 400-character target and an
      // 80-character overlap, sat outside that window and the chunk was cut
      // mid-word instead — measured on `200 a's + \n\n + 400 b's`, which produced
      // a first chunk ending in `bbbb…` rather than at the paragraph break.
      const windowStart = Math.max(cursor + 1, hardEnd - Math.max(overlap, Math.floor(size / 2)))
      end = findBoundary(source, windowStart, hardEnd) ?? hardEnd
    }
    const piece = source.slice(cursor, end).trim()
    if (piece.length > 0) chunks.push({ index: chunks.length, text: piece, start: cursor })
    if (end >= source.length) break
    // Step back so a claim split across the boundary is readable from either side.
    //
    // The step-back must land on a WORD start, not merely `overlap` characters
    // back: a raw backstep of 80 put the next chunk at `ere. sentenc…`, i.e. the
    // tail of a word the previous chunk had already emitted — measurable as a
    // duplicated fragment in the concatenation. Snapping forward to the next
    // space costs a few characters of overlap and removes the fragment.
    const wanted = Math.max(cursor + 1, end - overlap)
    const snapped = snapForwardToWordStart(source, wanted, end)
    // Never rewind past `cursor + 1`: that would not make progress.
    cursor = Math.max(cursor + 1, Math.min(snapped, Math.max(cursor + 1, end - 1)))
  }
  if (chunks.length === 0) return [{ index: 0, text: source, start: 0 }]
  return chunks
}

/**
 * Move a cursor forward to the next safe chunk start at or after `wanted`.
 *
 * The overlap exists so a reader of either chunk sees a complete claim, which it
 * does not if the chunk opens mid-token (`textBySeq` after a chunk ending
 * `...someT`). Three accept positions, in order of preference:
 *
 *  - a whitespace character (the common case for English prose);
 *  - a CJK clause terminator (Chinese has no spaces, so this is its seam);
 *  - an ASCII sentence terminator followed by a space.
 *
 * If the window `[wanted, limit)` contains none of those, the search CONTINUES past
 * `limit` instead of giving up. Giving up is what produced 118 mid-token openings
 * on the real corpus: a dense run of CJK or of code has no spaces for hundreds of
 * characters, so returning `wanted` cut a token in half. Overshooting the previous
 * chunk's end is harmless — it only means the two chunks do not overlap there —
 * whereas a mid-token start makes the fragment unreadable on its own.
 *
 * @param source - the full text.
 * @param wanted - the earliest acceptable offset.
 * @param limit - the previous chunk's end; a useful reference, not a hard ceiling.
 * @returns a chunk start, or `wanted` when the text has no seam at all.
 */
function snapForwardToWordStart(source: string, wanted: number, limit: number): number {
  if (wanted <= 0) return 0
  // Already at a word start: the previous character is whitespace or punctuation.
  const before = source[wanted - 1] as string
  if (/[\s。！？；]/.test(before)) return wanted

  // Pass 1: inside the overlap window.
  const inWindow = scanForSeam(source, wanted, Math.min(limit, source.length))
  if (inWindow !== null) return inWindow

  // Pass 2: past the window. Bounded by a fixed multiple of the chunk size so a
  // pathological block with no separators at all cannot walk the whole document.
  const extendedEnd = Math.min(source.length, limit + Math.max(64, Math.floor(Math.abs(limit - wanted) * 2)))
  const beyond = scanForSeam(source, limit, extendedEnd)
  if (beyond !== null) return beyond

  return wanted
}

/** First acceptable seam in `[from, to)`, or null. */
function scanForSeam(source: string, from: number, to: number): number | null {
  for (let index = Math.max(0, from); index < to; index += 1) {
    const char = source[index] as string
    if (/\s/.test(char)) {
      // Start AT the space: `trim()` on the slice normalises it away, and the next
      // chunk then opens on the word, not on the space.
      return index
    }
    // A CJK clause boundary is also an acceptable seam and needs no space.
    if ('。！？；'.includes(char)) return index + 1
    // An ASCII sentence terminator followed by a space: start after the space so
    // the next chunk opens on a sentence rather than on a number.
    if ('.!?'.includes(char) && /\s/.test(source[index + 1] ?? '')) return index + 2
    // CJK punctuation that ends a phrase also works as a seam.
    if ('，、：'.includes(char)) return index + 1
  }
  return null
}

/**
 * Find the best boundary index in `[from, to)`, or null when none exists.
 *
 * Strength wins over position: a paragraph break early in the window beats a space
 * late in it, because the paragraph break is a real semantic seam and the space is
 * not. Within one strength the LATEST occurrence wins, keeping chunks near the
 * target size.
 */
function findBoundary(source: string, from: number, to: number): number | null {
  for (const [, marker] of BOUNDARIES) {
    const at = source.lastIndexOf(marker, to - 1)
    // `lastIndexOf` searches the whole prefix, so reject anything before the window.
    if (at >= from && at + marker.length <= to) return at + marker.length
  }
  return null
}

/**
 * Roughly how many chunks a text will produce, without building them.
 *
 * An ESTIMATE, not an identity: a boundary found inside the overlap window pulls
 * the split earlier than the arithmetic step, so the real chunker sometimes yields
 * one more chunk (measured: 9 of 880 memories differ, always by exactly one). Use
 * this to size a run before doing embedding work; use {@link chunkMemoryText} when
 * the exact count matters.
 *
 * @param chars - text length.
 * @param chunkChars - target size.
 * @param overlapChars - overlap size.
 */
export function countChunks(
  chars: number,
  chunkChars: number = CHUNK_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
): number {
  if (chars <= 0) return 1
  if (chars <= chunkChars) return 1
  const size = Math.max(1, chunkChars)
  const overlap = Math.max(0, Math.min(overlapChars, size - 1))
  const step = size - overlap
  return Math.ceil((chars - size) / step) + 1
}
