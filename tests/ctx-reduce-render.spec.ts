/**
 * `ctx_reduce`'s agent-facing reply is a COUNT, not a tag list (MC 0.49.1
 * parity, followed up 2026-10-15).
 *
 * Why: the tags the agent stamps came from its own surface, so echoing them
 * back is pure noise, and the noise grows linearly with the batch size (a
 * 20-tag pass used to render 20 `§N§` handles plus two fixed lines). MC 0.49.1
 * changed the reply to a short count for exactly this reason.
 *
 * What deliberately does NOT change:
 *  - REFUSALS stay one line each: "no such tool-output tag on the current
 *    surface" / "already dropped" are actionable, and collapsing them into a
 *    count would make the agent retry a dead tag blindly.
 *  - The journal line (`ctx_reduce: queued N, refused M`, tool-bridge.ts:167)
 *    is machine-read by the client half and pinned by client-pure.spec.ts:137,
 *    so it is untouched by this change.
 *
 * `render` is a pure function of the tool result, so these specs drive it
 * without a session, a store, or the host.
 */
import { describe, expect, it } from 'vitest'
import { defineCtxReduceTool } from '../src/dsh/tool-bridge.ts'
import type { LocalDefineTool } from '../src/dsh/tool-bridge.ts'
import type { AdapterStores } from '../src/core/stores.ts'

type Render = (args: { readonly drop: string }, value: unknown) => { readonly text?: string }[]

/** Capture the registered options and hand back `output.render`. */
function reduceRender(): Render {
  const holder: { options?: { output: { render: Render } } } = {}
  const defineTool = ((options: { output: { render: Render } }) => {
    holder.options = options
    return options
  }) as unknown as LocalDefineTool
  defineCtxReduceTool({ stores: {} as AdapterStores, defineTool })
  const captured = holder.options
  if (captured === undefined) throw new Error('ctx_reduce did not register a definition')
  return captured.output.render
}

const renderText = (value: unknown): string =>
  reduceRender()({ drop: '1' }, value).map(block => block.text ?? '').join('\n')

/** Capture the whole registered definition, for the description itself. */
function reduceDefinition(): {
  readonly description: string
  readonly parameters: Record<string, { readonly description?: string }>
} {
  const holder: { options?: { description: string; parameters: Record<string, { readonly description?: string }> } } = {}
  const defineTool = ((options: unknown) => {
    holder.options = options as typeof holder.options
    return options
  }) as unknown as LocalDefineTool
  defineCtxReduceTool({ stores: {} as AdapterStores, defineTool })
  if (holder.options === undefined) throw new Error('ctx_reduce did not register a definition')
  return holder.options
}

describe('ctx_reduce reply is a count (MC 0.49.1 parity)', () => {
  it('positive: a 3-tag batch renders one count line, and no tag handles', () => {
    const text = renderText({ ok: true, queued: [3, 4, 5], refused: [] })
    expect(text).toBe('Queued 3 tags for reclaim.')
    // Negative control: the old enumerated form must stay gone.
    expect(text).not.toContain('§3§')
    expect(text).not.toContain('Queued for reclaim:')
    expect(text).not.toContain('reclaim band')
  })

  it('singular: one tag reads "tag", not "tags"', () => {
    expect(renderText({ ok: true, queued: [9], refused: [] })).toBe('Queued 1 tag for reclaim.')
  })

  it('refusals stay per-tag, on their own line, beside the count', () => {
    const text = renderText({
      ok: true,
      queued: [1, 2],
      refused: [{ tag: 7, ok: false, reason: 'already dropped' }],
    })
    expect(text).toBe('Queued 2 tags for reclaim.\n§7§ not queued: already dropped.')
  })

  it('a refusal with no reason still names the tag', () => {
    const text = renderText({ ok: true, queued: [], refused: [{ tag: 4, ok: false }] })
    expect(text).toBe('§4§ not queued: unavailable.')
  })

  it('nothing queued and nothing refused says so once', () => {
    expect(renderText({ ok: true, queued: [], refused: [] })).toBe('Nothing queued.')
    expect(renderText({})).toBe('Nothing queued.')
  })
})


// The description is the only place an agent learns WHAT to stamp and what to
// leave alone. The port had shipped 324 chars (25% of upstream) — the queue
// mechanics without the judgement — and a tool that only says "mark things you
// no longer need" produces either timidity or blanket sweeps.
describe('ctx_reduce description carries the stamp/keep judgement', () => {
  it('states the two lists verbatim from upstream', () => {
    const description = reduceDefinition().description
    expect(description).toContain('Stamp: file reads, search results and tool outputs')
    expect(description).toContain('build/test output after you acted on it')
    expect(description).toContain('Keep: user messages (never stamp one for its directive)')
    expect(description).toContain('raw evidence you have not extracted yet')
  })

  it('forbids blanket ranges and prefers many small stamps', () => {
    const description = reduceDefinition().description
    expect(description).toContain('never blanket-stamp a range like "1-50"')
    expect(description).toContain('Many small targeted stamps beat one sweep')
  })

  it('reframes the question as "what comes next", not "have I read it"', () => {
    expect(reduceDefinition().description)
      .toContain('does this need to stay on my desk for what comes next?')
  })

  it('names BOTH recovery channels instead of promising nothing is lost', () => {
    // Upstream promises "the newest tags are protected so stamping recent output
    // is harmless". This host has no such floor for a MANUAL stamp (it lands the
    // next time the execute band opens), so the honest claim is recoverability:
    // tag while the placeholder lives, event seq after the fold.
    const description = reduceDefinition().description
    expect(description).toContain('[dropped §N§]')
    expect(description).toContain('message=<seq>')
    expect(description).toContain('folded into a compartment')
    expect(description).not.toContain('the newest tags are protected')
  })

  it('advertises the range syntax the parser actually accepts', () => {
    // parseTagRanges handles "3-5", "1,2,9" and the mixed "1-5,8,12-15"; a
    // description that showed only single numbers would hide the batch form.
    const definition = reduceDefinition()
    expect(definition.description).toContain('"3-5", "1,2,9", "1-5,8,12-15"')
    expect(definition.parameters.drop?.description).toContain('1-5,8,12-15')
  })
})
