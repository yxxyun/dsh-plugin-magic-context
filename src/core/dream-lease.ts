/**
 * Cross-process lease on a background-task domain.
 *
 * Why this exists separately from `compartment-lease.ts`, which has the same
 * shape: the two guard different state with different lifetimes. A compartment
 * lease is per session and lives for one pass; a dream lease is per project and
 * per lease domain (`dream:memory:<project>`), and it must survive a long
 * `verify` that outlives a single turn. Sharing one table would mean one row
 * namespace for two unrelated concepts, and a session id could collide with a
 * lease key.
 *
 * What a lost race costs here is worse than a lost compartment race: two dreamer
 * processes both read the same memory rows, both decide to archive the same
 * entries, and the second one applies a verdict computed against state the first
 * already changed. `curate` merging a cluster that no longer exists is the
 * concrete failure.
 *
 * The TTL is the real safety net: a crashed holder's row expires after
 * `DREAM_LEASE_TTL_MS` whether or not liveness detection works, so a failed
 * reclaim only delays the next run rather than wedging the scheduler forever.
 */

import { isPidAlive } from './compartment-lease.ts'
import type { LeaseDatabase } from './compartment-lease.ts'

/** How long a lease stays valid without renewal. */
export const DREAM_LEASE_TTL_MS = 15 * 60 * 1000

export interface DreamLeaseAcquired {
  readonly leaseKey: string
  readonly holderId: string
  readonly acquiredAt: number
  readonly expiresAt: number
  readonly ownerPid: number
}

export interface DreamLeaseBlocker {
  readonly holderId: string
  readonly ownerPid: number
  readonly acquiredAt: number
  readonly expiresAt: number
}

export interface DreamLease {
  readonly id: string
  /** Acquire, or take over an expired / dead-owner lease. Null when held elsewhere. */
  acquire(leaseKey: string): DreamLeaseAcquired | null
  /** Extend a lease this holder still owns. False means it was lost. */
  renew(leaseKey: string): boolean
  /** Drop the lease. A failed release is safe: the row expires on its TTL. */
  release(leaseKey: string): void
  /** Current blocker for a key, or null when nobody holds a live lease. */
  blocker(leaseKey: string): DreamLeaseBlocker | null
  /** Whether THIS holder still owns a live lease. */
  heldBy(leaseKey: string): boolean
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS dream_lease(
  lease_key TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`

export interface DreamLeaseOptions {
  readonly db: LeaseDatabase
  /** Holder identity. Defaults to `<pid>-<random>`; tests pin it. */
  readonly holderId?: string
  readonly now?: () => number
  readonly log?: (leaseKey: string, message: string) => void
  readonly pidAlive?: (pid: number) => boolean
  /** Override for tests; production uses {@link DREAM_LEASE_TTL_MS}. */
  readonly ttlMs?: number
}

export function openDreamLease(options: DreamLeaseOptions): DreamLease {
  const { db } = options
  const now = options.now ?? Date.now
  const pidAlive = options.pidAlive ?? isPidAlive
  const log = options.log ?? (() => {})
  const ttlMs = options.ttlMs ?? DREAM_LEASE_TTL_MS
  const holderId = options.holderId ?? `${String(process.pid)}-${Math.random().toString(36).slice(2, 10)}`

  db.exec(CREATE_TABLE_SQL)

  const blocker = (leaseKey: string): DreamLeaseBlocker | null => {
    const row = db.prepare(
      `SELECT holder_id AS holderId, owner_pid AS ownerPid,
              acquired_at AS acquiredAt, expires_at AS expiresAt
         FROM dream_lease
        WHERE lease_key = ? AND expires_at > ?`,
    ).get(leaseKey, now()) as DreamLeaseBlocker | undefined
    return row ?? null
  }

  const acquire = (leaseKey: string): DreamLeaseAcquired | null => {
    const acquiredAt = now()
    const expiresAt = acquiredAt + ttlMs
    const ownerPid = process.pid

    // Reclaim a lease whose owner is gone: waiting out its TTL would stall the
    // scheduler for fifteen minutes after a crash. The delete is fenced on every
    // column we read, so a lease that changed hands in between survives.
    const existing = blocker(leaseKey)
    if (existing !== null && !pidAlive(existing.ownerPid)) {
      const reclaimed = db.prepare(
        `DELETE FROM dream_lease
          WHERE lease_key = ? AND holder_id = ? AND owner_pid = ?
            AND acquired_at = ? AND expires_at = ?`,
      ).run(leaseKey, existing.holderId, existing.ownerPid, existing.acquiredAt, existing.expiresAt)
      if (Number(reclaimed.changes) === 1) {
        log(leaseKey, `reclaimed dream lease from dead owner holder=${existing.holderId} pid=${String(existing.ownerPid)}`)
      }
    }

    // One statement does the work: insert, or take over only when this holder
    // already owns the row or the row has expired. A live lease held by someone
    // else makes the WHERE fail, so `changes` is 0.
    const result = db.prepare(
      `INSERT INTO dream_lease
          (lease_key, holder_id, owner_pid, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(lease_key) DO UPDATE SET
          holder_id = excluded.holder_id,
          owner_pid = excluded.owner_pid,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at
       WHERE dream_lease.holder_id = excluded.holder_id
          OR dream_lease.expires_at <= ?`,
    ).run(leaseKey, holderId, ownerPid, acquiredAt, expiresAt, acquiredAt)

    if (Number(result.changes) !== 1) return null
    return { leaseKey, holderId, acquiredAt, expiresAt, ownerPid }
  }

  const renew = (leaseKey: string): boolean => {
    const at = now()
    const result = db.prepare(
      `UPDATE dream_lease
          SET expires_at = ?, acquired_at = ?
        WHERE lease_key = ? AND holder_id = ? AND expires_at > ?`,
    ).run(at + ttlMs, at, leaseKey, holderId, at)
    return Number(result.changes) === 1
  }

  const release = (leaseKey: string): void => {
    try {
      db.prepare('DELETE FROM dream_lease WHERE lease_key = ? AND holder_id = ?').run(leaseKey, holderId)
    } catch (error) {
      // Losing a release is safe: the row expires on its TTL. Turning transient
      // SQLite contention into a thrown error would fail a completed run.
      log(leaseKey, `lease release failed (${error instanceof Error ? error.message : String(error)}); row expires on its TTL`)
    }
  }

  const heldBy = (leaseKey: string): boolean =>
    db.prepare(
      'SELECT 1 AS held FROM dream_lease WHERE lease_key = ? AND holder_id = ? AND expires_at > ?',
    ).get(leaseKey, holderId, now()) !== undefined

  return { id: holderId, acquire, renew, release, blocker, heldBy }
}
