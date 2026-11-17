/**
 * TTL expiry: archive memories whose lifetime has lapsed.
 *
 * Upstream keeps this as a function called from the TOP of its `curate` task
 * (`task-executor.ts`: "Curate owns the TTL lifecycle transition"), not as a
 * separate scheduled job and not as part of a fixed-interval maintenance tick.
 * Two reasons that placement is right, and both apply here:
 *
 *  - **It is a lifecycle transition, not a verification.** An expired row and a
 *    merged-away row end in the same place — `archiveMemory` with a reason — so
 *    they share the mutation log, the sharing restore and the lease. Splitting
 *    them across two schedulers means two writers racing on the same rows.
 *  - **It needs the lease.** Archiving is a destructive write; running it from a
 *    30-minute unconditional tick meant it could fire while a curate or verify
 *    pass held the memory lease.
 *
 * The function is pure host-side: no model, no prompt, no tokens. It is exported
 * separately from the curate tick so it can be tested on its own and so the
 * caller decides the batch size.
 */

import type { MemoryWriter } from './memory-write.ts'

/** Rows archived per call. `listExpired` caps its own list too. */
export const EXPIRE_BATCH = 200

export interface ExpireOutcome {
  /** Rows whose TTL had lapsed and were found. */
  readonly candidates: number
  /** Rows actually archived (a row can vanish or be refused mid-loop). */
  readonly archived: number
  readonly reason?: 'writer-unavailable' | 'read-only'
}

/**
 * Archive every expired row of `identity`, up to `limit`.
 *
 * `archiveMemory` (the contract action) is used rather than raw SQL so the
 * mutation log records the transition: an expiry that bypassed the log would be
 * invisible to anything auditing why a memory disappeared.
 *
 * Failures are counted, not thrown: a single row that cannot be archived (a
 * concurrent delete, a fence) must not abort the batch — the next run picks up
 * whatever is left.
 */
export function archiveExpiredMemories(
  writer: MemoryWriter | undefined,
  identity: string | undefined,
  now: number,
  limit = EXPIRE_BATCH,
): ExpireOutcome {
  if (writer === undefined || identity === undefined || identity.length === 0) {
    return { candidates: 0, archived: 0, reason: 'writer-unavailable' }
  }
  if (writer.status.readOnly === true) return { candidates: 0, archived: 0, reason: 'read-only' }

  const candidates = writer.listExpired(identity, now, limit)
  if (candidates.length === 0) return { candidates: 0, archived: 0 }

  let archived = 0
  for (const id of candidates) {
    const result = writer.archiveMemory({ identity, id, reason: 'ttl-expired' })
    if (result.ok) archived += 1
  }
  return { candidates: candidates.length, archived }
}
