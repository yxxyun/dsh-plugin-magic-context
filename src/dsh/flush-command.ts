/**
 * `/ctx-flush` — settle the drop queue now instead of waiting for a band.
 *
 * Upstream `executeFlush` (execute-flush.ts:10) answers three things and this
 * keeps all three: what was flushed, that nothing was pending, and that the
 * change lands on the next message rather than rewriting the current one.
 *
 * The local queue is a list of tags the agent already asked to drop; the only
 * reason it waits is that a pass lands them inside a band. Flush removes that
 * wait without changing what "dropped" means — it calls the same
 * `landPendingDrops` the pass uses.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PressurePolicy } from '../core/policy.ts'
import type { AdapterStores } from '../core/stores.ts'
import { landPendingDrops } from './drop-landing.ts'

interface CommandRegistrar {
  register(command: {
    name: string
    description: string
    input?: { hint?: string }
    handler: (invocation: {
      agent: { session: Parameters<typeof landPendingDrops>[0]['session'] }
      rawInput: string
    }) => Promise<{ kind: 'text' | 'error'; text: string }>
  }): void
}

export interface FlushDeps {
  readonly stores: AdapterStores
  readonly policy: () => PressurePolicy
}

export function registerCtxFlushCommand(ctx: Context, deps: FlushDeps): void {
  const commands = (ctx as unknown as { get(name: string): unknown }).get('commands') as
    | CommandRegistrar
    | undefined
  if (commands === undefined) {
    ctx.logger.warn('magic-context dsh adapter: commands service not mounted; /ctx-flush unavailable')
    return
  }
  commands.register({
    name: 'ctx-flush',
    description: 'Magic Context: land the queued drops now instead of waiting for the next execute band.',
    handler: async (invocation) => {
      const sessionId = invocation.agent.session.id
      const pending = deps.stores.listPendingDrops(sessionId)
      if (pending.length === 0) {
        return { kind: 'text', text: 'No pending operations to flush.' }
      }
      const result = landPendingDrops({
        session: invocation.agent.session,
        sessionId,
        stores: deps.stores,
        policy: deps.policy(),
      })
      if (result.error !== undefined) {
        const detail = result.error instanceof Error ? result.error.message : String(result.error)
        return { kind: 'error', text: `Error: Failed to flush context operations. ${detail}` }
      }
      const parts: string[] = []
      if (result.landed.length > 0) parts.push(`${String(result.landed.length)} dropped`)
      if (result.retired.length > 0) parts.push(`${String(result.retired.length)} retired (target gone)`)
      if (result.skippedSmall > 0) {
        parts.push(`${String(result.skippedSmall)} kept (small result, newest-call window)`)
      }
      if (parts.length === 0) return { kind: 'text', text: 'No pending operations to flush.' }
      return {
        kind: 'text',
        text: `Flushed: ${parts.join(', ')}. Changes take effect on next message.`,
      }
    },
  })
}
