/**
 * The memory lane has TWO switches, and the form can only write one of them.
 *
 * `memoryEnabled` is non-volatile: the lane opens its store handles once at
 * mount, so flipping it has to remount the fiber — and the Host refuses writes
 * to non-volatile fields outright (`@deepseek-ai/dsh-settings` write():
 * `Config field "X" is not volatile`). That refusal reached the card as a bare
 * `{ok: false}`, so the operator only ever saw "The Host did not accept the
 * save" when they tried to turn the lane on (2026-11-12).
 *
 * `memoryLive` is the volatile half the form writes; this helper decides what
 * it means at use time. The rules pinned here:
 *
 *  - the live switch is read through a getter, so a settings-form commit applies
 *    on the next pass without a remount;
 *  - the mount switch still wins downward: a lane that never opened cannot be
 *    turned on by a volatile flag alone;
 *  - the legacy patch spelling `memory.enabled: false` keeps its veto.
 */
import { describe, expect, it } from 'vitest'
import { memoryLaneEnabled } from '../src/dsh/live-flags.ts'

describe('memoryLaneEnabled', () => {
  it('is on when nothing configured the lane away', () => {
    expect(memoryLaneEnabled({})).toBe(true)
    expect(memoryLaneEnabled({ memoryEnabled: true, memoryLive: true })).toBe(true)
  })

  it('honours the live switch', () => {
    expect(memoryLaneEnabled({ memoryLive: false })).toBe(false)
    // An unset live switch never means off.
    expect(memoryLaneEnabled({ memoryLive: undefined })).toBe(true)
  })

  it('reads the live switch through a volatile getter', () => {
    expect(memoryLaneEnabled({ memoryLive: { get: () => false } })).toBe(false)
    expect(memoryLaneEnabled({ memoryLive: { get: () => true } })).toBe(true)
    // A getter that has not produced a boolean cannot turn the lane off.
    expect(memoryLaneEnabled({ memoryLive: { get: () => undefined } })).toBe(true)
  })

  it('cannot turn on a lane the mount switch closed', () => {
    expect(memoryLaneEnabled({ memoryEnabled: false, memoryLive: true })).toBe(false)
  })

  it('keeps the legacy patch veto', () => {
    expect(memoryLaneEnabled({ memory: { enabled: false }, memoryLive: true })).toBe(false)
  })
})
