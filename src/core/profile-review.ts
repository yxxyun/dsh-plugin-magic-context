/**
 * WP7 — the `user` domain's REVIEW pass.
 *
 * Candidates (WP5) become profile rows (`user_memories`) that render into m[0]
 * (WP8). Magic Context does this in a daily `review-user-memories` task that
 * needs a session-scoped dreamer; DSH has no such thing, so the pass rides the
 * existing maintenance tick and is throttled by a stored timestamp instead.
 *
 * Four rules carry the design, each of them a divergence or a defect fix:
 *
 *  1. **The candidate TTL does NOT live inside the review.** Upstream runs its
 *     30-day decay inside the review task, so switching the review off — or
 *     having no LLM route at all — means candidates are never cleaned and the
 *     pool grows without bound. Here expiry runs first, unconditionally, before
 *     any of the reasons that can skip the review.
 *  2. **Failure is closed, and it is closed on the WHOLE verdict.** A truncated
 *     or unparsable answer promotes nothing and consumes nothing: the candidates
 *     stay for the next tick, which is always cheaper than acting on half a
 *     judgement.
 *  3. **Consumption is a UNION, never just what the model listed.** A candidate
 *     is consumed when the model names it, when its content is what got
 *     promoted, or when the model rejects it — and a candidate whose content is
 *     already promoted is consumed even though the promotion itself is skipped
 *     as a duplicate. A model that forgets `consume_candidate_ids` therefore
 *     cannot make the same candidate be re-judged forever.
 *  4. **Candidates are consumed only for promotions that actually landed.**
 *     Deleting the inputs of a failed INSERT would lose the observation with
 *     nothing to show for it.
 *  5. **A decided pass is never silent.** A skip that means "nothing to do
 *     yet" (no-candidates / too-few / too-few-sessions) journals one info row
 *     AND stamps the daily throttle, so the pass leaves exactly one
 *     profile-review row per interval: a quiet journal can never again be read
 *     as "the lane is dead", and a persistent skip cannot spam every tick.
 *     Failed attempts (llm-off / llm-failed / invalid-output) stamp nothing,
 *     so they stay retried on the next tick.
 */

import type { Journal } from './journal.ts'
import type { ProfileCandidateRow, ProfileWriter } from './profile-write.ts'
import { LlmDeadlineError, withDeadline } from './llm-deadline.ts'
import { errText } from './types.ts'

/** The review LLM seam: the same call shape the maintenance tick uses. */
export interface ProfileReviewLlm {
  stream(options: {
    readonly provider: string
    readonly model: string
    readonly messages: readonly {
      readonly role: string
      readonly content: readonly { readonly type: string; readonly text: string }[]
    }[]
    readonly maxTokens: number
    readonly sessionId: string
    readonly purpose: 'compaction'
    readonly signal?: AbortSignal
  }): AsyncIterable<unknown>
}

/** Candidates needed before a review is worth an LLM call. */
export const PROFILE_REVIEW_THRESHOLD = 3
/**
 * Distinct SESSIONS the supporting candidates must come from before a profile
 * row may be promoted (2026-10-16 user decision; execution plan §8 C-0).
 *
 * The profile is injected into EVERY session, so the failure mode is one
 * talkative session turning its own quirk into a standing rule for all of them.
 * Upstream MC guards this with cross-session recurrence; the `org` domain has
 * the symmetric gate (`distinct_identities >= 2`), while this pass only counted
 * the pool size — three near-identical observations from ONE session could
 * promote. Counting distinct sessions closes that hole symmetrically.
 */
export const PROFILE_REVIEW_MIN_SESSIONS = 2
/** At most one review per day (MC's cadence, without MC's scheduler). */
export const PROFILE_REVIEW_INTERVAL_MS = 24 * 60 * 60 * 1000
/** MC's candidate TTL, enforced by expiry regardless of the switch. */
export const PROFILE_CANDIDATE_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Candidates read per review — bounded so one tick cannot become a batch job. */
/**
 * Candidates per review call.
 *
 * 12, not 40. Measured 2026-11-17 against a real profile with 40 waiting: every
 * run finished with `finish max-tokens` and ZERO text deltas at an 8192 ceiling —
 * the reasoning phase consumed the entire output budget before emitting any
 * verdict. The prompt was ~10k tokens of candidate text and the model was asked
 * to weigh all 40 at once, so it thought until it ran out. A smaller batch both
 * shortens the reasoning and gives the verdicts room; the pool drains over
 * several daily runs instead of one.
 */
export const PROFILE_REVIEW_BATCH = 12

/**
 * The meta key holding the last candidate id a pass judged.
 *
 * The queue has to advance even though a "keep" does not consume the row: with
 * 141 candidates waiting and a 12-row batch, ordering by position and always
 * starting at the beginning offered the same 12 every run and left the rest
 * unreachable. `reviewed_at` was the first attempt; it failed because the
 * candidates table lives in the memory store, which this adapter never migrates,
 * so the ALTER hit nothing while the schema version still advanced.
 */
export const PROFILE_REVIEW_CURSOR_KEY = 'profile:review:cursor'
/** Output cap for the verdict. */
/**
 * Output ceiling for one review call.
 *
 * 8192, not 4096: this lane writes a JSON verdict per candidate, and it is the
 * only model call in the adapter that was still at 4096 while `classify-memories`
 * and `curate` had both moved to 8192. Measured 2026-11-17 on a real profile —
 * 40 candidates waiting, two consecutive runs failing with "no text deltas" —
 * the stream finished without emitting a single text chunk, which is what a
 * reasoning model running out of budget inside its reasoning phase looks like.
 * The failure was silent in a way that mattered: it is retried each tick, so the
 * pool simply never drains.
 */
/**
 * Output ceiling for one review call.
 *
 * Raised from 4096 to 16384 after the fix above landed and still truncated:
 * `finish max-tokens` with zero text deltas means the budget went entirely to
 * reasoning. 16384 covers a 12-candidate judgement plus its thinking; if a future
 * model thinks longer, the diagnostic now names the finish reason so the next
 * adjustment is a one-line change rather than a mystery.
 */
export const PROFILE_REVIEW_MAX_TOKENS = 16_384
/**
 * Wall-clock budget for the review round trip, for the same reason the verify
 * lane has one: the review rides the maintenance tick, and a stream that never
 * settles would hold that lane only execution slot forever.
 */
export const PROFILE_REVIEW_TIMEOUT_MS = 120_000
/** A promoted profile row is a standing rule; longer than this is not one. */
export const PROFILE_MAX_CONTENT_CHARS = 800
/**
 * Adapter-meta key holding when a review pass last reached a DECIDED state —
 * a run, or a nothing-to-do skip (rule 5 above). The throttled timestamp
 * lives here rather than in the contract: it is our scheduling state, not
 * Magic Context's data, and writing it must not touch the shared store.
 */
export const PROFILE_REVIEW_META_KEY = 'profile_last_review_at'

export const PROFILE_REVIEW_INSTRUCTION = [
  'You maintain a USER PROFILE: statements about the user that stay true across projects.',
  'You are given candidate observations collected from past sessions. Decide which belong in the profile.',
  '',
  'Return ONLY one JSON object, no prose, no code fences:',
  '{',
  '  "promote": [{ "content": "...", "consume_candidate_ids": [1, 2] }],',
  '  "reject": [3]',
  '}',
  '',
  'Rules:',
  '- "promote" holds ONE entry per distinct standing fact. Merge near-duplicates into a single entry and put',
  '  EVERY candidate id that fed it into "consume_candidate_ids".',
  '- Treat the user as the subject. Project-specific facts (paths, module names, one-off incidents) do NOT',
  '  belong here: reject them.',
  '- Promoted content must be a standalone statement that reads correctly with no other context.',
  '- "reject" lists candidate ids that will never be promoted.',
  '- Every candidate id you were given must appear either in some "consume_candidate_ids" or in "reject".',
  '- If nothing qualifies, return {"promote":[],"reject":[]}. Never invent candidates.',
].join('\n')

/** Case/whitespace-insensitive form used for duplicate detection. */
export function normalizeProfileContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, ' ').trim()
}

export interface ProfileReviewVerdict {
  readonly promote: ReadonlyArray<{
    readonly content: string
    readonly consumeCandidateIds: readonly number[]
  }>
  readonly reject: readonly number[]
}

/**
 * Parse the review answer, fail-closed.
 *
 * The three failure modes the plan names — truncated JSON, no output, invalid
 * JSON — all return `undefined`, and the caller then promotes and consumes
 * nothing. Entries missing usable content are dropped individually (they cannot
 * be promoted either way); a malformed `promote`/`reject` CONTAINER fails the
 * whole verdict, because a partially-read verdict is a partially-applied
 * judgement.
 */
export function parseProfileReviewOutput(text: string): ProfileReviewVerdict | undefined {
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')
  if (open === -1 || close <= open) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(open, close + 1))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const rawPromote = record.promote
  const rawReject = record.reject
  if (rawPromote !== undefined && !Array.isArray(rawPromote)) return undefined
  if (rawReject !== undefined && !Array.isArray(rawReject)) return undefined
  const promote: Array<{ content: string; consumeCandidateIds: number[] }> = []
  for (const entry of (rawPromote ?? []) as unknown[]) {
    if (entry === null || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const content = typeof row.content === 'string' ? row.content.trim() : ''
    if (content === '') continue
    const ids = Array.isArray(row.consume_candidate_ids)
      ? (row.consume_candidate_ids as unknown[]).filter((id): id is number => Number.isInteger(id))
      : []
    promote.push({
      content: content.length > PROFILE_MAX_CONTENT_CHARS ? content.slice(0, PROFILE_MAX_CONTENT_CHARS) : content,
      consumeCandidateIds: ids,
    })
  }
  const reject = Array.isArray(rawReject)
    ? (rawReject as unknown[]).filter((id): id is number => Number.isInteger(id))
    : []
  return { promote, reject }
}

export interface ProfileReviewPlan {
  readonly promotions: ReadonlyArray<{
    readonly content: string
    readonly consume: readonly number[]
  }>
  readonly consumed: readonly number[]
}

/**
 * Turn a verdict into writes and deletions. Pure, so the union rule is testable
 * without a database or a model. See the rule list at the top of the file.
 */
export function planProfileReview(input: {
  readonly candidates: readonly ProfileCandidateRow[]
  readonly existing: readonly string[]
  readonly verdict: ProfileReviewVerdict
}): ProfileReviewPlan {
  const sent = new Map(input.candidates.map(row => [row.id, row] as const))
  const byContent = new Map<string, number[]>()
  for (const row of input.candidates) {
    const key = normalizeProfileContent(row.content)
    byContent.set(key, [...(byContent.get(key) ?? []), row.id])
  }
  const already = new Set(input.existing.map(normalizeProfileContent))
  const consumed = new Set<number>()
  const promotions: Array<{ content: string; consume: number[] }> = []
  for (const entry of input.verdict.promote) {
    const key = normalizeProfileContent(entry.content)
    // Named ids and content matches are BOTH consumed, and both are collected
    // even when the promotion itself is skipped as a duplicate: a candidate
    // already represented in the profile must not be re-judged forever.
    const own = [...new Set([
      ...entry.consumeCandidateIds.filter(id => sent.has(id)),
      ...(byContent.get(key) ?? []),
    ])].sort((left, right) => left - right)
    for (const id of own) consumed.add(id)
    if (key === '' || already.has(key)) continue
    already.add(key)
    promotions.push({ content: entry.content, consume: own })
  }
  for (const id of input.verdict.reject) {
    if (sent.has(id)) consumed.add(id)
  }
  return { promotions, consumed: [...consumed].sort((left, right) => left - right) }
}

export interface ProfileReviewOutcome {
  readonly expired: number
  readonly ran: boolean
  /**
   * The pass reached a decided state — a run, or a skip that means "nothing
   * to do yet" — so the caller stamps the daily throttle (rule 5). Failed
   * attempts never set it: they must retry on the next tick instead of being
   * silenced for a day by their own failure.
   */
  readonly attempted?: boolean
  readonly promoted: number
  readonly consumed: number
  /**
   * Candidates the model looked at and left alone.
   *
   * Reported separately from `promoted`/`consumed` because "0 promoted" alone is
   * ambiguous in a way that matters operationally: it reads the same whether the
   * model judged twelve candidates and kept every one, or never called the model
   * at all. Measured 2026-11-17 — a run reported `promoted 0, consumed 0` after a
   * successful call, and the only way to tell it apart from the earlier failures
   * was the absence of a warn line.
   */
  readonly kept?: number
  readonly reason?:
    | 'writer-unavailable'
    | 'no-candidates'
    | 'too-few'
    | 'too-few-sessions'
    | 'throttled'
    | 'llm-off'
    | 'llm-failed'
    | 'invalid-output'
}

export interface ProfileReviewDeps {
  readonly writer: ProfileWriter | undefined
  readonly llm?: ProfileReviewLlm
  readonly route?: { readonly provider: string; readonly model: string }
  /**
   * Adapter store, for the review cursor only.
   *
   * The candidates table belongs to the upstream memory store, which this adapter
   * reads but does not migrate — so "which rows has a pass already judged" cannot
   * be a column here. It is a single `meta` key in the adapter's own store
   * instead: the id of the last candidate a pass looked at.
   */
  readonly stores?: { getMeta(key: string): string | undefined; setMeta(key: string, value: string): void }
  readonly sessionId: string
  readonly journal: Journal
  readonly now?: () => number
  /** When a review last RAN (adapter meta), for the daily throttle. */
  readonly lastReviewAt?: number
  readonly threshold?: number
  readonly batch?: number
  /** Distinct sessions the batch must span. Defaults to PROFILE_REVIEW_MIN_SESSIONS. */
  readonly minSessions?: number
  /** Wall-clock budget for the review call. Defaults to {@link PROFILE_REVIEW_TIMEOUT_MS}. */
  readonly reviewTimeoutMs?: number
}

/** One LLM call, collected by block index — the same shape the tick uses. */
async function collectText(
  llm: ProfileReviewLlm,
  route: { readonly provider: string; readonly model: string },
  sessionId: string,
  prompt: string,
  budgetMs: number,
): Promise<{ ok: true; text: string; usage?: Record<string, number> } | { ok: false; why: string }> {
  try {
    return await withDeadline(async (signal) => {
    const byIndex = new Map<number, string>()
    let usage: Record<string, number> | undefined
    const chunks = llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: PROFILE_REVIEW_MAX_TOKENS,
      sessionId,
      purpose: 'compaction',
      signal,
    })
    let finishKind: string | undefined
    for await (const raw of chunks) {
      const chunk = raw as { type?: string; index?: number; text?: string; reason?: { kind?: string; failure?: { message?: string } } }
      if (chunk.type === 'text-delta' && typeof chunk.index === 'number' && typeof chunk.text === 'string') {
        byIndex.set(chunk.index, (byIndex.get(chunk.index) ?? '') + chunk.text)
      } else if (chunk.type === 'usage') {
        const reported = (raw as { usage?: Record<string, unknown> }).usage
        const numeric: Record<string, number> = {}
        for (const [key, value] of Object.entries(reported ?? {})) {
          if (typeof value === 'number') numeric[key] = value
        }
        usage = numeric
      } else if (chunk.type === 'finish') {
        const kind = chunk.reason?.kind
        finishKind = kind
        if (kind === 'error' || kind === 'aborted') {
          return { ok: false, why: `stream finished (${kind})${chunk.reason?.failure?.message === undefined ? '' : `: ${chunk.reason.failure.message}`}` }
        }
      }
    }
    const text = [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join('')
    if (text.trim().length === 0) {
      // Naming the finish reason is the difference between "the model said
      // nothing" and "the stream ended before it could": `length` means the
      // maxTokens ceiling cut it off, `stop` with no deltas means an empty reply.
      // Measured 2026-11-17: this lane failed with a bare "no text deltas" and 40
      // candidates waiting, and the reason was not observable.
      const chunks = byIndex.size
      return {
        ok: false as const,
        why: `stream produced no text deltas`
          + (finishKind === undefined ? ' (stream never reported finish)' : ` (finish ${finishKind})`)
          + `, ${String(chunks)} text index(es), maxTokens ${String(PROFILE_REVIEW_MAX_TOKENS)}`,
      }
    }
    return { ok: true as const, text, ...usage === undefined ? {} : { usage } }
    }, budgetMs)
  } catch (error) {
    // A spent budget is reported like any other failed call (journaled by the
    // caller, retried next tick) — the point is that it is reported at all.
    return { ok: false, why: error instanceof LlmDeadlineError ? `deadline ${error.message}` : errText(error) }
  }
}

function renderCandidate(row: ProfileCandidateRow, nowMs: number): string {
  const ageDays = Math.max(0, Math.round((nowMs - row.createdAt) / 86_400_000))
  const text = row.content.replace(/\s+/g, ' ')
  return `- id ${String(row.id)} (age ${String(ageDays)}d): ${text}`
}

/**
 * Run one review. Never throws: every failure is journaled and the pool is left
 * exactly as it was, so the next tick sees the same candidates.
 */
export async function runProfileReview(deps: ProfileReviewDeps): Promise<ProfileReviewOutcome> {
  const now = (deps.now ?? Date.now)()
  const writer = deps.writer
  const empty = { expired: 0, ran: false, promoted: 0, consumed: 0 } as const
  if (writer === undefined || writer.status.ok !== true) {
    return { ...empty, reason: 'writer-unavailable' }
  }

  // (1) TTL FIRST, and unconditionally. Upstream's decay lives inside its review
  // task, so turning the review off (or having no route) leaks candidates
  // forever; here the pool is bounded no matter what happens below.
  const expired = writer.expireCandidates(now - PROFILE_CANDIDATE_TTL_MS)

  if (deps.llm === undefined || deps.route === undefined) {
    deps.journal.info('profile-review', `profile review skipped (no llm route); expired ${String(expired)}`, {
      expired,
      reason: 'llm-off',
    })
    return { ...empty, expired, reason: 'llm-off' }
  }
  if (deps.lastReviewAt !== undefined && now - deps.lastReviewAt < PROFILE_REVIEW_INTERVAL_MS) {
    return { ...empty, expired, reason: 'throttled' }
  }
  const threshold = Math.max(1, deps.threshold ?? PROFILE_REVIEW_THRESHOLD)
  const batch = Math.max(threshold, deps.batch ?? PROFILE_REVIEW_BATCH)
  // Paged by id, wrapping at the end: a pass that reaches the tail starts over at
  // the head, so a small pool is re-examined rather than starved.
  const cursorRaw = Number(deps.stores?.getMeta(PROFILE_REVIEW_CURSOR_KEY) ?? '')
  const cursor = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : 0
  let candidates = writer.listCandidatesAfter(cursor, batch)
  let wrapped = false
  if (candidates.length < batch && cursor > 0) {
    const head = writer.listCandidatesAfter(0, batch - candidates.length)
    candidates = [...candidates, ...head]
    wrapped = true
  }
  if (candidates.length === 0) {
    deps.journal.info('profile-review', `profile review skipped (no candidates); expired ${String(expired)}`, {
      expired,
      reason: 'no-candidates',
    })
    return { ...empty, expired, reason: 'no-candidates', attempted: true }
  }
  if (candidates.length < threshold) {
    deps.journal.info(
      'profile-review',
      `profile review skipped (${String(candidates.length)} candidate(s) below threshold ${String(threshold)}); expired ${String(expired)}`,
      { expired, candidates: candidates.length, threshold, reason: 'too-few' },
    )
    return { ...empty, expired, reason: 'too-few', attempted: true }
  }
  // Cross-session gate (see PROFILE_REVIEW_MIN_SESSIONS). Checked before the LLM
  // call: a batch contributed by a single session cannot promote anything, so
  // paying for a judgement on it would only burn tokens and produce a verdict
  // that must be discarded.
  const minSessions = Math.max(1, deps.minSessions ?? PROFILE_REVIEW_MIN_SESSIONS)
  const sessions = new Set(candidates.map(row => row.sessionId))
  if (sessions.size < minSessions) {
    deps.journal.info(
      'profile-review',
      `profile review skipped (candidates span ${String(sessions.size)} session(s), need ${String(minSessions)}); expired ${String(expired)}`,
      { candidates: candidates.length, sessions: sessions.size, reason: 'too-few-sessions' },
    )
    return { ...empty, expired, reason: 'too-few-sessions', attempted: true }
  }

  const prompt = PROFILE_REVIEW_INSTRUCTION + '\n\nCandidate observations:\n'
    + candidates.map(row => renderCandidate(row, now)).join('\n')
  const call = await collectText(deps.llm, deps.route, deps.sessionId, prompt, deps.reviewTimeoutMs ?? PROFILE_REVIEW_TIMEOUT_MS)
  if (!call.ok) {
    deps.journal.warn('profile-review', `profile review call failed (retried next tick): ${call.why}`, {
      candidates: candidates.length,
      why: call.why,
      route: `${deps.route.provider}/${deps.route.model}`,
    })
    return { ...empty, expired, reason: 'llm-failed' }
  }

  // (2) Fail closed on the whole verdict: nothing promoted, nothing consumed.
  const verdict = parseProfileReviewOutput(call.text)
  if (verdict === undefined) {
    deps.journal.warn('profile-review', 'profile review answer rejected (invalid JSON); candidates kept', {
      candidates: candidates.length,
      outputChars: call.text.length,
      outputTail: call.text.slice(-400),
    })
    return { ...empty, expired, reason: 'invalid-output' }
  }

  const existing = writer.listActiveProfiles().map(row => row.content)
  const plan = planProfileReview({ candidates, existing, verdict })
  const provenance = JSON.stringify({
    sessions: [...new Set(candidates.map(row => row.sessionId))],
    candidateIds: candidates.map(row => row.id),
  })
  // Per-promotion cross-session gate: the batch check above only proves that TWO
  // sessions contributed SOMETHING; a promotion must itself rest on more than one
  // session's observations. One that does not is held back here — and its
  // candidates are deliberately NOT consumed, so it can be judged again once
  // another session corroborates it.
  const byId = new Map(candidates.map(row => [row.id, row] as const))
  const kept: Array<{ content: string; consume: readonly number[] }> = []
  const heldBack: number[] = []
  for (const promotion of plan.promotions) {
    const spanned = new Set(
      promotion.consume
        .map(id => byId.get(id)?.sessionId)
        .filter((sid): sid is string => sid !== undefined),
    )
    if (spanned.size < minSessions) {
      heldBack.push(...promotion.consume)
      continue
    }
    kept.push(promotion)
  }
  if (heldBack.length > 0) {
    deps.journal.info(
      'profile-review',
      `profile review held back ${String(heldBack.length)} candidate(s): a promotion needs observations from ${String(minSessions)} session(s)`,
      { heldBack: [...new Set(heldBack)].sort((left, right) => left - right), reason: 'too-few-sessions' },
    )
  }
  const promotedIds: number[] = []
  const landed: number[] = []
  for (const promotion of kept) {
    const id = writer.promoteProfile({
      content: promotion.content,
      candidateIds: promotion.consume,
      promotedAt: now,
      provenance,
    })
    // (4) Only a promotion that LANDED may consume its inputs.
    if (id !== undefined) {
      promotedIds.push(id)
      landed.push(...promotion.consume)
    }
  }
  // Rejections are consumption by definition — the model said these never
  // become profile rows — so they are dropped whether or not anything promoted.
  const rejected = verdict.reject.filter(id => candidates.some(row => row.id === id))
  const toDelete = [...new Set([...landed, ...rejected])]
  const consumed = toDelete.length === 0 ? 0 : writer.deleteCandidates(toDelete)

  // Advance the cursor past the last row this pass judged. A "keep" is not
  // consumption, so this is the only thing that keeps the queue moving.
  const lastJudged = candidates[candidates.length - 1]?.id
  if (lastJudged !== undefined) {
    deps.stores?.setMeta(PROFILE_REVIEW_CURSOR_KEY, String(wrapped ? 0 : lastJudged))
  }
  const usage = call.usage !== undefined
    ? { inputTokens: call.usage.inputTokens ?? 0, outputTokens: call.usage.outputTokens ?? 0 }
    : undefined
  // Candidates the model saw and left alone: neither promoted nor rejected. This
  // is the number that makes "0 promoted" readable.
  const leftAlone = candidates.length - new Set([...landed, ...rejected]).size
  deps.journal.info(
    'profile-review',
    `profile review: ${String(promotedIds.length)} promoted, ${String(consumed)} candidate(s) consumed`
      + `, ${String(leftAlone)} kept`
      + `${expired > 0 ? `, ${String(expired)} expired` : ''}`,
    {
      ran: true,
      expired,
      candidates: candidates.length,
      promoted: promotedIds.length,
      promotedIds,
      consumed,
      rejected: rejected.length,
      kept: leftAlone,
      cursor: lastJudged ?? 0, wrapped,
      ...usage === undefined ? {} : { usage },
    },
  )
  return { expired, ran: true, attempted: true, promoted: promotedIds.length, consumed, kept: leftAlone }
}
