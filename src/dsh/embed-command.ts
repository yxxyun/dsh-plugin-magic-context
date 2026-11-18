/**
 * `/ctx-embed [start|pause]` — the embedding lane's manual surface.
 *
 * Upstream `ctx-embed` (command-handler.ts, the `isEmbed` branch) answers three
 * things: status by default, `start` to run a backfill tick now, and `pause` to
 * stop the drain. Anything else gets the usage line.
 *
 * Local mapping:
 *   status  -> `measureVectorLane` over the corpus database (coverage, spaces,
 *              frontier). No model call, so it is always available.
 *   start   -> the same `vectorBackfill` handle the maintenance tick uses, so a
 *              manual run and a tick can never disagree about the gate. It
 *              reports the gate's own reason when it refuses, instead of a
 *              generic failure.
 *   pause   -> not offered. Upstream pauses an auto-drain loop that this adapter
 *              does not run: here a backfill is one bounded call from the
 *              maintenance tick, and "pause" is the `memory.backfill.enabled`
 *              switch. Saying so is more useful than a command that pretends.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Journal } from '../core/journal.ts'
import { measureVectorLane } from '../core/vector-lane.ts'
import type { VectorBackfillOutcome } from '../core/vector-backfill.ts'

interface CommandRegistrar {
  register(command: {
    name: string
    description: string
    input?: { hint?: string }
    handler: (invocation: { rawInput: string }) => Promise<{ kind: 'text' | 'error'; text: string }>
  }): void
}

export interface EmbedCommandDeps {
  /** Absolute path of the corpus database the vector lane lives in. */
  readonly corpusDbPath: () => string | undefined
  readonly backfill: () => ((limit: number, journal: Journal) => Promise<VectorBackfillOutcome | undefined>) | undefined
  readonly journal: () => Journal | undefined
  /** Rows per manual tick; the tick uses the same bound. */
  readonly limit?: number
}

const USAGE = 'Usage: `/ctx-embed` (status), or `/ctx-embed start`.'

function formatOutcome(outcome: VectorBackfillOutcome | undefined): string {
  if (outcome === undefined) {
    return 'Semantic embedding is not configured for this project, so there is nothing to embed.'
  }
  if (outcome.reason !== undefined) {
    // The reason names the gate that refused: parity-unproven, parity-mismatch,
    // no-plan, no-candidates, nothing-producible, embed-failed. Reporting it is
    // the difference between "it did nothing" and "it is not allowed to".
    return `Embedding backfill did not store anything: ${outcome.reason}.`
  }
  const parts = [`created ${String(outcome.created)}`]
  if (outcome.present > 0) parts.push(`${String(outcome.present)} already present`)
  if (outcome.skipped > 0) parts.push(`${String(outcome.skipped)} unusable`)
  if (outcome.failed > 0) parts.push(`${String(outcome.failed)} failed`)
  return `Embedded ${parts.join(', ')} of ${String(outcome.total)} candidate(s).`
}

export function registerCtxEmbedCommand(ctx: Context, deps: EmbedCommandDeps): void {
  const commands = (ctx as unknown as { get(name: string): unknown }).get('commands') as
    | CommandRegistrar
    | undefined
  if (commands === undefined) {
    ctx.logger.warn('magic-context dsh adapter: commands service not mounted; /ctx-embed unavailable')
    return
  }
  commands.register({
    name: 'ctx-embed',
    description: 'Magic Context: semantic-embedding coverage and a manual backfill tick.',
    input: { hint: 'start' },
    handler: async (invocation) => {
      const sub = invocation.rawInput.trim().toLowerCase()
      if (sub === 'pause') {
        return {
          kind: 'text',
          text: 'Pausing the embedding drain is not a separate action here: a backfill runs once per '
            + 'maintenance tick and is switched off with the memory backfill setting.',
        }
      }
      if (sub === 'start') {
        const backfill = deps.backfill()
        if (backfill === undefined) {
          return {
            kind: 'text',
            text: 'Semantic embedding is not configured for this project, so there is nothing to embed.',
          }
        }
        const journal = deps.journal()
        if (journal === undefined) {
          return { kind: 'error', text: 'Embedding backfill needs a journal; none is attached to this adapter.' }
        }
        return { kind: 'text', text: formatOutcome(await backfill(deps.limit ?? 64, journal)) }
      }
      if (sub !== '') return { kind: 'error', text: USAGE }

      const path = deps.corpusDbPath()
      const report = path === undefined ? undefined : measureVectorLane(path)
      if (report === undefined) {
        return {
          kind: 'text',
          text: '## Embedding Status\n\nSemantic embedding is not configured for this project.',
        }
      }
      const lines = [
        '## Embedding Status',
        '',
        `- active memories: ${String(report.active)}`,
        `- embedded: ${String(report.embedded)}`,
        `- missing: ${String(report.missing)}`,
        `- coverage: ${(report.coverage * 100).toFixed(1)}%`,
      ]
      if (report.dominantModelId !== undefined) {
        lines.push(`- dominant space: ${report.dominantModelId}`)
      }
      if (report.spaces.length > 1) {
        lines.push(`- spaces: ${report.spaces.map(space => `${space.modelId} (${String(space.rows)})`).join(', ')}`)
      }
      return { kind: 'text', text: lines.join('\n') }
    },
  })
}
