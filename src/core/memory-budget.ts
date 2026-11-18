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

/**
 * Budget selection with per-source fairness — upstream
 * `trimWorkspaceMemoriesToBudgetV2` (inject-compartments.ts:2063).
 *
 * The plain `trimToBudget` treats every row as one pool. That is wrong as soon as
 * memory comes from more than one source: a project that also reads domain peers
 * can have the peers' rows — or its own — fill the whole budget, so one source
 * silently disappears from the prompt while the other crowds it out.
 *
 * Upstream's order, reproduced here:
 *
 *   1. permanent rows first, in priority order, still bounded by the budget;
 *   2. the REMAINING budget is split evenly per source as a per-source floor, and
 *      each source fills its own floor in priority order;
 *   3. whatever is left is handed out by priority across all sources.
 *
 * Step 2 is a floor, not a cap: a source that does not use its share leaves it in
 * the pot for step 3.
 *
 * Note the deliberate difference from `trimToBudget`: this one SKIPS a row that
 * does not fit and keeps going (`continue`), because a floor pass per source
 * cannot stop at the first oversize row — it would starve every later row of that
 * source. The final pass still cannot exceed the budget.
 */
export function trimToBudgetBySource<T extends RankableMemory>(
  memories: readonly T[],
  budgetTokens: number,
  sourceOf: (memory: T) => string | undefined,
  costOf: (memory: T) => number,
  limit?: number,
): T[] {
  const selected: T[] = []
  const taken = new Set<number>()
  let used = 0
  const admit = (memory: T, cost: number): void => {
    selected.push(memory)
    taken.add(memory.id)
    used += cost
  }
  const fits = (cost: number): boolean => used + cost <= budgetTokens
  const capped = (): boolean => limit !== undefined && selected.length >= limit
  const ordered = [...memories].sort(compareMemoryPriority)

  // 1. permanent
  for (const memory of ordered) {
    if (capped()) break
    if (memory.permanent !== true) continue
    const cost = costOf(memory)
    if (!fits(cost)) continue
    admit(memory, cost)
  }

  // 2. per-source floor
  const sources = new Map<string, T[]>()
  for (const memory of ordered) {
    if (memory.permanent === true || taken.has(memory.id)) continue
    const source = sourceOf(memory)
    if (source === undefined || source === '') continue
    const list = sources.get(source)
    if (list === undefined) sources.set(source, [memory])
    else list.push(memory)
  }
  const floorTokens = Math.max(0, budgetTokens - used) / Math.max(1, sources.size)
  for (const rows of sources.values()) {
    let memberTokens = 0
    for (const memory of rows) {
      if (capped()) break
      if (taken.has(memory.id)) continue
      const cost = costOf(memory)
      if (memberTokens + cost > floorTokens) continue
      if (!fits(cost)) continue
      admit(memory, cost)
      memberTokens += cost
    }
  }

  // 3. everything left, by priority
  for (const memory of ordered) {
    if (capped()) break
    if (taken.has(memory.id)) continue
    const cost = costOf(memory)
    if (!fits(cost)) continue
    admit(memory, cost)
  }

  return selected
}
