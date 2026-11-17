/**
 * Cross-process compartment lease.
 *
 * The property that matters is mutual exclusion between two *processes*: the
 * in-process `inFlight` map already serialises passes inside one process, so a
 * lease that merely re-checked that would add nothing. Everything here is about
 * the second process:
 *
 *  - a live holder blocks a second acquirer;
 *  - an expired lease is taken over, so a crashed holder delays the next writer
 *    by at most its TTL;
 *  - a lease whose owner PID is gone is reclaimed immediately instead of waiting
 *    out that TTL;
 *  - renew and release are scoped to the holder, so one process cannot extend or
 *    drop another's lease.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COMPARTMENT_LEASE_TTL_MS,
  isPidAlive,
  openCompartmentLease,
  type LeaseDatabase,
} from '../src/core/compartment-lease.ts'

let dir: string
let db: DatabaseSync

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-lease-'))
  db = new DatabaseSync(join(dir, 'lease.db'))
})

afterEach(() => {
  try { db.close() } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true })
})

function lease(holderId: string, clock: { now: number }, pidAlive?: (pid: number) => boolean) {
  return openCompartmentLease({
    db: db as unknown as LeaseDatabase,
    holderId,
    now: () => clock.now,
    ...pidAlive === undefined ? {} : { pidAlive },
  })
}

const SESSION = 'session-a'

describe('mutual exclusion between holders', () => {
  it('lets one holder acquire and blocks the other', () => {
    const clock = { now: 1_000 }
    const a = lease('holder-a', clock)
    const b = lease('holder-b', clock)

    expect(a.acquire(SESSION)).not.toBeNull()
    expect(b.acquire(SESSION)).toBeNull()
    expect(b.blocker(SESSION)?.holderId).toBe('holder-a')
    // The loser is not recorded as the holder.
    expect(a.heldBy(SESSION)).toBe(true)
    expect(b.heldBy(SESSION)).toBe(false)
  })

  it('lets the same holder re-acquire rather than blocking itself', () => {
    const clock = { now: 1_000 }
    const a = lease('holder-a', clock)
    expect(a.acquire(SESSION)).not.toBeNull()
    // A second pass in the same process must not deadlock against its own lease.
    expect(a.acquire(SESSION)).not.toBeNull()
  })

  it('releases so the next holder can acquire', () => {
    const clock = { now: 1_000 }
    const a = lease('holder-a', clock)
    const b = lease('holder-b', clock)
    a.acquire(SESSION)
    a.release(SESSION)
    expect(b.acquire(SESSION)).not.toBeNull()
  })
})

describe('expiry and dead-owner reclaim', () => {
  it('takes over an expired lease without a liveness probe', () => {
    const clock = { now: 1_000 }
    const a = lease('holder-a', clock)
    const b = lease('holder-b', clock)
    a.acquire(SESSION)

    clock.now += COMPARTMENT_LEASE_TTL_MS + 1
    expect(a.blocker(SESSION)).toBeNull()
    expect(b.acquire(SESSION)).not.toBeNull()
  })

  it('reclaims immediately when the owner PID is gone', () => {
    const clock = { now: 1_000 }
    // Holder A claims a PID that the probe will report as dead.
    const a = openCompartmentLease({
      db: db as unknown as LeaseDatabase,
      holderId: 'holder-a',
      now: () => clock.now,
      pidAlive: () => true,
    })
    a.acquire(SESSION)

    // Rewrite the row's owner pid to something the next probe calls dead.
    db.prepare('UPDATE compartment_state_lease SET owner_pid = ? WHERE session_id = ?').run(999_999, SESSION)

    const b = openCompartmentLease({
      db: db as unknown as LeaseDatabase,
      holderId: 'holder-b',
      now: () => clock.now,
      pidAlive: () => false,
    })
    // No clock advance: reclaim must not wait for the TTL.
    expect(b.acquire(SESSION)).not.toBeNull()
    expect(b.heldBy(SESSION)).toBe(true)
  })

  it('does not reclaim a lease whose owner is alive', () => {
    const clock = { now: 1_000 }
    const a = openCompartmentLease({
      db: db as unknown as LeaseDatabase,
      holderId: 'holder-a',
      now: () => clock.now,
      pidAlive: () => true,
    })
    a.acquire(SESSION)
    db.prepare('UPDATE compartment_state_lease SET owner_pid = ? WHERE session_id = ?').run(424_242, SESSION)

    const b = openCompartmentLease({
      db: db as unknown as LeaseDatabase,
      holderId: 'holder-b',
      now: () => clock.now,
      pidAlive: () => true,
    })
    expect(b.acquire(SESSION)).toBeNull()
    expect(a.heldBy(SESSION)).toBe(true)
  })
})

describe('renew and release are holder-scoped', () => {
  it('renews only the holder that owns the lease', () => {
    const clock = { now: 1_000 }
    const a = lease('holder-a', clock)
    const b = lease('holder-b', clock)
    a.acquire(SESSION)
    expect(a.renew(SESSION)).toBe(true)
    expect(b.renew(SESSION)).toBe(false)
  })

  it('reports renew as failed once the lease expired', () => {
    const clock = { now: 1_000 }
    const a = lease('holder-a', clock)
    a.acquire(SESSION)
    clock.now += COMPARTMENT_LEASE_TTL_MS + 1
    expect(a.renew(SESSION)).toBe(false)
  })

  it('cannot release another holder\'s lease', () => {
    const clock = { now: 1_000 }
    const a = lease('holder-a', clock)
    const b = lease('holder-b', clock)
    a.acquire(SESSION)
    b.release(SESSION)
    // A's lease survives a foreign release attempt.
    expect(a.heldBy(SESSION)).toBe(true)
  })

  it('extends the expiry on renew', () => {
    const clock = { now: 1_000 }
    const a = lease('holder-a', clock)
    const first = a.acquire(SESSION)
    expect(first).not.toBeNull()

    clock.now += 60_000
    expect(a.renew(SESSION)).toBe(true)

    // Past the ORIGINAL expiry, still valid because of the renewal.
    clock.now = first!.expiresAt + 1
    expect(a.heldBy(SESSION)).toBe(true)
  })
})

describe('isPidAlive', () => {
  it('reports this process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true)
  })

  it('rejects nonsense pids without throwing', () => {
    expect(isPidAlive(0)).toBe(false)
    expect(isPidAlive(-1)).toBe(false)
    expect(isPidAlive(1.5)).toBe(false)
  })
})
