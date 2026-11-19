/**
 * The served check: what each session last sent to its provider, and how a later
 * request differs from it.
 *
 * ## What this measures
 *
 * Upstream's invariant (`hooks/magic-context/served-check.ts`, added after
 * v0.49.41) is one sentence: **a pass without rebuild permission must only
 * APPEND to the request served before it.** Any other change — an edited
 * placeholder, a stripped reasoning part, a re-rendered baseline head, a message
 * removed from the middle — invalidates the provider's cached prefix, and the next
 * request pays full price for history that did not need to move.
 *
 * This module measures how often that happens here and where. **It changes no
 * byte and no decision.** It exists because the cache-miss report answers "how
 * much was lost", never "who spent it": measured 2026-11-19, 59 of 1,118 pairs
 * accounted for 92% of misses, all of them idle gaps past the provider's 5-minute
 * TTL — which accounts for the gaps, not for whether our own edits break cacheable
 * prefixes *within* a burst.
 *
 * ## Tier 1 only: shape, never content
 *
 * Upstream runs two tiers. Tier 1 mixes each message's id, role, part count and
 * per-part (id, type, string lengths); it reads lengths and hashes nothing, so it
 * is cheap enough for every message of every pass. Tier 2 digests content on
 * replays and every 100th pass to sample Tier 1's blind spot.
 *
 * This port implements Tier 1. It catches every edit that changes a length or a
 * part — a drop placeholder (shorter text), a stripped reasoning block (a part
 * disappears), a re-rendered baseline head (different text length), a message
 * added or removed. It cannot see an edit that preserves every length, which is
 * the same blind spot upstream documents; Tier 2 would cover it and is
 * deliberately absent because this adapter has no replay path to hook it to.
 *
 * ## What is compared against what
 *
 * `noteServed` records the surface AFTER a pass, together with whether that pass
 * had rebuild permission. `compareServed` then answers, for the next request:
 * did the bytes the previous request sent survive?
 *
 * A session this process has not served has no record; its state is unknown,
 * never equal. Same after a restart — the map is per-process on purpose, because a
 * persisted "last served" would claim knowledge the process does not have.
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { enumerateSurfaceNodes } from '../dsh/seams.ts'

/** One message's shape: identity, role, part count, and total text length. */
export interface MessageShape {
  readonly id: number
  readonly type: string
  readonly parts: number
  /** Total length of the text a provider would read for this message. */
  readonly textLength: number
}

export interface ServedRecord {
  readonly shapes: readonly MessageShape[]
  /** Whether the pass that produced this record was allowed to rebuild. */
  readonly hadRebuildPermission: boolean
  readonly at: number
}

export interface ServedComparison {
  /** False when nothing is recorded for this session yet (unknown ≠ equal). */
  readonly known: boolean
  /** Whether every message the record held still matches at the same index. */
  readonly prefixIntact: boolean
  /** Index of the first message whose shape differs, when the prefix broke. */
  readonly firstChangeIndex?: number
  /** Messages present now beyond the recorded length. */
  readonly appended: number
  /** A shape changed and nothing was appended: history edited in place. */
  readonly rewroteInPlace: boolean
  /** Whether the PREVIOUS pass had permission, which excuses a rewrite. */
  readonly previousHadPermission: boolean
}

/**
 * Per-process records.
 *
 * Not persisted: after a restart this process has served nothing, and a stored
 * record would let it claim "prefix intact" about bytes it never sent.
 */
const served = new Map<string, ServedRecord>()

/** The per-message shapes of a surface, in order. */
export function surfaceShapes(session: Session): MessageShape[] {
  return enumerateSurfaceNodes(session).map(node => ({
    // `seq` is a number in this adapter's surface model.
    id: Number(node.seq),
    type: node.type,
    parts: node.hasToolCalls ? 2 : 1,
    textLength: node.text.length,
  }))
}

/**
 * A 32-bit FNV-1a of the shapes.
 *
 * Not cryptographic on purpose: this answers "did the shape change", and a
 * collision can only hide one change, never invent one. It exists for the journal
 * row, so two passes can be compared by eye without dumping every message.
 */
export function shapeFingerprint(shapes: readonly MessageShape[]): string {
  let hash = 0x811c9dc5
  const mix = (value: number): void => {
    hash ^= value & 0xff
    hash = Math.imul(hash, 0x01000193)
    hash ^= (value >>> 8) & 0xff
    hash = Math.imul(hash, 0x01000193)
    hash ^= (value >>> 16) & 0xff
    hash = Math.imul(hash, 0x01000193)
    hash ^= (value >>> 24) & 0xff
    hash = Math.imul(hash, 0x01000193)
  }
  for (const shape of shapes) {
    mix(shape.id)
    mix(shape.type.length)
    mix(shape.parts)
    mix(shape.textLength)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function noteServed(
  sessionId: string,
  session: Session,
  hadRebuildPermission: boolean,
  now: number,
): ServedRecord {
  const record: ServedRecord = {
    shapes: surfaceShapes(session),
    hadRebuildPermission,
    at: now,
  }
  served.set(sessionId, record)
  return record
}

export function servedRecord(sessionId: string): ServedRecord | undefined {
  return served.get(sessionId)
}

export function forgetServed(sessionId: string): void {
  served.delete(sessionId)
}

/**
 * Compare the current surface against what this session last served.
 *
 * The prefix is compared message by message so the answer names WHERE the request
 * stopped matching, not only that it did. That distinction is the whole point: a
 * suffix that grew is the healthy case (the pass appended), and a broken prefix
 * with nothing appended is history edited in place — the expensive case, and one
 * that is invisible in every other metric because the request still succeeds, just
 * slower and dearer.
 */
export function compareServed(sessionId: string, session: Session): ServedComparison {
  const record = served.get(sessionId)
  const shapes = surfaceShapes(session)
  if (record === undefined) {
    return {
      known: false,
      prefixIntact: false,
      appended: shapes.length,
      rewroteInPlace: false,
      previousHadPermission: false,
    }
  }
  const previous = record.shapes
  const shared = Math.min(previous.length, shapes.length)
  let firstChangeIndex: number | undefined
  for (let index = 0; index < shared; index += 1) {
    const before = previous[index] as MessageShape
    const after = shapes[index] as MessageShape
    if (before.type === after.type && before.parts === after.parts && before.textLength === after.textLength) {
      continue
    }
    firstChangeIndex = index
    break
  }
  const appended = Math.max(0, shapes.length - previous.length)
  const prefixIntact = firstChangeIndex === undefined
  return {
    known: true,
    prefixIntact,
    ...firstChangeIndex === undefined ? {} : { firstChangeIndex },
    appended,
    rewroteInPlace: !prefixIntact && appended === 0,
    previousHadPermission: record.hadRebuildPermission,
  }
}
