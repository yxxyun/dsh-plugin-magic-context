# DSH ↔ OpenCode / Pi: effective-behavior parity

This document records the **effective-behavior contract** between the DSH adapter
(`src/` in this repository) and the two upstream adapters — OpenCode 1/2
(`packages/plugin`) and Pi (`packages/pi-plugin`). Comparison target as of
2026-10-30 (alignment re-verified to v0.49.30; host anchor refreshed to the
0.2.1-rc.1 desktop line on 2026-10-17): see
`docs/upstream-followup-2026-10-30.md` for the v0.46.0→v0.49.30 sweep.

| Item | Value |
|---|---|
| Magic Context | **v0.49.50** (`80a3504d9`, swept 2026-11-11; the alignment core is still unchanged — `crates/` has **zero** commits between v0.49.48 and v0.49.50 beyond Cargo.toml version bumps, so every entry below keeps its verdict). The tags since v0.46.0 moved only `packages/`: host adapters, dashboard, cli, CI |
| MC store contract | shape inherited at the v95 cutover, **own lineage since 2026-10-13** (`src/core/memory-bridge.ts:45`; `MEMORY_SCHEMA_MAX_VERSION = 95`) |
| DeepSeek Harness | **Desktop 0.2.1-rc.1** (host paths below are relative to the DSH checkout) |
| Adapter | `dsh-plugin-magic-context` 0.9.0, own store **schema v10** (`src/core/stores.ts`) |

Scope split: `docs/dsh-plugin-upgrade-followup.md` says **how** to follow an
upgrade; this file says **where we differ**. Three verdicts are used below:

- **aligned** — same effective behavior, different plumbing;
- **host-imposed** — the DSH surface cannot express MC's mechanism; every entry
  cites the host file that constrains it;
- **intentional** — decided and recorded; do not "fix" these on an upgrade.

Sweep log: **2026-11-11, v0.49.48 → v0.49.50** (45 commits). Two host-side rules
were checked against this adapter and neither needs a port:

- **Force-band worth threshold (#886, `aa013de3b`).** Upstream now requires the
  span it would summarise to be ≥ **2 % of the resolved usable window** before a
  routine force-band historian run (`protected-tail-boundary.ts`,
  `hasRunnableCompartmentWindow`), exempting manual wrapup/recomp, ≥95 % and
  overflow recovery. This adapter is already **stricter**: `historianTriggerBudget`
  wants `max(5k, min(50k, window × 5 %))` — 50k at a 1M window against upstream's
  20k, 12.8k at 256k against 5.1k. Manual and region paths bypass it through
  `forcedRange` (`src/dsh/historian.ts:987`), the same exemption set. One
  deliberate difference: at ≥95 % pressure an automatic span below the 5 % floor
  is still skipped here, and the overflow case is served by the drop lane (§A
  emergency fit guard) rather than by an extra historian call.
- **Cache lifetime from request breakpoints (v0.49.50).** `eeb2a6af9` and
  `fdc878710` change `packages/plugin/scripts/analyze-cache-busts.ts` — the
  diagnostic analyzer, not the band decision, so `ttlMs` semantics here are
  untouched. The idea (derive the effective lifetime from what the request
  declared instead of assuming 5 m) is recorded in §E.

When a new upstream tag appears (re-clone cortexkit/magic-context as needed —
`dsh-track` is retired, see `docs/dsh-plugin-upgrade-followup.md` §0), walk the
numbered entries of §B/§C/§D and re-verify the cited lines: line numbers drift
with every refactor, the semantics behind them do not.

---

## A. Aligned effective behavior

- **Reclaim lane.** Tags are stamped on tool results only
  (`src/dsh/seams.ts:78`), resolved from the surface
  (`src/dsh/seams.ts:131`), dropped as `[dropped §N§]` placeholders, and restored
  by `ctx_expand` from the referenced event — the same contract as
  `packages/plugin` and `packages/pi-plugin`.
- **Memory write contract.** 29 columns, `UNIQUE` normalized hash, promotion as
  a pure append (`docs/dsh-plugin-memory-write-contract.md`, `src/core/memory-write.ts`).
- **Fusion retrieval.** 0.7/0.3 keyword↔vector fusion, id lookup, merge rules
  (upgrade guide §4, `src/core/memory-search.ts`).
- **Historian chunking.** ≤4 consecutive blocks plus the merge instruction
  (`src/dsh/historian.ts:380`); default timeout 120 s, matching `core/policy.ts`
  (`src/dsh/historian.ts:59`).
- **Maintenance tick** — the adapter's slice of MC's dreamer: TTL expiry through
  the archive contract, then batched LLM verification
  (`src/core/maintenance.ts:200`, wired at `src/dsh/maintenance-wiring.ts:40`;
  first sweep 60 s after mount, then every 30 min, floor 60 s —
  `src/dsh/maintenance-wiring.ts:97`).
- **Reduce guidance.** Desk section plus the dynamic reduce context, thresholds
  copied verbatim from MC (60k/25k floors, 20/40/60 % ladder, channel 2 at ≥75 %
  and ≥50k, sticky 5 turns) — upgrade guide §4, `src/dsh/reduce-guidance.ts`.
- **Emergency fit guard (#731, upstream `selection.rs` `floor_above_ceiling`).**
  The drop lane refuses to fire when the fixed floor alone busts the window:
  `surfaceEstimate − reclaimableTokens > contextWindow` ⇒ `skipped:'cannot-fit'`,
  results preserved, no retry (`src/dsh/emergency.ts`, both call sites pass the
  whole-surface estimate).
- **Historian no-progress gate (#802, upstream e9075bfec).** After an automatic
  run that published nothing, the next automatic run waits until a surface node
  NEWER than the failed span's end exists; manual/forced spans bypass. Watermark
  is a store-meta kv entry (`historian_no_progress:<sessionId>`, own store — no
  schema change), released by a stored compartment (`src/dsh/historian.ts`).
- **User-observation production toggle (upstream d02292d0d).** Observations are
  requested only when a profile-collect sink is armed; otherwise the per-call
  USER instruction carries `<user_observation_extraction>disabled</...>` and
  asks for `"userObservations": []`. The JSON contract bytes are unchanged
  (`src/dsh/historian.ts`).

## B. Host-imposed mechanism differences

### B1. No pre-request injection seam → the decision lives in `agent/pre-step`

The DSH request is derived from the append-only log; replacements are model-only
material (`host: packages/core/session/src/surface.ts:85`). The only interception
point is the `agent/pre-step` waterfall
(`host: packages/core/agent-loop/src/agent.ts:277`, payload shape
`host: packages/core/agent/src/runtime-types.ts:320`), which is where the adapter
composes m[0]/m[1]/`<memory-updates>` and takes its pressure decision
(`src/dsh/pre-step.ts:9`, `src/dsh/seams.ts:40`).

**Consequence:** tags are durable surface content, not a wire-level rewrite.
OpenCode mutates `output.messages` and Pi returns a replacement array; neither
touches the session log. Anything the adapter writes to the surface is visible to
the model *and* the GUI, and survives as the same artifact.

### B2. `§N§` can only be stamped on tool results

Because the model face and the UI face are one surface (B1) and the reclaim lanes
resolve tool results only (`src/dsh/seams.ts:131`), a tag on a user message is a
dead handle: `ctx_reduce` refuses it, and it pollutes the deterministic session
title, which reads the first message whose `source.kind === 'user'`
(`host: packages/session/session-title/src/normalize.ts:70` and
`host: packages/session/session-title/src/index.ts:788`).

**Consequence:** admission tagging was removed; `tools/post-execute` stamping
stays (`src/dsh/seams.ts:41`, `src/dsh/seams.ts:72`). Tool-result cards in the
transcript still carry `§N§` — a model needs the handle, and this host has no
per-request projection seam to hide it. Without a host seam this cannot be
aligned with OpenCode/Pi (see §C, `per-request projection`).

### B3. Synthetic surface nodes must carry a real source

The GUI renders only append-surface events
(`host: packages/core/session/src/surface.ts:89`, used by
`host: packages/client/ui-chat/src/client/conversation-nodes/message.ts:67`,
`.../tool.ts:303`, `.../fallback.ts:19`), and the title fallback folds the first
`kind === 'user'` message (B2). A synthetic node that claims
`{ kind: 'user' }` therefore hijacks both.

**Consequence:** the adapter emits `{ kind: 'magic-context', form: 'notice',
summary }` for session notices (`src/dsh/seams.ts:441`,
`src/dsh/session-notice.ts:104`) and `{ kind: 'compact-checkpoint', compactionId,
sourceCommandId? }` for compaction checkpoints (`src/dsh/seams.ts:457`), mirroring
the host's own shape (`host: packages/compaction/compaction/src/checkpoint.ts:19`)
so the GUI's command node correlates its card
(`host: packages/client/ui-chat/src/client/conversation-nodes/command.ts:23`).

### B4. A surface replacement may change `content` only

The host validator rejects anything else for tool results:
`tool/result surface replacement may change only content`
(`host: packages/core/session/src/surface.ts:482`). `replaceSurfaceRange`
(`src/dsh/seams.ts:474`) therefore rewrites content and leaves the appended
event's type, id and source untouched; recovery works because the original event
stays in the log.

### B5. Occupancy is read from the host projection, not recomputed

The native meter reports `projectedTokens ?? pressureTokens`
(`host: packages/client/ui-conversation/src/client/context-occupancy.ts:18`),
where `projectedTokens` is the sample plus the surface's signed movement since it
was taken (`host: packages/llm/token-meter/src/usage-projection.ts:69`,
`:215`). Recomputing occupancy from the last billing row gave a number that never
moved after a compaction.

**Consequence:** the adapter subscribes to the `sessionProjections` service
(`src/index.ts:429`) and journals the `contextPressure` key
(`src/index.ts:439`, `src/dsh/context-pressure.ts:4`), so the panel and the
native pill show the same figure.

### B6. Project identity is per call, not per turn

DSH has no OpenCode-style per-turn working directory (the session header's `cwd`
is frozen at creation), so MC's three-layer `session_projects` cannot be ported
directly. The adapter instead takes an optional `project` argument on every
`ctx_memory` action (absolute path, `git:` or `dir:` identity) and observes
foreign roots per turn in `src/dsh/project-drift.ts`.

**Consequence:** an unresolvable `project` is rejected structurally (`ok:false`)
rather than guessed; facts written without it belong to the session's project.

### B7. Configuration loading

`cordis.patch.yml` config is **replaced wholesale, not deep-merged** — every key
that must survive has to be repeated in the patch — and the plugin's `Config`
must come off the **default export**; a named-only `Config` is silently ignored
by the loader (upgrade guide §3.3).

### B8. Storage boundary

Superseded 2026-10-13: the adapter owns its corpus. `memories.db` (own
data dir, shape inherited verbatim from the upstream v95 store) is read and
written directly; `MEMORY_SCHEMA_MAX_VERSION = 95`
(`src/core/memory-bridge.ts`) guards the plugin's OWN migration lineage —
a corpus newer than the build degrades the write path to read-only. The
legacy shared `context.db` is never opened. The adapter's own runtime store
keeps its `SCHEMA_VERSION` chain (`src/core/stores.ts`). Upstream MC is
followed for FEATURES only; there is no storage-compatibility obligation.

### B9. Historian budget shape

The adapter budgets one historian run as `Math.min(600_000, timeoutMs ×
plannedCalls + merge)` (`src/dsh/historian.ts:478`); MC keeps an independent
budget structure (upgrade guide §5). Same user-visible outcome, different
arithmetic.

## C. Not ported

| MC module | Status here | Why |
|---|---|---|
| `dreamer` — full task set (~90 files: task-executor, scheduler, lease, verify, map-memories, retrospective, primers) | tick slice only (TTL + verify) | curate/verify/expire would double-archive against this adapter's own archive path, and DSH has no cron/lease infrastructure; only the tasks that pay for themselves belong on the existing tick |
| `caveman`, `decay_render` | absent | render-side product features, no DSH surface |
| `decision_calibration`, `divergence` | absent | analysis lanes with no consumer in this host |
| `healing` | absent | relies on MC's WAL recovery sweep (see §D) |
| `reply_pages` | absent | host-specific pagination UX |
| `historian_chunk` (MC side) | replaced | adapter implements chunk planning directly (`src/dsh/historian.ts:380`) |
| per-request projection seam | absent | it would violate the host's reconstructability rule (`host: packages/core/session/src/surface.ts:85`), which is why §B2 stays host-imposed |
| `protected_tools` holds (per-tool kept results) | absent | not ported: the lane reached v0.46.0 through introduce → revert → restore → restrict, so it is not yet a stable target. This adapter's emergency model keeps the protection *window* (`clamp(contextWindow × 5%, 8k, 64k)`) plus a count floor (`src/dsh/emergency.ts`), which is what §B's reclaim lane needs |
| `/ctx-recomp` recompaction | **ported** (different carrier) | `src/dsh/recomp.ts` + the `ctx-recomp` command: it re-runs the historian over the compartment's original span — the shadowed events are still in the log (`seams.nodesForSeqs`) — and replaces the stored digest in place. Upstream's staging promotion, placeholder rewriting and compartment lease are unnecessary here because the digest is rendered from the store, not from the wire; the placeholder node only marks the span |
| watermark age reclaim (`tool-reclaim`) | absent | upstream auto-drops active tool tags at or below a watermark once they are worth `AGE_RECLAIM_MIN_TOKENS`; this adapter reclaims only on model stamps and in the force band |
| historian calibration anchors (`reference-retrieval` + 60 seeds) | absent | our historian prompt carries instructions but no scored anchors, so importance calibration is guesswork here (and importance drives tier, decay and promotion) |
| tokenizer calibration, image token estimate, decision calibration | absent | accounting is `chars/4` (`src/core/compartments.ts:59`); image-heavy sessions are underestimated |
| `edit-marker` (trim old edit/write inputs) | absent | only tool-result content is rewritten (§B4), so giant `edit` diffs stay resident |
| LKG replay + degraded-pass refusal | absent (structurally unnecessary) | the wire is derived from the append-only log: a failed pass appends nothing, so there is no degraded wire to replace. The premise would return with any in-place rewrite of landed messages — see the survey §3.4 |

Adding any of these is a product decision, not an upgrade task: record the
decision here before writing code. The current ruling — MC classifies its twelve
dreamer tasks by transport (seven need an agent tool loop, four are one-shot, one
is host-only), and that host-only task, `promote-primers`, turns out to need the
whole primer pipeline (producer prompt, tables, clustering, consumer), so **no
task is queued**; vector backfill stays off — is
`docs/dsh-plugin-dreamer-vector-decision-2026-10-08.md` (its §6 corrects the
earlier "add promote-primers next" reading).

## D. Intentional deviations — do not "fix" on upgrade

- `recordRetrieval` does **not** write `updated_at` (MC does), keeping the m[0]
  digest `id:updatedAt` stable.
- Above v94 the write path degrades to read-only; `seen_count` uses `COALESCE`;
  errors surface as `{ ok: false, reason }` instead of throwing.
- Tool-result cards keep their `§N§` prefix (§B2 — architectural, not cosmetic).
- Historian `start` rows that never get a terminal row inside the process are
  repaired on remount; MC's WAL scan is the counterpart we do not port.
- Proactive 95 % band, mid-turn deferral and leases are impossible with only
  `agent/pre-step`: there is no seam between a request and its response.
- `memory.embedBackfill` defaults **off** (`src/dsh/config.ts:74`,
  `src/dsh/memory-lane.ts:106`): the in-memory fill lane costs a local model load,
  so it stays opt-in.
- Emergency reclaim rides the `agent/request-error` waterfall rather than a
  pre-request decision (`src/dsh/emergency.ts:3`, `src/dsh/seams.ts:43`).

## E. Pending parity (observation, no verdict yet)

- Historian done-rate under long sessions.
- `verify` quota rejections (provider 429) surfacing as `llm-failed` tick reasons.
- `project-drift` frequency — decides whether per-fact ownership or a DSH
  `session_projects` equivalent is worth building.
- Physical TTL cleanup (rows archived, bytes still on disk) — awaits a ruling.
- Cache lifetime is assumed (5 m default via `ttlMs`) rather than derived from the
  request's declared breakpoints; upstream's analyzer derives it
  (`analyze-cache-busts.ts`, v0.49.50). Report-accuracy item only — no band
  behavior depends on it.
- Storage-compat observations R3–R9 from the MC↔DSH audit (TTL asymmetry,
  owned-path equality, git-fault fallback, symlinked dirs, missing embeddings).
