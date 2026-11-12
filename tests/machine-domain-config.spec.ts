/**
 * The machine domain's switch has exactly ONE reading (2026-11-12).
 *
 * The defect this guards: the two callers of `syncMachineDomain` disagreed about
 * what an ABSENT `memory.global.machine.enabled` means. The mount projection in
 * `memory-lane.ts` read it as ON (`liveBoolean(…, true)`), the execute-pass sync
 * in `pre-step.ts` spread the key only when it was defined, i.e. read it as OFF.
 * On the operator's machine that produced a `dir:global:machine` row that was
 * created enabled at boot and disabled by the first pass — so `auto-stage`
 * journalled `domain-missing` for days while the row sat there at `enabled = 0`,
 * and memories never left the project scope.
 *
 * The default must be OFF, which is what the surrounding contracts already say:
 * `syncMachineDomain` creates no row at all unless enabled, and the pre-step
 * comment calls its sync "a no-op until `memory.global.machine.enabled`".
 * Sharing across projects is an explicit profile edit, never an assumption.
 *
 * These cases pin the helper, so the "absent means ON" reading cannot come back
 * through a re-typed literal at one of the two call sites.
 */
import { describe, expect, it } from 'vitest'
import { machineDomainConfigOf } from '../src/dsh/machine-domain-config.ts'

describe('machineDomainConfigOf', () => {
  it('reads an absent switch as OFF (never creates a domain by accident)', () => {
    expect(machineDomainConfigOf({})).toEqual({ enabled: false })
    expect(machineDomainConfigOf({ memory: {} })).toEqual({ enabled: false })
    expect(machineDomainConfigOf({ memory: { global: {} } })).toEqual({ enabled: false })
    expect(machineDomainConfigOf({ memory: { global: { machine: {} } } })).toEqual({ enabled: false })
  })

  it('passes an explicit true through — the opt-in that mounts sharing', () => {
    expect(machineDomainConfigOf({ memory: { global: { machine: { enabled: true } } } }))
      .toEqual({ enabled: true })
  })

  it('keeps an explicit false off', () => {
    expect(machineDomainConfigOf({ memory: { global: { machine: { enabled: false } } } }))
      .toEqual({ enabled: false })
  })

  it('resolves a volatile getter the way the settings form writes one', () => {
    const boxed = { get: () => true }
    expect(machineDomainConfigOf({ memory: { global: { machine: { enabled: boxed } } } }).enabled)
      .toBe(true)
    expect(machineDomainConfigOf({ memory: { global: { machine: { enabled: { get: () => false } } } } }).enabled)
      .toBe(false)
  })

  it('treats a non-boolean, non-getter value as absent rather than truthy', () => {
    expect(machineDomainConfigOf({ memory: { global: { machine: { enabled: 'yes' } } } }).enabled)
      .toBe(false)
    expect(machineDomainConfigOf({ memory: { global: { machine: { enabled: 1 } } } }).enabled)
      .toBe(false)
  })

  it('reads the declared scalar, which is what the settings form writes', () => {
    expect(machineDomainConfigOf({ machineDomainEnabled: true })).toEqual({ enabled: true })
    expect(machineDomainConfigOf({ machineDomainEnabled: false })).toEqual({ enabled: false })
  })

  it('lets the scalar win over the hand-written object spelling', () => {
    expect(machineDomainConfigOf({
      machineDomainEnabled: true,
      memory: { global: { machine: { enabled: false } } },
    })).toEqual({ enabled: true })
    expect(machineDomainConfigOf({
      machineDomainEnabled: false,
      memory: { global: { machine: { enabled: true } } },
    })).toEqual({ enabled: false })
  })

  it('falls through to the object spelling while the scalar is absent', () => {
    // The schema declares the scalar WITHOUT a default, so an untouched profile
    // keeps working through `memory.global.machine.enabled`.
    expect(machineDomainConfigOf({
      memory: { global: { machine: { enabled: true } } },
    })).toEqual({ enabled: true })
  })

  it('passes excludeProjects through only when it is an array', () => {
    expect(machineDomainConfigOf({
      memory: { global: { machine: { enabled: true, excludeProjects: ['a', 'b'] } } },
    })).toEqual({ enabled: true, excludeProjects: ['a', 'b'] })
    expect(machineDomainConfigOf({
      memory: { global: { machine: { enabled: true, excludeProjects: 'a' } } },
    })).toEqual({ enabled: true })
  })
})
