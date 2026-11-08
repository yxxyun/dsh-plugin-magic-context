/**
 * The agent tools — Magic Context's ctx_reduce / ctx_expand onto the DSH
 * tool registry.
 *
 * The tool CONSTRUCTOR is resolved in this order:
 *  1. `config.defineTool` — host glue that resolved `@deepseek-ai/dsh-tools`
 *     natively (tests, in-tree glue);
 *  2. a dynamic `import('@deepseek-ai/dsh-tools')` — the normal path: the
 *     package is a hard dependency, so every install shape resolves it.
 *
 * When neither resolves, apply() aborts the mount loudly: the ctx_* tools are
 * the only entry for the agent's reduce marks, so a boot without them must not
 * half-run. (The former local `defineTool` reimplementation is gone — it was
 * reachable only while the harness packages were peers; they are pinned
 * dependencies now.)
 *
 * Semantics follow Magic Context's discipline: ctx_reduce only QUEUES marks
 * (a landing is a priced bust, so it waits for the execute band in pre-step
 * — never origins its own); ctx_expand restores original content from the
 * placeholder's cited source event (durable, content-only replacement).
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Journal } from '../core/journal.ts'
import type { MemoryWriter } from '../core/memory-write.ts'
import { parseTagRanges } from '../core/policy.ts'
import type { AdapterStores } from '../core/stores.ts'
import { searchMessageHistory, type SessionQueryLike } from '../core/message-search.ts'
import { previewText } from '../core/memory-search.ts'
import {
  enumerateSurfaceNodes,
  enumerateSurfaceToolResults,
  originalContentOfPlaceholder,
  replaceToolResultContent,
  type SurfaceToolNode,
} from './seams.ts'

/** One authored tool parameter: the JSON-schema keywords this package uses. */
export interface LocalToolParameter {
  readonly type: string
  readonly required?: boolean
  readonly enum?: readonly string[]
  readonly items?: LocalToolParameter
  readonly description?: string
}

/**
 * The subset of `defineTool`'s option shape this package authors, generic over
 * the tool's validated arguments.
 *
 * Arguments are checked at the tool boundary — by {@link defineToolLocal}
 * below, or by the host's own `defineTool` when the profile supplies one — so
 * inside a tool body they carry the declared type instead of an implicit
 * `any`. `exec` is the host's own `ToolRunContext`: the runtime always passes a
 * real one, and the structural stand-in this used to declare
 * (`{ session: { id: string } }`) is not assignable to the branded `Session`
 * the seam functions take.
 */
export interface LocalToolOptions<A = Record<string, unknown>> {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, LocalToolParameter>
  readonly output: {
    readonly schema: { readonly type: 'json' }
    readonly render: (args: A, value: unknown) => ContentBlock[]
  }
  readonly execute: (args: A, exec: ToolRunContext) => Promise<unknown>
}

/**
 * The call shape both tool builders answer to.
 *
 * `defineToolLocal` is a faithful subset of the host's `defineTool`, and the
 * host's builder accepts a wider option type; this names the subset the call
 * sites author, so they keep their contextual types. The seam used to read
 * `(options: never) => unknown`, which kept the two casts quiet but denied
 * every call site its parameter types — three "not assignable to never" errors
 * and twelve implicit-`any` errors that only appeared once the host types
 * became resolvable.
 */
export type LocalDefineTool = <A>(options: LocalToolOptions<A>) => unknown

export interface ToolBridgeDeps {
  readonly stores: AdapterStores
  /** Resolved constructor: `config.defineTool` or the dynamic import. Required — apply() fails loud without one. */
  readonly defineTool: LocalDefineTool
  /** Validation-period activity journal (optional). */
  readonly journal?: Journal
}

/** Probe for the loading-mode diagnostics: resolves the dynamic-import constructor. */
export function resolveDefineTool(): Promise<ToolBridgeDeps['defineTool']> {
  // The host builder takes its own (wider) option type; the seam names the
  // subset we author, so the call sites keep their parameter types.
  return import('@deepseek-ai/dsh-tools').then(module => module.defineTool as LocalDefineTool)
}

interface TagVerdict {
  readonly tag: number
  readonly ok: boolean
  readonly reason?: string
}

/**
 * The session id, when the host supplied a run context. A tool must never
 * throw because the context is missing (a host may call it bare): the memory
 * tool then answers without a session and leaves the recall decision to the
 * host's callback.
 */
function sessionIdOf(
  exec: { readonly agent?: { readonly session: { readonly id: string } } } | undefined,
): string | undefined {
  return exec?.agent?.session.id
}

function ackText(lines: string[]): ContentBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

export function defineCtxReduceTool(deps: ToolBridgeDeps): unknown {
  const defineTool = deps.defineTool
  return defineTool<{ readonly drop: string }>({
    name: 'ctx_reduce',
    description:
      'Mark conversation items you no longer need so their tokens are reclaimed. '
        + 'Pass tag IDs you saw on tool outputs: drop: "3-5, 1, 9". '
        + 'Marks are queued and land when the context manager opens its reclaim band; '
        + 'dropped tool outputs become `[dropped §N§]` placeholders. Nothing is lost: '
        + 'ctx_expand restores any original.',
    parameters: { drop: { type: 'string', required: true } },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const payload = value as { queued?: number[]; refused?: TagVerdict[] }
        const lines: string[] = []
        const queued = payload.queued ?? []
        // A count, not a list (MC 0.49.1 parity): the tags came from the agent's
        // own surface, so echoing them back is pure noise, and the noise grows
        // linearly with the batch. Refusals stay per-tag: each one is an
        // actionable failure the agent must not retry blindly.
        if (queued.length > 0) {
          lines.push(`Queued ${String(queued.length)} ${queued.length === 1 ? 'tag' : 'tags'} for reclaim.`)
        }
        for (const refused of payload.refused ?? []) {
          lines.push(`§${refused.tag}§ not queued: ${refused.reason ?? 'unavailable'}.`)
        }
        if (lines.length === 0) lines.push('Nothing queued.')
        return ackText(lines)
      },
    },
    async execute(args, exec) {
      const startedAt = Date.now()
      const sessionId = sessionIdOf(exec)
      if (sessionId === undefined) return { ok: false, queued: [], refused: [], reason: 'no-session' }
      const requested = parseTagRanges(args.drop)
      const nodes = enumerateSurfaceToolResults(exec.agent!.session, callId =>
        deps.stores.getTag(sessionId, { kind: 'tool-result', callId }))
      const queued: number[] = []
      const refused: TagVerdict[] = []
      const now = Date.now()
      for (const tag of requested) {
        const node: SurfaceToolNode | undefined = nodes.find(candidate => candidate.tagNumber === tag)
        if (node === undefined) {
          refused.push({ tag, ok: false, reason: 'no such tool-output tag on the current surface' })
          continue
        }
        if (node.isPlaceholder) {
          refused.push({ tag, ok: false, reason: 'already dropped' })
          continue
        }
        deps.stores.queueDrop(sessionId, tag, now)
        queued.push(tag)
      }
      deps.journal?.info('tool-call', `ctx_reduce: queued ${String(queued.length)}, refused ${String(refused.length)}`, {
        tool: 'ctx_reduce',
        requested,
        queued,
        refused: refused.map(entry => ({ tag: entry.tag, reason: entry.reason })),
        ms: Date.now() - startedAt,
      }, sessionId)
      return { ok: true, queued, refused }
    },
  })
}

export function defineCtxExpandTool(deps: ToolBridgeDeps): unknown {
  const defineTool = deps.defineTool
  return defineTool<{ readonly tags: string }>({
    name: 'ctx_expand',
    description:
      'Restore previously dropped items in full. Pass tag IDs: tags: "3, 7". '
        + 'The original content returns to the conversation exactly as it was.',
    parameters: { tags: { type: 'string', required: true } },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const payload = value as { restored?: number[]; refused?: TagVerdict[] }
        const lines: string[] = []
        if (payload.restored !== undefined && payload.restored.length > 0) {
          lines.push(`Restored in full: ${payload.restored.map(tag => `§${tag}§`).join(', ')}.`)
        }
        for (const refused of payload.refused ?? []) {
          lines.push(`§${refused.tag}§ not restored: ${refused.reason ?? 'unavailable'}.`)
        }
        if (lines.length === 0) lines.push('Nothing restored.')
        return ackText(lines)
      },
    },
    async execute(args, exec) {
      const startedAt = Date.now()
      const sessionId = sessionIdOf(exec)
      if (sessionId === undefined) return { ok: false, restored: [], refused: [], reason: 'no-session' }
      const requested = parseTagRanges(args.tags)
      const session = exec.agent!.session
      const nodes = enumerateSurfaceToolResults(session, callId =>
        deps.stores.getTag(sessionId, { kind: 'tool-result', callId }))
      const restored: number[] = []
      const refused: TagVerdict[] = []
      for (const tag of requested) {
        const placeholder = nodes.find(candidate => candidate.isPlaceholder && candidate.droppedTag === tag)
        if (placeholder === undefined) {
          refused.push({ tag, ok: false, reason: 'no dropped item carries this tag' })
          continue
        }
        const original = originalContentOfPlaceholder(session, placeholder.seq)
        if (original === undefined) {
          refused.push({ tag, ok: false, reason: 'original content is no longer recoverable' })
          continue
        }
        const restoreSeq = replaceToolResultContent(session, placeholder.seq, original)
        deps.stores.markDropLanded(sessionId, tag, restoreSeq)
        restored.push(tag)
      }
      deps.journal?.info('tool-call', `ctx_expand: restored ${String(restored.length)}, refused ${String(refused.length)}`, {
        tool: 'ctx_expand',
        requested,
        restored,
        refused: refused.map(entry => ({ tag: entry.tag, reason: entry.reason })),
        ms: Date.now() - startedAt,
      }, sessionId)
      return { ok: true, restored, refused }
    },
  })
}

/**
 * `ctx_memory` — read/write access to the plugin's own corpus (memories.db).
 *
 * Reads (list/get) recall project memories, including domain-shared rows.
 * Writes (write/update/archive/merge) reproduce the corpus write contract —
 * normalized hash, dedup bump, mutation log — so every consumer keeps
 * agreeing about the same rows; every failure is a structured
 * `{ok:false, reason}` refusal, never a thrown error.
 */
export interface MemoryToolDeps {
  readonly defineTool: ToolBridgeDeps['defineTool']
  readonly journal?: Journal
  /**
   * Recall callback. The second argument is the tool's run context: a host that
   * scopes recall by `config.memory.project ?? session cwd` needs it, because
   * the request alone carries no session information. `request.identity` is the
   * identity this tool already resolved, so a host can also scope by that and
   * never inspect the context at all.
   */
  readonly recall?: (
    request: MemoryToolRecallRequest,
    exec?: MemoryToolRunContext,
  ) => {
    readonly lines: readonly string[]
    readonly digest: string
    /**
     * Ids of the memory rows this recall returned, when the host can report
     * them. `ctx_memory` then bumps `retrieval_count` for exactly those rows
     * (contract §9.1, Magic Context `search.ts:2258-2276`): explicit
     * agent-driven retrieval counts, automatic m[0]/m[1] surfacing does not.
     * Absent = no telemetry, which is always safe: the count is not correctness.
     */
    readonly ids?: readonly number[]
    /**
     * Why nothing could be recalled (fenced / unavailable store), when the host
     * knows. Reported only when the recall produced no lines, so a working store
     * never grows a reason; without it a fenced store would silently answer
     * `{ empty: true }` and the agent could not tell an empty pool from a
     * read-only downgrade.
     */
    readonly reason?: string
  } | undefined
  /**
   * Absent when memory writes are disabled: the tool then stays read-only.
   * Writes replicate Magic Context's storage contract instead of forking it,
   * and a module-managed project is never written directly.
   */
  readonly writer?: MemoryWriter
  /**
   * A2: the memory ids this session's injected block currently renders
   * (MC getVisibleMemoryIds). Absent = no suppression (fail-open).
   */
  readonly visibleMemoryIdsOf?: (exec?: MemoryToolRunContext) => ReadonlySet<number> | undefined
  /**
   * The hybrid memory search lane (MC ctx_search's memory half): FTS5 +
   * stored-vector cosine with MC's 0.7/0.3 fusion. Read-only — it works even
   * when `writer` is absent, and §9.1 counting applies to its returned ids.
   */
  readonly search?: (request: {
    readonly query: string
    readonly limit?: number
    readonly identity: string
    /** A2: memory ids already rendered in this session's injected block. */
    readonly visibleMemoryIds?: ReadonlySet<number>
    /** A3: created_at window, epoch ms (inclusive both ends). */
    readonly from?: number
    readonly to?: number
  }) => Promise<
    | {
      readonly ok: true
      readonly text: string
      readonly hits: readonly { readonly id: number }[]
    }
    | { readonly ok: false; readonly reason: string }
  >
  /** Resolves the session's `git:`/`dir:` identity for scoped writes. */
  readonly resolveIdentity?: (
    exec: { agent?: { session: { header: { cwd?: string } } } } | undefined,
  ) => string | undefined
  /**
   * Human approval for global-domain candidates (machine + org alike): raises
   * one `ctx.userQuestions` card per pending candidate and publishes only the
   * approved ones. Absent = not wired (headless): the action reports that and
   * touches no state.
   */
  readonly reviewGlobal?: (exec?: MemoryToolRunContext) => Promise<{ outcome: string; detail?: string }>
  /**
   * One-shot promotion (the `promote` action): enqueue one project memory into
   * a global domain's pending pool and IMMEDIATELY raise its approval card —
   * the human-judged lane with no recurrence gate, so a single fresh write can
   * be shared the moment the user asks for it. Absent = not wired: the action
   * reports that and touches no state.
   */
  readonly promoteGlobal?: (input: {
    readonly memoryId: number
    /** Short name (`machine`/`org`) or full `dir:global:*` identity; default org. */
    readonly domain?: string
  }, exec?: MemoryToolRunContext) => Promise<{ outcome: string; detail?: string }>
  /**
   * Resolves an EXPLICIT project spec (absolute path or `git:`/`dir:` identity)
   * to an identity — the `project` argument's resolver. DSH has no OpenCode-style
   * per-turn working directory, so cross-project facts can only be scoped by the
   * model naming the project; the same normalizer keeps every writer agreeing.
   */
  readonly resolveIdentityOf?: (spec: string) => string | undefined
}

/** What `ctx_memory` asks the host to recall (contract §11.6). */
export interface MemoryToolRecallRequest {
  readonly query?: string
  /** Row cap; the host applies its own policy limit when absent. */
  readonly limit?: number
  /**
   * The session's resolved project identity, when one could be resolved. Hosts
   * whose `recall` callback has no session access use this as the scope.
   */
  readonly identity?: string
}

/** The run-context surface `ctx_memory` reads (structural subset of ToolRunContext). */
export interface MemoryToolRunContext {
  readonly agent?: {
    readonly session: {
      readonly id?: string
      readonly header?: { readonly cwd?: string }
    }
  }
}

export function defineCtxMemoryTool(deps: MemoryToolDeps): unknown {
  const defineTool = deps.defineTool
  /**
   * The session's project identity, which every write must carry: Magic Context
   * only lets an agent mutate its own project's memories.
   */
  const identityFor = (exec: unknown): string | undefined => {
    try {
      return deps.resolveIdentity?.(exec as Parameters<NonNullable<MemoryToolDeps['resolveIdentity']>>[0])
    } catch {
      return undefined
    }
  }
  return defineTool<Record<string, unknown>>({
    name: 'ctx_memory',
    description:
      'Read and maintain the project memory store (shared with the other coding agents on this machine): '
        + 'durable facts, constraints, configuration values and naming rules. '
        + 'Actions: list (optionally with query), search (hybrid keyword+semantic retrieval over the pool, '
        + 'optionally bounded by from/to dates), '
        + 'get (by id), write (new memory), update (rewrite one), '
        + 'archive (retire one, optionally superseded by another), merge (fold duplicates into one), '
        + 'review_global (present pending global-domain candidates — the work and global audiences — to the user as '
        + 'approval cards, one at a time; an approved candidate is published into the shared domain), '
        + 'promote (memory_id + optional domain machine|org — machine is the GLOBAL domain every project on '
        + 'this machine sees, org is the WORK domain limited to its member projects: enqueue one project memory '
        + 'into that domain and IMMEDIATELY raise its approval card — approved publishes, rejected retires it for '
        + 'good; the human-judged lane with no recurrence gate, so a single fresh write can be shared '
        + 'right away). '
        + 'Writes are scoped to this project and deduplicated by normalized content. '
        + 'Every action accepts an optional project (an absolute path or git root): use it when the '
        + 'memory belongs to ANOTHER project than the one this session was opened in — reading a '
        + "project's memories or writing facts about it while you work on it from a different session.",
    parameters: {
      action: { type: 'string', enum: ['list', 'search', 'get', 'write', 'update', 'archive', 'merge', 'review_global', 'promote'] },
      query: { type: 'string' },
      limit: { type: 'integer' },
      from: { type: 'string' },
      to: { type: 'string' },
      id: { type: 'integer' },
      ids: { type: 'array', items: { type: 'integer' } },
      category: { type: 'string' },
      content: { type: 'string' },
      importance: { type: 'integer' },
      reason: { type: 'string' },
      superseded_by: { type: 'integer' },
      target_id: { type: 'integer' },
      project: { type: 'string' },
      memory_id: { type: 'integer' },
      domain: { type: 'string' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const payload = value as {
          lines?: string[]
          digest?: string
          empty?: boolean
          reason?: string
          action?: string
          outcome?: string
          detail?: string
          /** `search` action: the rendered hits line. */
          search?: string
          /** `search` action: how many rows the query matched. */
          hits?: number
          memory?: { id: number; category: string; content: string; importance: number }
        }
        if (payload.reason !== undefined) return ackText([`Memory store unavailable: ${payload.reason}`])
        if (payload.search !== undefined) return ackText([String(payload.search)])
        if (payload.outcome !== undefined) {
          return ackText([payload.outcome, ...payload.detail === undefined ? [] : [payload.detail]])
        }
        if (payload.memory !== undefined) {
          return ackText([
            `Memory ${String(payload.memory.id)} [${payload.memory.category}] (importance ${String(payload.memory.importance)}):`,
            payload.memory.content,
          ])
        }
        if (payload.empty === true || payload.lines === undefined || payload.lines.length === 0) {
          return ackText(['No matching project memories.'])
        }
        return ackText([
          `Project memories (${String(payload.lines.length)} shown):`,
          ...payload.lines,
        ])
      },
    },
    async execute(args, exec) {
      const startedAt = Date.now()
      const sessionId = sessionIdOf(exec)
      const action = typeof args.action === 'string' ? args.action : 'list'
      // Effective scope: the session's project unless the model names another
      // one via `project`. An unresolvable spec is a structured refusal — the
      // model then knows the write/read did NOT happen under some guessed scope.
      const explicitProject = typeof args.project === 'string' && args.project.trim() !== ''
        ? args.project.trim()
        : undefined
      let identity = identityFor(exec)
      const finish = (payload: Record<string, unknown>): Record<string, unknown> => {
        const summary = payload.outcome
          ?? (payload.memory !== undefined
            ? `memory ${(payload.memory as { id: number }).id}`
            : payload.search !== undefined
              ? `search: ${String(payload.hits ?? 0)} result(s)`
              : `${String((payload.lines as string[] | undefined)?.length ?? 0)} line(s)`)
        deps.journal?.info('tool-call', `ctx_memory ${action}: ${String(summary)}`, {
          tool: 'ctx_memory',
          action,
          identity,
          ...explicitProject === undefined ? {} : { explicitProject },
          query: args.query,
          id: args.id,
          // The panel's read row shows the hit count (`detail.hits`); without it
          // a search record could only say "search".
          ...typeof payload.hits === 'number' ? { hits: payload.hits } : {},
          ms: Date.now() - startedAt,
          ok: typeof payload.ok === 'boolean' ? payload.ok : payload.reason === undefined,
        }, sessionId)
        return payload
      }
      if (explicitProject !== undefined) {
        let resolved: string | undefined
        if (explicitProject.startsWith('git:') || explicitProject.startsWith('dir:')) {
          resolved = explicitProject
        } else {
          try {
            resolved = deps.resolveIdentityOf?.(explicitProject)
          } catch {
            resolved = undefined
          }
        }
        if (resolved === undefined || resolved === '') {
          return finish({
            outcome: `project "${explicitProject}" could not be resolved to a project identity `
              + '(directory missing, or not inside a git repository and not an identity string). '
              + 'Nothing was read or written.',
            ok: false,
          })
        }
        identity = resolved
      }

      if (action === 'review_global') {
        if (deps.reviewGlobal === undefined) {
          return finish({ reason: 'global review is not wired in this host' })
        }
        const result = await deps.reviewGlobal(exec as MemoryToolRunContext)
        return finish(result)
      }

      if (action === 'promote') {
        if (deps.promoteGlobal === undefined) {
          return finish({ reason: 'global promotion is not wired in this host' })
        }
        if (typeof args.memory_id !== 'number' || !Number.isInteger(args.memory_id)) {
          return finish({
            outcome: 'promote needs an integer memory_id (the project memory to enqueue for approval). '
              + 'Nothing was promoted.',
            ok: false,
          })
        }
        const domain = typeof args.domain === 'string' && args.domain.trim() !== '' ? args.domain.trim() : undefined
        const result = await deps.promoteGlobal({ memoryId: args.memory_id, ...(domain === undefined ? {} : { domain }) },
          exec as MemoryToolRunContext)
        return finish(result)
      }

      if (action === 'list' || (action === 'get' && args.id === undefined)) {
        const recall = deps.recall
        if (recall === undefined) {
          return finish({ reason: 'memory recall is not wired in this host' })
        }
        // The run context goes to the host alongside the request: a host whose
        // recall callback scopes by `config.memory.project ?? session cwd` has
        // no other way to see the session (index.ts), and `identity` is the
        // identity this tool already resolved for the same purpose. The two
        // model-supplied fields are narrowed here: `args` is the validated
        // argument record, and a `query`/`limit` of the wrong type must not
        // reach the host's recall as a non-string / non-number.
        const query = typeof args.query === 'string' ? args.query : undefined
        const limit = typeof args.limit === 'number' ? args.limit : undefined
        const result = recall({
          ...query === undefined ? {} : { query },
          ...limit === undefined ? {} : { limit },
          ...identity === undefined ? {} : { identity },
        }, exec as MemoryToolRunContext)
        if (result === undefined) return finish({ empty: true })
        // A store the host could not read at all (fenced schema, unreadable file)
        // must say so: `{ empty: true }` would read as "your project has no
        // memories", which is a different fact.
        if (result.lines.length === 0 && result.reason !== undefined) {
          return finish({ reason: result.reason })
        }
        // Retrieval telemetry (contract §9.1): the agent explicitly searched here,
        // so the rows it received are counted. Telemetry is never correctness, so
        // a fenced / authority-blocked / failing store is swallowed and the agent
        // still gets its lines. An automatic injection path must NOT reach here.
        const recalledIds = result.ids
        if (recalledIds !== undefined && recalledIds.length > 0 && identity !== undefined) {
          try {
            deps.writer?.recordRetrieval({ identity, ids: [...recalledIds] })
          } catch {
            // never fail a read because a counter could not be bumped
          }
        }
        return finish({ lines: [...result.lines], digest: result.digest })
      }

      if (action === 'search') {
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        if (query.length === 0) return finish({ outcome: 'search needs a query.' })
        if (deps.search === undefined) {
          return finish({ reason: 'memory search is not wired in this host' })
        }
        if (identity === undefined) {
          return finish({ reason: 'no project identity could be resolved for this session' })
        }
        // A3: `from`/`to` accept an ISO date (YYYY-MM-DD, local midnight /
        // end-of-day) or epoch milliseconds; invalid values are ignored.
        const parseBound = (raw: unknown, endOfDay: boolean): number | undefined => {
          if (typeof raw === 'number' && Number.isFinite(raw)) return raw
          if (typeof raw !== 'string') return undefined
          const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : raw)
          if (Number.isNaN(ms)) return undefined
          return endOfDay ? ms + 24 * 3600 * 1000 - 1 : ms
        }
        const from = parseBound(args.from, false)
        const to = parseBound(args.to, true)
        const visibleMemoryIds = deps.visibleMemoryIdsOf?.(exec)
        const outcome = await deps.search({
          query,
          ...args.limit === undefined ? {} : { limit: args.limit as number },
          identity,
          ...visibleMemoryIds === undefined ? {} : { visibleMemoryIds },
          ...from === undefined ? {} : { from },
          ...to === undefined ? {} : { to },
        })
        if (!outcome.ok) return finish({ reason: outcome.reason })
        // Retrieval telemetry (contract §9.1): an explicit search counts, in
        // MC only through ctx_search — the same rule, same call shape.
        if (outcome.hits.length > 0) {
          try {
            deps.writer?.recordRetrieval({ identity, ids: outcome.hits.map(hit => hit.id) })
          } catch {
            // never fail a read because a counter could not be bumped
          }
        }
        return finish({ search: outcome.text, hits: outcome.hits.length })
      }

      // Every remaining action writes (or reads one row by id) and needs the
      // writer plus a resolved identity.
      const writer = deps.writer
      if (writer === undefined) {
        return finish({ reason: 'memory writes are disabled (memory.enabled / memory.write)' })
      }
      if (identity === undefined) {
        return finish({ reason: 'no project identity could be resolved for this session' })
      }

      if (action === 'get') {
        const row = writer.getMemory(identity, args.id as number)
        if (row === undefined) return finish({ outcome: `No memory ${String(args.id)} in this project.` })
        // Contract §9.1: a single-row get does NOT count as a retrieval — only
        // explicit list/query searches do (MC search.ts:2258-2281: "a row read
        // is not a search"). Pinned by memory-retrieval-wiring.spec.ts.
        return finish({
          memory: { id: row.id, category: row.category, content: row.content, importance: row.importance ?? 50 },
        })
      }
      if (action === 'write') {
        if (typeof args.content !== 'string' || typeof args.category !== 'string') {
          return finish({ outcome: 'write needs both category and content.' })
        }
        const result = writer.writeMemory({
          identity,
          category: args.category,
          content: args.content,
          ...args.importance === undefined ? {} : { importance: args.importance as number },
          ...sessionId === undefined ? {} : { sessionId },
        })
        if (!result.ok) return finish({ outcome: `write refused (${result.reason}).`, detail: result.detail })
        return finish({
          outcome: result.created === false
            ? `Already known (memory ${String(result.id)}, seen ${String(result.seenCount ?? 0)} times).`
            : `Saved as memory ${String(result.id)} [${args.category}].`,
        })
      }
      if (action === 'update') {
        if (args.id === undefined || typeof args.content !== 'string') {
          return finish({ outcome: 'update needs id and content.' })
        }
        const result = writer.updateMemory({
          identity,
          id: args.id as number,
          content: args.content,
          ...args.category === undefined ? {} : { category: args.category as string },
          ...args.importance === undefined ? {} : { importance: args.importance as number },
        })
        if (!result.ok) return finish({ outcome: `update refused (${result.reason}).`, detail: result.detail })
        return finish({ outcome: `Updated memory ${String(result.id)}.` })
      }
      if (action === 'archive') {
        if (args.id === undefined) return finish({ outcome: 'archive needs id.' })
        const result = writer.archiveMemory({
          identity,
          id: args.id as number,
          ...args.reason === undefined ? {} : { reason: args.reason as string },
          ...args.superseded_by === undefined ? {} : { supersededBy: args.superseded_by as number },
        })
        if (!result.ok) return finish({ outcome: `archive refused (${result.reason}).`, detail: result.detail })
        return finish({ outcome: `Archived memory ${String(result.id)}.` })
      }
      if (action === 'merge') {
        const target = (args.target_id ?? args.id) as number | undefined
        const sources = (args.ids ?? []) as number[]
        if (target === undefined || sources.length === 0 || typeof args.content !== 'string') {
          return finish({ outcome: 'merge needs target_id, ids and the merged content.' })
        }
        const result = writer.mergeMemory({
          identity,
          targetId: target,
          sourceIds: sources,
          content: args.content,
          ...args.category === undefined ? {} : { category: args.category as string },
        })
        if (!result.ok) return finish({ outcome: `merge refused (${result.reason}).`, detail: result.detail })
        return finish({
          outcome: `Merged ${String(result.superseded.length)} row(s) into memory ${String(result.id)}.`,
        })
      }
      return finish({ outcome: `Unknown action "${action}".` })
    },
  })
}

/**
 * `ctx_search` — one query across the three recall surfaces the model cannot
 * see at once: project memory, this session's earlier history, and the note
 * queue.
 *
 * Why one tool instead of three: the agent's question is "did we already
 * establish this somewhere", and the answer's source is an implementation
 * detail of where it was stored. Upstream MC unifies five lanes; three of its
 * sources have no DSH analogue (`git_commit` has no commit index here,
 * `primer` and `improvement` are dreamer artifacts that were deliberately not
 * ported), and `facts` is excluded upstream too — the injected m[0] block
 * already renders it, so searching it returns what the model is reading.
 *
 * Failure discipline: every lane is independent and reports its own state. A
 * disabled session index (the host ships `openAt: never`) must not fail the
 * whole call — memory and notes still answer, with one line saying history was
 * not searched and why.
 */
export interface SearchToolDeps {
  readonly defineTool: ToolBridgeDeps['defineTool']
  readonly journal?: Journal
  readonly stores: AdapterStores
  /** Memory lane (the `ctx_memory search` closure), absent when memory is off. */
  readonly search?: MemoryToolDeps['search']
  /** The session's project identity for the memory lane. */
  readonly resolveIdentity?: MemoryToolDeps['resolveIdentity']
  /** Memory ids the injected block already renders (suppressed from hits). */
  readonly visibleMemoryIdsOf?: MemoryToolDeps['visibleMemoryIdsOf']
  /**
   * The host's session index, resolved per call: `ctx.sessionQuery` is an
   * optional service, so the composition root passes a getter rather than a
   * value captured at mount.
   */
  readonly sessionQueryOf?: (exec?: MemoryToolRunContext) => SessionQueryLike | undefined
}

const SEARCH_SOURCES: readonly string[] = ['memory', 'message', 'note']
const DEFAULT_SEARCH_LIMIT = 8

function normalizeSources(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return SEARCH_SOURCES
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const name = entry.trim().toLowerCase()
    if (SEARCH_SOURCES.includes(name)) seen.add(name)
  }
  // An explicit empty list means "no filter", same as upstream: the agent that
  // named only unknown sources wants the default, not silence.
  return seen.size === 0 ? SEARCH_SOURCES : [...seen]
}

/** `now - t` as the compact age upstream prints (`3h`, `12d`, `2mo`). */
function ageOf(ageMs: number): string {
  const minutes = Math.max(0, Math.round(ageMs / 60_000))
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)}h`
  const days = Math.round(hours / 24)
  if (days < 60) return `${String(days)}d`
  return `${String(Math.round(days / 30))}mo`
}

export function defineCtxSearchTool(deps: SearchToolDeps): unknown {
  const defineTool = deps.defineTool
  return defineTool<{
    readonly query: string
    readonly limit?: number
    readonly sources?: readonly string[]
  }>({
    name: 'ctx_search',
    description:
      'Search across project memory, this session\'s earlier conversation (including turns the context '
        + 'manager has since compacted or dropped), and pending notes. Use it when the answer may already '
        + 'have been established earlier — a decision, a config value, a command that worked, a file you '
        + 'touched — instead of re-deriving it or asking the user again. '
        + 'sources accepts memory, message, note (default: all three). '
        + 'History hits come back as event seqs: read them with ctx_expand or the session reader.',
    parameters: {
      query: { type: 'string', required: true },
      limit: { type: 'integer' },
      sources: { type: 'array', items: { type: 'string', enum: [...SEARCH_SOURCES] } },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const payload = value as { lines?: string[]; empty?: boolean; reason?: string }
        // A refusal is a REFUSAL, not "no results": the empty-query path sets
        // both `reason` and `empty`, and rendering it as "No results." would
        // teach the model that the corpus has nothing rather than that it
        // forgot to say what to look for.
        if (payload.reason !== undefined) {
          return ackText([payload.lines === undefined ? `Search unavailable: ${payload.reason}` : payload.reason])
        }
        const lines = payload.lines ?? []
        if (lines.length === 0) return ackText(['No results.'])
        return ackText(lines)
      },
    },
    async execute(args, exec) {
      const startedAt = Date.now()
      const sessionId = sessionIdOf(exec)
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const limit = Math.max(1, Math.min(25, args.limit ?? DEFAULT_SEARCH_LIMIT))
      if (query.length === 0) {
        return { lines: [], empty: true, reason: 'ctx_search needs a query' }
      }
      const sources = normalizeSources(args.sources)
      const blocks: string[] = []
      const notes: string[] = []

      if (sources.includes('memory') && deps.search !== undefined) {
        const identity = (() => {
          try {
            return deps.resolveIdentity?.(exec as Parameters<NonNullable<MemoryToolDeps['resolveIdentity']>>[0])
          } catch {
            return undefined
          }
        })()
        if (identity === undefined) {
          notes.push('memory: no project identity for this session')
        } else {
          const visible = deps.visibleMemoryIdsOf?.(exec)
          const outcome = await deps.search({
            query,
            limit,
            identity,
            ...visible === undefined ? {} : { visibleMemoryIds: visible },
          })
          if (outcome.ok) {
            // The memory lane already renders MC's hit format; reuse it rather
            // than reformat and drift from the `ctx_memory search` output.
            if (outcome.hits.length > 0) blocks.push(outcome.text)
          } else {
            notes.push(`memory: ${outcome.reason}`)
          }
        }
      }

      if (sources.includes('message') && sessionId !== undefined) {
        // Live surface seqs are excluded: they are already in the window, and
        // returning them spends output tokens on what the model just read.
        const live = new Set<number>()
        try {
          const session = exec.agent?.session
          if (session !== undefined) {
            for (const node of enumerateSurfaceNodes(session)) live.add(node.seq as unknown as number)
          }
        } catch {
          /* no session view: no exclusion, worst case a redundant hit */
        }
        const outcome = await searchMessageHistory(deps.sessionQueryOf?.(exec), {
          sessionId,
          query,
          limit,
          ...live.size === 0 ? {} : { liveSeqs: live },
        })
        if (outcome.ok) {
          if (outcome.hits.length > 0) {
            const rendered = outcome.hits.map((hit, index) =>
              `[${String(index + 1)}] [message] seq=${String(hit.seq)} type=${hit.type}\n${previewText(hit.snippet)}`)
            blocks.push(`History (${String(outcome.hits.length)} hit${outcome.hits.length === 1 ? '' : 's'}):\n\n${rendered.join('\n\n')}`)
          }
        } else if (outcome.reason === 'disabled') {
          notes.push('message history: the session index is disabled in this deployment (openAt: never)')
        } else {
          notes.push(`message: ${outcome.reason}`)
        }
      }

      if (sources.includes('note')) {
        // Notes are a small local table: a substring match over the content is
        // honest and cheap, and there is no ranking to get wrong.
        const cwd = exec.agent?.session.header?.cwd
        const rows = deps.stores.listNotes({
          ...sessionId === undefined ? {} : { sessionId },
          ...cwd === undefined ? {} : { projectPath: cwd },
          status: 'open',
          limit: 50,
        })
        const needle = query.toLowerCase()
        const matched = rows.filter(row => row.content.toLowerCase().includes(needle)).slice(0, limit)
        if (matched.length > 0) {
          const now = Date.now()
          const rendered = matched.map((row, index) =>
            `[${String(index + 1)}] [note] id=#${String(row.id)} status=${row.status} age=${ageOf(now - row.createdAt)}\n${previewText(row.content)}`)
          blocks.push(`Notes (${String(matched.length)} hit${matched.length === 1 ? '' : 's'}):\n\n${rendered.join('\n\n')}`)
        }
      }

      deps.journal?.info('tool-call', `ctx_search: ${String(blocks.length)} lane(s) matched`, {
        tool: 'ctx_search',
        query,
        sources,
        blocks: blocks.length,
        ms: Date.now() - startedAt,
        notes,
      }, sessionId)

      if (blocks.length === 0) {
        return {
          lines: [
            `No results for "${query}" across ${sources.join(', ')}.`,
            ...notes.map(note => `(${note})`),
          ],
          empty: true,
        }
      }
      return {
        lines: [
          ...blocks,
          ...notes.length === 0 ? [] : ['', ...notes.map(note => `(${note})`)],
        ],
      }
    },
  })
}

/**
 * `ctx_note` — the pending-intention queue.
 *
 * What this is NOT: a second memory store. A note is a thing you mean to come
 * back to WITH its findings attached; it is expected to go stale and be
 * dismissed, and nothing depends on it. Durable facts, rules and configuration
 * belong in memory (`ctx_memory`), where the injected baseline keeps them
 * alive. Upstream states the same boundary in the tool description, and the
 * distinction is the only reason the two stores are separate.
 */
export interface NoteToolDeps {
  readonly defineTool: ToolBridgeDeps['defineTool']
  readonly journal?: Journal
  readonly stores: AdapterStores
  /** Records the note's anchor ordinal (the newest indexed message). */
  readonly anchorOrdinalOf?: (exec?: MemoryToolRunContext) => number | undefined
}

const NOTE_READ_LIMIT = 25
const DISMISS_FOOTER = 'To dismiss a stale note: ctx_note(action="dismiss", note_ids=[N])'

export function defineCtxNoteTool(deps: NoteToolDeps): unknown {
  const defineTool = deps.defineTool
  return defineTool<{
    readonly action: string
    readonly content?: string
    readonly note_ids?: readonly number[]
  }>({
    name: 'ctx_note',
    description:
      'Session notes are pending intentions: work you intend to return to, with its findings attached. '
        + 'Write one when you park a thread mid-way and would lose its context. '
        + 'Do NOT use notes for: the next few steps (keep working), an active plan, a restart/crash '
        + 'cushion, or a plain record of how things stand that you do not intend to act on — that goes '
        + 'stale silently; a fact worth keeping is memory, the rest is nothing. '
        + 'Active work belongs in todos; if the detail already lives in a file, note the path instead '
        + 'of copying it; durable facts belong in ctx_memory. '
        + 'Actions: write (content), read (optionally note_ids), update (note_ids exactly one + content), '
        + 'dismiss (1..50 ids — a queue you never dismiss from stops being read).',
    parameters: {
      action: { type: 'string', required: true, enum: ['write', 'read', 'update', 'dismiss'] },
      content: { type: 'string' },
      note_ids: { type: 'array', items: { type: 'integer' } },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const payload = value as {
          lines?: string[]
          reason?: string
          outcome?: string
          detail?: string
        }
        if (payload.reason !== undefined) return ackText([`Notes unavailable: ${payload.reason}`])
        if (payload.outcome !== undefined) {
          return ackText([payload.outcome, ...payload.detail === undefined ? [] : [payload.detail]])
        }
        const lines = payload.lines ?? []
        return ackText(lines.length === 0 ? ['No notes.'] : lines)
      },
    },
    async execute(args, exec) {
      const startedAt = Date.now()
      const sessionId = sessionIdOf(exec)
      const action = typeof args.action === 'string' ? args.action : 'read'
      const cwd = exec.agent?.session.header?.cwd
      const now = Date.now()
      const ids = Array.isArray(args.note_ids)
        ? args.note_ids.filter((id): id is number => typeof id === 'number' && Number.isInteger(id))
        : []
      const finish = (payload: Record<string, unknown>): Record<string, unknown> => {
        deps.journal?.info('tool-call', `ctx_note ${action}`, {
          tool: 'ctx_note',
          action,
          count: Array.isArray(payload.lines) ? (payload.lines as string[]).length : ids.length,
          ms: Date.now() - startedAt,
          ok: payload.reason === undefined,
        }, sessionId)
        return payload
      }

      if (action === 'write') {
        const content = typeof args.content === 'string' ? args.content.trim() : ''
        if (content.length === 0) return finish({ reason: 'write needs content' })
        const anchor = deps.anchorOrdinalOf?.(exec)
        const row = deps.stores.createNote({
          content,
          ...sessionId === undefined ? {} : { sessionId },
          ...cwd === undefined ? {} : { projectPath: cwd },
          ...anchor === undefined ? {} : { anchorOrdinal: anchor },
        }, now)
        return finish({ outcome: `Saved note #${String(row.id)}.` })
      }

      if (action === 'read') {
        if (ids.length > 0) {
          const lines: string[] = []
          for (const id of ids) {
            const row = deps.stores.getNote(id)
            if (row === undefined) {
              lines.push(`#${String(id)}: no such note.`)
              continue
            }
            lines.push(`#${String(row.id)} · ${ageOf(now - row.createdAt)} · ${row.status}`)
            lines.push(row.content)
            lines.push('')
          }
          return finish({ lines })
        }
        const rows = deps.stores.listNotes({
          ...sessionId === undefined ? {} : { sessionId },
          ...cwd === undefined ? {} : { projectPath: cwd },
          status: 'open',
          limit: NOTE_READ_LIMIT,
        })
        if (rows.length === 0) return finish({ lines: [] })
        const lines = rows.map(row => {
          const stale = now - row.createdAt > 30 * 24 * 3600 * 1000 ? ' (stale)' : ''
          const first = row.content.split('\n')[0]?.trim() ?? ''
          const title = first.length > 80 ? `${first.slice(0, 79)}…` : first
          return `#${String(row.id)} · ${ageOf(now - row.createdAt)} · ${title}${stale}`
        })
        lines.push('', DISMISS_FOOTER)
        return finish({ lines })
      }

      if (action === 'update') {
        if (ids.length !== 1) return finish({ reason: 'update needs exactly one note id' })
        const content = typeof args.content === 'string' ? args.content.trim() : ''
        if (content.length === 0) return finish({ reason: 'update needs content' })
        const row = deps.stores.updateNote(ids[0]!, content, now)
        if (row === undefined) return finish({ reason: `no note #${String(ids[0])}` })
        return finish({ outcome: `Updated note #${String(row.id)}.` })
      }

      if (action === 'dismiss') {
        if (ids.length === 0) return finish({ reason: 'dismiss needs at least one note id' })
        if (ids.length > 50) return finish({ reason: 'dismiss takes at most 50 ids at once' })
        const count = deps.stores.retireNotes(ids, 'dismiss', now)
        return finish({ outcome: `Dismissed ${String(count)} note(s).` })
      }

      return finish({ reason: `unknown action "${action}"` })
    },
  })
}
