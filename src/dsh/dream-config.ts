/**
 * The dreamer's tunables, resolved once per run instead of once per mount.
 *
 * ## Why this is a resolver and not a plain type
 *
 * Every field here is editable from the settings form, which means it arrives as
 * a schemastery **volatile** reference — not a value. Reading `config.dream.x`
 * directly gives you a wrapper object, and reading it at mount gives you a
 * snapshot that ignores every later edit. Both mistakes have been made in this
 * codebase before (`maintenance.verifyProvider` once printed `[object Object]`),
 * so the unwrapping and the "when" live together here.
 *
 * ## Why defaults are resolved here rather than in the schema
 *
 * The schema declares defaults so the form shows a sensible starting value, but
 * a resolved config is what the handlers consume, and handlers must work when
 * the whole `dream` object is absent (a profile that never configured it).
 * Having one place that says "absent means this" keeps the schema and the
 * runtime from drifting.
 */

import { liveBoolean, liveNumber, liveStringArray, liveValue } from './volatile.ts'

export interface DreamRuntimeConfig {
  /** Age at which an importance score is considered stale, in ms. */
  readonly classifyStaleAfterMs: number
  readonly classifyBatchSize: number
  readonly verifyBatchSize: number
  /** False is the ONLY value that lets curate write. */
  readonly curateDryRun: boolean
  readonly curateSimilarityFloor: number
  readonly curateMaxPairs: number
  readonly retrospectiveWindowMs: number
  /** Candidates per `review-user-memories` call (see PROFILE_REVIEW_BATCH). */
  readonly profileReviewBatch: number
  /**
   * Distinct sessions a single promotion must rest on (see
   * PROFILE_REVIEW_MIN_SESSIONS).
   *
   * Exposed because the guard can only pass where the same preference was
   * observed twice in DIFFERENT sessions. Measured 2026-11-17 on the real pool:
   * 147 candidates across 6 sessions, 83 of them from one long-running session,
   * and ZERO pairs that normalize to the same content — so every promotion was
   * held back and the lane burned a call a day to promote nothing. On a
   * single-operator machine `2` is therefore a permanent stall; `1` promotes
   * from one session's evidence and trusts the model's own judgement instead.
   */
  readonly profileReviewMinSessions: number
  /** Additional trees `verify` may search, always starting with none. */
  readonly verifyExtraRoots: readonly string[]
}

const DAY = 24 * 60 * 60 * 1000

export const DEFAULT_DREAM_CONFIG: DreamRuntimeConfig = {
  // Two weeks: long enough that a normal project's ranking stays stable, short
  // enough that a pool which doubled gets re-ranked within a month.
  classifyStaleAfterMs: 14 * DAY,
  classifyBatchSize: 16,
  // 16, not 8: this lane now owns EVERY unverified row (the maintenance sweep no
  // longer verifies at all), so the batch has to cover the promotion inflow. At
  // the two-hourly cadence that is 12 runs a day, ~192 rows — the sweep's old
  // 16-per-30-minutes ceiling with one lane instead of two.
  verifyBatchSize: 16,
  curateDryRun: true,
  curateSimilarityFloor: 0.92,
  curateMaxPairs: 6,
  retrospectiveWindowMs: 7 * DAY,
  profileReviewBatch: 12,
  // 1, not the core default of 2: see the field's docstring. The cross-session
  // guard stays available for anyone running several sessions per day, but the
  // shipped default must not be a state machine that never advances.
  profileReviewMinSessions: 1,
  verifyExtraRoots: [],
}


/** Bounds, applied on read so a hand-edited patch cannot disable the guards. */
const LIMITS = {
  classifyStaleAfterMs: { min: 60 * 60 * 1000, max: 365 * DAY },
  classifyBatchSize: { min: 1, max: 200 },
  verifyBatchSize: { min: 1, max: 100 },
  curateSimilarityFloor: { min: 0, max: 1 },
  curateMaxPairs: { min: 1, max: 50 },
  retrospectiveWindowMs: { min: 60 * 60 * 1000, max: 365 * DAY },
  profileReviewBatch: { min: 1, max: 60 },
  profileReviewMinSessions: { min: 1, max: 5 },
} as const

function clamp(value: number, bounds: { min: number; max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, value))
}

/**
 * Resolve the live config. Call this **per run**, not at mount: a settings-form
 * commit mutates the volatile reference in place and never remounts the fiber,
 * so a value captured earlier is simply the old value.
 */
export function resolveDreamConfig(configured: unknown): DreamRuntimeConfig {
  const raw = (liveValue(configured) ?? {}) as Record<string, unknown>
  return {
    classifyStaleAfterMs: clamp(
      liveNumber(raw.classifyStaleAfterMs, DEFAULT_DREAM_CONFIG.classifyStaleAfterMs),
      LIMITS.classifyStaleAfterMs,
    ),
    classifyBatchSize: Math.round(clamp(
      liveNumber(raw.classifyBatchSize, DEFAULT_DREAM_CONFIG.classifyBatchSize),
      LIMITS.classifyBatchSize,
    )),
    verifyBatchSize: Math.round(clamp(
      liveNumber(raw.verifyBatchSize, DEFAULT_DREAM_CONFIG.verifyBatchSize),
      LIMITS.verifyBatchSize,
    )),
    // Only an explicit `false` opts in to writing. `undefined`, a stale
    // reference, or a malformed value all resolve to the dry run, because the
    // alternative is a merge nobody asked for.
    curateDryRun: liveBoolean(raw.curateDryRun, DEFAULT_DREAM_CONFIG.curateDryRun) !== false,
    curateSimilarityFloor: clamp(
      liveNumber(raw.curateSimilarityFloor, DEFAULT_DREAM_CONFIG.curateSimilarityFloor),
      LIMITS.curateSimilarityFloor,
    ),
    curateMaxPairs: Math.round(clamp(
      liveNumber(raw.curateMaxPairs, DEFAULT_DREAM_CONFIG.curateMaxPairs),
      LIMITS.curateMaxPairs,
    )),
    retrospectiveWindowMs: clamp(
      liveNumber(raw.retrospectiveWindowMs, DEFAULT_DREAM_CONFIG.retrospectiveWindowMs),
      LIMITS.retrospectiveWindowMs,
    ),
    profileReviewBatch: Math.round(clamp(
      liveNumber(raw.profileReviewBatch, DEFAULT_DREAM_CONFIG.profileReviewBatch),
      LIMITS.profileReviewBatch,
    )),
    profileReviewMinSessions: Math.round(clamp(
      liveNumber(raw.profileReviewMinSessions, DEFAULT_DREAM_CONFIG.profileReviewMinSessions),
      LIMITS.profileReviewMinSessions,
    )),
    // Empty entries are dropped: an empty string would resolve to the process
    // cwd inside `buildFileIndex` and index the entire working tree by accident.
    verifyExtraRoots: liveStringArray(raw.verifyExtraRoots, [])
      .map(root => root.trim())
      .filter(root => root.length > 0),
  }
}
