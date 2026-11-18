/**
 * Emergency arming, per session (upstream `needsEmergencyRecovery` +
 * `emergencyRecoveryOrigin`, storage-meta-persisted.ts:2138).
 *
 * The pairing is the whole point. The fail-closed gate refuses a request only
 * when the arming came from a PROVIDER OVERFLOW; a flag without an origin may
 * not abort, because then any session that armmed for a different reason (a
 * model shrink) would start refusing requests it can serve.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMPTY_DRAIN_STATE, openStores } from '../src/core/stores.ts'

const SESSION = 'mc-arming'

async function withStore(fn: (stores: ReturnType<typeof openStores>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mc-arming-'))
  const stores = openStores(dir)
  try {
    await fn(stores)
  } finally {
    stores.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
  }
}

describe('emergency arming', () => {
  it('starts unarmed', async () => {
    await withStore(async (stores) => {
      const state = stores.getDrainState(SESSION)
      expect(state.overflowArmedAt).toBe(0)
      expect(state.overflowOrigin).toBeUndefined()
      expect(EMPTY_DRAIN_STATE.overflowArmedAt).toBe(0)
    })
  })

  it('round-trips the arming time and origin', async () => {
    await withStore(async (stores) => {
      stores.putDrainState(SESSION, {
        ...stores.getDrainState(SESSION),
        overflowArmedAt: 1_700_000_000_000,
        overflowOrigin: 'provider_overflow',
      })
      const state = stores.getDrainState(SESSION)
      expect(state.overflowArmedAt).toBe(1_700_000_000_000)
      expect(state.overflowOrigin).toBe('provider_overflow')
    })
  })

  it('keeps the drain accounting alongside the arming', async () => {
    await withStore(async (stores) => {
      stores.putDrainState(SESSION, {
        windowStartedAt: 111,
        spentTokens: 222,
        latchActiveSince: 333,
        failureAt: 444,
        overflowArmedAt: 555,
        overflowOrigin: 'proactive_model_shrink',
      })
      const state = stores.getDrainState(SESSION)
      expect(state.windowStartedAt).toBe(111)
      expect(state.spentTokens).toBe(222)
      expect(state.latchActiveSince).toBe(333)
      expect(state.failureAt).toBe(444)
      expect(state.overflowArmedAt).toBe(555)
      expect(state.overflowOrigin).toBe('proactive_model_shrink')
    })
  })

  it('disarms by writing zero back', async () => {
    await withStore(async (stores) => {
      stores.putDrainState(SESSION, {
        ...stores.getDrainState(SESSION),
        overflowArmedAt: 999,
        overflowOrigin: 'provider_overflow',
      })
      stores.putDrainState(SESSION, { ...stores.getDrainState(SESSION), overflowArmedAt: 0 })
      const state = stores.getDrainState(SESSION)
      expect(state.overflowArmedAt).toBe(0)
      // The origin is cleared with it, so a later arming cannot inherit one.
      expect(state.overflowOrigin).toBe('provider_overflow')
    })
  })

  it('drops an unknown origin rather than passing it through', async () => {
    await withStore(async (stores) => {
      // A downgrade (or hand-edited row) may hold a value this build does not
      // know. Reading it back as an origin would arm an abort path on garbage.
      stores.putDrainState(SESSION, {
        ...stores.getDrainState(SESSION),
        overflowArmedAt: 1,
        overflowOrigin: 'not_a_real_origin' as never,
      })
      expect(stores.getDrainState(SESSION).overflowOrigin).toBeUndefined()
    })
  })
})
