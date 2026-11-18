/**
 * The migration chain must be STRICTLY ASCENDING.
 *
 * `openStores` walks `MIGRATIONS` in array order and writes `meta.schema_version`
 * after each one, so a version inserted out of order runs, then gets overwritten
 * by the smaller version that follows it — and the store reports an older schema
 * than the columns it actually has. That mismatch stays silent until the next
 * boot sees `persisted < SCHEMA_VERSION` and replays migrations whose
 * `ALTER TABLE` then fails with "duplicate column".
 *
 * This happened three times while adding v16, v17 and v18. The rule belongs in a
 * test, not in a comment nobody reads while adding the next one.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openStores, SCHEMA_VERSION } from '../src/core/stores.ts'

function freshDir(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mc-mig-order-'))
  // `openStores` puts the adapter database at <dir>/dsh-magic-context.db.
  return { dir, dbPath: join(dir, 'dsh-magic-context.db') }
}

const readVersion = (dbPath: string): string => {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined
    return row?.value ?? 'missing'
  } finally {
    db.close()
  }
}

describe('migration chain', () => {
  it('ends on SCHEMA_VERSION, not on some smaller version replayed after it', () => {
    const { dir, dbPath } = freshDir()
    const stores = openStores(dir)
    try {
      // Not asserted through an internal accessor: the value in the database is
      // what the NEXT boot reads, and that is what the failure mode depends on.
      expect(stores.listCompartments('probe')).toEqual([])
    } finally {
      stores.close()
    }
    try {
      expect(readVersion(dbPath)).toBe(String(SCHEMA_VERSION))
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
    }
  })

  it('reopens an already-migrated database without replaying anything', () => {
    const { dir } = freshDir()
    try {
      const first = openStores(dir)
      first.close()
      // A chain that left schema_version behind the newest migration would hit
      // "duplicate column" here, because the ALTERs would run a second time.
      expect(() => {
        const second = openStores(dir)
        second.close()
      }).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
    }
  })

  it('exposes the newest baseline columns after migrating', () => {
    const { dir } = freshDir()
    const stores = openStores(dir)
    try {
      // Writing and reading back the newest fields proves v16/v17/v18 ALTERs ran
      // in an order that left all three columns present.
      stores.saveBaselineState({
        sessionId: 's',
        epoch: 1,
        frozenAt: 1,
        renderEpoch: 6,
        maxCompartmentId: 3,
        systemHash: 'abc',
        updatedAt: 1,
      })
      const state = stores.baselineState('s')
      expect(state?.renderEpoch).toBe(6)
      expect(state?.maxCompartmentId).toBe(3)
      expect(state?.systemHash).toBe('abc')
    } finally {
      stores.close()
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
    }
  })
})
