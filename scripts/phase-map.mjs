/**
 * The phase map — which specs gate which phase, and what each phase still
 * cannot see.
 *
 * The execution plan requires a stage gate: work may only move to the next
 * phase when the current phase's suite is green. A suite is only a gate if
 * nothing can fall out of it, so this table is asserted against the filesystem
 * (tests/phase-map.spec.ts): every spec in the repository must belong to at
 * least one phase, every path listed here must exist, and every phase must name
 * its blind spots.
 *
 * `blind` is not decoration. A green phase suite that quietly covers nothing is
 * the failure mode this file exists to prevent, so the runner prints the blind
 * list on every run — pass or fail.
 *
 * Phase 0 is the plugin's existing regression suite: everything that shipped
 * before the takeover work. It gates every later phase, because new lanes must
 * not break the old ones.
 */

/** Phase 0: the behaviour that already shipped, before any of the takeover work. */
const PHASE_BASE = [
  'tests/phase-map.spec.ts',
  'tests/client-pure.spec.ts',
  'tests/protected-tail.spec.ts',
  'tests/historian-failure.spec.ts',
  'tests/user-facing-codes.spec.ts',
  'tests/historian-failure-streak.spec.ts',
  'tests/importance.spec.ts',
  'tests/decay-curve.spec.ts',
  'tests/baseline-render-epoch.spec.ts',
  'tests/drop-small-result.spec.ts',
  'tests/flush-command.spec.ts',
  'tests/dream-command.spec.ts',
  'tests/embed-command.spec.ts',
  'tests/memory-budget.spec.ts',
  'tests/baseline-split-sequence.spec.ts',
  'tests/baseline-section-order.spec.ts',
  'tests/memory-line-format.spec.ts',
  'tests/memory-grouping.spec.ts',
  'tests/historian-memory-block.spec.ts',
  'tests/memory-budget-source.spec.ts',
  'tests/migration-order.spec.ts',
  'tests/system-hash.spec.ts',
  'tests/emergency-fail-closed.spec.ts',
  'tests/provider-limit.spec.ts',
  'tests/emergency-arming.spec.ts',
  // Anti-idle gates ported from upstream mc-upstream a1ca346: the derived force
  // band, the rolling drain budget, the emergency latch, and the post-drop
  // projection that decides when summarisation is the only lever left.
  'tests/escalation-bands.spec.ts',
  'tests/drain-budget.spec.ts',
  'tests/drain-latch.spec.ts',
  'tests/drop-projection.spec.ts',
  // `ctx_search`'s from/to contract: a date-only `to` must cover the whole day,
  // and an impossible date must be refused rather than normalised by Date.UTC.
  'tests/date-range.spec.ts',
  // `ctx_note` read paging: the note queue is the one that grows in a long
  // session, so limit/offset/filter are what keep it reachable.
  'tests/note-paging.spec.ts',
  // Protection window: the mass window and the count floor are independent and
  // the wider one wins (upstream `cutoff = min(mass_cutoff, newest3_cutoff)`).
  'tests/emergency-structural-min.spec.ts',
  // Work metrics: growth vs. peak context, and the incremental carry must equal
  // the cold fold (verified on a 5,285-step live session, 0 mismatches).
  'tests/work-metrics.spec.ts',
  // Cross-process compartment lease: mutual exclusion between processes, TTL
  // takeover, and dead-owner reclaim (the in-process inFlight guard cannot see
  // any of that).
  'tests/compartment-lease.spec.ts',
  // Smart notes: declarative surface conditions are DATA, never code, and a path
  // escaping the project root is refused at parse time.
  'tests/surface-condition.spec.ts',
  // The tick that wakes them: false stays parked, errors retry, repeated errors
  // surface with a warning instead of parking invisibly.
  'tests/smart-notes.spec.ts',
  // Token estimation: `chars/4` under-counted the provider by 31% (CJK is ~1
  // token/char), and every request carries ~42k of fixed overhead no persisted
  // document contains. The floor must stay positive — a zero reintroduces the
  // under-estimate this module exists to remove.
  'tests/token-estimate.spec.ts',
  // Memory chunking: no gap between consecutive spans, every chunk opens on a word
  // (not mid-token), and the first/last chunks reach the ends of the source.
  'tests/memory-chunk.spec.ts',
  // Chunk vectors: replace-not-append (a shrunk memory must not leave orphans),
  // best-chunk ranking (averaging reproduces the dilution chunking removes), and
  // byte-exact round-trip (a view into a statement buffer is freed by the next query).
  'tests/chunk-store.spec.ts',
  // Git commit lane: the parse contract (US/RS not NUL, four-separator split,
  // full-object-name check), eviction by COMMIT time, the conditional upsert, and
  // the FTS + semantic merge.
  'tests/git-commits.spec.ts',
  // Primer lane: support counts distinct DAYS (a burst is not a habit), promotion
  // needs support AND span, the occurrence key keeps recurrences separate, and a
  // primer with no vector must still absorb its own recurrences (normalization bug).
  'tests/primer.spec.ts',
  // The SOFT-refresh cache invariant: m[0] must not change a byte when
  // compartments land in m[1], and the heading carries no tier/time. Baseline:
  // it pins the upstream rule (ARCHITECTURE.md:96) the local renderer broke.
  'tests/soft-refresh-invariant.spec.ts',
  // The dock pill's hover contract: portal out of the composer dock, a finite
  // bubble width, and one pointer handler family (the duplicate mouse pair made
  // the whole window flicker). Baseline: it pins shipped behaviour, not new work.
  'tests/client-hover-tooltip.spec.ts',
  // An expired provider cache is not a rebuild reason (MC v0.49.44). Pins the
  // decision so the idle-clock branch cannot drift back in silently.
  'tests/idle-band.spec.ts',
  'tests/historian-idle-admission.spec.ts',
  'tests/historian-envelope.spec.ts',
  // The reclaim lane's accounting: `drop-landed` estimates from the text it
  // removed (the map used to be built after the replace and read the placeholder,
  // so every drop recorded 0 tokens), and the dashboard reports tags landed
  // rather than batch rows. Baseline: it pins shipped behaviour.
  'tests/drop-estimate.spec.ts',
  'tests/compaction-engine.spec.ts',
  'tests/compaction-conflict.spec.ts',
  'tests/compartments.spec.ts',
  'tests/config-schema.spec.ts',
  'tests/global-autostage.spec.ts',
  'tests/global-review.spec.ts',
  'tests/context-pressure.spec.ts',
  'tests/ctx-reduce-render.spec.ts',
  // The read-only dashboard (`/mc-dashboard`): the surface upstream ships as a
  // Tauri app. Gated here because it adds no behaviour to the compaction loop —
  // it only reads what the baseline already writes.
  'tests/dashboard.spec.ts',
  // ctx_search / ctx_note + the v11 notes table: the two capabilities the
  // port lacked (history recall, parked intentions). Gated here because they
  // extend the tool surface the baseline already ships.
  'tests/ctx-search-note.spec.ts',
  // ctx_expand's history channel: `message=<seq>` / `start,end` read back out of
  // stored history, so a stamped output stays recoverable after its message is
  // folded into a compartment (the tag channel dies with the placeholder).
  // Gated here because it completes an existing tool rather than adding one.
  'tests/session-history.spec.ts',
  'tests/ctx-expand-history.spec.ts',
  // /ctx-wrapup + the manual-checkpoint primitives: the one upstream entry
  // point the port could only reach by adopting the adapter as its compaction
  // engine. Gated here because it adds a command to the baseline surface.
  'tests/wrapup.spec.ts',
  'tests/embedding-wasm.spec.ts',
  'tests/emergency-drop.spec.ts',
  'tests/historian-chunking.spec.ts',
  'tests/historian-terminal.spec.ts',
  'tests/host-drift-tolerance.spec.ts',
  'tests/journal.spec.ts',
  'tests/live-journal.spec.ts',
  'tests/maintenance-wiring.spec.ts',
  'tests/maintenance.spec.ts',
  'tests/management-pass-fail.spec.ts',
  'tests/memory-bridge.spec.ts',
  'tests/memory-gate-fence.spec.ts',
  'tests/memory-promotion.spec.ts',
  'tests/memory-retrieval-wiring.spec.ts',
  'tests/memory-scoring.spec.ts',
  'tests/memory-search.spec.ts',
  'tests/memory-tool-bridge.spec.ts',
  'tests/memory-write.spec.ts',
  'tests/phase1.spec.ts',
  'tests/phase2.spec.ts',
  'tests/poc.spec.ts',
  'tests/pressure-staleness.spec.ts',
  'tests/llm-deadline.spec.ts',
  'tests/ttl-rebuild.spec.ts',
  'tests/probe.spec.ts',
  'tests/project-drift.spec.ts',
  'tests/publish-guard.spec.ts',
  'tests/publish-pairing.spec.ts',
  'tests/recomp.spec.ts',
  'tests/reduce-guidance.spec.ts',
  'tests/search-hint-carrier.spec.ts',
  'tests/search-hint.spec.ts',
  'tests/session-notice.spec.ts',
  'tests/store-fusion.spec.ts',
  'tests/tags-retention.spec.ts',
  'tests/telemetry.spec.ts',
  'tests/wire-repair.spec.ts',
]

/** Phase A: the substrate. Own corpus (v95 lineage), adapter schema v9, domains activate. */
const PHASE_A = [
  'tests/corpus-store.spec.ts',
  'tests/corpus-version-invariant.spec.ts',
  'tests/store-schema-v8.spec.ts',
  'tests/domain-visibility.spec.ts',
  'tests/memory-delta.spec.ts',
  'tests/memory-sharing.spec.ts',
]

/**
 * Phase B: the `user` domain. Collection and review WRITE the own corpus
 * and stay behind their own switches (`memory.global.user.collect` / `.review`,
 * both default off), so the specs below use a synthetic corpus database.
 */
const PHASE_B = [
  'tests/directive-detect.spec.ts',
  'tests/profile-collection.spec.ts',
  'tests/profile-collection-run.spec.ts',
  'tests/profile-confirmation.spec.ts',
  'tests/profile-render.spec.ts',
  'tests/profile-review.spec.ts',
]

/** Phase C: org/machine domains. Publishing writes the corpus. */
const PHASE_C = [
  // The gate a memory must pass before it becomes visible to another project.
  // It replaces "a human reads every approval card": measured on this
  // installation, 130 of 896 active memories carry a local path, a loopback
  // endpoint or a credential, and one of those was already published.
  'tests/shareable-guard.spec.ts',
  // The judgement wired into the two places a row can become shared: the
  // automatic path (classify, upstream's model) and the gated one (publish —
  // which since 2026-11-17 also runs automatically from auto-stage, with
  // `approvalGate` as its only veto; the approval CARD is a fallback for
  // gate refusals, not the normal route).
  'tests/shareable-wiring.spec.ts',
  'tests/org-domain.spec.ts',
  'tests/domain-publish.spec.ts',
  'tests/machine-domain.spec.ts',
  // The machine domain switch has one reading (2026-11-12).
  'tests/machine-domain-config.spec.ts',
  // The two memory-lane switches and what the form may write (2026-11-12).
  'tests/live-flags.spec.ts',
  // "publishing is a copy, not a mirror": the audit of published domain rows
  // against the memories they were promoted from (2026-10-16).
  'tests/domain-reconcile.spec.ts',
]

/** Phase D: the operating loop — commands, telemetry, backfill, drill. */
const PHASE_D = [
  'tests/command-surface.spec.ts',
  'tests/config-switches.spec.ts',
  'tests/vector-lane.spec.ts',
  'tests/vector-backfill.spec.ts',
  'tests/report-classify.spec.ts',
  'tests/domain-checks.spec.ts',
  'tests/profile-checks.spec.ts',
  'tests/cli-flags.spec.ts',
  'tests/route-health.spec.ts',
  'tests/report-hits.spec.ts',
  'tests/historian-pairing.spec.ts',
  'tests/baseline-stability.spec.ts',
  'tests/baseline-clock-freeze.spec.ts',
  'tests/report-dilution.spec.ts',
]

/**
 * Phase E: background tasks (the Dreamer lane).
 *
 * The gate here is the scheduler's safety rules, not its features: a task that
 * runs when it should not, or writes effects after reporting a failure, is worse
 * than no scheduler at all. Only `promote-primers` is wired in this phase — the
 * one task with no model call — so the clock and the lease are proven before any
 * completion is added.
 */
const PHASE_E = [
  // The clock: strictly-after semantics, Vixie dom/dow OR-matching, and an
  // impossible expression resolving to null instead of a far-future date.
  'tests/dream-cron.spec.ts',
  // The rules: lease before work, no effects after a failure, the clock moving
  // in the same transaction as the run row, and failure backoff.
  'tests/dream-scheduler.spec.ts',
  // Phase 2: re-ranking importance. The assertions that matter are the failure
  // paths (a failed call or bad manifest writes NOTHING) and the staleness
  // window (a freshly scored row is skipped).
  'tests/dream-classify.spec.ts',
  // Phase 3: file-backed verification. The evidence module is where the
  // no-guessing rule lives (an ambiguous filename stays ambiguous, a URL is not
  // a path), and `dream-verify` is where the pool rule lives (unverified AND
  // cites a file — nothing else is this task's business).
  'tests/memory-evidence.spec.ts',
  'tests/dream-verify.spec.ts',
  // Phase 4: consolidation. The gate's four refusals are pure functions with a
  // test each, and the dry-run assertions check that the DEFAULT mode writes
  // nothing at all.
  'tests/curate-safety.spec.ts',
  'tests/dream-curate.spec.ts',
  // Phase 5: the retrospective. The friction ranking is a judgement (severity
  // breaks a total-cost tie), and "a quiet window costs nothing" is the rule that
  // keeps a nightly job from becoming noise.
  'tests/dream-retrospective.spec.ts',
  // The tunables: volatile unwrapping (a wrapper read as a value silently takes
  // the default), bounds, and the per-run resolution that makes a settings edit
  // apply without a restart.
  'tests/dream-config.spec.ts',
  // TTL expiry, moved into `curate` to match upstream's placement ("Curate owns
  // the TTL lifecycle transition"). The old maintenance tests asserted the sweep
  // did it; they now assert it does NOT, because two writers racing the same
  // rows is the bug the move fixed.
  'tests/expire-memories.spec.ts',
  // Smart notes as their own scheduled task, where upstream keeps them (they
  // used to be the last step of the maintenance sweep).
  'tests/dream-smart-notes.spec.ts',
  // User-memory review as a task (was the middle of the maintenance sweep).
  'tests/dream-review-user-memories.spec.ts',
  // The three lanes moved off the fixed-interval sweep: auto-staging, vector
  // backfill (which now carries the RSS series), and the commit index.
  'tests/dream-housekeeping.spec.ts',
  // Every canonical task has a capability, a schedule, and a handler. A task
  // name without a handler is silently never executed.
  'tests/dream-registry-complete.spec.ts',
]

export const PHASES = [
  {
    id: '0',
    title: '0 基线回归（接管前已发布的行为）',
    specs: PHASE_BASE,
    checks: [],
    blind: ['不含接管新增的域/画像/命令车道——那四条见 A–D'],
  },
  {
    id: 'a',
    title: 'A 地基（自有语料 / schema v9 / 域激活）',
    specs: PHASE_A,
    /** Extra commands that must pass for the gate, run after the specs. */
    checks: [],
    blind: [
      'WP4 共享属性维护已在合成库验证；实测库上的共享行更新已执行（org 域行发布后共享属性保持；machine 域一次误归域已归档并迁至 org）',
      'A-7 双源对照随契约源退役（2026-10-13 corpus 切换）：域激活唯一来源=adapter 表，'
      + '契约源与回滚杠杆一并删除——现世界无"切换动作"可演练',
    ],
  },
  {
    id: 'b',
    title: 'B user 域（画像）',
    specs: PHASE_B,
    checks: [],
    blind: [
      'WP5/WP7 已实现并有用例；开关线上实况（2026-10-13）：collect=on、review=on（13:15 重启生效）；'
      + '渲染半边已活（profile-recall 每步注入 14 行）——真机端到端（真实会话产出候选 → 评审 → 注入）**已跑通**：'
      + '2026-10-14 21:32 采集 5 条观察 → 21:34 评审晋升 4 行（ids 18–21）、meta profile_last_review_at 写入，'
      + '22:00 起 m[1] <new-user-profile> 收到 4 new（watermark 17 → currentMaxId 21）',
      'B-8 端到端（合成会话全链路可 journal 回溯）仍缺',
    ],
  },
  {
    id: 'c',
    title: 'C org / machine 域',
    specs: PHASE_C,
    checks: [],
    blind: [
      '三个域都有实现与用例；实测库上 org / machine 域均有成员且 machine 已 enabled+autoStage（成员随项目导入自动增长），user 写侧 collect=on、review=on',
      '复现检测在真实语料上是空门（1941 行 / 39 项目 / 0 共享 hash，剔除域行副本口径；2026-10-16 实测）——见 global-domain-source-finding',
      '实测库已发布域行（含归档后按批准复活的形状）：跨项目真实注入已发生——域命中 14d 持续增长（计数随每拍增长，已去数字化）',
      'C-7 产品判据埋点已落地（scripts/report-hits.mjs + mc-report「域命中(14d)」行 + tests/report-hits.spec.ts）；'
      + '剩余盲区=观察期未满：org 域 2026-10-10 启用、14 天窗到 2026-10-24，期间域命中=0 属"未起算"，'
      + 'WP9 判据（<2 读取项目 ⇒ 停止投入）到 10-24 才能出结论',
    ],
  },
  {
    id: 'd',
    title: 'D 运维面（命令 / 观测 / 回填）',
    specs: PHASE_D,
    checks: [],
    blind: [
      'D-5 剥离演练随 2026-10-13 corpus 切换退役（前提"保护共享库"消失；现世界=corpus 自包含，'
      + '卸载即带走/删除 memories.db，无第三方库可损）；白名单=两条闭环都走完 5 步：'
      + 'org 域（建域→候选→批准→注入→退役）+ user 域（采集→评审→注入→退役）',
      '发布是"复制"而非"镜像"：源行改写不传播到域行——该对账语义随 domain-source-parity.spec '
      + '（契约源对照）一并退役后，由 memory-gate-fence.spec 的"改写/归档源行不传播"用例继续钉住；'
      + '域行更新只能走产品路径（新候选→发布→归档旧行），没有镜像修复',
      '写开关线上实况（2026-10-13）：user.collect=on、review=on（13:15 生效）、vectorBackfill=on（已收口）、'
      + 'machine.enabled+autoStage=on——画像评审首轮已于 2026-10-14 21:34 跑通（晋升 4），'
      + '演练与线上的差距只剩"域命中观察窗未满"；'
      + '2026-10-12 起 vectorBackfill 缺省=true（分发默认可用，显式 false 才关），'
      + 'profile 需逐键重复的"必须为 true"清单收缩为 scoring/collect',
      'WP11 向量回填已真写并收口（2026-10-10 09:52 开启 → 15:19 dominant 100%）；'
      + '残余特性：缺口随新晋升行回升、靠 30 分钟维护拍清理，机器空闲时段不补跑',
      'doctor / mc-acceptance 的域判定已有 hermetic 正负样本（tests/domain-checks.spec.ts），'
      + '实测库采样已积累（候选批准 / 拒绝 / 待定均有）：阈值与采样量的长期漂移仍只能靠趋势，不能靠这两条判据',
      'profile 依赖卫生判据（tests/profile-checks.spec.ts，2026-10-11 启动失败后加）是静态检查：'
      + '只看 profile 根 node_modules/@deepseek-ai/（Node 真能解析到的位置），看不到 .pnpm 内部未提升的副本；'
      + '宿主包清单读不到时（app.asar 不可达）dependencies 一项降级为 WARN，不冒充绿灯',
    ],
  },
  {
    id: 'e',
    title: 'E 后台任务（Dreamer 调度骨架）',
    specs: PHASE_E,
    checks: [],
    blind: [
      '全部十个任务都有 handler（dream-handlers.ts）：promote-primers / classify-memories / '
      + 'verify(316) / curate(383) / retrospective(490) / auto-stage(632) / index-commits(715) / '
      + 'evaluate-smart-notes / review-user-memories / backfill-vectors。'
      + '本阶段只验证调度骨架（时钟、lease、预算、失败隔离），不验证各 handler 的判定质量——'
      + '那属于各自模块的 spec，2026-11-17 已实测 verify 在真机跑通（158s / 36,902 tokens）',
      'classify 会写 scope / shareable（CLASSIFY_SHARING），双向：私有→共享、共享→私有都能发生，'
      + '与上游 setMemoryClassification 一致（上游没有 AND shareable = 0 那道单向守卫，那是本地自加的，'
      + '2026-11-17 按「跟随上游、不要人工审批」的既定方针删掉）；'
      + '唯一的否决权在 shareable-guard：blocked 强制回写为私有，对应上游 classify.ts:762-766 的 '
      + 'hasShareabilitySensitiveText 守卫。早期文档写「有意完全不写、共享归人工闸门」，'
      + '2026-11-17 代码分析（P1-9）指出与实现相反，现按上游行为定稿',
      'cron 只在本地墙钟时区验证；跨时区（同一 db 被不同 TZ 的进程打开）未测，'
      + '结论是 next_due_at 是绝对 epoch，跨时区不会重复触发但触发时刻跟随写入方',
      'lease 的跨进程互斥用同一 db 文件的第二个 openStores 模拟，'
      + '没有真的起第二个 node 进程——PID 存活性判据（isPidAlive）只在 compartment-lease 用例里覆盖',
      '真机 dwell 未跑：本轮验证止于"5 分钟 tick 在 mount 后启动、dispose 时清理、'
      + '首次打开项目时播种 rows"，没有等一个真实 cron 到点',
      'classify 的 route 跟随主会话最新路由；进程内还没有任何会话跑过时 route 为空 → '
      + '任务记 skipped。真机上首次 boot 到第一次对话之间存在这个窗口',
      '宿主进程被 Electron 独占，无法用 --dump-config 复验 profile 层；'
      + '调度器是否真的在跑要看 journal 的 dream-run / dream-seeded / dream-classify 行',
      'index.ts 的装配没有测试覆盖：所有验收脚本都是直接调函数，绕过了真实的 on(preStep, …) 接线。'
      + '2026-11-17 实测踩过一次——ensureDreamSchedules 传给了 injectReduceGuidance（只做 systemPrompt 注入）'
      + '而不是 preStepListener，结果 dream_schedule 一直是 0 行、journal 零 dream-* 行，而全部单测与五个验收脚本都通过。'
      + '判据只能是重启后查 dream_schedule 行数与 journal，不能靠测试绿灯',
      '2026-11-17 起补了一段廉价自检：dream tick 里做一次性检查，挂载满 2 分钟后若 dream_schedule 仍为 0 行，'
      + '就往 journal 与宿主日志各写一条 warn，并点名「通常是 apply() 的接线错误」。'
      + '它覆盖的只是「播种完全没发生」这一类；播种到了错误身份、或事件接反但仍然写库，它看不出来。'
      + '完整的装配 smoke test（fake Context 调 apply()，断言事件名集合、五个工具、命令注册、dispose 顺序）仍未做——'
      + '按 2026-11-17 的实际数据判断优先级：全时段 354 次挂载只出过 1 次装配事故，先把静默变成可见，再谈覆盖',
    ],
  },
]

/** Every spec path the map refers to. */
export function mappedSpecs() {
  return [...new Set(PHASES.flatMap(phase => phase.specs))]
}

export function phaseById(id) {
  return PHASES.find(phase => phase.id === id)
}
