/**
 * `/ctx-embed [start|pause]` (upstream's `isEmbed` branch in command-handler.ts).
 *
 * The cases that matter are the ones that would otherwise be silent:
 *   - status works with NO embedder configured (it reports that, not an error);
 *   - `start` reports the gate's own refusal reason instead of a generic failure;
 *   - `pause` explains that the switch is a setting here, rather than pretending
 *     to pause a loop this adapter does not run.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerCtxEmbedCommand } from '../src/dsh/embed-command.ts'
import type { VectorBackfillOutcome } from '../src/core/vector-backfill.ts'

interface Registered {
  name: string
  handler: (invocation: { rawInput: string }) => Promise<{ kind: string; text: string }>
}

function harness(overrides: {
  corpusDbPath?: () => string | undefined
  backfill?: () => ((limit: number, journal: never) => Promise<VectorBackfillOutcome | undefined>) | undefined
  journal?: () => never | undefined
}): Registered[] {
  const registered: Registered[] = []
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    get: (name: string) => name === 'commands'
      ? { register: (command: Registered) => { registered.push(command) } }
      : undefined,
  } as never
  registerCtxEmbedCommand(ctx, {
    corpusDbPath: overrides.corpusDbPath ?? (() => undefined),
    backfill: overrides.backfill ?? (() => undefined),
    journal: overrides.journal ?? (() => undefined),
  })
  return registered
}

describe('/ctx-embed', () => {
  it('reports "not configured" for status when no corpus path is known', async () => {
    const [command] = harness({})
    const result = await command!.handler({ rawInput: '' })
    expect(result.kind).toBe('text')
    expect(result.text).toContain('not configured')
  })

  it('refuses an unknown subcommand with the usage line', async () => {
    const [command] = harness({})
    const result = await command!.handler({ rawInput: 'rebuild' })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('/ctx-embed start')
  })

  it('explains that pause is a setting here, not a command action', async () => {
    const [command] = harness({})
    const result = await command!.handler({ rawInput: 'pause' })
    expect(result.kind).toBe('text')
    expect(result.text).toContain('backfill setting')
  })

  it('start with no backfill handle reports "nothing to embed"', async () => {
    const [command] = harness({ journal: () => ({}) as never })
    const result = await command!.handler({ rawInput: 'start' })
    expect(result.text).toContain('nothing to embed')
  })

  it('start reports the gate refusal reason verbatim', async () => {
    const [command] = harness({
      journal: () => ({}) as never,
      backfill: () => async () => ({
        created: 0, present: 0, skipped: 0, failed: 0, total: 5, reason: 'parity-unproven',
      }),
    })
    const result = await command!.handler({ rawInput: 'start' })
    expect(result.text).toContain('parity-unproven')
  })

  it('start summarises a successful tick', async () => {
    const [command] = harness({
      journal: () => ({}) as never,
      backfill: () => async () => ({
        created: 3, present: 1, skipped: 0, failed: 0, total: 4,
      }),
    })
    const result = await command!.handler({ rawInput: 'start' })
    expect(result.text).toContain('created 3')
    expect(result.text).toContain('1 already present')
    expect(result.text).toContain('of 4 candidate(s)')
  })

  it('start without a journal is an error, not a silent no-op', async () => {
    const [command] = harness({
      backfill: () => async () => ({ created: 0, present: 0, skipped: 0, failed: 0, total: 0 }),
    })
    const result = await command!.handler({ rawInput: 'start' })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('journal')
  })
})
