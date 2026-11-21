import { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createHash } from 'node:crypto'
/**
 * The preStep band: the real-user-turn counter, cross-project drift
 * observation, maintenance identity registration, and the pressure decision
 * with its execute-band management pass. Moved verbatim out of index.ts; the
 * closure locals the body used are now the destructured fields of
 * {@link PreStepDeps} so the moved code keeps its names.
 *
 * Admission stamps nothing. §N§ handles belong to tool results (index.ts, on
 * `tools/post-execute`), the only content the reclaim lanes can resolve — a
 * handle on a user message or on a host-injected context node is dead weight
 * that also leaks into the record and the derived title (see preStepListener).
 *
 * Also home to the reduce-guidance SystemPrompt injection (the desk section
 * and the Channel 1/2 dynamic context) — the other half of the guidance band.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AdapterStores } from '../core/stores.ts'
import type { CompartmentLease } from '../core/compartment-lease.ts'
import type { Journal } from '../core/journal.ts'
import { decidePass, pressurePercent, pressureWindowTokens, withTokenThreshold, type PressurePolicy } from '../core/policy.ts'
import { machineDomainConfigOf } from './machine-domain-config.ts'
import { memoryLaneEnabled } from './live-flags.ts'
import { PROFILE_M0_BUDGET_TOKENS, resolveIdentitySpec } from '../core/memory-bridge.ts'
import type { MemoryFact } from '../core/memory-categories.ts'
import { errText } from '../core/types.ts'
import { estimateTokens } from '../core/compartments.ts'
import { renderHistorianMemoryBlock } from '../core/memory-bridge.ts'
import {
  DSH_EVENTS,
  type PreStepEnterDecision,
  type PreStepPayload,
  type Session,
  type UserMessage,
  enumerateSurfaceNodes,
  enumerateSurfaceToolResults,
  requestContextOf,
  wireStrandedResults,
} from './seams.ts'
import { runManagementPass } from './management-pass.ts'
import { evaluateEmergencyFailClosed } from '../core/emergency-fail-closed.ts'
import { provenLimitKey } from '../core/provider-limit.ts'
import { calibratedWireEstimate, pairEstimateSamples, summarise } from '../core/wire-accuracy.ts'
import { surfaceTokens, surfaceWireTokens } from './management-pass.ts'
import { compareServed, noteServed, servedRecord } from '../core/served-check.ts'
import { protectedToolTokens } from './emergency.ts'
import { appendMagicContextEntry } from './session-notice.ts'
import { historianInFlight } from './historian.ts'
import { syncMachineDomain } from '../core/machine-domain.ts'
import type { HistorianLlm } from './historian.ts'
import {
  buildChannel1Reminder,
  buildChannel2Reminder,
  buildDeskSection,
  decideReduceNudge,
  type ReduceNudgeTracker,
} from './reduce-guidance.ts'
import { appendSessionNotice } from './session-notice.ts'
import { detectProjectDrift } from './project-drift.ts'
import type { MagicContextDshConfig } from './config.ts'
import type { MemoryLane } from './memory-lane.ts'
import { liveBoolean, liveRoute } from './volatile.ts'
import { planSearchHint, type SearchHintTracker } from './search-hint.ts'

/** Identities shared by the preStep, the maintenance sweep and the panel. */
export interface PreStepProjects {
  /** Every identity this process has actually served (sweep scope). */
  seenIdentities: Set<string>
  /** Session → project identity, so panel stats answer for the viewed project. */
  sessionIdentity: Map<string, string>
}

export interface PreStepDeps {
  ctx: Context
  config: MagicContextDshConfig
  stores: AdapterStores
  /**
   * Cross-process lease on compartment state. The in-process `inFlight` guard
   * covers one process; this covers an HMR remount or a second session sharing
   * the same database. Optional so tests and stand-alone constructions are
   * unchanged.
   */
  lease?: CompartmentLease
  journal: Journal | undefined
  /** The LLM seam (declared inject); the historian's auxiliary call uses it. */
  llm: HistorianLlm | undefined
  reduceTracker: ReduceNudgeTracker
  lane: MemoryLane
  projects: PreStepProjects
  /** Sessions already announced, so the journal gets exactly one first-seen row. */
  seenSessions: Set<string>
  /** Live thresholds: a settings-form edit reaches the next pass immediately. */
  activePolicy: () => PressurePolicy
  /** Auto-search hint state: one hint per user turn, shared across preSteps. */
  searchHints?: SearchHintTracker
  /**
   * Records the main conversation's latest provider/model route, so the
   * maintenance lane can follow it (an explicit pin still wins). Optional so
   * drift tests and stand-alone constructions stay unchanged.
   */
  noteSessionRoute?: (route: { provider: string; model: string }) => void
  /**
   * The current turn's working directory, recorded so filesystem lanes (git
   * commit indexing) know which project to read. Optional for the same reason.
   */
  noteSessionCwd?: (cwd: string) => void
  /**
   * Record one user question as primer evidence. Absent = no primer lane.
   */
  recordQuestion?: MemoryLane['recordQuestion']
  /**
   * Compaction-engine mount/unmount, invoked at EVERY pre-step so the live
   * `registerCompactionEngine` flag follows a settings-form toggle without a
   * restart (volatile commits never remount the plugin, so the old
   * mount-time branch made the form's switch a dead option). Optional for the
   * same reason as {@link noteSessionRoute}. Must not throw.
   */
  reconcileEngine?: () => void
  /**
   * Register a project with the background-task scheduler.
   *
   * Called once per project identity per process. The scheduler needs to know
   * WHO to serve before it can run anything, and this is the one place that
   * already resolves the identity from `config.memory.project ?? session cwd`.
   * Idempotent and must never throw — a scheduling nicety cannot fail a turn.
   *
   * `root` is the unresolved spec (a directory path). The identity is a hash for
   * a plain directory, so it cannot be turned back into a path later; tasks that
   * read files (`verify`) need the original string, and this is the only place
   * that still has both forms at once.
   */
  ensureDreamSchedules?: (projectIdentity: string, now: number, root?: string) => void
}

/**
 * The newest REAL user prompt in this request, for the auto-search hint. Host
 * context nodes and this adapter's own entries are user-role messages too, so they
 * are skipped by their markers instead of by role alone.
 */
function latestUserPromptText(
  messages: readonly unknown[],
): { readonly text: string; readonly turnKey: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { id?: unknown; role?: unknown; content?: unknown } | undefined
    if (message === undefined || message.role !== 'user' || !Array.isArray(message.content)) continue
    const text = (message.content as Array<{ type?: string; text?: unknown }>)
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join('\n')
    if (text.trim().length === 0) continue
    if (text.includes('<magic-context>') || text.startsWith('Magic Context ·')) continue
    return { text, turnKey: typeof message.id === 'string' ? message.id : text.slice(0, 64) }
  }
  return undefined
}

/** The seam-local listener shape (kept here so upstream renames touch one file). */
export type PreStepListener = (
  payload: PreStepPayload,
  next: () => Promise<PreStepEnterDecision | { kind: 'reject' }>,
) => Promise<PreStepEnterDecision | { kind: 'reject' }>

export function preStepListener(deps: PreStepDeps): PreStepListener {
  const { ctx, config, stores, journal, llm, reduceTracker, lane, projects, seenSessions, activePolicy } = deps
  const { seenIdentities, sessionIdentity } = projects
  const { memoryRecall, memoryWriter, profileWriter, visibleMemoryIdsBySession } = lane
  /** Consecutive defers per session, keyed by reason, to log transitions only. */
  const deferStreak = new Map<string, { reason: string; count: number }>()
  /** Did this turn's pass fold m[0]? The fail-closed gate needs it. */
  let baselineUpdatedThisPass = false
  /** This turn's pressure reading, hoisted for the fail-closed gate. */
  let pressureThisTurn: number | undefined
  /** The band this turn's pass landed in; scopes the served check's permission. */
  let passKindThisTurn: 'execute' | 'defer' | undefined
  /** One-shot flag: a drifted pre-step payload must warn once, not every step. */
  let payloadDriftWarned = false

  return async (payload: PreStepPayload, next): Promise<PreStepEnterDecision | { kind: 'reject' }> => {
    // Engine mount/unmount rides the step band: reconcile is two boolean
    // reads when nothing changed and must never fail the turn.
    deps.reconcileEngine?.()
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    // Shape-tolerant identity read: this line sits BEFORE every fail-open band
    // below, so a host refactor that drops `agent` from the pre-step payload
    // (the agent dispatcher injects it today) would otherwise throw into the
    // host's waterfall and fail the whole turn. Skipping this step's adapter
    // work degrades to "adapter idle" instead; the doctor heartbeat is what
    // surfaces the drift durably.
    const sessionId = payload.agent?.session?.id
    if (sessionId === undefined) {
      if (!payloadDriftWarned) {
        payloadDriftWarned = true
        journal?.error('error', 'pre-step payload has no agent.session.id — adapter bands skipped this step (host payload drift?)', { scope: 'pre-step' })
      }
      return decision
    }
    // Admission stamps NOTHING — deliberately. The reclaim lanes (ctx_reduce /
    // ctx_expand, drop landing, emergency reclaim) resolve tags against surface
    // TOOL RESULTS only, so a handle on a user message or on a host-injected
    // context node (runtime-context, skill-catalog, time-context) could never be
    // acted on: ctx_reduce would answer "no such tool-output tag on the current
    // surface". Unlike opencode/pi — which stamp a throwaway per-call array, so
    // the stamp never reaches the record — DSH has ONE surface shared by the
    // model and the UI, and no wire-only seam. A dead handle is therefore not
    // free: it shows up in the conversation transcript, and `session-title`
    // derives its deterministic fallback from the first `source: 'user'`
    // message, so it becomes the session title too (measured live: seq 9
    // `§1§ …` -> seq 15 `title: "§1§ 一个新的问题：现在会话"`). Only tool
    // results carry handles; the stream is untouched.
    const messages = decision.messages
    // Reduce guidance (desk section + Channel 1/2) is wired through the
    // SystemPrompt service below — a static section and a dynamic context —
    // not by rewriting messages here. The only preStep duty is the REAL USER
    // TURN counter the sticky refire gap needs: observing the newest message
    // id is idempotent per step, so repeated preSteps on one turn count once.
    if (liveBoolean(config.reduceGuidance, true)) {
      try {
        const newest = messages.at(-1)
        if (newest !== undefined) reduceTracker.observeUserMessage(sessionId, newest.id)
      } catch {
        // counting is advisory; never fail the turn for it
      }
    }

    // Auto-search hint (upstream `auto-search-runner`): one hint per user turn,
    // built from the user's own words. Awaited, because the hint has to ride
    // the request it was computed for, but every path is fail-open and the
    // search carries its own deadline.
    //
    // The hint does NOT append to the session here. This waterfall band runs
    // BEFORE the host writes step/start and the first system/message, so a
    // direct append on a fresh session's first step took surface node 0 and the
    // loader rejected the log on replay (the 2026-10-09 protected-head
    // incident). The hint instead travels inside the admitted batch: the
    // appendix below joins `decision.messages`, which the host persists after
    // its own system-prompt commits — the head always lands first, on every
    // turn, and the hint still rides this request. First-half stopgap (skip
    // while the surface was headless) retired by this carrier change.
    let hintAppendix: UserMessage | undefined
    if (deps.searchHints !== undefined && liveBoolean(config.searchHint, true)) {
      try {
        const prompt = latestUserPromptText(messages)
        if (prompt !== undefined) {
          const outcome = await planSearchHint(
            {
              search: lane.searchForSession,
              tracker: deps.searchHints,
              ...journal === undefined ? {} : { journal },
            },
            { sessionId, session: payload.agent.session, text: prompt.text, turnKey: prompt.turnKey },
          )
          if (outcome.action === 'hinted') hintAppendix = outcome.message
        }
      } catch {
        // a hint is an optimisation; never fail the turn for it
      }
    }

    // Primer evidence: record the user's question so the maintenance tick can see
    // that it recurs.
    //
    // Recording is deliberately narrow. A primer answers "have we answered this
    // before", which only makes sense for a real question — so the gate is a
    // question mark or an interrogative opener, and the text has to be long enough
    // to be a question rather than a "?" ping. Everything else is conversation.
    // Fail-open: evidence collection must never cost a turn.
    if (deps.recordQuestion !== undefined && liveBoolean(config.memory?.promotePrimers, true)) {
      try {
        const prompt = latestUserPromptText(messages)
        const cwd = payload.agent.session.header?.cwd
        if (prompt !== undefined && cwd !== undefined && looksLikeQuestion(prompt.text)) {
          const lastMessage = messages.at(-1)
          const messageId = String((lastMessage as { id?: unknown } | undefined)?.id ?? prompt.turnKey)
          // Same key the reader uses. `promotePrimers` is handed the project
          // IDENTITY (from the dream runner), so writing the raw cwd here left
          // every candidate unreachable: measured 2026-11-17, three candidate
          // rows sat under `C:\Users\…\default-workspace` while the runner
          // looked for `dir:af36666a8eb6` and promoted nothing.
          deps.recordQuestion({
            projectPath: resolveIdentitySpec(config.memory?.project ?? cwd) ?? cwd,
            sessionId,
            question: prompt.text,
            sourceMessageTime: Date.now(),
            sourceStartMessageId: messageId,
            sourceEndMessageId: messageId,
          })
        }
      } catch {
        // evidence is advisory; never fail the turn for it
      }
    }

    // Cross-project drift observation: the turn's own text is the only signal
    // DSH gives about WHERE work is happening (there is no per-turn working
    // directory). Foreign git roots in the newest message get one warn-level
    // journal row per turn — the data that quantifies how often cross-project
    // sessions actually happen (and whether facts land in the wrong project).
    try {
      const newestMessage = messages.at(-1)
      const driftText = newestMessage === undefined
        ? ''
        : newestMessage.content
          .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
          .join('\n')
      if (driftText.length >= 8) {
        const drift = detectProjectDrift(driftText, payload.agent.session.header.cwd)
        if (drift !== undefined) {
          journal?.warn('project-drift', `cross-project work observed (${String(drift.foreignRoots.length)} foreign root(s))`, {
            sessionRoot: drift.sessionRoot,
            foreignRoots: drift.foreignRoots,
          }, sessionId)
        }
      }
    } catch {
      // observation only; never fail the turn for it
    }

    // Register the session's project identity for the maintenance sweep HERE,
    // not only in the pass-execute branch: a quiet conversation never crosses
    // the compaction threshold, and the sweep then had no identity to serve —
    // every tick spun empty (measured live 18:24, zero maintenance rows after
    // a remount despite an active session).
    try {
      const projectSpec = config.memory?.project ?? payload.agent.session.header.cwd
      const memoryIdentity = projectSpec === undefined ? undefined : resolveIdentitySpec(projectSpec)
      if (memoryIdentity !== undefined) {
        seenIdentities.add(memoryIdentity)
        sessionIdentity.set(sessionId, memoryIdentity)
        if (sessionIdentity.size > 512) {
          const oldest = sessionIdentity.keys().next().value
          if (oldest !== undefined) sessionIdentity.delete(oldest)
        }
        // The scheduler serves projects it has been told about, and this is the
        // only place that resolves an identity. Registering here means a project
        // becomes schedulable the first time it is opened — no separate config,
        // and no boot-time scan of every project on disk.
        deps.ensureDreamSchedules?.(memoryIdentity, Date.now(), projectSpec)
      }
    } catch {
      // registration is advisory; never fail the turn for it
    }

    // ── Pressure decision + the execute-band management pass (Phase 1 + 2) ──
    // The session surface is only mutated inside the execute band: that is
    // the one permission under which a priced bust buys reclaim (MC's
    // "drops land on the next bust cycle", translated to durable surface).
    try {
      if (!seenSessions.has(sessionId)) {
        seenSessions.add(sessionId)
        journal?.info('session-first-seen', 'session first seen by the adapter', {
          turn: payload.turn,
          step: payload.step,
        }, sessionId)
      }
      const latest = stores.latestUsage(sessionId)
      const context = requestContextOf(payload.agent.session)
      // Live thresholds: a settings-form edit reaches this pass immediately.
      const configured = activePolicy()
      // A route that discloses no window is scheduled against the assumed one:
      // an undefined denominator defers 'no-window' on every step, so the
      // execute band — and every drop waiting behind it — would never open.
      const pressureWindow = pressureWindowTokens(context.contextWindow, configured)
      // MC `execute_threshold_tokens` (CONFIGURATION.md:296): when the knob is
      // set the band is expressed in the unit the decision is actually about —
      // on a 1M-token route "30%" means "compact at 300k" and the session then
      // lives inside the band forever.
      const policy = withTokenThreshold(configured, pressureWindow)
      const pressure = pressurePercent(latest, pressureWindow)
      pressureThisTurn = pressure
      // A reading recorded before the injected surface last changed measures a
      // prompt that no longer exists (a compartment landed / the baseline was
      // refreshed after it). It stays the only size signal for the pass decision,
      // but the force band must not reclaim against it — that is how compaction
      // ends up dropping a second batch of content for nothing (upstream MC
      // v0.49.49, `usagePredatesHistoryChange`).
      const historyChangedAt = stores.latestHistoryChangeAt(sessionId)
      const pressureStale = latest !== undefined && historyChangedAt !== undefined
        && historyChangedAt > latest.recordedAt
      const pass = decidePass({
        latest,
        pressure,
        now: Date.now(),
        policy,
        // Iron rule: a stranded tool_result 400s every strict-provider request,
        // so it forces the execute band regardless of pressure.
        wireDefects: wireStrandedResults(payload.agent.session).length,
      })
      passKindThisTurn = pass.kind === 'execute' ? 'execute' : 'defer'
      const usage = latest === undefined ? undefined : {
        input: latest.inputTokens ?? 0,
        cacheRead: latest.cacheReadTokens ?? 0,
        cacheWrite: latest.cacheWriteTokens ?? 0,
      }
      if (context.provider !== undefined && context.model !== undefined) {
        deps.noteSessionRoute?.({ provider: context.provider, model: context.model })
      }
      // Compare BEFORE this pass touches the surface, so the answer describes the
      // previous request's bytes against what the host is about to send.
      const served = compareServed(sessionId, payload.agent.session)
      const servedView = served.known
        ? {
          prefixIntact: served.prefixIntact,
          appended: served.appended,
          rewroteInPlace: served.rewroteInPlace,
          previousHadPermission: served.previousHadPermission,
          ...served.previousWasFirst ? { previousWasFirst: true } : {},
          ...served.firstChangeIndex === undefined ? {} : { firstChangeIndex: served.firstChangeIndex },
        }
        : { known: false }
      const sessionCwd = payload.agent.session.header?.cwd
      if (sessionCwd !== undefined) deps.noteSessionCwd?.(sessionCwd)
      const basePassData = {
        reason: pass.reason,
        // The chars/4 estimate this pass was sized against, on EVERY pass row
        // (execute and defer alike). The accuracy report pairs it with the usage
        // the provider bills for the request that follows; without it on the
        // common path there is nothing to regress against.
        // Surface nodes PLUS the system prompt: the wire carries both, and a
        // surface-only number under-reported by 2.5x on the first measured
        // sample. Recorded under the same key so old rows stay comparable.
        // WIRE tokens, not text tokens: `surfaceTokens` excludes tool-call
        // arguments and reasoning by design, and that exclusion is most of a
        // tool-heavy request (measured 2.4x). `surfaceWireTokens` charges every
        // block, so this number means what the provider will bill.
        estSurfaceTokens: surfaceWireTokens(payload.agent.session) + (latestSystemPromptTokens ?? 0),
        // A FIELD NAME THAT MEANS ONE THING. `estSurfaceTokens` changed meaning
        // twice (text-only, then + system prompt, then wire tokens), so rows from
        // different eras sit under one key and no reader can tell them apart —
        // the accuracy report's spread was dominated by one pre-wire sample.
        // Anything that compares estimates against reality reads THIS key.
        estWireTokens: surfaceWireTokens(payload.agent.session) + (latestSystemPromptTokens ?? 0),
        ...latestSystemPromptTokens === undefined ? {} : { estSystemPromptTokens: latestSystemPromptTokens },
        pressure: pressure === undefined ? undefined : Number(pressure.toFixed(1)),
        // Visible in the pass row: a stale reading explains why a high
        // percentage did not reclaim (see the force-band guard).
        ...pressureStale ? { pressureStale: true } : {},
        // The denominator the decision actually used, flagged when it was the
        // assumption rather than the route's own reading.
        contextWindow: pressureWindow,
        ...context.contextWindow === undefined ? { contextWindowAssumed: true } : {},
        route: context.provider === undefined || context.model === undefined
          ? undefined
          : `${context.provider}/${context.model}`,
        usage,
        // The served check (upstream `hooks/magic-context/served-check.ts`): did
        // the bytes the LAST request sent survive into this one? A pass without
        // rebuild permission may only append; anything else invalidates the
        // provider's cached prefix. Measured only — it changes no byte here.
        // `known: false` means this process has not served this session since it
        // started, which is unknown rather than equal.
        served: servedView,
      }
      if (pass.kind === 'execute') {
        // The project identity is resolved once per pass (the git lookup is
        // cached for the process). An explicit `git:`/`dir:` value is already
        // an identity; only a directory has to be resolved.
        const projectSpec = config.memory?.project ?? payload.agent.session.header.cwd
        const memoryIdentity = projectSpec === undefined
          ? undefined
          : resolveIdentitySpec(projectSpec)
        // The maintenance sweep maintains every identity this process has
        // actually served (the configured project is added unconditionally),
        // and the session→identity map scopes the telemetry panel's stats to
        // the project the viewed conversation is working on.
        if (memoryIdentity !== undefined) {
          seenIdentities.add(memoryIdentity)
          if (sessionId !== undefined) {
            sessionIdentity.set(sessionId, memoryIdentity)
            if (sessionIdentity.size > 512) {
              const oldest = sessionIdentity.keys().next().value
              if (oldest !== undefined) sessionIdentity.delete(oldest)
            }
          }
        }
        // WP10: keep the machine domain's membership in step with the projects
        // this process has actually served, BEFORE the recall resolves peers —
        // otherwise a project's first pass would read the domain without being
        // in it. Idempotent, and a no-op until `memory.global.machine.enabled`.
        if (memoryRecall !== undefined) {
          syncMachineDomain(stores, {
            identities: [...seenIdentities],
            config: machineDomainConfigOf(config),
            now: Date.now(),
          })
        }
        // The live switch (volatile, form-writable) gates USE; the mount
        // switch already decided whether the lane exists at all.
        const memoryLive = memoryLaneEnabled(config)
        const memories = !memoryLive || memoryRecall === undefined ? undefined : memoryRecall.recall({
          ...projectSpec === undefined ? {} : { project: projectSpec },
          domainProjects: config.memory?.domainProjects,
          shareCategories: config.memory?.shareCategories,
          budgetTokens: policy.memoryBudgetTokens,
          limit: policy.memoryLimit,
          // B2 (MC m0_compose.rs:104-116): the frozen prefix evaluates expiry
          // against the HARD-rebuild clock — a row expiring mid-cycle must not
          // bust the cache. The next HARD rebuild re-composes with a live clock
          // and freezes the new time.
          now: stores.baselineState(sessionId)?.frozenAt ?? Date.now(),
          // The additive lane: everything above the stored watermark is an
          // in-session addition and renders in m[1], keeping m[0] byte-stable.
          ...stores.baselineState(sessionId)?.maxMemoryId === undefined
            ? {}
            : { maxMemoryId: stores.baselineState(sessionId)?.maxMemoryId },
          // S(t) decay scoring (schema v7): the sidecar stats + live config;
          // `enabled` inside gates the ranking takeover, stats always ride.
          ...memoryIdentity === undefined ? {} : { scoring: lane.memoryScoring(memoryIdentity) },
        })
        // WP8: the user profile. Its own read with its own watermark — the
        // profile is unaffected by project identity, and this lane can be
        // switched off (`memory.global.user.render`, default true) without
        // touching memory recall at all.
        const profileEnabled = liveBoolean(config.memory?.global?.user?.render, true)
        const profile = !profileEnabled || memoryRecall === undefined
          ? undefined
          : memoryRecall.profileRecall({
            // Frozen-prefix discipline, same as memory recall: the m[0] profile
            // evaluates against the HARD-rebuild clock, not a live one.
            now: stores.baselineState(sessionId)?.frozenAt ?? Date.now(),
            budgetTokens: PROFILE_M0_BUDGET_TOKENS,
            ...stores.baselineState(sessionId)?.profileWatermark === undefined
              ? {}
              : { maxId: stores.baselineState(sessionId)?.profileWatermark },
          })
        // A2 (MC getVisibleMemoryIds): the ids the injected block renders NOW
        // are what ctx_memory search suppresses as already-visible. Replaced
        // per pass, process-memory only, fail-open when absent.
        if (memories !== undefined) {
          visibleMemoryIdsBySession.delete(sessionId)
          visibleMemoryIdsBySession.set(sessionId, new Set<number>([
            ...memories.rows.map(row => row.id),
            ...memories.newRows.map(row => row.id),
          ]))
          if (visibleMemoryIdsBySession.size > 256) {
            const oldest = visibleMemoryIdsBySession.keys().next().value
            if (oldest !== undefined) visibleMemoryIdsBySession.delete(oldest)
          }
        }
        // S(t) sidecar (schema v7): recall injections strengthen the rows for
        // future ranking, and the orphan sweep drops stats rows whose memory
        // left the visible pool. Shadow collection — runs whether or not the
        // ranking takeover is enabled. Fail-open: scoring stats are advisory.
        if (memories !== undefined && memoryIdentity !== undefined) {
          try {
            const statsNow = Date.now()
            for (const row of memories.rows) stores.recordMemoryEvent(memoryIdentity, row.id, 'injection', statsNow)
            for (const row of memories.newRows) stores.recordMemoryEvent(memoryIdentity, row.id, 'injection', statsNow)
            const knownIds = new Set<number>(memories.eligibleIds)
            for (const row of memories.newRows) knownIds.add(row.id)
            stores.pruneMemoryStats(memoryIdentity, [...knownIds])
          } catch {
            /* scoring stats are advisory */
          }
        }
        // The watermark is read straight from the store, so a HARD rebuild can
        // freeze it even when this pass recalled no rows at all (the first
        // pass of a fresh session, which is exactly when it matters).
        const currentMaxMemoryId = memoryRecall?.maxMemoryId(projectSpec) ?? 0
        // The NON-additive lane (contract §6): `memory_mutation_log` rows above
        // the frozen cursor render as `<memory-updates>` in the m[1] region, so
        // an update/archive/supersede reaches the model without rebuilding m[0].
        // `afterId` is the cursor frozen by the last HARD rebuild (0 for a
        // session that never folded), and the epoch fingerprint is passed on
        // EVERY pass: management-pass only flags an epoch change when both the
        // previous fingerprint and this one are present.
        const mutations = memoryRecall?.mutations({
          ...projectSpec === undefined ? {} : { project: projectSpec },
          domainProjects: config.memory?.domainProjects,
          shareCategories: config.memory?.shareCategories,
          afterId: stores.baselineState(sessionId)?.maxMemoryMutationId ?? 0,
          limit: policy.memoryLimit,
          now: Date.now(),
        })
        if (memories !== undefined && (memories.lines.length > 0 || memories.newLines.length > 0)) {          journal?.info(
            'memory-recall',
            `recalled ${String(memories.rows.length)} project memories into m[0]`
              + `${memories.newLines.length > 0 ? `, ${String(memories.newLines.length)} new in m[1]` : ''}`,
            {
              rows: memories.rows.length,
              newRows: memories.newLines.length,
              digest: memories.digest.slice(0, 12),
              budgetTokens: policy.memoryBudgetTokens,
              estTokens: memories.lines.reduce((total, line) => total + estimateTokens(line), 0),
              identity: memories.identity,
              maxMemoryId: memories.currentMaxMemoryId,
              domains: memories.domains,
              members: memories.members?.length,
              projects: [...new Set(memories.rows.map(row => row.projectPath.slice(0, 24)))],
            },
            sessionId,
          )
        }
        if (profile !== undefined && (profile.lines.length > 0 || profile.newLines.length > 0)) {
          journal?.info(
            'profile-recall',
            `injected ${String(profile.lines.length)} profile row(s) into m[0]`
              + `${profile.newLines.length > 0 ? `, ${String(profile.newLines.length)} new in m[1]` : ''}`,
            {
              rows: profile.rows.length,
              newRows: profile.newRows.length,
              digest: profile.digest.slice(0, 12),
              watermark: stores.baselineState(sessionId)?.profileWatermark,
              currentMaxId: profile.currentMaxId,
              estTokens: profile.lines.reduce((total, line) => total + estimateTokens(line), 0),
            },
            sessionId,
          )
        }
        // The generation pin is a live settings-form field: re-read it every
        // pass, and treat a half-filled pair as "follow the session route".
        const generationRoute = liveRoute(config.historian?.provider, config.historian?.model)
        const outcome = runManagementPass({
          session: payload.agent.session,
          ...historianInFlight(sessionId) === undefined ? {} : { historianBusy: true },
          sessionId,
          stores,
          policy,
          logger: ctx.logger,
          pass,
          ...latestSystemPromptFingerprint === undefined
            ? {}
            : { systemHash: latestSystemPromptFingerprint },
          pressure,
          ...pressureStale ? { pressureStale: true } : {},
          ...journal === undefined ? {} : { journal },
          ...context.provider === undefined || context.model === undefined
            ? {}
            : { route: { provider: context.provider, model: context.model } },
          ...context.contextWindow === undefined ? {} : { contextWindow: context.contextWindow },
          ...liveBoolean(config.historianEnabled, true) === false || llm === undefined
            ? {}
            : {
              historian: {
                llm,
                ...generationRoute === undefined ? {} : { route: generationRoute },
                // Semantic dedup input: the historian scans these facts and skips
                // overlapping ones. `normalized_hash` only catches a verbatim
                // repeat, so a fact restated in other words would become a second
                // row without this block.
                memoryBlock: () => memories === undefined
                  ? undefined
                  : renderHistorianMemoryBlock([...memories.rows, ...memories.newRows]),
              },
            },
          ...memoryRecall === undefined
            ? {}
            : {
              memories: {
                digest: memories?.digest ?? '',
                lines: memories?.lines ?? [],
                // Grouped form: renders `<CATEGORY>` runs (upstream
                // `renderMemoryBlockV2`) instead of a flat tagged list.
                groups: memories?.groups ?? [],
                newLines: memories?.newLines ?? [],
                // An `update` on a memory that is still above the watermark
                // writes a mutation-log row without changing the id, so the row
                // would otherwise render once in `<new-memories>` (current
                // content) and again in `<memory-updates>` (same content).
                // Passing the ids lets the renderer suppress the duplicate.
                newMemoryIds: memories?.newRows.map(row => row.id) ?? [],
                // MC only announces a mutation whose target is a row the m[0]
                // baseline actually rendered (inject-compartments.ts:2843-2848):
                // mutations for budget-truncated rows would be phantom pointers.
                baselineIds: memories?.rows.map(row => row.id) ?? [],
                // A1: the pre-budget visible set — the authority for forced
                // rows in `<memory-updates>`/`<new-memories>`
                // (inject-compartments.ts:2822-2869).
                eligibleIds: memories?.eligibleIds ?? [],
                eligibleRows: memories?.eligibleRows ?? [],
                maxMemoryId: currentMaxMemoryId,
              },
            },
          ...profile === undefined ? {} : { profile },
          ...deps.lease === undefined ? {} : { lease: deps.lease },
          // `cursor` is deliberately the CURRENT max mutation id, not the paged
          // read cursor: on a HARD rebuild m[0] swallows everything up to now,
          // so freezing a partial page would re-render rows it already folded.
          ...mutations === undefined
            ? {}
            : {
              memoryUpdates: {
                updates: mutations.updates,
                cursor: mutations.currentCursor,
                projectEpochFingerprint: mutations.projectEpochFingerprint,
              },
            },
          ...memoryWriter === undefined || memoryIdentity === undefined || config.memory?.autoPromote === false
            ? {}
            : { memoryPromote: (promote: { identity: string; facts: readonly MemoryFact[]; sessionId: string }) => memoryWriter.promoteFacts(promote), memoryIdentity },
          // WP5: the `user` domain's collection switch — read LIVE, so it can be
          // flipped without a remount, and default OFF because this lane stages
          // rows in the shared contract. The historian journals what it staged
          // (including what normalization dropped), so the switch's effect is
          // visible from the journal rather than inferred from the pool size.
          ...profileWriter === undefined || profileWriter.status.ok !== true
            || !liveBoolean(config.memory?.global?.user?.collect, true)
            ? {}
            : {
              profileCollect: (collect: {
                sessionId: string
                observations: readonly string[]
                compartmentStart: number | null
                compartmentEnd: number | null
              }) => profileWriter.recordCandidates(collect),
            },
        })
        journal?.info('pass', `execute (${pass.reason}) at ${pressure?.toFixed(1) ?? '?'}%`, {
          decision: 'execute',
          ...basePassData,
          landed: outcome.landedDrops,
          ...outcome.retiredDrops.length === 0 ? {} : { retired: outcome.retiredDrops },
          published: outcome.published,
          forceDropped: outcome.forceDropped,
          baseline: outcome.baselineUpdated ? 'refreshed' : 'unchanged',
          historianRequested: outcome.historianRequested,
          // Net reclaim proof: surface estimate before/after this pass.
          tokensBefore: outcome.tokensBefore,
          tokensAfter: outcome.tokensAfter,
          tokensDelta: outcome.tokensAfter - outcome.tokensBefore,
          factsPromoted: outcome.factsPromoted,
          factsSeenAgain: outcome.factsSeenAgain,
        }, sessionId)
        // Channel A of the live session stream: one notice entry per pass
        // that actually did something (publish / force-drop / promotion).
        // `appendSessionNotice` is fail-open, quiet on nothing-notable, and
        // refuses a headless surface (an out-of-band append before the host
        // wrote surface node 0 would make the log unloadable — 2026-10-09
        // incident; see docs/dsh-surface-write-audit-2026-10-09.md). A refusal
        // means the execute band opened on a headless surface, which should be
        // impossible (no surface ⇒ no usage and no wire defects ⇒ defer), so it
        // is journaled as an anomaly rather than silently dropped.
        if (liveBoolean(config.sessionNotices, true)) {
          baselineUpdatedThisPass = outcome.baselineUpdated === true
      const notice = appendSessionNotice({ session: payload.agent.session, result: outcome })
          if (notice.ok) {
            journal?.info('session-notice', notice.summary, { seq: notice.seq }, sessionId)
          } else if (notice.reason === 'headless-surface') {
            journal?.warn('session-notice', 'notice suppressed: session surface has no protected head yet', {
              reason: notice.reason,
            }, sessionId)
          } else if (notice.reason === 'append-failed') {
            journal?.warn('session-notice', `notice append failed: ${notice.detail ?? '?'}`, {
              detail: notice.detail,
            }, sessionId)
          }
        }
        deferStreak.delete(sessionId)
      } else {
        // Defer passes repeat every step: record the reason TRANSITIONS only,
        // carrying how many consecutive defers shared the current reason, so
        // the journal stays reviewable instead of flooding.
        const streak = deferStreak.get(sessionId)
        if (streak === undefined || streak.reason !== pass.reason) {
          deferStreak.set(sessionId, { reason: pass.reason, count: 1 })
          journal?.info('pass', `defer (${pass.reason}) at ${pressure?.toFixed(1) ?? '?'}%`, {
            decision: 'defer',
            ...basePassData,
            consecutive: 1,
          }, sessionId)
        } else {
          streak.count += 1
        }
      }
    } catch (error) {
      const detail = errText(error)
      journal?.error('error', `management pass failed: ${detail}`, { scope: 'pre-step', detail }, sessionId)
      // A failed management pass must never wedge the turn: log and continue
      // with the tagged messages (MC per-turn fail-open). The next pass
      // re-decides from durable state.
      ctx.logger.warn(`magic-context: management pass failed (continuing): ${detail}`)
    }

    // ── Emergency fail-closed ────────────────────────────────────────────────
    // Upstream decides this AFTER the reclaim pass (`evaluateEmergencyFailClosed`,
    // transform-postprocess-phase.ts:1901), because the pass is what makes the
    // wire smaller: aborting before it would refuse a request the pass just
    // fixed. Only a session armed BY A PROVIDER OVERFLOW may abort, and only when
    // this pass did not fold — otherwise the request describes a wire the
    // provider has already rejected (`:1930`).
    try {
      const drain = stores.getDrainState(sessionId)
      const armed = (drain.overflowArmedAt ?? 0) > 0
      if (armed) {
        const route = requestContextOf(payload.agent.session)
        const provenRaw = route.provider === undefined || route.model === undefined
          ? undefined
          : stores.getMeta(provenLimitKey(route.provider, route.model))
        const provenLimit = provenRaw === undefined ? undefined : Number(provenRaw)
        // Calibrated wire estimate: the chars/4 surface number scaled by the
        // measured estimate-to-bill ratio. `trusted` comes from the report, not
        // from optimism — until >=30 samples with a narrow band exist, this stays
        // untrusted and the gate ignores it, exactly as before.
        const accuracy = summarise(pairEstimateSamples(
          stores.listJournal({ sessionId, kinds: ['pass'], limit: 200 }).map(entry => ({
            at: entry.at,
            // `estWireTokens` only: the older key has meant three different
            // things over this project's life, so a calibration built on it
            // mixes eras (see the note where the key is written).
            estimated: typeof (entry.data as { estWireTokens?: unknown } | undefined)?.estWireTokens === 'number'
              ? (entry.data as { estWireTokens: number }).estWireTokens
              : undefined,
          })),
          stores.listUsage(sessionId).map(record => ({
            recordedAt: record.recordedAt,
            inputTokens: (record.inputTokens ?? 0)
              + (record.cacheReadTokens ?? 0)
              + (record.cacheWriteTokens ?? 0),
          })),
        ))
        const wire = calibratedWireEstimate(surfaceTokens(payload.agent.session), accuracy)
        // The nodes past the last published compartment are what a historian can
        // still digest. When there are none, "send again" is advice that cannot
        // work, and the refusal says so instead.
        const lastCompartmentEnd = stores.baselineState(sessionId)?.maxCompartmentId
        const historyRemains = lastCompartmentEnd === undefined
          ? true
          : enumerateSurfaceNodes(payload.agent.session).some(node => Number(node.seq) > lastCompartmentEnd)
        // The tail a reclaim may NOT drop. A request over the limit is only
        // hopeless when THIS alone cannot fit; otherwise dropping reclaimable
        // output would have saved it, and refusing would be wrong.
        const protectedTailTokens = (() => {
          try {
            return protectedToolTokens(
              enumerateSurfaceToolResults(payload.agent.session, callId =>
                stores.getTag(sessionId, { kind: 'tool-result', callId })),
              withTokenThreshold(activePolicy(), route.contextWindow),
              route.contextWindow,
              pressureThisTurn,
            )
          } catch {
            return undefined
          }
        })()
        const failClosed = evaluateEmergencyFailClosed({
          usagePercentage: pressureThisTurn ?? 0,
          emergencyRecoveryArmed: armed,
          emergencyRecoveryOrigin: drain.overflowOrigin ?? null,
          foldMaterializedThisPass: baselineUpdatedThisPass,
          historyRemains,
          ...protectedTailTokens === undefined ? {} : { protectedToolTokens: protectedTailTokens },
          ...wire.trusted
            ? {
              finalWireEstimate: {
                tokens: wire.tokens,
                trusted: true,
                // A trusted measurement ABOVE the proven limit is what makes a
                // refusal legitimate: sending it would 400. Below the limit the
                // estimate is just a size, not evidence of failure.
                ...provenLimit !== undefined && Number.isFinite(provenLimit) && provenLimit > 0 && wire.tokens > provenLimit
                  ? { refusalGrade: true, refusalTokens: wire.tokens }
                  : {},
              },
            }
            : {},
          ...provenLimit === undefined || !Number.isFinite(provenLimit)
            ? {}
            : { providerProvenLimitTokens: provenLimit },
          ...route.contextWindow === undefined ? {} : { contextLimitTokens: route.contextWindow },
        })
        if (failClosed.shouldAbort) {
          journal?.warn(
            'error',
            `emergency fail-closed: ${failClosed.reason} — request refused`,
            { scope: 'fail-closed', reason: failClosed.reason, pressure: pressureThisTurn },
            sessionId,
          )
          // Tell the user why the turn did not happen: a rejection with no
          // explanation reads as a hang.
          try {
            // `appendMagicContextEntry` rather than `appendSessionNotice`: the
            // latter summarises a PASS result, and this is not one.
            appendMagicContextEntry(
              payload.agent.session,
              failClosed.refusalMessage ?? (
                'Magic Context: the previous request exceeded the context window and nothing has '
                + 'reclaimed enough since. The request was refused instead of being sent to fail again.'
              ),
              'Magic Context · request refused (context window exceeded)',
            )
          } catch {
            // A notice is courtesy; the rejection is the point.
          }
          return { kind: 'reject' }
        }
        if (failClosed.reason === 'trusted-final-wire-disarm' && failClosed.disarm !== undefined) {
          stores.putDrainState(sessionId, { ...drain, overflowArmedAt: 0, overflowOrigin: undefined })
          journal?.info(
            'emergency-reclaim',
            `disarmed: ${String(failClosed.disarm.finalWireTokens)} of ${String(failClosed.disarm.provenLimitTokens)} tokens`,
            { finalWireTokens: failClosed.disarm.finalWireTokens, limit: failClosed.disarm.provenLimitTokens },
            sessionId,
          )
        }
      }
    } catch (failClosedError) {
      // A gate that throws must not wedge the turn: same fail-open rule as the
      // rest of the pre-step band.
      ctx.logger.warn(`magic-context: fail-closed evaluation failed (continuing): ${errText(failClosedError)}`)
    }

    // Record what this request is about to send. `execute` is the only band that
    // may rewrite history, so it is the only one that gets rebuild permission
    // here — a defer or a nudge that edits the surface is exactly what the check
    // exists to catch. Wrapped because a measurement must never fail a turn.
    try {
      noteServed(
        sessionId,
        payload.agent.session,
        passKindThisTurn === 'execute',
        Date.now(),
        // No record before this call means the session was never served by this
        // process: its first request establishes m[0], and the next comparison
        // will legitimately see index 0 change.
        servedRecord(sessionId) === undefined,
      )
    } catch (servedError) {
      ctx.logger.warn(`magic-context: served check failed (continuing): ${errText(servedError)}`)
    }
    return { ...decision, messages: hintAppendix === undefined ? messages : [...messages, hintAppendix] }
  }
}

/**
 * Reduce guidance through the SystemPrompt service (MC parity): a STATIC desk
 * section (identical bytes every assembly, so the system prompt stays
 * prefix-cache stable) plus a DYNAMIC context whose provider re-measures the
 * unstamped tail at every assembly and renders the MC reminder copy only when
 * a band fires — an empty text contributes nothing. The listeners dispose with
 * the inject fiber (a scope reload re-runs the whole inject).
 */
/**
 * The system-prompt fingerprint the LAST assembly produced.
 *
 * Upstream keys a HARD fold on it (`system-prompt-hash.ts:739`): the system
 * prompt precedes every message, so a change there makes the provider rewrite its
 * cache from that block onward anyway — folding the baseline on the same turn is
 * free, and serving the old prefix wastes the whole rewrite.
 *
 * One value, not a map: a system prompt is assembled immediately before the turn
 * it belongs to, so the assembly observed most recently IS the one the next pass
 * runs under. Two sessions assembling concurrently would race here — the pass
 * would then compare against the other session's prompt and fold once for
 * nothing. That is a wasted fold, not a wrong result, and the alternative is
 * threading a scope key through an API that does not hand one to the callback.
 */
let latestSystemPromptFingerprint: string | undefined

/**
 * Tokens of the last assembled system prompt. Paired with `surfaceTokens` it
 * approximates the real request, which is what the accuracy report is measuring.
 */
let latestSystemPromptTokens: number | undefined
/** One-shot: the observation path is best-effort, but its failure is not silent. */
let systemPromptObservationWarned = false

/**
 * MD5 of the rendered system prompt — the same digest and the same material the
 * upstream fingerprint uses (`systemPromptFingerprint`, prompt-surface-runtime.ts:71),
 * so a value recorded here means what an upstream value means.
 *
 * `renderPrompt` is the host's own renderer; using it (rather than hashing the
 * assembly object) keeps the digest tied to the bytes the provider will see.
 */
function fingerprintOf(assembly: unknown): string | undefined {
  if (assembly === undefined || assembly === null) return undefined
  const rendered = renderPrompt(assembly as Parameters<typeof renderPrompt>[0])
  if (typeof rendered !== 'string' || rendered.length === 0) return undefined
  // Record the SIZE alongside the digest. `surfaceTokens` counts only surface
  // nodes, so the system prompt — plus the tool schemas rendered beside it — is
  // the biggest single thing a wire estimate can miss. Measured 2026-11-18: the
  // first calibrated sample put actual at 2.51x the estimate, and the missing
  // system block is the bulk of that.
  latestSystemPromptTokens = estimateTokens(rendered)
  return createHash('md5').update(rendered).digest('hex')
}

/** Tokens the last assembled system prompt (and its tool schemas) occupied. */
export function currentSystemPromptTokens(): number | undefined {
  return latestSystemPromptTokens
}

/** Test seam: the digest of the most recent assembly, or undefined. */
export function currentSystemPromptFingerprint(): string | undefined {
  return latestSystemPromptFingerprint
}

/**
 * Observe every assembled system prompt.
 *
 * The obvious place — the `text` provider inside `systemPrompt.context` — is the
 * WRONG one: its argument is `AssembleContext` (`{ scope, signal }`), not a
 * `PromptAssembly`. Passing it to `renderPrompt` throws, and an early empty catch
 * made that silent: `baseline_state.system_hash` was null in every row while the
 * code looked correct (measured 2026-11-18).
 *
 * The waterfall event is the one that carries the assembled prompt. Wrapping
 * `next()` and recording afterwards also makes the value the REAL assembly —
 * every other contributor has already had its say.
 */
export function observeSystemPrompt(deps: Pick<PreStepDeps, 'ctx'>): void {
  const { ctx } = deps
  try {
    ;(ctx as unknown as { on(name: string, handler: (...args: never[]) => unknown): void }).on(
      'system-prompt/assemble',
      async (assembly: unknown, _context: unknown, next: () => Promise<unknown>) => {
        const assembled = await next()
        try {
          const prompt = assembled as Parameters<typeof renderPrompt>[0] & {
            contexts?: ReadonlyArray<{ name: string }>
            tools?: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>
          }
          // `renderPrompt` renders SECTIONS ONLY (`lib/index.js`): dynamic
          // contexts and the tool schemas reach the provider as separate
          // segments. Counting only the sections under-reported the block by
          // tens of thousands of tokens on a tool-heavy session (measured
          // 2026-11-18: estimate 172k vs actual 408k).
          const rendered = renderPrompt(prompt)
          const contexts = prompt.contexts === undefined || prompt.contexts.length === 0
            ? ''
            : renderContextSnapshot(prompt)
          const tools = prompt.tools === undefined || prompt.tools.length === 0
            ? ''
            : JSON.stringify(prompt.tools)
          const full = `${rendered}\n\n${contexts}\n\n${tools}`
          if (full.length > 0) {
            latestSystemPromptFingerprint = createHash('md5').update(full).digest('hex')
            latestSystemPromptTokens = estimateTokens(full)
          }
        } catch (observeError) {
          // Observation only: never cost the turn. Say it once so the next
          // silent failure is diagnosable.
          if (!systemPromptObservationWarned) {
            systemPromptObservationWarned = true
            ctx.logger?.warn?.(
              `magic-context: system prompt observation failed (continuing): ${errText(observeError)}`,
            )
          }
        }
        return assembled
      },
    )
  } catch (hookError) {
    ctx.logger?.warn?.(`magic-context: could not observe system prompts: ${errText(hookError)}`)
  }
}

export function injectReduceGuidance(deps: PreStepDeps): void {
  const { ctx, config, stores, journal, reduceTracker, lane } = deps
  if (liveBoolean(config.reduceGuidance, true) === false) return
  ctx.inject(['systemPrompt'], (scope) => {
    const systemPrompt = (scope as { systemPrompt?: {
      section(section: { name: string; text: string; order?: number }): () => void
      context(context: { name: string; order: number; text: (assembly: unknown) => string }): () => void
    } }).systemPrompt
    if (systemPrompt === undefined) return
    scope.effect(() => systemPrompt.section({
      name: 'magic-context-desk',
      text: buildDeskSection(lane.memoryEnabled),
      order: 900,
    }))
    scope.effect(() => systemPrompt.context({
      name: 'magic-context-reduce',
      order: 910,
      text: (assembly: unknown) => {
        try {
          const agent = (assembly as { agent?: { session?: Session } }).agent
          const session = agent?.session
          if (session === undefined) return ''
          const sessionId = session.id
          const tagged = enumerateSurfaceToolResults(session, callId =>
            stores.getTag(sessionId, { kind: 'tool-result', callId }))
            .filter(node => node.tagNumber !== undefined)
          if (tagged.length === 0) return ''
          const tailToolTokens = tagged.reduce((total, node) => total + Math.ceil(node.textLength / 4), 0)
          const undropped = tagged.filter(node => !node.isPlaceholder)
          const undroppedTokens = undropped.reduce((total, node) => total + Math.ceil(node.textLength / 4), 0)
          const state = reduceTracker.state(sessionId)
          const nudge = decideReduceNudge({
            tailToolTokens,
            undroppedTokens,
            realUserTurnCount: state.realUserTurnCount,
            ...state.lastBand === undefined ? {} : { lastBand: state.lastBand },
            lastOrdinal: state.lastOrdinal,
            ...state.lastOrdinalTurn === undefined ? {} : { lastOrdinalTurn: state.lastOrdinalTurn },
          })
          // The turn MUST be the session's real user-turn count, not a literal:
          // record persists it as lastOrdinalTurn, and decideReduceNudge's
          // sticky gap is realUserTurnCount - lastOrdinalTurn. A literal 0 made
          // the gap read as the WHOLE turn count, so any session past 5 user
          // turns re-fired its channel2 reminder on every system-prompt
          // assembly (measured live 2026-10-25: 33 reminders in 11 minutes,
          // each double-journaled by the host's assemble→preStep-append→
          // reassemble cycle).
          reduceTracker.record(sessionId, nudge, state.realUserTurnCount)
          if (!nudge.fire || nudge.level === undefined) return ''
          const hints = undropped.slice(0, 4).map(node => ({ tagNumber: node.tagNumber as number }))
          const reminder = nudge.level === 'channel2'
            ? buildChannel2Reminder(undroppedTokens, undropped.length, hints)
            : buildChannel1Reminder(nudge.level, undroppedTokens, undropped.length, hints, nudge.sticky)
          journal?.info('pass', `reduce nudge (${nudge.level})`, {
            decision: 'reduce-nudge',
            band: nudge.band,
            tailToolTokens,
            undroppedTokens,
          }, sessionId)
          return reminder
        } catch {
          // A closed store mid-remount must degrade to no reminder.
          return ''
        }
      },
    }))
  })
}

/**
 * Does this user text look like a question worth remembering?
 *
 * A primer exists to answer "have we answered this before", which needs a real
 * question. The gate is intentionally loose-but-not-empty:
 *
 *  - a question mark anywhere (covers CJK `？` and `?`);
 *  - or an interrogative opener, which is how Chinese questions usually start
 *    even though they often carry no mark at all;
 *  - and at least a few characters, so "?" and "ok" never become evidence.
 *
 * Slash commands are excluded: `/ctx-status` is an instruction to the adapter,
 * not a question about the project.
 *
 * @param text - the user's message text.
 */
function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 6) return false
  if (trimmed.startsWith('/')) return false
  if (/[?？]/.test(trimmed)) return true
  return /^(?:how|what|why|when|where|which|who|can|should|is|are|does|do|did|will|would|has|have|能否|怎么|怎样|如何|为什么|为何|什么|哪些|哪个|哪里|是否|能不能|可不可以|有没有)/i.test(trimmed)
}
