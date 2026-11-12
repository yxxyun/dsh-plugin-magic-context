/**
 * The live memory-lane switch.
 *
 * Why this exists (2026-11-12): the settings form could not save the lane at
 * all. `memoryEnabled` is declared NON-volatile on purpose — the lane opens its
 * store handles once at mount, so the switch has to remount the fiber — but the
 * Host only accepts writes to volatile fields:
 *
 *   `@deepseek-ai/dsh-settings/lib/index.js` → `write()`:
 *     for (const path of paths) if (path.length && !isVolatilePath(schema, path))
 *       throw new Error(`Config field "${path.join(".")}" is not volatile`)
 *
 * The RPC turns that into `{ok: false}` with no message, which is why the card
 * could only say "The Host did not accept the save".
 *
 * The split is therefore explicit:
 *
 *  - `memoryEnabled` stays the mount-time switch: it decides whether the lane
 *    opens at all (bridge, tools, writer), and it is edited in the patch.
 *  - `memoryLive` is the volatile switch the form writes: it gates USE — the
 *    recall that injects the memory block — and takes effect on the next pass
 *    with no restart.
 *
 * Turning `memoryLive` off keeps the handles open but stops injecting and
 * stops the write path, which is what "off" should mean for a cost-sensitive
 * operator; the mount switch still has to be turned off in the patch to reclaim
 * the store.
 */
import { liveBoolean } from './volatile.ts'

/** The config slice that decides whether the lane is in use. */
export interface MemoryLaneLiveInput {
  /** Volatile: written by the settings form. */
  readonly memoryLive?: unknown
  /** Mount-time switch (non-volatile): edited in the patch. */
  readonly memoryEnabled?: unknown
  readonly memory?: { readonly enabled?: unknown }
}

/**
 * Resolve whether the memory lane may be USED right now.
 *
 * @param config - the plugin's resolved config (volatile getters included).
 * @returns true only when the mount switch, the legacy `memory.enabled`
 *   opt-out, and the live switch all allow it.
 */
export function memoryLaneEnabled(config: MemoryLaneLiveInput): boolean {
  if (config.memory?.enabled === false) return false
  if (liveBoolean(config.memoryEnabled, true) === false) return false
  return liveBoolean(config.memoryLive, true) !== false
}
