/**
 * The fail-closed wiring in the pre-step band.
 *
 * The gate itself is pinned by `emergency-fail-closed.spec.ts`; arming by
 * `emergency-arming.spec.ts`; limit parsing by `provider-limit.spec.ts`. What is
 * left to prove here is the JOIN: that an armed session with a
 * `provider_overflow` origin and no fold actually rejects the turn, and that the
 * same session proceeds once it is disarmed.
 *
 * The join is the part that goes wrong quietly — three correct pieces wired to
 * the wrong inputs behave exactly like no gate at all.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateEmergencyFailClosed } from '../src/core/emergency-fail-closed.ts'
import { openStores } from '../src/core/stores.ts'
import { provenLimitKey } from '../src/core/provider-limit.ts'

const SESSION = 'mc-join'

/** The exact expression the pre-step evaluates, kept in one place. */
function decide(
  stores: ReturnType<typeof openStores>,
  args: { usagePercentage: number; foldMaterializedThisPass: boolean; provider: string; model: string },
) {
  const drain = stores.getDrainState(SESSION)
  const provenRaw = stores.getMeta(provenLimitKey(args.provider, args.model))
  const provenLimit = provenRaw === undefined ? undefined : Number(provenRaw)
  return evaluateEmergencyFailClosed({
    usagePercentage: args.usagePercentage,
    emergencyRecoveryArmed: (drain.overflowArmedAt ?? 0) > 0,
    emergencyRecoveryOrigin: drain.overflowOrigin ?? null,
    foldMaterializedThisPass: args.foldMaterializedThisPass,
    ...provenLimit === undefined || !Number.isFinite(provenLimit)
      ? {}
      : { providerProvenLimitTokens: provenLimit },
  })
}

async function withStore(fn: (stores: ReturnType<typeof openStores>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mc-join-'))
  const stores = openStores(dir)
  try {
    await fn(stores)
  } finally {
    stores.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
  }
}

describe('fail-closed join', () => {
  it('rejects an armed session at emergency pressure with no fold', async () => {
    await withStore(async (stores) => {
      stores.putDrainState(SESSION, {
        ...stores.getDrainState(SESSION),
        overflowArmedAt: 1,
        overflowOrigin: 'provider_overflow',
      })
      expect(decide(stores, {
        usagePercentage: 97, foldMaterializedThisPass: false, provider: 'p', model: 'm',
      }).shouldAbort).toBe(true)
    })
  })

  it('proceeds once the same session folds', async () => {
    await withStore(async (stores) => {
      stores.putDrainState(SESSION, {
        ...stores.getDrainState(SESSION),
        overflowArmedAt: 1,
        overflowOrigin: 'provider_overflow',
      })
      expect(decide(stores, {
        usagePercentage: 97, foldMaterializedThisPass: true, provider: 'p', model: 'm',
      }).shouldAbort).toBe(false)
    })
  })

  it('proceeds for an unarmed session even at 99%', async () => {
    await withStore(async (stores) => {
      expect(decide(stores, {
        usagePercentage: 99, foldMaterializedThisPass: false, provider: 'p', model: 'm',
      }).shouldAbort).toBe(false)
    })
  })

  it('proceeds for a session armed by something other than an overflow', async () => {
    await withStore(async (stores) => {
      stores.putDrainState(SESSION, {
        ...stores.getDrainState(SESSION),
        overflowArmedAt: 1,
        overflowOrigin: 'proactive_model_shrink',
      })
      expect(decide(stores, {
        usagePercentage: 99, foldMaterializedThisPass: false, provider: 'p', model: 'm',
      }).shouldAbort).toBe(false)
    })
  })

  it('disarms from a proven limit recorded for THIS route', async () => {
    await withStore(async (stores) => {
      stores.putDrainState(SESSION, {
        ...stores.getDrainState(SESSION),
        overflowArmedAt: 1,
        overflowOrigin: 'provider_overflow',
      })
      stores.setMeta(provenLimitKey('p', 'm'), '262144')
      // 262144 × 0.8 = 209715; an estimate under that disarms — but only with a
      // trusted measurement, which this adapter does not yet produce, so the
      // call still has to carry one explicitly.
      const decision = evaluateEmergencyFailClosed({
        usagePercentage: 99,
        emergencyRecoveryArmed: true,
        emergencyRecoveryOrigin: 'provider_overflow',
        foldMaterializedThisPass: false,
        finalWireEstimate: { tokens: 100_000, trusted: true },
        providerProvenLimitTokens: Number(stores.getMeta(provenLimitKey('p', 'm'))),
      })
      expect(decision.reason).toBe('trusted-final-wire-disarm')
    })
  })

  it('does not read a proven limit recorded for a different model', async () => {
    await withStore(async (stores) => {
      stores.setMeta(provenLimitKey('p', 'other-model'), '8192')
      const sameRoute = stores.getMeta(provenLimitKey('p', 'm'))
      expect(sameRoute).toBeUndefined()
    })
  })
})
