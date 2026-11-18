/**
 * Memory selection under the injection budget — upstream
 * `trimMemoriesToBudget` + `utilityTier` (inject-compartments.ts:333-364).
 *
 * Two properties the local picker did not have, and both are about WHICH
 * memories survive a tight budget rather than how many:
 *
 *   1. UTILITY, not importance. Upstream ranks a memory that has actually been
 *      retrieved above one that merely contains constraint language, and both
 *      above the rest. Importance scores are written by a model at authoring
 *      time; retrieval count is evidence from use. A memory the agent keeps
 *      reaching for is worth the budget even if its importance is modest.
 *
 *   2. STOP at the first that does not fit. Upstream `break`s, so the surviving
 *      set is a strict priority PREFIX. Continuing (skipping the big one and
 *      taking a smaller one further down) packs more rows but makes the set
 *      depend on byte-level fit — a one-token edit to one memory reshuffles
 *      which memories the model sees, which is also a cache-stability problem.
 *
 * Pure and total: no clock, no I/O.
 */

/** Upstream `CONSTRAINT_KEYWORDS`. */
const CONSTRAINT_KEYWORDS = /\b(must|never|always|cannot|should not|must not)\b/i

export interface RankableMemory {
  readonly id: number
  readonly content: string
  /** Times this memory was actually retrieved into context. */
  readonly retrievalCount?: number
  readonly permanent?: boolean
  /** Times the memory matched a recall query. */
  readonly seenCount?: number
}

/** Lower is better: retrieved > constraint wording > everything else. */
export function utilityTier(memory: RankableMemory): 0 | 1 | 2 {
  if ((memory.retrievalCount ?? 0) > 0) return 0
  if (CONSTRAINT_KEYWORDS.test(memory.content)) return 1
  return 2
}

/**
 * Upstream's priority order, as a comparator:
 *   1. permanent first
 *   2. utility tier
 *   3. seen count, descending
 *   4. shorter content first (more memories fit)
 *   5. id, for a stable order
 */
export function compareMemoryPriority(left: RankableMemory, right: RankableMemory): number {
  const permanentDiff = Number(right.permanent === true) - Number(left.permanent === true)
  if (permanentDiff !== 0) return permanentDiff
  const tierDiff = utilityTier(left) - utilityTier(right)
  if (tierDiff !== 0) return tierDiff
  const seenDiff = (right.seenCount ?? 0) - (left.seenCount ?? 0)
  if (seenDiff !== 0) return seenDiff
  const lengthDiff = left.content.length - right.content.length
  if (lengthDiff !== 0) return lengthDiff
  return left.id - right.id
}

/**
 * Take the longest priority PREFIX that fits `budgetTokens`.
 *
 * `costOf` is the caller's byte/token estimate for one memory, kept as a
 * parameter so this module never guesses how a row is rendered.
 */
export function trimToBudget<T extends RankableMemory>(
  memories: readonly T[],
  budgetTokens: number,
  costOf: (memory: T) => number,
  limit?: number,
): T[] {
  const sorted = [...memories].sort(compareMemoryPriority)
  const selected: T[] = []
  let used = 0
  for (const memory of sorted) {
    if (limit !== undefined && selected.length >= limit) break
    const cost = costOf(memory)
    // STOP, do not skip: the surviving set must be a priority prefix, so that a
    // small edit to one row cannot change WHICH rows the model sees.
    if (used + cost > budgetTokens) break
    used += cost
    selected.push(memory)
  }
  return selected
}
