/**
 * Reading one session's stored history back out, by event seq.
 *
 * This is the second recovery channel `ctx_expand` needs and did not have. The
 * first is the tag channel: a `[dropped §N§]` placeholder still sits on the
 * surface, so the original content is one lookup away. That channel dies the
 * moment the message carrying the placeholder is folded into a compartment —
 * `management-pass.ts` retires the drop with `target-gone`, the placeholder
 * goes with the message, and `ctx_expand(tag=N)` can only answer "no dropped
 * item carries this tag".
 *
 * Upstream has the answer: `ctx_expand(message=N)` reads the raw message out of
 * stored history instead of off the surface. Its renderer (`ctx-expand/render.ts`)
 * walks `RawMessage` records from the harness's own store. The host here exposes
 * the same capability under a different shape — `ctx.sessionQuery.readEvent`
 * returns one complete `SessionEvent` (plus a bounded window) straight from the
 * persisted log, whether or not the event is still on the surface.
 *
 * Why `readEvent` and not `listEvents`: `listEvents` returns
 * `buildSessionEventRecords` output — `{seq, type, time, surface}` and no
 * content at all. `readEvent` returns `snapshotSessionEvent(target)`, the whole
 * event. The window (`before`/`after`) is capped by the host at
 * `SESSION_QUERY_READ_WINDOW_MAX` (50), so a wide range is paged, never loaded
 * whole.
 *
 * The event vocabulary is `extractSessionEventText`'s (host `extraction.ts`):
 * `user/message` and `assistant/message` carry content blocks, `tool/call`
 * carries a name plus a JSON argument string, `tool/result` carries content
 * blocks plus an optional error, and the structural events
 * (`turn/start`, `step/start`, `step/end`, `assistant/attempt`, `request/header`)
 * carry nothing worth recovering. Reasoning blocks are deliberately dropped from
 * the recovery view — upstream drops them too (`renderPartFull` returns null for
 * reasoning), because they are not the evidence an agent came back for.
 */

import { estimateTokens } from './token-estimate.ts'

/** Upstream's recovery budget (`CTX_EXPAND_TOKEN_BUDGET`). */
export const CTX_EXPAND_TOKEN_BUDGET = 15_000

/** The host's cap on one `readEvent` window, either side. */
export const READ_EVENT_WINDOW_MAX = 50

/** One content block, structurally — `text`, `reasoning`, `tool-call`, … */
interface ContentBlockLike {
  readonly type?: string
  readonly text?: string
  readonly name?: string
  readonly arguments?: string
}

/** One stored event, structurally. Only the fields the renderers read. */
export interface SessionEventLike {
  readonly seq: number
  readonly type: string
  readonly time?: number
  readonly data?: {
    readonly content?: readonly ContentBlockLike[]
    readonly message?: { readonly content?: readonly ContentBlockLike[] }
    readonly name?: string
    readonly arguments?: string
    readonly error?: { readonly name?: string; readonly code?: string; readonly message?: string }
    readonly todos?: readonly { readonly status?: string; readonly content?: string }[]
    readonly reason?: { readonly kind?: string; readonly error?: { readonly message?: string } }
  }
}

/** The slice of `ctx.sessionQuery` this lane uses. Structural on purpose. */
export interface SessionQueryReadLike {
  readEvent(
    request: {
      readonly sessionId: string
      readonly seq: number
      readonly before?: number
      readonly after?: number
    },
    /**
     * An `AbortSignal`, NOT the tool run context.
     *
     * The host's signature is `readEvent(request, signal)` and its body calls
     * `signal?.throwIfAborted()`. Passing the run context here fails at runtime
     * with "signal?.throwIfAborted is not a function" — measured 2026-11-17 on
     * the first live call, after every unit test passed against a fake that
     * ignored the argument. Omitted entirely when there is no signal to give.
     */
    signal?: AbortSignal,
  ): Promise<{
    readonly target?: SessionEventLike
    readonly events?: readonly SessionEventLike[]
    readonly startSeq?: number
    readonly endSeq?: number
  }>
}

/** Error code the host raises when the seq does not exist. */
export const EVENT_NOT_FOUND_CODE = 'SESSION_QUERY_EVENT_NOT_FOUND'

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = (error as { code?: unknown }).code
  return typeof candidate === 'string' ? candidate : undefined
}

/** Events that carry nothing worth recovering — upstream skips the same set. */
const STRUCTURAL_EVENTS = new Set([
  'turn/start',
  'step/start',
  'step/end',
  'assistant/attempt',
  'request/header',
])

function blockText(block: ContentBlockLike): string | null {
  if (block.type === 'text' && typeof block.text === 'string') {
    return block.text.trim().length > 0 ? block.text : null
  }
  if (block.type === 'tool-call' && typeof block.name === 'string') {
    const args = typeof block.arguments === 'string' ? block.arguments : ''
    return args.length === 0 ? `[tool-call ${block.name}]` : `[tool-call ${block.name}] ${args}`
  }
  // Reasoning and any structural block: not the evidence recovery is for.
  return null
}

function blocksText(blocks: readonly ContentBlockLike[] | undefined): string {
  return (blocks ?? [])
    .map(blockText)
    .filter((line): line is string => line !== null)
    .join('\n')
}

/** A short, stable label for one event's role in the transcript. */
export function eventLabel(event: SessionEventLike): string {
  switch (event.type) {
    case 'user/message': return 'U (user)'
    case 'assistant/message': return 'A (assistant)'
    case 'tool/call': return 'tool call'
    case 'tool/result': return 'tool result'
    case 'todo/write': return 'todos'
    case 'turn/end': return 'turn end'
    default: return event.type
  }
}

/**
 * Full untruncated rendering of one event — the recovery view.
 *
 * Returns `null` for structural events and for events whose only content was
 * reasoning: they carry nothing to recover, and printing `[step/start]` lines
 * would spend the budget saying "nothing here".
 */
export function renderEventFull(event: SessionEventLike): string | null {
  if (STRUCTURAL_EVENTS.has(event.type)) return null
  const data = event.data
  if (data === undefined) return null

  switch (event.type) {
    case 'user/message':
    case 'assistant/message': {
      const text = blocksText(data.message?.content ?? data.content)
      return text.length > 0 ? text : null
    }
    case 'tool/call': {
      const name = data.name ?? 'tool'
      const args = data.arguments ?? ''
      return args.length > 0 ? `[tool: ${name}]\n  arguments: ${args}` : `[tool: ${name}]`
    }
    case 'tool/result': {
      // No `[tool result]` prefix: the block header already labels the event
      // (`[7] tool result`), and repeating it in the body reads as a nested
      // result. The error line stays — that is data the header does not carry.
      const lines: string[] = []
      const text = blocksText(data.message?.content)
      if (text.length > 0) lines.push(text)
      const error = data.error
      if (error !== undefined) {
        const detail = [error.name, error.code, error.message].filter(
          (part): part is string => typeof part === 'string' && part.length > 0,
        )
        if (detail.length > 0) lines.push(`[error] ${detail.join(': ')}`)
      }
      return lines.length > 0 ? lines.join('\n') : null
    }
    case 'todo/write': {
      const todos = data.todos ?? []
      if (todos.length === 0) return null
      return todos
        .map(todo => `- [${todo.status ?? '?'}] ${todo.content ?? ''}`)
        .join('\n')
    }
    case 'turn/end': {
      const reason = data.reason
      if (reason?.kind === 'error' && typeof reason.error?.message === 'string') {
        return `[turn ended: error] ${reason.error.message}`
      }
      return reason?.kind === undefined ? null : `[turn ended: ${reason.kind}]`
    }
    default:
      return null
  }
}

/** One-line preview of an event, for the verbose range view. */
export function renderEventPreview(event: SessionEventLike): string | null {
  const full = renderEventFull(event)
  if (full === null) return null
  const flat = full.replace(/\s+/g, ' ').trim()
  const head = flat.length <= 180 ? flat : `${flat.slice(0, 180)}…`
  return `    • ${head} (~${String(estimateTokens(full))} tok)`
}

/**
 * Render one event by seq, in full.
 *
 * `undefined` means the seq does not exist in stored history (pruned, reverted,
 * or simply wrong) — the caller turns that into a message rather than re-running
 * a tool, whose answer may since have changed.
 */
export async function readEventBySeq(
  query: SessionQueryReadLike,
  sessionId: string,
  seq: number,
): Promise<SessionEventLike | undefined> {
  try {
    const result = await query.readEvent({ sessionId, seq })
    const target = result.target
    return target === undefined ? undefined : target
  } catch (error) {
    if (codeOf(error) === EVENT_NOT_FOUND_CODE) return undefined
    throw error
  }
}

export interface RangeReadResult {
  /** Rendered blocks, one per recoverable event, in seq order. */
  readonly blocks: readonly string[]
  /** Last seq actually rendered. */
  readonly lastSeq: number
  /** True when the budget or the window cap cut the range short. */
  readonly truncated: boolean
  /** True when no event in the range had anything to render. */
  readonly empty: boolean
}

/**
 * Read and render `[start, end]` within a token budget.
 *
 * Paged by the host's window cap: one `readEvent` fetches at most
 * `READ_EVENT_WINDOW_MAX` events past the target, so the loop advances a window
 * at a time and stops on the budget. `verbose` swaps the full render for the
 * per-event preview, which is how the agent picks a single seq to recover.
 */
export async function readEventRange(
  query: SessionQueryReadLike,
  sessionId: string,
  start: number,
  end: number,
  budget: number,
  options: { readonly verbose?: boolean } = {},
): Promise<RangeReadResult> {
  const blocks: string[] = []
  let usedTokens = 0
  let lastSeq = start - 1
  let truncated = false
  let sawAny = false

  let cursor = start
  while (cursor <= end) {
    const want = Math.min(READ_EVENT_WINDOW_MAX, end - cursor + 1)
    let window: readonly SessionEventLike[]
    try {
      const result = await query.readEvent(
        { sessionId, seq: cursor + want - 1, before: want - 1 },
      )
      window = result.events ?? []
    } catch (error) {
      if (codeOf(error) !== EVENT_NOT_FOUND_CODE) throw error
      // The window tail is past the end of the log; retry the single seq so a
      // range that runs off the history still renders what exists.
      const single = await readEventBySeq(query, sessionId, cursor)
      window = single === undefined ? [] : [single]
    }
    if (window.length === 0) break
    sawAny = true

    for (const event of window) {
      if (event.seq < start || event.seq > end) continue
      const body = options.verbose === true
        ? renderEventPreview(event)
        : renderEventFull(event)
      lastSeq = event.seq
      if (body === null) continue
      const block = `[${String(event.seq)}] ${eventLabel(event)}\n${body}`
      const blockTokens = estimateTokens(block)
      if (usedTokens + blockTokens > budget && blocks.length > 0) {
        truncated = true
        return { blocks, lastSeq: lastSeq - 1, truncated, empty: false }
      }
      blocks.push(block)
      usedTokens += blockTokens
    }
    cursor = Math.min(window[window.length - 1]?.seq ?? end, end) + 1
  }

  return { blocks, lastSeq, truncated, empty: !sawAny || blocks.length === 0 }
}
