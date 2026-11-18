/**
 * Renderer format stamp for the composed baseline (upstream
 * `compartmentRenderEpoch`, inject-compartments.ts:1816).
 *
 * The defect it prevents is silent: change how a baseline is RENDERED and every
 * existing baseline keeps the old bytes while the code that would write them
 * today disagrees — so the two "match" forever and the change never lands. This
 * is exactly what happened when tier selection moved to the decay curve.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStores } from '../src/core/stores.ts'

function withStore<T>(fn: (stores: ReturnType<typeof openStores>) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'mc-render-epoch-'))
  const stores = openStores(dir)
  try {
    return fn(stores)
  } finally {
    stores.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
  }
}

describe('baseline render epoch', () => {
  it('round-trips the stamp', () => {
    withStore((stores) => {
      stores.saveBaselineState({
        sessionId: 's1', epoch: 1, frozenAt: 100, renderEpoch: 7, updatedAt: 100,
      })
      expect(stores.baselineState('s1')?.renderEpoch).toBe(7)
    })
  })

  it('treats a pre-v16 row (0) as "no stamp" rather than "renderer 0"', () => {
    withStore((stores) => {
      // A legacy row carries 0 by column default; the loader drops it so the
      // caller sees `undefined` and can decide to fold.
      stores.saveBaselineState({ sessionId: 's2', epoch: 1, frozenAt: 100, updatedAt: 100 })
      expect(stores.baselineState('s2')?.renderEpoch).toBeUndefined()
    })
  })

  it('keeps other columns intact across the stamp update', () => {
    withStore((stores) => {
      stores.saveBaselineState({
        sessionId: 's3', epoch: 3, frozenAt: 200, memoriesDigest: 'abc', updatedAt: 200,
      })
      stores.saveBaselineState({
        sessionId: 's3', epoch: 3, frozenAt: 200, memoriesDigest: 'abc', renderEpoch: 2, updatedAt: 201,
      })
      const state = stores.baselineState('s3')
      expect(state?.renderEpoch).toBe(2)
      expect(state?.memoriesDigest).toBe('abc')
      expect(state?.epoch).toBe(3)
    })
  })
})
