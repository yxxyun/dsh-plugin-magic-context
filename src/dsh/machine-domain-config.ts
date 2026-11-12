/**
 * One reading of `memory.global.machine`, shared by every caller of
 * `syncMachineDomain`.
 *
 * Why this file exists (2026-11-12): the two call sites disagreed about the
 * DEFAULT, so the domain could never stay on.
 *
 *  - the mount projection (memory-lane.ts) read `liveBoolean(…, true)`, i.e.
 *    "absent means ON", and created/enabled the `dir:global:machine` row;
 *  - the execute-pass sync (pre-step.ts) spread the key only when it was
 *    defined, i.e. "absent means OFF", and flipped the same row back to
 *    disabled on the first pass.
 *
 * Net effect on the operator's machine: a domain row that exists and is
 * `enabled = 0`, and `memory-promote` journalling
 * `auto-stage paused: domain-missing (memories stay at project level)` — memory
 * never left the project scope, so a second project never saw the first one's
 * rules.
 *
 * The default is OFF, which is what the surrounding contracts already say:
 * `syncMachineDomain` refuses to create a row unless enabled ("Nothing
 * configured and nothing remembered: not even a row to keep in sync", so a
 * profile that never opted in leaves no trace), and the pre-step comment calls
 * the sync "a no-op until `memory.global.machine.enabled`". Turning sharing on
 * is an explicit profile edit, never a default this plugin assumes.
 */
import type { MachineDomainConfig } from '../core/machine-domain.ts'
import { liveBoolean } from './volatile.ts'

/** The `memory.global.machine` slice as it appears in a resolved config. */
export interface MachineDomainConfigInput {
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
 * Read `memory.global.machine` into the shape `syncMachineDomain` takes.
 *
 * @param config - the plugin's resolved config (volatile getters included).
 * @returns the machine domain's config; `enabled` is false unless the profile
 *   says true, and `excludeProjects` is passed through only when it is an array.
 */
export function machineDomainConfigOf(config: MachineDomainConfigInput): MachineDomainConfig {
  const machine = config.memory?.global?.machine
  const excluded = machine?.excludeProjects
  return {
    enabled: liveBoolean(machine?.enabled, false),
    ...Array.isArray(excluded) ? { excludeProjects: excluded as readonly string[] } : {},
  }
}
