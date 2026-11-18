/**
 * The system-prompt fingerprint (upstream `systemPromptFingerprint`,
 * prompt-surface-runtime.ts:71; the HARD gate at system-prompt-hash.ts:739).
 *
 * The rule: when the system prompt changes, the provider rewrites its cache from
 * that block onward anyway, so folding the baseline on the same turn is free —
 * and NOT folding leaves the plugin serving a prefix that is already dead.
 *
 * Both sides must be known before the gate can fire. A session that has never
 * observed a fingerprint must not fold on every pass while it stays unknown.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStores } from '../src/core/stores.ts'

const SESSION = 'mc-system-hash'
async function withStore(fn: (stores: ReturnType<typeof openStores>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mc-syshash-'))
  const stores = openStores(dir)
  try {
    await fn(stores)
  } finally {
    stores.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
  }
}

describe('system prompt fingerprint — store round-trip', () => {
  // The HARD gate itself lives inside `refreshBaseline`, which needs a session the
  // surface enumerator understands. These cases pin the storage half; the gate's
  // truth table is pinned by `management-pass-hard.spec.ts` against the decision
  // inputs directly.
  it('round-trips the fingerprint', async () => {
    await withStore(async (stores) => {
      stores.saveBaselineState({ sessionId: SESSION, epoch: 1, frozenAt: 1, systemHash: 'hash-a', updatedAt: 1 })
      expect(stores.baselineState(SESSION)?.systemHash).toBe('hash-a')
    })
  })

  it('leaves it undefined for a row written before v18', async () => {
    await withStore(async (stores) => {
      stores.saveBaselineState({ sessionId: SESSION, epoch: 1, frozenAt: 1, updatedAt: 1 })
      expect(stores.baselineState(SESSION)?.systemHash).toBeUndefined()
    })
  })

  it('replaces it on the next write', async () => {
    await withStore(async (stores) => {
      stores.saveBaselineState({ sessionId: SESSION, epoch: 1, frozenAt: 1, systemHash: 'hash-a', updatedAt: 1 })
      stores.saveBaselineState({ sessionId: SESSION, epoch: 2, frozenAt: 2, systemHash: 'hash-b', updatedAt: 2 })
      expect(stores.baselineState(SESSION)?.systemHash).toBe('hash-b')
    })
  })
})
