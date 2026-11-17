/**
 * Cross-process lease on a session's compartment state.
 *
 * The adapter already serialises passes *within* one process: `historian.ts`
 * keeps an `inFlight` promise per session, so a second pass on the same session
 * awaits the first instead of interleaving with it. That guard cannot see a
 * second process, and two writers are real here — the host can remount the
 * plugin (HMR / profile reload) while a pass is still running, and a second agent
 * session on the same machine opens the same `dsh-magic-context.db`.
 *
 * What a lost race costs: both passes read the same `baseline_state`, both write
 * a compartment, and one of them records a baseline whose predecessor no longer
 * exists. The next pass then renders m[0] from a history that never happened.
 *
 * Ported from upstream `compartment-lease.ts` (137 lines). Two deliberate
 * differences:
 *
 * - **PID liveness.** Upstream calls `isPidAlive()` from its RPC layer and
 *   reclaims a dead owner's row immediately. Node exposes the same check
 *   portably as `process.kill(pid, 0)`; EPERM means the process exists but is
 *   not ours, which still counts as alive.
 * - **No sessionLog dependency.** The caller passes a logger, so this module
 *   stays free of the journal's shape.
 *
 * The TTL is the real safety net: a crashed holder's row expires after
 * `COMPARTMENT_LEASE_TTL_MS` whether or not liveness detection works, so a
 * failed reclaim only delays the next writer rather than wedging it.
 */

/** How long a lease stays valid without renewal. */
export const COMPARTMENT_LEASE_TTL_MS = 5 * 60 * 1000
/** How often a long pass must renew to keep the lease. */
export const COMPARTMENT_LEASE_RENEWAL_MS = 60 * 1000

export interface LeaseAcquired {
  readonly sessionId: string
  readonly holderId: string
  readonly acquiredAt: number
  readonly expiresAt: number
  readonly ownerPid: number
}

export interface CompartmentLeaseBlocker {
  readonly holderId: string
  readonly ownerPid: number | null
  readonly acquiredAt: number
  readonly expiresAt: number
}

/** The three lifecycle methods a lease holder needs; `id` identifies this holder. */
export interface CompartmentLease {
  readonly id: string
  /** Acquire, or take over an expired / dead-owner lease. Null when someone else holds it. */
  acquire(sessionId: string): LeaseAcquired | null
  /** Extend a lease this holder still owns. False means it was lost. */
  renew(sessionId: string): boolean
  /** Drop the lease. A failed release is safe: the row expires on its TTL. */
  release(sessionId: string): void
  /** Current blocker for a session, or null when nobody holds a live lease. */
  blocker(sessionId: string): CompartmentLeaseBlocker | null
  /** Whether THIS holder still owns a live lease. */
  heldBy(sessionId: string): boolean
}

/** Minimal database surface, so the module can be tested without SQLite. */
export interface LeaseDatabase {
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    run(...params: unknown[]): { changes: number | bigint }
  }
  exec(sql: string): void
}

/**
 * Is a process alive? `process.kill(pid, 0)` sends no signal — it only performs
 * the permission/existence check. ESRCH means gone; EPERM means alive but owned
 * by another user, which is still alive for our purposes.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM'
  }
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS compartment_state_lease(
  session_id TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`

export interface CompartmentLeaseOptions {
  readonly db: LeaseDatabase
  /** Holder identity. Defaults to `<pid>-<random>`; tests pin it. */
  readonly holderId?: string
  /** Clock, injectable for tests. */
  readonly now?: () => number
  /** Optional diagnostic sink. */
  readonly log?: (sessionId: string, message: string) => void
  /** Liveness probe, injectable for tests. */
  readonly pidAlive?: (pid: number) => boolean
}

export function openCompartmentLease(options: CompartmentLeaseOptions): CompartmentLease {
  const { db } = options
  const now = options.now ?? Date.now
  const pidAlive = options.pidAlive ?? isPidAlive
  const log = options.log ?? (() => {})
  const holderId = options.holderId ?? `${String(process.pid)}-${Math.random().toString(36).slice(2, 10)}`

  db.exec(CREATE_TABLE_SQL)

  const blocker = (sessionId: string): CompartmentLeaseBlocker | null => {
    const row = db.prepare(
      `SELECT holder_id AS holderId, owner_pid AS ownerPid,
              acquired_at AS acquiredAt, expires_at AS expiresAt
         FROM compartment_state_lease
        WHERE session_id = ? AND expires_at > ?`,
    ).get(sessionId, now()) as CompartmentLeaseBlocker | undefined
    return row ?? null
  }

  const acquire = (sessionId: string): LeaseAcquired | null => {
    const acquiredAt = now()
    const expiresAt = acquiredAt + COMPARTMENT_LEASE_TTL_MS
    const ownerPid = process.pid

    // Reclaim a lease whose owner is gone: waiting out its TTL would stall a
    // session for up to five minutes after a crash. The delete is fenced on
    // every column we read, so a lease that changed hands in between survives.
    const existing = blocker(sessionId)
    if (existing !== null && existing.ownerPid !== null && !pidAlive(existing.ownerPid)) {
      const reclaimed = db.prepare(
        `DELETE FROM compartment_state_lease
          WHERE session_id = ? AND holder_id = ? AND owner_pid = ?
            AND acquired_at = ? AND expires_at = ?`,
      ).run(sessionId, existing.holderId, existing.ownerPid, existing.acquiredAt, existing.expiresAt)
      if (Number(reclaimed.changes) === 1) {
        log(sessionId, `reclaimed compartment lease from dead owner holder=${existing.holderId} pid=${String(existing.ownerPid)}`)
      }
    }

    // One statement does the work: insert, or take over only when this holder
    // already owns the row or the row has expired. A live lease held by someone
    // else makes the WHERE fail, so `changes` is 0.
    const result = db.prepare(
      `INSERT INTO compartment_state_lease
          (session_id, holder_id, owner_pid, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
          holder_id = excluded.holder_id,
          owner_pid = excluded.owner_pid,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at
       WHERE compartment_state_lease.holder_id = excluded.holder_id
          OR compartment_state_lease.expires_at <= ?`,
    ).run(sessionId, holderId, ownerPid, acquiredAt, expiresAt, acquiredAt)

    if (Number(result.changes) !== 1) return null
    return { sessionId, holderId, acquiredAt, expiresAt, ownerPid }
  }

  const renew = (sessionId: string): boolean => {
    const at = now()
    const result = db.prepare(
      `UPDATE compartment_state_lease
          SET expires_at = ?, acquired_at = ?
        WHERE session_id = ? AND holder_id = ? AND expires_at > ?`,
    ).run(at + COMPARTMENT_LEASE_TTL_MS, at, sessionId, holderId, at)
    return Number(result.changes) === 1
  }

  const release = (sessionId: string): void => {
    try {
      db.prepare('DELETE FROM compartment_state_lease WHERE session_id = ? AND holder_id = ?')
        .run(sessionId, holderId)
    } catch (error) {
      // Losing a release is safe: the row expires on its TTL. Turning transient
      // SQLite contention into a thrown error would fail a completed pass.
      log(sessionId, `lease release failed (${error instanceof Error ? error.message : String(error)}); row expires on its TTL`)
    }
  }

  const heldBy = (sessionId: string): boolean =>
    db.prepare(
      'SELECT 1 AS held FROM compartment_state_lease WHERE session_id = ? AND holder_id = ? AND expires_at > ?',
    ).get(sessionId, holderId, now()) !== undefined

  return { id: holderId, acquire, renew, release, blocker, heldBy }
}
