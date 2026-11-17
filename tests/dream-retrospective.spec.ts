/**
 * `retrospective`: counting friction out of the journal, and explaining it.
 *
 * Two things matter and both are about not inventing work:
 *
 * - **A quiet window costs nothing.** If nothing in the journal means "this cost
 *   the user something", the task reports that and stops. Paying a model to say
 *   "nothing happened" is how a nightly job becomes noise the user turns off.
 * - **A failed call writes no note.** The note is the deliverable, so a broken
 *   completion must leave the queue exactly as it was.
 *
 * `collectFriction` is exported and tested directly because the weighting is a
 * judgement: a forced compaction outranks two retired drops, and a FAILED dream
 * run counts while a skipped one does not.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectFriction, runRetrospectiveTick, type RetrospectiveLlm } from '../src/core/retrospective.ts'
import { openStores, type AdapterStores } from '../src/core/stores.ts'
import type { Journal } from '../src/core/journal.ts'
import { buildRetrospectiveHandler } from '../src/dsh/dream-handlers.ts'

const NOW = 1_800_000_000_000
const IDENTITY = 'dir:retro-test'
const ROUTE = { provider: 'test', model: 'test-model' }
const DAY = 24 * 60 * 60 * 1000

let dir: string
let stores: AdapterStores
const reported: Array<{ level: string; kind: string; summary: string }> = []

const journal = {
  enabled: true,
  record: (level: string, kind: string, summary: string) => { reported.push({ level, kind, summary }) },
  info: (kind: string, summary: string) => { reported.push({ level: 'info', kind, summary }) },
  warn: (kind: string, summary: string) => { reported.push({ level: 'warn', kind, summary }) },
  error: (kind: string, summary: string) => { reported.push({ level: 'error', kind, summary }) },
  tail: () => [],
  byKind: () => [],
} as unknown as Journal

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-retro-'))
  stores = openStores(dir)
  reported.length = 0
})

afterEach(() => {
  try { stores.close() } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true })
})

/** Append one journal row. */
function log(kind: string, level: 'info' | 'warn' | 'error', summary: string, at = NOW - DAY): void {
  stores.appendJournal({ at, kind: kind as never, level, summary })
}

function fakeLlm(answer: string | { fail: 'error' }): { llm: RetrospectiveLlm; prompts: string[] } {
  const prompts: string[] = []
  const llm: RetrospectiveLlm = {
    stream(options) {
      prompts.push((options.messages[0] as { content: Array<{ text: string }> }).content[0]!.text)
      return (async function* () {
        if (typeof answer !== 'string') {
          yield { type: 'finish', reason: { kind: answer.fail, failure: { message: 'stand-in' } } }
          return
        }
        yield { type: 'text-delta', index: 0, text: answer }
        yield { type: 'usage', usage: { inputTokens: 800, outputTokens: 200 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return { llm, prompts }
}

const baseDeps = () => ({
  stores, identity: IDENTITY, route: ROUTE, journal, sessionId: 'mc-dreamer', now: () => NOW,
})

describe('collectFriction', () => {
  it('ignores ordinary rows', () => {
    expect(collectFriction([
      { kind: 'pass', level: 'info', summary: 'defer', at: NOW },
      { kind: 'memory-recall', level: 'info', summary: 'hits 3', at: NOW },
    ])).toEqual([])
  })

  it('counts a forced compaction', () => {
    const signals = collectFriction([{ kind: 'force-path', level: 'warn', summary: 'force fired', at: NOW }])
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ kind: 'force-path', count: 1 })
  })

  it('counts any error regardless of kind', () => {
    const signals = collectFriction([{ kind: 'historian', level: 'error', summary: 'call failed', at: NOW }])
    expect(signals.map(signal => signal.kind)).toEqual(['historian'])
  })

  it('counts a FAILED dream run but not a skipped one', () => {
    const failed = collectFriction([{ kind: 'dream-run', level: 'warn', summary: 'classify failed', at: NOW }])
    expect(failed).toHaveLength(1)
    const skipped = collectFriction([{ kind: 'dream-run', level: 'info', summary: 'skipped', at: NOW }])
    expect(skipped).toEqual([])
  })

  it('ranks by cost, not by count', () => {
    const signals = collectFriction([
      // Three cheap events vs one expensive one.
      { kind: 'drop-retired', level: 'warn', summary: 'retired', at: NOW },
      { kind: 'drop-retired', level: 'warn', summary: 'retired', at: NOW },
      { kind: 'drop-retired', level: 'warn', summary: 'retired', at: NOW },
      { kind: 'force-path', level: 'warn', summary: 'forced', at: NOW },
    ])
    expect(signals[0]?.kind).toBe('force-path')
    expect(signals[1]?.kind).toBe('drop-retired')
  })

  it('bounds the samples per signal', () => {
    const rows = Array.from({ length: 10 }, () => ({
      kind: 'wire-repair', level: 'warn' as const, summary: 'repaired', at: NOW,
    }))
    const signals = collectFriction(rows)
    expect(signals[0]?.count).toBe(10)
    expect(signals[0]?.samples.length).toBeLessThanOrEqual(4)
  })

  it('keeps the newest rows first among ties', () => {
    const signals = collectFriction([
      { kind: 'wire-repair', level: 'warn', summary: 'older', at: NOW - 3 * DAY },
      { kind: 'project-drift', level: 'warn', summary: 'newer', at: NOW },
    ])
    // Same weight and count, so recency decides.
    expect(signals[0]?.kind).toBe('project-drift')
  })
})

describe('runRetrospectiveTick', () => {
  it('reports empty-window without calling the model', async () => {
    const { llm, prompts } = fakeLlm('should not be used')
    const outcome = await runRetrospectiveTick({ ...baseDeps(), llm })
    expect(outcome.reason).toBe('empty-window')
    expect(prompts).toHaveLength(0)
  })

  it('reports no-friction and pays nothing when the window is clean', async () => {
    log('pass', 'info', 'defer below-threshold')
    log('memory-recall', 'info', 'hits 2')
    const { llm, prompts } = fakeLlm('should not be used')
    const outcome = await runRetrospectiveTick({ ...baseDeps(), llm })
    expect(outcome.reason).toBe('no-friction')
    expect(outcome.tokensUsed).toBe(0)
    expect(prompts).toHaveLength(0)
  })

  it('writes a note when there is friction', async () => {
    log('force-path', 'warn', 'force fired at 88%')
    const { llm, prompts } = fakeLlm('The context grew faster than the threshold.')
    const outcome = await runRetrospectiveTick({ ...baseDeps(), llm })
    expect(outcome.signals).toBe(1)
    expect(outcome.summary).toContain('grew faster')
    expect(outcome.noteId).toBeDefined()
    expect(prompts[0]).toContain('force-path')
    // The note is the deliverable: it must exist and carry the text.
    const note = stores.getNote(outcome.noteId as number)
    expect(note?.content).toContain('grew faster')
    expect(note?.projectPath).toBe(IDENTITY)
  })

  it('writes no note when the call fails', async () => {
    log('force-path', 'warn', 'force fired')
    const { llm } = fakeLlm({ fail: 'error' })
    const outcome = await runRetrospectiveTick({ ...baseDeps(), llm })
    expect(outcome.reason).toBe('llm-failed')
    expect(outcome.noteId).toBeUndefined()
    expect(stores.listNotes({ projectPath: IDENTITY })).toHaveLength(0)
  })

  it('reports without persisting when writeNote is false', async () => {
    log('emergency-reclaim', 'warn', 'reclaimed 12k tokens')
    const { llm } = fakeLlm('The window was over on every turn.')
    const outcome = await runRetrospectiveTick({ ...baseDeps(), llm, writeNote: false })
    expect(outcome.summary).toContain('over on every turn')
    expect(outcome.noteId).toBeUndefined()
    expect(stores.listNotes({ projectPath: IDENTITY })).toHaveLength(0)
  })

  it('ignores rows older than the window', async () => {
    log('force-path', 'warn', 'ancient', NOW - 30 * DAY)
    log('pass', 'info', 'recent', NOW - DAY)
    const { llm } = fakeLlm('should not be used')
    const outcome = await runRetrospectiveTick({ ...baseDeps(), llm, windowMs: 7 * DAY })
    expect(outcome.reason).toBe('no-friction')
  })

  it('reports stores-unavailable rather than throwing', async () => {
    const { llm } = fakeLlm('x')
    const outcome = await runRetrospectiveTick({ ...baseDeps(), llm, stores: undefined })
    expect(outcome.reason).toBe('stores-unavailable')
  })
})

describe('buildRetrospectiveHandler', () => {
  const context = { projectPath: IDENTITY, now: NOW, tokenBudget: 80_000, log: () => {} }

  it('skips without a route', async () => {
    const { llm } = fakeLlm('x')
    const handler = buildRetrospectiveHandler({
      retrospective: { stores, llm, route: () => undefined, journal, sessionId: 'mc-dreamer' },
    })
    const result = await handler(context)
    expect(result.status).toBe('skipped')
  })

  it('reports ok with zero changes on a quiet week', async () => {
    log('pass', 'info', 'normal')
    const { llm } = fakeLlm('x')
    const handler = buildRetrospectiveHandler({
      retrospective: { stores, llm, route: () => ROUTE, journal, sessionId: 'mc-dreamer' },
    })
    const result = await handler(context)
    // Nothing went wrong is a completed run, not an error.
    expect(result.status).toBe('ok')
    expect(result.itemsChanged).toBe(0)
    expect(result.summary).toContain('nothing went wrong')
  })

  it('counts the note as one change when there is friction', async () => {
    log('force-path', 'warn', 'forced')
    const { llm } = fakeLlm('Too many forced compactions.')
    const handler = buildRetrospectiveHandler({
      retrospective: { stores, llm, route: () => ROUTE, journal, sessionId: 'mc-dreamer' },
    })
    const result = await handler(context)
    expect(result.status).toBe('ok')
    expect(result.itemsChanged).toBe(1)
    expect(result.summary).toContain('note #')
  })

  it('fails when the model call failed', async () => {
    log('force-path', 'warn', 'forced')
    const { llm } = fakeLlm({ fail: 'error' })
    const handler = buildRetrospectiveHandler({
      retrospective: { stores, llm, route: () => ROUTE, journal, sessionId: 'mc-dreamer' },
    })
    const result = await handler(context)
    expect(result.status).toBe('failed')
    expect(result.error).toBe('llm-failed')
  })
})
