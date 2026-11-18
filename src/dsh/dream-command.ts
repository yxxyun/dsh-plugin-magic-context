/**
 * `/ctx-dream [task]` — run the background tasks now, ignoring their cron gate.
 *
 * Upstream's `executeDreaming` (command-handler.ts:370) exposes exactly this:
 * `runManual(task?)` forces one task by name, or every enabled task when the
 * argument is omitted. It exists because a scheduled sweep on a 30-minute cron
 * means "I want it now" is otherwise impossible — the user has to wait for a
 * timer they cannot see.
 *
 * Two answers upstream gives and this keeps: an unknown task name is refused
 * with the canonical list, and "nothing configured" is a plain sentence rather
 * than a silent no-op.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { DreamRunnerDeps, DreamRunOutcome } from '../core/dream-runner.ts'
import { runDueDreamTasks } from '../core/dream-runner.ts'
import { CANONICAL_DREAM_TASKS, type DreamTaskName } from '../core/dream-registry.ts'

interface CommandRegistrar {
  register(command: {
    name: string
    description: string
    input?: { hint?: string }
    handler: (invocation: { rawInput: string }) => Promise<{ kind: 'text' | 'error'; text: string }>
  }): void
}

export interface DreamCommandDeps {
  readonly runner: () => DreamRunnerDeps
  /** Project identities that have schedules seeded (the dream registry key). */
  readonly projects: () => readonly string[]
}

function isCanonicalTask(value: string): value is DreamTaskName {
  return (CANONICAL_DREAM_TASKS as readonly string[]).includes(value)
}

function summarise(outcomes: readonly DreamRunOutcome[]): string {
  if (outcomes.length === 0) return 'No background tasks ran.'
  const counts = new Map<string, number>()
  for (const outcome of outcomes) counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1)
  const parts = [...counts.entries()].map(([status, count]) => `${String(count)} ${status}`)
  const lines = [`Ran ${String(outcomes.length)} task(s): ${parts.join(', ')}.`]
  for (const outcome of outcomes) {
    if (outcome.status === 'skipped') {
      lines.push(`- ${outcome.task}: skipped (${outcome.skippedReason ?? 'unspecified'})`)
    } else if (outcome.status === 'failed') {
      lines.push(`- ${outcome.task}: failed${outcome.error === undefined ? '' : ` — ${outcome.error}`}`)
    } else {
      lines.push(`- ${outcome.task}: ${String(outcome.itemsChanged)} changed of ${String(outcome.itemsProcessed)} seen`)
    }
  }
  return lines.join('\n')
}

export function registerCtxDreamCommand(ctx: Context, deps: DreamCommandDeps): void {
  const commands = (ctx as unknown as { get(name: string): unknown }).get('commands') as
    | CommandRegistrar
    | undefined
  if (commands === undefined) {
    ctx.logger.warn('magic-context dsh adapter: commands service not mounted; /ctx-dream unavailable')
    return
  }
  commands.register({
    name: 'ctx-dream',
    description: 'Magic Context: run the background tasks now instead of waiting for their schedule.',
    input: { hint: CANONICAL_DREAM_TASKS.join(' | ') },
    handler: async (invocation) => {
      const requested = invocation.rawInput.trim()
      if (requested.length > 0 && !isCanonicalTask(requested)) {
        return {
          kind: 'error',
          text: `Unknown background task "${requested}". Known tasks: ${CANONICAL_DREAM_TASKS.join(', ')}.`,
        }
      }
      const projects = deps.projects()
      if (projects.length === 0) {
        return { kind: 'text', text: 'Dreaming is not configured for any project yet.' }
      }
      const runner = deps.runner()
      const outcomes: DreamRunOutcome[] = []
      for (const projectPath of projects) {
        outcomes.push(...await runDueDreamTasks(runner, {
          force: {
            projectPath,
            ...requested.length === 0 ? {} : { task: requested as DreamTaskName },
          },
        }))
      }
      return { kind: 'text', text: summarise(outcomes) }
    },
  })
}
