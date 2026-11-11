/**
 * Compartments — Magic Context's historian output, in adapter-neutral terms.
 *
 * A compartment is an LLM-written digest of a contiguous span of the
 * conversation, stored with four detail tiers so the adapter can degrade it
 * gracefully as it ages (Magic Context's p1–p4 ladder) instead of losing it
 * to a single fixed summary. The tiers are produced in one call: the
 * historian is asked for all four at once.
 *
 * This module owns the historian's OUTPUT CONTRACT and its rendering. It has
 * no DSH and no SQLite dependency, so the whole thing is unit-testable.
 */
import type { MemoryFact } from './memory-categories.ts'
import { errText } from './types.ts'

/** One compartment's four detail tiers, most detailed (p1) to most compressed (p4). */
export interface CompartmentTiers {
  readonly p1: string
  readonly p2: string
  readonly p3: string
  readonly p4: string
}

/** The validated historian output, before it is stored. */
export interface CompartmentDraft {
  readonly tiers: CompartmentTiers
  readonly importance: number
  /** Categorized facts — the only shape Magic Context can promote. */
  readonly facts: readonly MemoryFact[]
  readonly events: readonly string[]
  /**
   * WP5: statements about the USER that would still hold in another project
   * ("always answer in Chinese", "never push without asking"). They travel
   * outside `facts` because facts are project-scoped and these are not.
   *
   * Optional on purpose: a compartment row stored before WP5 has none, and the
   * historian writes them to the candidate pool immediately after the digest
   * lands, so nothing has to re-read them out of the row later.
   */
  readonly userObservations?: readonly string[]
}

/** A stored compartment row. */
export interface Compartment extends CompartmentDraft {
  readonly sessionId: string
  readonly compartmentId: number
  readonly createdAt: number
  /** First and last covered surface seqs (inclusive). */
  readonly coveredStartSeq: number
  readonly coveredEndSeq: number
  /** Every covered surface node seq, in surface order. */
  readonly coveredSeqs: readonly number[]
  /** Token estimate of the covered span at summarization time. */
  readonly coveredTokens: number
  /** The `baseline_epoch` in force when the compartment was created. */
  readonly baselineEpoch: number
  /** The placeholder event that landed for it, once the publish lane ran. */
  readonly landedEventSeq?: number
  /**
   * Terminal non-publish outcome (adapter schema v7): `not-shrinkable` (the
   * publish guard proved the digest does not pay for its baseline render) or
   * `superseded-entrants` (substantive nodes entered the positional range
   * after drafting — the row is retired and its span re-claimed for a fresh
   * digest). A row with a landed reason is never published and never retried;
   * `listUnlandedCompartments` excludes it.
   *
   * NOTE (2026-10-16): the guard that produced the first two reasons is
   * RETIRED, so no producer writes them any more. The column, the reasons and
   * the store API stay for schema-v7 compatibility, historical rows, and the
   * replace-failed path (`compartment-published` level=error) that still
   * retires a poisoned draft.
   */
  readonly landedReason?: string
}

export type CompartmentTier = 'p1' | 'p2' | 'p3' | 'p4'

/** The `[compacted §C<n>§]` placeholder (Magic Context's dropped-then-compacted marker). */
export function compactedPlaceholder(compartmentId: number): string {
  return `[compacted §C${compartmentId}§]`
}

/** Rough token estimate used for triggering and budgets (chars/4, min 1). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

/**
 * Pick the detail tier for one compartment from its importance and its
 * POSITIONAL age (0 = newest), never its wall-clock age.
 *
 * Upstream: `crates/mc-core/src/decay.rs:61-62` — "the half-life-scaled age
 * `z = a / H` … `a` is the 0-based age", i.e. the index in the chronological
 * list — and `decay.rs:109 rendered_tier(compartment_index, importance,
 * budget_pressure, anchor_overlap)`. Time never enters the render, which is
 * what makes `same inputs → same bytes` true (`m0_compose.rs:1-9`).
 *
 * Adapter-side approximation of the decay curve (documented divergence): the
 * same four bands, measured in compartments rather than minutes — the newest
 * three keep full fidelity, then 3–7, 8–19, and everything older collapses to
 * the p4 skeleton. Importance still nudges one step.
 */
export function selectTier(importance: number, positionalAge: number): CompartmentTier {
  const bands: readonly CompartmentTier[] = ['p1', 'p2', 'p3', 'p4']
  const age = Math.max(0, Math.floor(positionalAge))
  let index = age < 3 ? 0 : age < 8 ? 1 : age < 20 ? 2 : 3
  if (importance >= 80) index -= 1
  else if (importance <= 20) index += 1
  return bands[Math.min(bands.length - 1, Math.max(0, index))] as CompartmentTier
}

/** The text of one compartment at its natural tier. */
export function tierText(compartment: Compartment, positionalAge: number): { tier: CompartmentTier; text: string } {
  const tier = selectTier(compartment.importance, positionalAge)
  return { tier, text: compartment.tiers[tier] }
}

/**
 * The header line identifying a compartment in a rendered baseline.
 *
 * Carries NO relative time and NO tier. Both were cache bugs:
 *
 * - A `12m ago` suffix re-renders a different byte every minute, so the
 *   `block === block` guard in `refreshBaseline` never matched and every
 *   execute pass rewrote the cached prefix (measured 2026-11-10: 35 soft
 *   refreshes against 10 published compartments, `cacheRead 32,768` on a
 *   303k-token prompt).
 * - A `[p2, importance 84]` tier tag re-renders whenever the compartment's
 *   POSITIONAL age crosses a band boundary (3/8/20), which happens every time
 *   a new compartment lands in m[1]. That kept the same guard from matching on
 *   the common path: measured 2026-11-11, soft refreshes carried a p10 cache
 *   fidelity of 24.0% — worse than a HARD fold — and 12.8M tokens of re-billed
 *   input, 3× the HARD cost.
 *
 * Upstream keeps the heading tier-free for exactly this reason
 * (`decay-render.ts:63` `compartmentHeading`: `## start-end · title`); the
 * tier only ever picks WHICH BODY renders. Chronology is the recency signal:
 * `renderBaseline` orders m[0] oldest-first and m[1] newest-first, so position
 * is already legible without spelling out the tier.
 */
export function compartmentHeader(compartment: Compartment): string {
  return `§C${compartment.compartmentId}§`
}

/**
 * Render one compartment as a baseline block: header, digest, and the
 * extracted facts/events. `mostCompressedTier` bounds fidelity downward (the
 * budget path forces p4 on a compartment whose natural tier is more detailed).
 */
export function renderCompartment(
  compartment: Compartment,
  positionalAge: number,
  mostCompressedTier?: CompartmentTier,
): string {
  const natural = tierText(compartment, positionalAge)
  const order: readonly CompartmentTier[] = ['p1', 'p2', 'p3', 'p4']
  const forced = mostCompressedTier !== undefined
    && order.indexOf(mostCompressedTier) > order.indexOf(natural.tier)
  const tier = forced ? (mostCompressedTier as CompartmentTier) : natural.tier
  const lines = [`${compartmentHeader(compartment)}`, compartment.tiers[tier]]
  if (compartment.facts.length > 0) {
    lines.push(`facts: ${compartment.facts.map(fact =>
      fact.category.length === 0 ? fact.content : `[${fact.category}] ${fact.content}`).join(' | ')}`)
  }
  if (compartment.events.length > 0) lines.push(`events: ${compartment.events.join(' | ')}`)
  return lines.join('\n')
}

/** The in-band sentinels wrapping the injected baseline inside its node. */
export const BASELINE_OPEN = '<magic-context>'
export const BASELINE_CLOSE = '</magic-context>'

// ── m[1] mutation deltas: Magic Context's `<memory-updates>` block ───────────
//
// Contract: `docs/dsh-plugin-memory-write-contract.md` §6. Additive writes
// surface through the `maxMemoryId` watermark (`<new-memories>`); everything
// non-additive (`update`/`archive`/`delete`/`superseded`) is recorded in the
// shared `memory_mutation_log` and must surface as a *delta* here instead. The
// block is rendered with the exact bytes of Magic Context's
// `renderMemoryUpdatesBlock` (TS `inject-compartments.ts:2794-2876`, Rust
// `memory_render.rs:333-377`) so the two hosts agree on the wire format.

/** Magic Context's `memory_mutation_log.mutation_type` vocabulary (§6.1). */
export type MemoryMutationType = 'archive' | 'delete' | 'update' | 'superseded'

/**
 * One coalesced mutation-log row, ready to render. The bridge resolves the
 * live memory row for `update` and the supersede chain for `superseded` so
 * this stays a pure, DB-free value object.
 */
export interface MemoryUpdateLine {
  /** `memory_mutation_log.id` — the ordering key (globally monotonic). */
  readonly id: number
  readonly targetMemoryId: number
  readonly mutationType: MemoryMutationType
  /** The new category, when the mutation carries one (`update`/`superseded`). */
  readonly category?: string
  /** The live content for an `update` (MC re-reads the row, §6.3). */
  readonly content?: string
  /** The replacement id for a `superseded` mutation. */
  readonly supersededById?: number
  /**
   * `superseded` only: true when the replacement resolves to an eligible
   * memory. Otherwise the line degrades to `<removed>` (MC §6.4).
   */
  readonly replacementResolvable?: boolean
}

/**
 * Magic Context's visibility sentinel: the mutation only flipped the row's
 * cross-project visibility, the content is unchanged (§6.2).
 */
export const MEMORY_VISIBILITY_SENTINEL = '__mc_visibility__'

/** MC inject-compartments.ts:1142 — forced rows per delta render, hard cap. */
export const MAX_FORCED_MEMORIES_PER_DELTA = 10

/** The full `<memory-updates>` render: the block plus MC's forced set
 *  (inject-compartments.ts:2822-2869) for the sibling `<new-memories>`. */
export interface MemoryUpdatesRender {
  readonly block: string
  readonly count: number
  readonly forcedMemoryIds: readonly number[]
}

export const MEMORY_UPDATES_OPEN = '<memory-updates>'
export const MEMORY_UPDATES_CLOSE = '</memory-updates>'
export const MEMORY_UPDATES_HEADER = 'These memories changed since the snapshot below — trust these:'

/** Attribute escaping (MC `memory_render.rs:36-47`): `& < > "`. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Text escaping (MC `memory_render.rs:36-47`): `& < >`. */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Render Magic Context's `<memory-updates>` block, or `''` when there is
 * nothing to say. The header alone means "empty" (§6.4), so an empty delta
 * contributes zero bytes — the cache-prefix invariant depends on it.
 *
 * @param options.renderedIds - ids whose content is already rendered in the
 *   sibling `<new-memories>` block of the same m[1] region. An `<updated>`
 *   line for one of them is dropped so no memory's content is rendered twice;
 *   pointer lines (`<superseded>`/`<removed>`) are still emitted.
 * @param options.baselineIds - ids rendered in the m[0] baseline. When given,
 *   mutations for any other target are dropped entirely (MC
 *   inject-compartments.ts:2843-2848): the model never saw that id, so an
 *   `<updated>`/`<removed>` pointer for it would be phantom.
 */
export function renderMemoryUpdates(
  updates: readonly MemoryUpdateLine[],
  options: {
    readonly renderedIds?: ReadonlySet<number>
    readonly baselineIds?: ReadonlySet<number>
    /** MC `eligibleMemoryIds`: every currently-visible row, pre-budget. */
    readonly eligibleIds?: ReadonlySet<number>
  } = {},
): MemoryUpdatesRender {
  const lines: string[] = [MEMORY_UPDATES_HEADER]
  const emitted = new Set<number>()
  // MC inject-compartments.ts:2822-2869 — rows the model never saw in m[0]
  // can still be FORCED into `<new-memories>`: a `superseded` replacement and
  // a visibility-flipped target are eligible even when out of the baseline.
  const forcedIds = new Set<number>()
  for (const update of [...updates].sort((left, right) => left.id - right.id)) {
    const target = update.targetMemoryId
    // When the caller supplies the eligible set it is authoritative (MC);
    // without it a legacy caller cannot be checked — stay permissive.
    const eligible = options.eligibleIds === undefined || options.eligibleIds.has(target)
    if (update.mutationType === 'superseded') {
      // MC order (:2825-2841): the replacement is forced FIRST (even when the
      // target itself was never in the baseline), then the pointer line only
      // renders when the target WAS in the baseline — otherwise it is phantom.
      const replacement = update.supersededById
      const replacementVisible = options.eligibleIds === undefined
        || (replacement !== undefined && options.eligibleIds.has(replacement))
      const replacementResolvable = update.replacementResolvable === true && replacementVisible
      if (replacement !== undefined && replacementResolvable
        && options.baselineIds?.has(replacement) !== true) {
        forcedIds.add(replacement)
      }
      if (options.baselineIds !== undefined && !options.baselineIds.has(target)) continue
      emitted.add(target)
      lines.push(replacement !== undefined && replacementResolvable
        ? `  <superseded id="${String(target)}" by="${String(replacement)}"/>`
        : `  <removed id="${String(target)}"/>`)
      continue
    }
    if (options.baselineIds !== undefined && !options.baselineIds.has(target)) {
      // Out-of-baseline target: a visibility flip still surfaces the row
      // (forced), anything else stays silent (MC :2843-2848).
      if (update.mutationType === 'update'
        && update.category === MEMORY_VISIBILITY_SENTINEL
        && eligible) {
        forcedIds.add(target)
      }
      continue
    }
    // Coalescing already keeps one row per target upstream; this is the
    // defensive second gate ("the same change never appears twice").
    if (emitted.has(target)) continue
    if (update.mutationType !== 'update') {
      emitted.add(target)
      lines.push(`  <removed id="${String(target)}"/>`)
      continue
    }
    if (options.renderedIds?.has(target) === true) continue
    const content = update.content
    if (content === undefined || content.length === 0) {
      emitted.add(target)
      lines.push(`  <removed id="${String(target)}"/>`)
      continue
    }
    emitted.add(target)
    const category = update.category
    // MC omits the attribute for an empty category and for the visibility
    // sentinel (it is not a real category) — §6.4.
    const hasCategory = category !== undefined
      && category.length > 0
      && category !== MEMORY_VISIBILITY_SENTINEL
    lines.push(hasCategory
      ? `  <updated id="${String(target)}" category="${escapeAttribute(category)}">${escapeText(content)}</updated>`
      : `  <updated id="${String(target)}">${escapeText(content)}</updated>`)
  }
  const forcedMemoryIds = [...forcedIds].sort((left, right) => left - right)
    .slice(0, MAX_FORCED_MEMORIES_PER_DELTA)
  if (lines.length === 1) return { block: '', count: 0, forcedMemoryIds }
  return {
    block: [MEMORY_UPDATES_OPEN, ...lines, MEMORY_UPDATES_CLOSE].join('\n'),
    count: lines.length - 1,
    forcedMemoryIds,
  }
}

/**
 * Compose the m[0] baseline / m[1] delta block. m[0] is frozen history
 * (compartments created at or before the last hard rebuild, plus project
 * memories); m[1] is the delta accumulated since. Newest first inside m[1],
 * oldest first inside m[0] so the model reads a stable, chronological spine.
 *
 * @param budgetTokens - soft cap; older m[0] compartments degrade to their
 *   compressed tier and then drop out when the budget is exhausted. m[1] is
 *   never truncated (it is the part that must not be lost).
 */
export function renderBaseline(input: {
  /**
   * VESTIGIAL — the renderer is clock-free by construction (it is what makes
   * `same inputs → same bytes` true). Kept only so existing call sites and
   * goldens keep their shape; nothing here reads it. Remove with the next
   * breaking change.
   */
  readonly now: number
  /** Compartments created at or before the last hard rebuild. */
  readonly baseline: readonly Compartment[]
  /** Compartments accumulated since the last hard rebuild. */
  readonly delta: readonly Compartment[]
  readonly memories: readonly string[]
  /**
   * Memories written AFTER the m[0] watermark (Magic Context's additive lane).
   * They render in the delta region, never in m[0]: a new memory must not
   * rebuild the cached prefix.
   */
  readonly newMemories?: readonly string[]
  /**
   * Ids of {@link newMemories}, in the same order. Used to keep the
   * `<memory-updates>` block from re-rendering content that `<new-memories>`
   * already carries in the same m[1] region (no memory rendered twice).
   */
  readonly newMemoryIds?: readonly number[]
  /**
   * Ids rendered in the m[0] baseline. When given, `<memory-updates>` only
   * announces mutations whose target is one of them (MC
   * inject-compartments.ts:2843-2848): a target the model never saw would
   * make the pointer phantom.
   */
  readonly baselineIds?: readonly number[]
  /**
   * Non-additive changes (MC's `memory_mutation_log` delta) since the frozen
   * m[0]. They are rendered as `<memory-updates>`, positioned after the m[0]
   * sections and before `<new-memories>`, so their bytes live entirely in the
   * m[1] region: an update can never disturb the cached prefix.
   */
  readonly memoryUpdates?: readonly MemoryUpdateLine[]
  /**
   * MC `eligibleMemoryIds`: every currently-visible memory id, pre-budget.
   * Supplied, `<memory-updates>` collects forced rows (a `superseded`
   * replacement, a visibility flip) that must appear in `<new-memories>`
   * regardless of the delta budget (cap {@link MAX_FORCED_MEMORIES_PER_DELTA}).
   */
  readonly eligibleIds?: readonly number[]
  /**
   * Rendered lines for the forced ids (caller maps them via the eligible
   * rows). Appended to `<new-memories>` after the budgeted additions, exactly
   * like MC's deltaMemories composition (inject-compartments.ts:2966-2969).
   */
  readonly forcedMemoryLines?: readonly string[]
  /**
   * WP8: the user-profile lines that belong to m[0] (`<user-profile>`). The
   * profile has no activation rule — it is global to the person, exactly as in
   * Magic Context — so it renders ABOVE the project memories: who the person is
   * frames what the project is.
   *
   * The budget is the caller's (the bridge trims with the same `continue`
   * semantics the memory pool uses), because only the reader knows how many
   * tokens the profile is worth.
   */
  readonly profileLines?: readonly string[]
  /**
   * WP8: profile rows written AFTER the frozen m[0] watermark. They render in
   * the m[1] region as `<new-user-profile>`, so a new profile entry never
   * rebuilds the cached prefix.
   */
  readonly newProfileLines?: readonly string[]
  readonly budgetTokens: number
}): string {
  const sections: string[] = []
  const profileLines = input.profileLines ?? []
  if (profileLines.length > 0) {
    sections.push(['<user-profile>', ...profileLines, '</user-profile>'].join('\n'))
  }
  if (input.memories.length > 0) {
    sections.push(['<project-memories>', ...input.memories, '</project-memories>'].join('\n'))
  }
  if (input.baseline.length > 0) {
    const ordered = [...input.baseline].sort((left, right) => left.createdAt - right.createdAt)
    // Positional age is measured INSIDE m[0] only.
    //
    // It used to be `ordered.length + input.delta.length - 1`, so the newest
    // wire row (the last delta row) scored age 0 and every m[0] row shifted one
    // step older each time a compartment landed in m[1]. With tier deciding the
    // rendered body, that re-rendered m[0] on the common path — the "SOFT pass
    // must never re-tier" invariant upstream states at ARCHITECTURE.md:96.
    // Measured 2026-11-11: soft refreshes had a p10 fidelity of 24.0% and cost
    // 12.8M re-billed input tokens.
    //
    // m[1] rows do not participate in this loop at all (they render in their
    // own `<compartment-delta>` section at P1, matching upstream
    // `inject-compartments.ts:3050`), so counting them here only made m[0]'s
    // bytes accelerate toward older tiers without buying any fidelity where it
    // mattered. Decay within m[0] still ages correctly: the block is frozen at
    // a HARD fold, and the rows ahead of it stay put.
    const newest = ordered.length - 1
    const rendered: string[] = []
    let used = 0
    for (const [index, compartment] of ordered.entries()) {
      const age = newest - index
      const full = renderCompartment(compartment, age)
      const fullCost = estimateTokens(full)
      if (used + fullCost <= input.budgetTokens) {
        rendered.push(full)
        used += fullCost
        continue
      }
      const compressed = renderCompartment(compartment, age, 'p4')
      const compressedCost = estimateTokens(compressed)
      if (used + compressedCost <= input.budgetTokens) {
        rendered.push(compressed)
        used += compressedCost
      }
    }
    if (rendered.length > 0) sections.push(['<compartment-baseline>', ...rendered, '</compartment-baseline>'].join('\n'))
  }
  // m[1] begins here: every section below is delta-shaped and may change without
  // touching a single byte of the sections above (the cache-prefix invariant).
  const memoryUpdates = renderMemoryUpdates(input.memoryUpdates ?? [], {
    ...input.newMemoryIds === undefined ? {} : { renderedIds: new Set(input.newMemoryIds) },
    ...input.baselineIds === undefined ? {} : { baselineIds: new Set(input.baselineIds) },
    ...input.eligibleIds === undefined ? {} : { eligibleIds: new Set(input.eligibleIds) },
  })
  if (memoryUpdates.block.length > 0) sections.push(memoryUpdates.block)
  const forcedMemoryLines = input.forcedMemoryLines ?? []
  const budgetedNewMemories = input.newMemories ?? []
  const newMemories = budgetedNewMemories.length > 0 || forcedMemoryLines.length > 0
    ? [...budgetedNewMemories, ...forcedMemoryLines]
    : []
  if (newMemories.length > 0) {
    sections.push(['<new-memories>', ...newMemories, '</new-memories>'].join('\n'))
  }
  const newProfileLines = input.newProfileLines ?? []
  if (newProfileLines.length > 0) {
    sections.push(['<new-user-profile>', ...newProfileLines, '</new-user-profile>'].join('\n'))
  }
  if (input.delta.length > 0) {
    const ordered = [...input.delta].sort((left, right) => right.createdAt - left.createdAt)
    // m[1] rows always render at P1 (age 0), matching upstream
    // `inject-compartments.ts:3050` `renderCompartmentAtTier(compartment, 1)`.
    // They are the newest work by definition — the delta only holds rows that
    // landed after the m[0] freeze — so decaying them by their position inside
    // the delta would summarise the freshest history harder than the frozen
    // baseline behind it.
    sections.push([
      '<compartment-delta>',
      ...ordered.map(compartment => renderCompartment(compartment, 0)),
      '</compartment-delta>',
    ].join('\n'))
  }
  if (sections.length === 0) return ''
  return [BASELINE_OPEN, ...sections, BASELINE_CLOSE].join('\n')
}

/** Index of the baseline block inside a message's text, if it carries one. */
export function findBaselineRange(text: string): { start: number; end: number } | undefined {
  const start = text.indexOf(BASELINE_OPEN)
  if (start === -1) return undefined
  const close = text.indexOf(BASELINE_CLOSE, start + BASELINE_OPEN.length)
  if (close === -1) return undefined
  return { start, end: close + BASELINE_CLOSE.length }
}

/** Strip any previously injected baseline block from a message text. */
export function stripBaseline(text: string): string {
  const range = findBaselineRange(text)
  if (range === undefined) return text
  return (text.slice(0, range.start) + text.slice(range.end)).trim()
}

export class HistorianOutputError extends Error {
  constructor(message: string) {
    super(`magic-context historian output rejected: ${message}`)
    this.name = 'HistorianOutputError'
  }
}

function asTier(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HistorianOutputError(`summary.${key} must be a non-empty string`)
  }
  return value.trim()
}

function asStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new HistorianOutputError('facts/events must be arrays')
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim())
}

/**
 * Facts as `{category, content}` (Magic Context's promotable shape).
 *
 * Legacy plain strings are still accepted by the HISTORIAN contract — a model
 * that returns `["..."]` must not fail the whole run — but they carry no
 * category and are therefore not promotable; they are kept as `category: ''`
 * so the compartment still renders them and the journal can explain why they
 * were skipped. Unknown categories are kept verbatim for the same reason:
 * Magic Context drops them at promotion time, not at parse time.
 */
function asFactArray(value: unknown): MemoryFact[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new HistorianOutputError('facts must be an array')
  const facts: MemoryFact[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      const content = item.trim()
      if (content.length > 0) facts.push({ category: '', content })
      continue
    }
    if (item !== null && typeof item === 'object') {
      const record = item as Record<string, unknown>
      const content = typeof record.content === 'string' ? record.content.trim() : ''
      if (content.length === 0) continue
      const category = typeof record.category === 'string' ? record.category.trim() : ''
      facts.push({ category, content })
    }
  }
  return facts
}

/**
 * A one-line description of why a JSON-ish text does not balance, for the
 * failure journal.
 *
 * All four live `invalid-output` failures (2026-10-08..10-10) reported a JSON
 * syntax error at the LAST character of the output — position = `outputChars - 1`
 * — while the tail the journal kept was a well-formed ending (`...".` then `}`).
 * A parser only trips on the final `}` when something earlier never closed, so
 * the text looked intact at both ends and the defect sat in the middle, exactly
 * where the journal kept nothing. Counting openers against closers, ignoring
 * both inside string literals, turns that into a recorded fact instead of a
 * guess about the model.
 */
export function describeJsonImbalance(text: string): string {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') {
      stack.push(char)
      continue
    }
    if (char === '}' || char === ']') {
      const want = char === '}' ? '{' : '['
      if (stack.length === 0) return `unexpected '${char}'`
      if (stack[stack.length - 1] !== want) return `'${stack[stack.length - 1] as string}' closed by '${char}'`
      stack.pop()
    }
  }
  if (inString) return 'unterminated string'
  if (stack.length === 0) return ''
  const closers = new Map<string, number>()
  for (const open of stack) {
    const close = open === '{' ? '}' : ']'
    closers.set(close, (closers.get(close) ?? 0) + 1)
  }
  return `unclosed ${[...closers.entries()].map(([close, count]) => `'${close}'×${String(count)}`).join('+')}`
}

/**
 * Parse and validate a historian response. Throws {@link HistorianOutputError}
 * on any contract violation — the run then fails closed (no compartment row,
 * no mutation) rather than storing a half-digest.
 */
/**
 * Re-escape a model's JSON without changing its meaning, for the two shapes
 * that break strict `JSON.parse` in practice:
 *
 *  - a raw control character inside a string (models write multi-line digests
 *    with real newlines/tabs instead of `\n`/`\t`);
 *  - a backslash that starts no valid escape (a Windows path, or a literal `\`
 *    in prose: `C:\temp`, `\§`).
 *
 * Nothing is invented and nothing is dropped except CR and other control
 * characters below 0x20, which cannot appear in a JSON string anyway. A
 * *truncated* object is NOT repaired here on purpose: a half-digest silently
 * admitted would put a lie in the baseline, so it must keep failing loudly.
 *
 * Live example this exists for (2026-11-10 16:49:17): a 105k-token span
 * chunked 3 ways came back `finishReason=stop` with 6,131 characters and
 * `invalid JSON (position 1132, line 3 column 1116)` — a long single line, i.e.
 * a string with raw newlines in it.
 */
export function repairHistorianJson(text: string): { text: string; notes: readonly string[] } {
  const open = text.indexOf('{')
  if (open === -1) return { text, notes: [] }
  const validEscapes = '"\\/bfnrtu'
  const notes = new Set<string>()
  let out = ''
  let inString = false
  let escaped = false
  for (let index = open; index < text.length; index += 1) {
    const char = text[index] as string
    if (inString) {
      if (escaped) {
        if (!validEscapes.includes(char)) {
          out += '\\'
          notes.add('bad-escape')
        }
        out += char
        escaped = false
        continue
      }
      if (char === '\\') {
        out += char
        escaped = true
        continue
      }
      if (char === '"') {
        out += char
        inString = false
        continue
      }
      if (char === '\n') {
        out += '\\n'
        notes.add('raw-newline')
        continue
      }
      if (char === '\t') {
        out += '\\t'
        notes.add('raw-tab')
        continue
      }
      if (char === '\r') {
        notes.add('raw-cr')
        continue
      }
      if (char < ' ') {
        out += ' '
        notes.add('control-char')
        continue
      }
      out += char
      continue
    }
    if (char === '"') inString = true
    out += char
  }
  return { text: out, notes: [...notes] }
}

/** The five fact categories the historian may emit (MC's FACT_CATEGORIES). */
const FACT_CATEGORIES = ['PROJECT_RULES', 'ARCHITECTURE', 'CONSTRAINTS', 'CONFIG_VALUES', 'NAMING'] as const

/** One scanned tag: its name, its attributes, and the text between the tags. */
interface TagBlock {
  readonly name: string
  readonly attrs: Readonly<Record<string, string>>
  readonly inner: string
}

/**
 * Split a leading tag into its name and attributes, tolerating a raw `>` inside
 * a quoted attribute value (golden case 3: "raw `>` inside a quoted attribute
 * value keeps the compartment").
 */
function splitTag(raw: string): { name: string; attrs: Record<string, string>; selfClosed: boolean } | undefined {
  const inner = raw.slice(1, raw.endsWith('/') ? -1 : undefined).trim()
  const match = inner.match(/^([A-Za-z_][\w.-]*)([\s\S]*)$/)
  if (match === null) return undefined
  const name = match[1] as string
  const attrs: Record<string, string> = {}
  const rest = match[2] ?? ''
  const attrPattern = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g
  let found: RegExpExecArray | null
  while ((found = attrPattern.exec(rest)) !== null) attrs[found[1] as string] = found[2] as string
  return { name, attrs, selfClosed: raw.trimEnd().endsWith('/>') }
}

/** End index of the tag that opens at `start` (`>` outside a quoted value). */
function tagEnd(text: string, start: number): number {
  let quoted = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (char === '"') quoted = !quoted
    else if (char === '>' && !quoted) return index
  }
  return -1
}

/**
 * Every `<name …>…</name>` block, LENIENT about the close tag: a missing
 * `</name>` runs to the next opening tag of the same name, or to the end of the
 * text (golden case 0: "mismatched and missing tier closes stay lenient").
 */
export function scanTagBlocks(text: string, name: string): TagBlock[] {
  const blocks: TagBlock[] = []
  const opener = new RegExp(`<\\s*${name}(?=[\\s/>])`, 'gi')
  let cursor = 0
  for (;;) {
    opener.lastIndex = cursor
    const found = opener.exec(text)
    if (found === null) return blocks
    const openEnd = tagEnd(text, found.index)
    if (openEnd === -1) return blocks
    const split = splitTag(text.slice(found.index, openEnd + 1))
    if (split === undefined) {
      cursor = openEnd + 1
      continue
    }
    const bodyStart = openEnd + 1
    let bodyEnd = text.length
    if (!split.selfClosed) {
      const closer = new RegExp(`<\\s*/\\s*${name}\\s*>`, 'i')
      const rest = text.slice(bodyStart)
      const closeMatch = rest.match(closer)
      const nextOpen = rest.slice(1).search(new RegExp(`<\\s*${name}(?=[\\s/>])`, 'i'))
      if (closeMatch !== null && closeMatch.index !== undefined) bodyEnd = bodyStart + closeMatch.index
      else if (nextOpen !== -1) bodyEnd = bodyStart + 1 + nextOpen
    }
    blocks.push({
      name: split.name,
      attrs: split.attrs,
      inner: split.selfClosed ? '' : text.slice(bodyStart, bodyEnd),
    })
    cursor = bodyEnd + 1
    if (cursor >= text.length) return blocks
  }
}

/** Text content of one named child, or '' when the child is absent/self-closed. */
function childText(block: TagBlock, child: string): string {
  const inner = scanTagBlocks(block.inner, child)
  return inner.length === 0 ? '' : decodeEntities(inner[0]!.inner.trim())
}

/**
 * XML entities, decoded exactly ONCE (golden case 2: "xml entities decode
 * exactly once"). Order matters — `&amp;` last, so `&amp;lt;` becomes `&lt;`
 * and not `<`: a digest that talks about `&lt;` in code must not turn into a
 * real tag two layers down.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Bullets and blank lines stripped — the facts lane is line-of-text per row. */
function linesOf(raw: string): string[] {
  return raw
    .split('\n')
    .map(line => line.replace(/^\s*[*\-•]\s*/, '').trim())
    .filter(line => line.length > 0)
    .map(decodeEntities)
}

/** True when the text is shaped like Magic Context's tag envelope. */
export function hasHistorianEnvelope(text: string): boolean {
  return /<\s*output[\s>]/i.test(text) || /<\s*compartment[\s/>]/i.test(text)
}

/**
 * Parse Magic Context's TAG ENVELOPE into the draft this adapter stores.
 *
 * Upstream never asks its historian for JSON. `testdata/historian-parse-golden.json`
 * (8 cases) is the contract:
 *
 * ```text
 * <output>
 * <compartments>
 * <compartment start="1" end="2" title="Setup" episode_type="infra" importance="40">
 * <p1>did setup</p1><p2>…</p2><p3>…</p3><p4/>
 * </compartment>
 * </compartments>
 * <facts><PROJECT_RULES>* Keep goldens deterministic.</PROJECT_RULES></facts>
 * <events><causal_incident at_compartment="1"><summary>Setup broke.</summary></causal_incident></events>
 * <meta><unprocessed_from>3</unprocessed_from></meta>
 * </output>
 * ```
 *
 * Why this exists at all: a 6k-character JSON object is one unescaped quote away
 * from being unparseable as a whole, and the live failure on 2026-11-10
 * (`invalid JSON (position 1132, line 3 column 1116)`, 105k-token span) threw
 * away a digest the model HAD produced. Field boundaries made of tags survive a
 * missing close tag; boundaries made of commas do not.
 *
 * Only the first `<compartment>` is used: one call produces one compartment in
 * this adapter (chunking is ours, not the model's).
 */
/**
 * Where a compartment body really ends.
 *
 * Upstream treats a close tag as markup only at depth 0 — a paragraph that
 * writes `</compartment>` while a `<p1>` is still open is TEXT (golden case 5).
 * Without depth tracking the first quoted `</compartment>` amputates the block,
 * and the rest of the block then leaks into the facts/events scan as a second
 * body — which is exactly how one event turns into two.
 */
function compartmentCloseAt(text: string, from: number): number {
  const re = /<\s*(\/?)\s*(p[1-4]|compartment)(?=[\s/>])/gi
  re.lastIndex = from
  let inTier: string | null = null
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const closing = match[1] === '/'
    const name = (match[2] ?? '').toLowerCase()
    if (name === 'compartment') {
      // A close only counts when no paragraph is open; inside one it is the
      // text the paragraph is quoting (golden case 5).
      if (closing && inTier === null) return match.index
      continue
    }
    if (closing) {
      // Any tier close ends the open paragraph, even a mismatched one
      // (golden case 1: `<p1>first</p2>`).
      inTier = null
      continue
    }
    // Tiers are siblings: a second opener while one is open is quoted text,
    // not nesting (golden case 4: `Discussed <p2> tags vs <pre>`).
    // A self-closed tier (`<p4/>`) never opens a paragraph.
    if (inTier === null && text[match.index + match[0].length] !== '/') inTier = name
  }
  return text.length
}

/** Every compartment block, with bodies cut by {@link compartmentCloseAt}. */
function scanCompartments(text: string): TagBlock[] {
  const blocks: TagBlock[] = []
  const opener = /<\s*compartment(?=[\s/>])/gi
  let match: RegExpExecArray | null
  while ((match = opener.exec(text)) !== null) {
    const start = match.index
    const head = tagEnd(text, start)
    if (head === -1) break
    const split = splitTag(text.slice(start, head + 1))
    const bodyStart = head + 1
    if (split === undefined) {
      // Unterminated tag: nothing further can be read reliably.
      break
    }
    if (split.selfClosed) {
      blocks.push({ name: 'compartment', attrs: split.attrs, inner: '' })
      opener.lastIndex = bodyStart
      continue
    }
    const bodyEnd = compartmentCloseAt(text, bodyStart)
    blocks.push({ name: 'compartment', attrs: split.attrs, inner: text.slice(bodyStart, bodyEnd) })
    const afterClose = text.indexOf('>', bodyEnd)
    opener.lastIndex = afterClose === -1 ? text.length : afterClose + 1
  }
  return blocks
}

/**
 * The compartment to read out of an envelope.
 *
 * This adapter asks for one compartment per call, so when several arrive the
 * choice only has to be defensible: the one with the smallest `start` anchor
 * (golden case 7 — compartments are allowed to arrive out of order).
 */
function pickCompartment(text: string): TagBlock {
  const blocks = scanCompartments(text)
  if (blocks.length === 0) {
    throw new HistorianOutputError('no <compartment> block found in the response')
  }
  let best = blocks[0] as TagBlock
  let bestStart = Number(best.attrs.start)
  for (const block of blocks.slice(1)) {
    const start = Number(block.attrs.start)
    if (Number.isFinite(start) && (!Number.isFinite(bestStart) || start < bestStart)) {
      best = block
      bestStart = start
    }
  }
  return best
}

export function parseHistorianEnvelope(text: string): CompartmentDraft {
  const first = pickCompartment(text)
  const body = first.inner
  const tidy = (raw: string): string => decodeEntities(raw).replace(/\s+/g, ' ').trim()
  /**
   * One tier body. The rule that reconciles every shape in the golden file is
   * "ask what the FIRST close tag of any tier is":
   *
   *  - it closes this tier: the paragraph owns everything up to the LAST close
   *    of this tier, because a quoted `</p1>` and the real close look identical
   *    (golden case 4) and greedy beats position;
   *  - it closes a sibling: the body stops at whichever comes first, a sibling
   *    opener (`<p1>first<p2>second`) or that mismatched close (golden case 1).
   */
  const tierOf = (name: string): string => {
    // A self-closed `<p3/>` inside another paragraph is a MENTION, not this
    // tier's opening (golden case 4 writes one inside p2).
    let opener: RegExpExecArray | null = null
    const openAll = new RegExp(`<\\s*${name}(?=[\\s/>])[^>]*>`, 'gi')
    for (let hit = openAll.exec(body); hit !== null; hit = openAll.exec(body)) {
      if (hit[0].endsWith('/>')) continue
      opener = hit
      break
    }
    const start = opener === null ? 0 : (opener.index + opener[0].length)
    const rest = body.slice(start)
    const firstClose = rest.match(/<\s*\/\s*(p[1-4])\s*>/i)
    if (firstClose !== null && (firstClose[1] ?? '').toLowerCase() === name.toLowerCase()) {
      const same = [...rest.matchAll(new RegExp(`<\\s*/\\s*${name}\\s*>`, 'gi'))].pop()
      return tidy(rest.slice(0, same?.index ?? rest.length))
    }
    const nextOpen = rest.search(/<\s*p[1-4](?=[\s/>])/i)
    const limit = Math.min(
      nextOpen === -1 ? rest.length : nextOpen,
      firstClose?.index ?? rest.length,
    )
    return tidy(rest.slice(0, limit))
  }

  const rawImportance = Number(first.attrs.importance)
  const importance = Number.isFinite(rawImportance) && rawImportance > 0
    ? Math.min(100, Math.max(0, Math.round(rawImportance)))
    : 50
  // Side channels live OUTSIDE the compartment body. A paragraph that QUOTES
  // `<facts>` or `<user_observations>` (golden case 5) must not manufacture
  // fifteen facts out of one sentence.
  const sideText = first.inner.length === 0 ? text : text.split(first.inner).join('\n')
  const factsBlock = scanTagBlocks(sideText, 'facts')[0]
  const facts: Array<{ category: string; content: string }> = []
  const pushFacts = (category: string, raw: string): void => {
    // No blanket tag stripping here: a fact line may QUOTE a tag
    // (`Real fact mentioning </compartment> as text.`, golden case 5) and
    // stripping would silently eat the quote.
    for (const line of linesOf(raw)) facts.push({ category, content: line })
  }
  if (factsBlock !== undefined) {
    for (const name of FACT_CATEGORIES) {
      for (const block of scanTagBlocks(factsBlock.inner, name)) {
        pushFacts(name, block.inner.replace(new RegExp('<\\s*/?\\s*' + name + '\\s*>', 'gi'), ' '))
      }
    }
    // A model that ignores the category rule and writes prose under <facts>
    // still gets its lines kept — under the catch-all category, never dropped.
    if (facts.length === 0) {
      for (const line of linesOf(factsBlock.inner.replace(/<[^>]*>/g, ' '))) {
        facts.push({ category: 'CONSTRAINTS', content: line })
      }
    }
  } else {
    // Legacy shape (golden case 6): bare category blocks outside <facts>.
    for (const name of FACT_CATEGORIES) {
      for (const block of scanTagBlocks(sideText, name)) pushFacts(name, block.inner)
    }
  }
  const events: string[] = []
  const eventsBlock = scanTagBlocks(sideText, 'events')[0]
  if (eventsBlock !== undefined) {
    // Every TOP-LEVEL element under <events> is one event slot; `<summary>`
    // and `<evidence>` are its fields (golden case 5: a nested `<evidence>`
    // must not become an event of its own).
    const names: string[] = []
    let depth = 0
    for (const found of eventsBlock.inner.matchAll(/<\s*(\/?)\s*([A-Za-z_][\w-]*)(?=[\s/>])/g)) {
      const closing = found[1] === '/'
      const name = found[2] as string
      if (closing) {
        depth = Math.max(0, depth - 1)
        continue
      }
      if (depth === 0 && name !== 'events') names.push(name)
      const selfClosed = eventsBlock.inner[found.index + found[0].length] === '/'
      if (!selfClosed) depth += 1
    }
    // Depth counting cannot tell a nested element from a close tag quoted
    // inside a summary (`Real event about </p1> text`), so drop any candidate
    // whose blocks live INSIDE another candidate's block.
    const collected = new Map<string, TagBlock[]>()
    for (const kind of new Set(names)) collected.set(kind, scanTagBlocks(eventsBlock.inner, kind))
    const isNested = (kind: string): boolean =>
      [...collected.entries()].some(([other, blocks]) =>
        other !== kind && blocks.some(block => new RegExp('<\\s*' + kind + '(?=[\\s/>])').test(block.inner)))
    for (const kind of collected.keys()) {
      if (isNested(kind)) continue
      for (const block of collected.get(kind) ?? []) {
        const summary = childText(block, 'summary')
        const text = summary.length > 0
          ? summary.replace(/\s+/g, ' ')
          : linesOf(block.inner.replace(/<[^>]*>/g, ' ')).join(' ')
        if (text.length > 0) events.push(kind + ': ' + text)
      }
    }
  }
  // A digest that answers in one tier still lands: the fallback fills the rest,
  // and p3 belongs in the chain — a p3-only answer used to be rejected as
  // 'no tier text' and thrown away, word for word the loss this envelope exists
  // to prevent.
  const content = tierOf('p1') || tierOf('p2') || tierOf('p3') || tierOf('p4')
  // WP5 lane: statements about the PERSON, not the project. The prompt asks for
  // them under `<user_observations>`, and `historian.ts` writes them to the
  // candidate pool from `draft.userObservations` — if this block is ever dropped
  // from the envelope, profile collection goes quiet with no error anywhere.
  const observationsBlock = scanTagBlocks(sideText, 'user_observations')[0]
  const userObservations = observationsBlock === undefined
    ? []
    : linesOf(observationsBlock.inner.replace(/<[^>]*>/g, ' '))
  const draft = {
    tiers: {
      p1: tierOf('p1') || content,
      p2: tierOf('p2') || content,
      p3: tierOf('p3') || content,
      p4: tierOf('p4') || content,
    },
    importance,
    facts,
    events,
    ...userObservations.length === 0 ? {} : { userObservations },
  }
  if (draft.tiers.p1.length === 0) {
    throw new HistorianOutputError('the <compartment> block carries no tier text')
  }
  return draft
}

export function parseHistorianOutput(text: string): CompartmentDraft {
  // The envelope first when the response looks like one: upstream asks for that
  // shape, and such a response has no JSON object at all — the JSON path would
  // only report "no JSON object found" and lose a digest the model produced.
  if (hasHistorianEnvelope(text)) return parseHistorianEnvelope(text)
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')
  if (open === -1 || close <= open) {
    throw new HistorianOutputError('no JSON object found in the response')
  }
  const slice = text.slice(open, close + 1)
  const repaired = repairHistorianJson(slice)
  let parsed: unknown
  try {
    parsed = JSON.parse(repaired.text)
  } catch (error) {
    const imbalance = describeJsonImbalance(repaired.text)
    const note = repaired.notes.length === 0 ? '' : `, repaired ${repaired.notes.join('+')}`
    throw new HistorianOutputError(
      `invalid JSON (${errText(error)})${imbalance === '' ? '' : ` [${imbalance}]`}${note}`,
    )
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new HistorianOutputError('response is not a JSON object')
  }
  const record = parsed as Record<string, unknown>
  const summary = record.summary
  if (summary === null || typeof summary !== 'object') {
    throw new HistorianOutputError('summary must be an object with p1..p4')
  }
  const tiers = summary as Record<string, unknown>
  const importanceRaw = record.importance
  const importance = typeof importanceRaw === 'number' && Number.isFinite(importanceRaw)
    ? Math.min(100, Math.max(0, Math.round(importanceRaw)))
    : importanceRaw === undefined
      ? 50
      : undefined
  if (importance === undefined) throw new HistorianOutputError('importance must be a number when present')
  return {
    tiers: {
      p1: asTier(tiers.p1, 'p1'),
      p2: asTier(tiers.p2, 'p2'),
      p3: asTier(tiers.p3, 'p3'),
      p4: asTier(tiers.p4, 'p4'),
    },
    importance,
    facts: asFactArray(record.facts),
    events: asStringArray(record.events),
    // WP5: absent on every digest written before the field existed, and on any
    // model that follows the instruction by omitting an empty array.
    userObservations: asStringArray(record.userObservations),
  }
}
