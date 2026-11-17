/**
 * The adapter's configuration contract (moved verbatim out of index.ts so the
 * wiring modules can type their `config` without importing the composition
 * root). Nothing here executes; index.ts re-exports the interface.
 */
import type { JournalLevel } from '../core/journal.ts'
import type { PressurePolicy } from '../core/policy.ts'

export interface MagicContextDshConfig {
  /** Directory for the adapter's SQLite store. Defaults under ~/.local/share. */
  dataDir?: string
  /** Master switch; false keeps the plugin loaded but fully inert. */
  enabled?: boolean
  /**
   * Options-page master switch for the memory lane (declared in the exported
   * Config as a non-volatile scalar, so a form commit remounts the fiber and the
   * mount-time lane gate re-evaluates).
   *
   * Off from either spelling closes the lane: this scalar, or the patch-level
   * `memory.enabled: false` that predates it.
   */
  memoryEnabled?: boolean
  /** Register the ctx_reduce / ctx_expand agent tools (default true). */
  registerTools?: boolean
  /** Register the /ctx-status command (default true). */
  registerStatusCommand?: boolean
  /**
   * Host-supplied tool constructor. In-tree glue (which resolves
   * @deepseek-ai/dsh-tools natively) passes it here; when absent the
   * adapter falls back to a dynamic import, which only works in loading
   * modes where that specifier is resolvable from this package.
   */
  defineTool?: MagicContextDshConfigDefineTool
  /**
   * Generation route (historian + `/compact` summaries): a PROVIDER/MODEL
   * pair. Both halves non-empty = pinned; anything else = follow the session's
   * routed model. The schema always materialises this block (empty halves by
   * default), so a `historian: {}` override is equivalent to leaving it unset.
   */
  historian?: { provider: string; model: string }
  /** Turn the historian's out-of-band digests off (default: on). */
  historianEnabled?: boolean
  /**
   * Write one notice entry (`user/message`, producer kind `magic-context`,
   * form `notice`) into the session stream after each management pass that
   * actually did something — publish, force-drop, or fact promotion. The
   * transcript renders it as a collapsed notice row. Default true; the entry
   * is model-visible, so it costs its own (short) tokens until compaction.
   */
  sessionNotices?: boolean
  /**
   * Project-memory recall from the plugin's own corpus (`memories.db`,
   * cut over from the legacy shared store 2026-10-13). Off when omitted.
   */
  memory?: {
    /** Explicit corpus path; defaults into the adapter's own data directory. */
    dbPath?: string
    /** Master switch for the whole memory lane (default true when memory is present). */
    enabled?: boolean
    /**
     * Identity (`git:<root-sha>` / `dir:<hash>`) OR a directory to derive it
     * from. Unset falls back to the session's cwd, so project memory works
     * with no configuration at all.
     */
    project?: string
    /** Extra identities to read shared rows from; unset uses the active domains. */
    domainProjects?: readonly string[]
    /** Category allowlist for shared rows; unset uses the active domains' union policy. */
    shareCategories?: readonly string[]
    /**
     * Promote the historian's facts into project memory (Magic Context's
     * `memory.auto_promote`). Default true when memory is configured: facts
     * only become durable knowledge through this path.
     */
    autoPromote?: boolean
    /**
     * Let the agent maintain memories through `ctx_memory` (write/update/
     * archive/merge). Default true; false keeps the tool read-only while the
     * bridge still injects existing memories.
     */
    write?: boolean
    /**
     * S(t) decay scoring (schema v7 sidecar, borrowed from mon3stera's
     * dsh-magic-context): hits slow the decay and boost the score;
     * sub-threshold rows stop being injected here (they stay searchable in
     * ctx_memory). Stats are ALWAYS collected in the adapter's own
     * `memory_stats` table; `enabled` gates only the ranking takeover.
     * Profile-JSON only (like the rest of `memory`, not in the settings
     * schema — a declared key would open the lane for every profile).
     */
    scoring?: {
      /** Default true (distribution default 2026-10-13): S(t) takes over ranking. */
      enabled?: boolean
      /** Hit boost strength (mon3stera default 0.4). */
      alpha?: number
      /** How much each hit slows the decay (mon3stera default 0.2). */
      beta?: number
      /** Scores below this stop being injected (default 2, on the 1–100 scale). */
      archiveThreshold?: number
      /** Category half-life in DAYS; null = immortal. Defaults: PROJECT_RULES/
       * ARCHITECTURE/CONSTRAINTS immortal, CONFIG_VALUES 60, NAMING 90,
       * USER_PREFERENCES 14, WORKFLOW_RULES/KNOWN_ISSUES 30, ENVIRONMENT 90. */
      halfLives?: Record<string, number | null>
    }
    /**
     * The `user` (profile) lane. It has no activation rule because it is about
     * the person, not a project — which is exactly why its two halves are
     * separate switches: rendering reads the shared store, collecting writes it.
     */
    global?: {
      user?: {
        /**
         * Inject the stored profile as m[0] `<user-profile>` (and new entries as
         * m[1] `<new-user-profile>`). Default true — Magic Context injected the
         * profile into every session, and this adapter had no such lane.
         * Read-only: nothing is written to the shared store.
         */
        render?: boolean
        /**
         * Produce new profile candidates from DSH sessions. Default TRUE since
         * the 2026-10-13 distribution decision — the corpus is plugin-owned, so
         * collecting observations needs no opt-in; an explicit `false` still
         * disables it.
         */
        collect?: boolean
        /**
         * Review candidates into the profile (`user_memories`) — the half that
         * makes a promoted fact inject into EVERY session. Default TRUE since
         * the 2026-10-13 distribution decision; the recurrence gate
         * (cross-session, promotion_threshold) and the directive-shaped
         * confirmation queue stay in force, and an explicit `false` still
         * disables the lane.
         */
        review?: boolean
      }
      machine?: {
        /**
         * Share knowledge between every project on THIS machine. Default TRUE
         * since the 2026-10-13 distribution decision (corpus is plugin-owned;
         * only explicitly published rows are ever visible). `excludeProjects`
         * narrows it; an explicit `false` disables the sync.
         */
        enabled?: boolean
        /**
         * Projects kept OUT of the machine domain, even while it is on. Names
         * are `git:`/`dir:` identities, exactly as they appear in `ctx-status`.
         * An excluded project neither sees machine rows nor joins the domain;
         * excluding never deletes anything else (see planMachineDomain).
         */
        excludeProjects?: readonly string[]
        /**
         * L1① (2026-10-12): the maintenance tick may promote qualifying
         * memories into the machine domain's CANDIDATE pool on its own —
         * active, project scope, category on the domain's allowlist,
         * seen_count >= 2, no credential body, ≤3 per pass, paused while ≥10
         * candidates sit pending. Staging is reversible and shares nothing;
         * PUBLISHING stays a human act (`approve` / panel button). Default
         * TRUE since the 2026-10-13 distribution decision; LLM classification
         * fail-closes (paused rows, never a guessed domain).
         */
        autoStage?: boolean
      }
      /**
       * Human approval for global-domain candidates (machine + org alike):
       * `ctx_memory action=review_global` presents pending candidates as
       * user-questions cards — five questions per modal, chained within the
       * call until the queue drains — and only the user-approved ones are
       * published (source_type=user — the WP9 publishing semantics).
       */
      review?: {
        /** Candidates one review_global call may process (default 50, the auto-stage pool cap). */
        batchLimit?: number
      }
    }
    /**
     * Embed query-side candidates in memory instead of reading stored vectors
     * (the B4 lane, `memory-lane.ts`). Default TRUE — this is what lets a search
     * work at all on rows the store has no vector for. It writes nothing.
     * (The old comment here claimed a false default while the code read true;
     * the flag was never the backfill switch, and WP11 added the real one below.)
     */
    embedBackfill?: boolean
    /**
     * WP11: fill `memory_embeddings` for active rows the dominant space is
     * missing. Default TRUE (2026-10-12): the write path never embeds, so a
     * default-off lane meant every NEW memory stayed vector-less and Chinese
     * semantic recall silently decayed. Writes go into this machine's own
     * single-writer store, bounded by `vectorBackfillLimit` per tick and
     * behind the shared-space parity gate; set `false` to keep the store
     * free of writes. (The original default was FALSE while the store was
     * still MC's contract territory; the OpenCode/Pi retirement made this
     * store single-writer ours, which removed the opt-in rationale.)
     */
    vectorBackfill?: boolean
    /**
     * Index the current project's git history on each maintenance tick
     * (default on). Gives `ctx_search` a `git_commit` source: "when did this
     * change", "what did that commit do". Off leaves commit queries answering
     * that this deployment has no commit index.
     */
    indexCommits?: boolean
    /**
     * Cluster the questions observed in this project and promote the ones that
     * recur across days into primers (default on). A primer with no answer yet is
     * still reported by `ctx_search` — "we keep asking this and never wrote it
     * down" is the state promotion exists to surface.
     */
    promotePrimers?: boolean
    /**
     * Rows per maintenance tick for the vector backfill (default 24). Bounds how
     * much of the shared store one pass touches; the remaining gap is picked up
     * by the next tick.
     */
    vectorBackfillLimit?: number
  }
  /**
   * Turn the reduce-guidance band (desk section + Channel 1/2) off entirely
   * (default true). Read through the volatile reference live at every pass.
   */
  reduceGuidance?: boolean
  /**
   * Auto-search hint: one "you may recall something related" entry per user turn
   * (default true, `search-hint.ts`). The hint is FTS-only and deadline-bounded.
   */
  searchHint?: boolean
  /**
   * The maintenance tick's schedule + verify route. Profile-JSON only (the
   * settings schema at index.ts declares the volatile fields the form may
   * edit; these arrive through the same patch object either way).
   */
  maintenance?: {
    enabled?: boolean
    intervalMs?: number
    verifyProvider?: string
    verifyModel?: string
    /**
     * Evaluate parked smart notes' declarative surface conditions on each tick
     * (default on). Off leaves every smart note parked forever, which is only
     * useful for isolating the note lane while debugging something else.
     */
    smartNotes?: boolean
  }
  /**
   * Background tasks (the Dreamer lane).
   *
   * Schedules themselves live in the database (`dream_schedule`), not here: they
   * are per-project state with a runtime history, and a config key would fight
   * the table every boot. This block only carries the knobs that are global and
   * static.
   */
  dream?: {
    /**
     * How old an importance score must be before `classify-memories` re-ranks
     * it, in ms. Default two weeks.
     *
     * Not a freshness preference: importance is a RANK inside the current pool,
     * so a project whose memory count has moved a lot needs re-ranking sooner
     * than one that has not. Shorter costs more model calls for a ranking nobody
     * needed yet.
     */
    classifyStaleAfterMs?: number
    /** Memories per classify call (default 16). Larger batches risk a truncated
     *  manifest and cost more per failure; smaller ones pay more per row. */
    classifyBatchSize?: number
    /**
     * Memories per verify call (default 8).
     *
     * Smaller than classify's batch on purpose: a verify prompt carries the
     * memory text AND the filesystem evidence under it, so each row costs several
     * times what a score row costs, and a verdict is a bigger claim to get wrong.
     */
    verifyBatchSize?: number
    /**
     * `curate` writes by default only when this is explicitly `false`.
     *
     * Absent means dry run. Merging archives a source row and installs a
     * machine-written replacement; neither is recoverable by the task, so the
     * safe state has to be the default rather than a warning.
     */
    curateDryRun?: boolean
    /** Cosine below which a pair is never offered to the model (default 0.92). */
    curateSimilarityFloor?: number
    /** Pairs examined per curate run (default 6). */
    curateMaxPairs?: number
    /** How far back a retrospective reads the journal (default 7 days). */
    retrospectiveWindowMs?: number
    /**
     * Extra directory trees `verify` may search for the files a memory cites.
     *
     * Exists because work in one project routinely touches another repository,
     * and a memory written here then cites `src/core/guard.ts` that lives over
     * there. Without these roots every such reference reads as missing, the row
     * can never be verified, and it sits in the pool forever.
     *
     * Point these at PARENT directories of your checkouts (`C:/data/code`), not
     * at each project: the list is then stable for months instead of needing an
     * edit every time a repository is cloned. Avoid a parent so large that the
     * index hits its file ceiling — 20k source files is the cap.
     */
    verifyExtraRoots?: string[]
  }
  /**
   * Host-supplied CompactionEngine base class (in-tree glue injects it; when
   * absent the adapter resolves `@deepseek-ai/dsh-compaction` dynamically).
   */
  compactionBase?: unknown
  /** Mount the adapter's CompactionEngine on the `compaction` seam (default false —
   *  the seam is first-come-first-served, so takeover needs a profile that does
   *  not mount compaction-basic; see tests/compaction-conflict.spec.ts). */
  registerCompactionEngine?: boolean
  /**
   * Validation-period observability. The Desktop app does not persist the
   * harness logger, so decisions and outcomes go to the adapter's own journal
   * table plus (by default) a human-readable mirror file; see
   * scripts/mc-report.mjs for the review side.
   */
  journal?: {
    /** Turn the journal off entirely (default: on). */
    enabled?: boolean
    /** Minimum persisted level (default 'info'; 'warn' drops routine events). */
    level?: JournalLevel
    /** Retention in days, pruned when the journal opens (default 30). */
    retentionDays?: number
    /** Write the one-line text mirror (default true). */
    mirror?: boolean
  }
  /** §N§ tag registry retention (default 30 days; pruned once per mount). */
  tags?: {
    retentionDays?: number
  }
  /** Pressure policy overrides; unset fields keep the defaults. */
  policy?: Partial<PressurePolicy>
}

export type MagicContextDshConfigDefineTool = typeof import('@deepseek-ai/dsh-tools')['defineTool']
