/**
 * The gate a consolidation verdict must pass before it touches a row.
 *
 * Ported from upstream `dreamer/curate-memory-safety.ts` (120 lines) with the
 * same four refusals. They exist because consolidation is the one dreamer task
 * that DELETES things: `verify` can rewrite a fact that turns out wrong, but an
 * archive is only recoverable by a human who noticed. Each rule below encodes a
 * way that went wrong before.
 *
 * 1. **`missing-active-same-category-successor`** — an archive must name a live,
 *    same-category replacement. Without it, "this is a duplicate of #412" where
 *    #412 was itself archived last week removes the fact from the project
 *    entirely and neither the model nor the log says so.
 * 2. **`user-profile-is-not-project-memory`** — a project-scoped row cited as
 *    superseded by a *user profile* fact is a category error: profiles describe
 *    the operator, project memories describe the codebase. Merging across that
 *    line publishes local knowledge as a personal preference.
 * 3. **`directive-shaped-project-rule`** — a rule phrased as an instruction
 *    ("never push without asking") has truth that lives in TEAM BEHAVIOUR, not
 *    in the repository. Two such rules that read similarly are usually two
 *    different rules, and merging them loses one.
 * 4. **`content-loss`** — a rewrite that keeps less than half the original text,
 *    with no surviving successor, has replaced a fact rather than tightened it.
 *
 * The asymmetry is deliberate: every rule refuses, none permits. A refusal costs
 * one duplicate left in the corpus; a false permit costs a fact nobody can find
 * again.
 */

/** Category whose rows are imperative rather than declarative. */
const PROJECT_RULES_CATEGORY = 'PROJECT_RULES'

/** All v2 categories are project-scoped; kept as a set so the check reads like
 *  the upstream guard rather than a string comparison. */
const PROJECT_SCOPED_CATEGORIES: ReadonlySet<string> = new Set([
  'PROJECT_RULES', 'ARCHITECTURE', 'CONSTRAINTS', 'CONFIG_VALUES', 'NAMING',
])

const USER_PROFILE_REFERENCE = /\buser(?:[\s_-]+)(?:profile|preferences?)\b|\bU\d+\b/i

// ── Directive shapes ────────────────────────────────────────────────────────
// Numeric-only, no NLP: these match the phrasings that actually appear in
// PROJECT_RULES rows. A declarative implementation claim ("binds use spread
// args") deliberately does NOT match — those are verifiable and mergeable.
const POLICY_SENTENCE_START =
  /(?:^|[.!?]\s+|\n\s*)(?:[-*]\s+|\d+[.)]\s+)?(?:you\s+|we\s+)?(?:must(?:\s+not)?|never|always|do\s+not|don't|shall\s+not)\b/i
const ACTOR_POLICY =
  /\b(?:you|we|agents?|workers?|operators?|users?|maintainers?)\s+(?:must(?:\s+not)?|should(?:\s+not)?|need\s+to|shall(?:\s+not)?|cannot|can't|may\s+not)\b/i
const BEHAVIORAL_WHEN_CLAUSE =
  /\bwhen\s+(?:you(?:'re|\s+are)?|we(?:'re|\s+are)?|told|asked|requested|working|debugging|reviewing|checking|verifying|investigating|using|running|editing|changing)\b/i
const WORKFLOW_IMPERATIVE =
  /(?:^|[.!?]\s+|\n\s*)(?:[-*]\s+|\d+[.)]\s+)?(?:please\s+)?(?:run|use|check|ask|avoid|prefer|ensure|keep|follow|brief|report|inspect|search|open|read|review|validate|confirm|delegate|stop|start|remember)\b/i
const DECISION_AUTHORITY =
  /\b(?:the\s+)?(?:user|operator|maintainer|owner)\s+(?:decides|chooses|approves|has\s+(?:the\s+)?final\s+say)\b/i

/**
 * True when a PROJECT_RULES row is phrased as an instruction.
 *
 * Only `PROJECT_RULES` is gated: an imperative ARCHITECTURE note ("always call
 * this through the wrapper") is still a statement about the code, and merging it
 * is an ordinary dedup.
 */
export function isDirectiveShapedProjectRule(category: string, content: string): boolean {
  if (category !== PROJECT_RULES_CATEGORY) return false
  const text = content.trim()
  if (text.length === 0) return false
  return (
    POLICY_SENTENCE_START.test(text)
    || ACTOR_POLICY.test(text)
    || BEHAVIORAL_WHEN_CLAUSE.test(text)
    || WORKFLOW_IMPERATIVE.test(text)
    || DECISION_AUTHORITY.test(text)
  )
}

export type CurateVerdict = 'merge' | 'archive'
export type CurateRefusalReason =
  | 'missing-active-same-category-successor'
  | 'user-profile-is-not-project-memory'
  | 'directive-shaped-project-rule'
  | 'content-loss'

export interface CurateRefusal {
  readonly memoryId: number
  readonly verdict: CurateVerdict
  readonly reason: CurateRefusalReason
  readonly originalChars?: number
  readonly replacementChars?: number
}

/** The minimum a row must expose for the gate to judge it. */
export interface CurateCandidateRow {
  readonly id: number
  readonly category: string
  readonly content: string
  readonly status: string
  readonly supersededByMemoryId: number | null
  readonly expiresAt?: number | null
}

/**
 * Is `successor` a row that will still be readable after this mutation?
 *
 * Every clause matters: a different row (not itself), live (not archived), not
 * already superseded, unexpired, same project (the caller passes only its own
 * rows, so that is implied), and same category — because a merged fact that
 * changes category changes which memory block renders it.
 */
function isSurvivingSuccessor(memory: CurateCandidateRow, successor: CurateCandidateRow | null, now: number): successor is CurateCandidateRow {
  if (successor === null) return false
  if (successor.id === memory.id) return false
  if (successor.status !== 'active' && successor.status !== 'permanent') return false
  if (successor.supersededByMemoryId !== null) return false
  if (successor.expiresAt !== undefined && successor.expiresAt !== null && successor.expiresAt <= now) return false
  return successor.category === memory.category
}

/**
 * The gate. Returns the refusal, or null when the mutation may proceed.
 *
 * `successor` is the row this one is being folded INTO. A pure `archive` with no
 * successor is the "this memory is wrong, drop it" case — allowed only for a row
 * whose content is not a directive, because a dropped rule is a behaviour change
 * disguised as cleanup.
 */
export function assessCurateMutationSafety(args: {
  readonly memory: CurateCandidateRow
  readonly verdict: CurateVerdict
  /** The reason text the model gave — scanned for a user-profile citation. */
  readonly reason?: string
  readonly replacementContent?: string
  readonly successor: CurateCandidateRow | null
  readonly now: number
}): CurateRefusal | null {
  const { memory, verdict, successor } = args

  if (verdict === 'archive') {
    // A merge-style archive must land somewhere. (An archive with NO successor
    // is the deliberate-drop case, which rule 3 still guards.)
    if (successor !== null && !isSurvivingSuccessor(memory, successor, args.now)) {
      return { memoryId: memory.id, verdict, reason: 'missing-active-same-category-successor' }
    }
    if (
      successor === null
      && args.reason !== undefined
      && PROJECT_SCOPED_CATEGORIES.has(memory.category)
      && USER_PROFILE_REFERENCE.test(args.reason)
    ) {
      return { memoryId: memory.id, verdict, reason: 'user-profile-is-not-project-memory' }
    }
  }

  if (isDirectiveShapedProjectRule(memory.category, memory.content)) {
    return { memoryId: memory.id, verdict, reason: 'directive-shaped-project-rule' }
  }

  if (verdict === 'merge') {
    if (successor === null || !isSurvivingSuccessor(memory, successor, args.now)) {
      return { memoryId: memory.id, verdict, reason: 'missing-active-same-category-successor' }
    }
    const originalChars = memory.content.trim().length
    const replacementChars = args.replacementContent?.trim().length ?? 0
    // Half is the line: a rewrite that keeps most of the text is a tightening,
    // one that keeps less than half is a replacement wearing a merge's clothes.
    if (replacementChars * 2 < originalChars) {
      return {
        memoryId: memory.id,
        verdict,
        reason: 'content-loss',
        originalChars,
        replacementChars,
      }
    }
  }

  return null
}
