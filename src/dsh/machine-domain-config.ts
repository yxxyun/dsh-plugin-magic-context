/**
 * One reading of the machine domain switch, shared by every caller of
 * `syncMachineDomain`.
 *
 * Two things live here, and both were learned the hard way.
 *
 * 1. **One default.** Until 2026-11-12 the two call sites disagreed about an
 *    ABSENT `memory.global.machine.enabled`: the mount projection
 *    (`memory-lane.ts`) read `liveBoolean(…, true)` — absent means ON — and
 *    created/enabled the `dir:global:machine` row, while the execute-pass sync
 *    (`pre-step.ts`) spread the key only when it was defined — absent means OFF
 *    — and flipped the same row back to disabled on the first pass. The result
 *    was a row that existed at `enabled = 0` and `memory-promote` journalling
 *    `auto-stage paused: domain-missing` forever, so memories never left the
 *    project scope.
 *
 * 2. **One spelling that a form can write.** `memory` is deliberately NOT part
 *    of the plugin's schema — declaring the object would materialise it into
 *    every profile, and its mere presence opens the shared-store bridge (see
 *    `src/index.ts`). Hand-editing `memory.global.machine.enabled` stays
 *    supported for profiles that already do it, but the switch a settings card
 *    can save is the declared scalar `machineDomainEnabled`. The scalar wins so
 *    that flipping it in the form is never silently overridden by a stale
 *    object in the patch.
 *
 * The default is OFF. That is what the surrounding contracts already say:
 * `syncMachineDomain` creates no row unless enabled ("Nothing configured and
 * nothing remembered: not even a row to keep in sync"), and the pre-step
 * comment calls its sync "a no-op until `memory.global.machine.enabled`".
 * Sharing across projects is an explicit choice, never an assumption.
 */
import type { MachineDomainConfig } from '../core/machine-domain.ts'
import { liveBoolean } from './volatile.ts'

/** The config slice that decides the machine domain. */
export interface MachineDomainConfigInput {
  /** Declared scalar — what the settings form writes. */
  readonly machineDomainEnabled?: unknown
  readonly memory?: {
    readonly global?: {
      readonly machine?: {
        readonly enabled?: unknown
        readonly excludeProjects?: unknown
      }
    }
  }
}

/**
 * Read the machine domain's config.
 *
 * @param config - the plugin's resolved config (volatile getters included).
 * @returns the shape `syncMachineDomain` takes; `enabled` is false unless the
 *   scalar (or the legacy object spelling) says true, and `excludeProjects` is
 *   passed through only when it is an array.
 */
export function machineDomainConfigOf(config: MachineDomainConfigInput): MachineDomainConfig {
  const machine = config.memory?.global?.machine
  const excluded = machine?.excludeProjects
  return {
    enabled: liveBoolean(config.machineDomainEnabled, liveBoolean(machine?.enabled, false)),
    ...Array.isArray(excluded) ? { excludeProjects: excluded as readonly string[] } : {},
  }
}
