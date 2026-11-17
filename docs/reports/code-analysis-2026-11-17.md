# dsh-plugin-magic-context 代码分析报告

- 分析对象：`C:\data\code\dsh-plugin-magic-context`，v0.11.1，分支 `local/custom`（HEAD `80abb4e`）
- 分析时间：2026-11-17
- 方法：全量读码（src 88 个文件 / 36.8k 行）+ 静态度量 + 跑门禁（typecheck、vitest）+ 读本机线上库（`~/.local/share/cortexkit/magic-context-dsh-poc`）与 journal 实证
- 结论口径：`P0` = 会造成静默错误、长期停摆或无界增长；`P1` = 正确性/一致性缺陷；`P2` = 整洁度与文档漂移。带「实测」的数据来自本机真实运行，不是推算。

---

## 0. 一页结论

这是一份**工程纪律明显高于平均线**的适配器代码：每个非显然的决定都写了「为什么」和实测日期（注释里上百条 2026-xx-xx 的现场记录），契约文档（PARITY.md / NOTICE / docs 25 篇）与测试门禁（118 spec / 1424 用例 / 相位映射全覆盖）都在，写作风格统一，失败方向几乎都是 fail-closed 而不是 fail-silent。

真正的风险不在「算法写错了」，而在**三处结构性问题**：

1. **装配层 `src/index.ts`（1609 行、20 多个接缝/工具/命令的接线）零测试**。仓库自己在 `scripts/phase-map.mjs:361-364` 记了 2026-11-17 的事故：`ensureDreamSchedules` 传给了错误的接线函数，`dream_schedule` 一直 0 行、journal 零 `dream-*`，而全部单测 + 五个验收脚本全绿。这是当前最大的单点风险，且已有前科。**（2026-11-17 已补一段自检：挂载 2 分钟后仍无排程即 warn，见 §7.1；完整 smoke spec 按数据判缓。）**
2. **后台调度（dream）的边界处理不完整**：一个没有 deadline 的 LLM 车道能锁死整个调度器；租约只发不续（可被合法夺取后双写）；`dream_runs` 无裁剪、journal 只在挂载时裁剪（**后者已改为每日任务 `prune-journal`，见 §7.2**）；两条模型车道谎报 `tokensUsed: 0`，使预算闸形同虚设。
3. **记忆的可见性边界靠「身份字符串」承担**：写路径只校验 identity 非空（`memory-write.ts:1266`），`dir:` / `git:` 前缀原样放行（`tool-bridge.ts:706-712`），因此 `dir:global:org` 可以被直接写入，绕过发布闸门与域 cap；classify 夜间调用会写 `shareable/scope`（`memory-write.ts:1881-1894`）——这一点本身是对的（上游同形），错的是文档；而「共享归人工闸门」这个说法已按既定方针作废，共享改为双向且自动（§7.3）。

代码本身是健康的：`tsc --noEmit` 零错误（`strict` + `noUncheckedIndexedAccess`），`vitest run` 118/118 文件、1424/1424 用例通过（墙钟 14s）。线上库 schema v14、语料 v95，运行正常，最近一次 `verify` 在 14:32（本地）成功。

---

## 1. 规模与构成

| 项 | 数值 |
|---|---|
| 源码 | `src/core` 20,226 + `src/dsh` 12,369 + `src/index.ts` 1,609 + `src/client` 2,623 = **36,827 行** |
| 测试 | `tests/` **30,735 行 / 118 spec / 1,408 用例**（测试:源码 ≈ 0.83） |
| 文档 | 25 篇（`PARITY.md` 16.7k 字节的逐条对齐契约 + `docs/reports/*`） |
| 脚本 | 34 个（门禁、验收、审计、迁移、打包） |
| 依赖 | 运行期仅 `@huggingface/tokenizers` + `onnxruntime-common`；宿主包全在 `peerDependencies`（`@deepseek-ai/*` 钉 0.2.1-rc.1） |
| 历史 | 249 commits，2026-10-07 起（约 6 周） |
| 数据库 | `node:sqlite`（`DatabaseSync`，Electron 下无 ABI 问题），双库：适配器库 v14 + 自有语料库 v95 |

分层很清楚，且是「可移植核心 + 宿主适配」的标准切法：

```
src/index.ts        组装根：探针 → 开库 → 各条车道接线 → 接缝占位 → 遥测/看板 → dispose
src/dsh/*           宿主接缝层：所有对 DSH 的接触（事件、surface、compaction、webServer、settings）
src/core/*          中立逻辑：策略、存储、记忆、调度——不含 DSH 类型
src/client/index.js Web 面板：React（无 JSX、无构建步骤，宿主静态模块表提供 react）
```

`cordis.patch.yml` 把它自己声明成 bundle（保守装机：`registerCompactionEngine: false`，不抢宿主的压缩位），并为 `ctx_search` 打开 `session-query-sqlite` 的 `first-search` 索引——这个 patch 的注释把「为什么配置是 REPLACE 语义、为什么路径必须是持久文件」都写清了。

---

## 2. 三层机制解读

### 2.1 上下文回收（这条是产品的主线）

```
工具结果落地 → tools/post-execute 打 §N§ 标签（index.ts:653-664，seams.ts:79-89）
            → 标签号由 tag_counters 单调发放（stores.ts:1166-1183）
agent 标记     → ctx_reduce 只入队 pending_drops（tool-bridge.ts:217）
execute band  → 只有压力 ≥ 阈值 / 空闲超 ttlMs / wire 有缺陷时才落地（policy.ts:190-208）
              → 落地即 surface replace 成 [dropped §N§]，原文保留在事件日志（seams.ts:175-198）
取回          → ctx_expand：tag 通道（沿 sourceEventSeqs）或 stored history 通道（seq 范围）
压缩          → historian 把最老一段 eligible span 摘要成四层 compartment（核心是 out-of-band）
发布          → 下一次 execute band 用 [compacted §C<n>§] 替换整段，并仅在此刷新 m[0] baseline
溢出兜底      → agent/request-error 上 Tier0 发布 ready compartment → Tier0.5 等 digest → 丢弃车道
```

设计上有三个值得点名的判断：

- **落地 = 一次计价的缓存失效**，所以 `ctx_reduce` 绝不立即改 surface，而是排队等 execute band。这条纪律写在 `policy.ts` 文件头，也写在 reduce 工具描述里。
- **渲染必须无时钟**：`refreshBaseline` 在 SOFT 路径取 `previous.frozenAt`，只有 HARD 才推进；`baselineBlockOf(text) === block` 的「字节相同就不动」保护靠这一点成立。CHANGELOG 记录了这个 bug 的实际代价（1726 步里 35 条软刷新、8 连发空转 execute 各烧 27–30 万 token）。
- **溢出路径的次序**：先发布能发布的 compartment（一次替换收回一整段），再丢单个工具结果，且「丢光也装不下」时整体拒丢（`emergency.ts:146-159`，#731）。

### 2.2 记忆（自有语料库）

写：`ctx_memory write` → 校验类别（v2 五类）→ `BEGIN IMMEDIATE` → 按 `(project_path, category, normalized_hash)` 去重，命中只 `seen_count+1`。
读：FTS5(bm25) + 本地 WASM embedding 双路，`hybrid = 0.7·cos + 0.3·(1/(rank+1))`，单路命中乘 0.8 惩罚（`memory-search.ts:33-36`）；注入侧再按 `scoreMemory`（重要度 × 复现次数 × 时间衰减）排序装预算（`memory-scoring.ts:81`、`memory-bridge.ts:1085-1112`）。
治理：`classify`（重排 importance）/ `verify`（读文件证据裁定是否仍成立）/ `curate`（合并同类，默认 dry-run）/ `expire`（TTL）/ `auto-stage`（跨项目复现 → machine 域候选）/ `review-user-memories`（画像候选）。

域模型是**受众轴**而不是主题轴：`user / org / machine`，可见性 = 域成员 ∩ 类别白名单 ∩ `shareable=1` ∩ scope，无身份时谓词直接 fail-closed 成 `AND 0=1`（`memory-search.ts:205`）。

### 2.3 后台调度（dream）

单一调度器：`setInterval(5min)` → `runDueDreamTasks` 按 `next_due_at` 串行跑十一个任务；跨进程靠 `dream_lease`（key = `dream:memory:<project>`，原子 upsert + 死 PID 围栏回收）；每次 run 的「写 run 行 + 推进 next_due_at」在**同一事务**（`stores.ts:2094-2133`）——这是避免重复执行的关键。

cron 是自研 5 字段求值器，按本地墙钟、Vixie 的 DOM/DOW 取或规则、DST 重复分钟去重（`cron.ts:183-287`）。失败按指数退避（5min→6h）、`skipped` 重置失败计数、环境性跳过 5 分钟短重试（`dream-handlers.ts:25`、`dream-runner.ts:181-184`）。

---

## 3. 运行时实证（本机）

门禁：`npx tsc --noEmit -p tsconfig.json` → exit 0；`npx vitest run` → **118 files / 1424 tests passed**。

线上库（2026-11-17 15:08 快照，13 MB）：

| 表 | 行数 | 备注 |
|---|---|---|
| `usage_records` | 13,815 | 单会话最多 5,285；全库无 DELETE |
| `journal` | 17,408 | `context-pressure` 5,732 行、`pass` 2,085、`search-hint` 2,588；约 4 MB `data` |
| `tags` | 13,808 | 单会话 5,090 |
| `pending_drops` | 1,508 | 1,500 已落地 / 8 排队（哨兵设计有效） |
| `compartments` | 77 | 10 个会话；最大会话 35 个，累计覆盖 227 万 token |
| `dream_schedule` / `dream_runs` | 20 / 49 | 10 任务 × 2 项目；run 无裁剪 |
| `memories` / `memory_embeddings` / `memory_chunks` | 945 / 943 / 221 | chunk 仅由手动脚本回填 |

journal 里读到的真实故障轨迹（这条最能说明这套代码的诚实程度——诊断信息足以定位根因）：

- `verify` 在 12:29–13:52（本地）连续 7 次 `failed`，明细是 `stream produced no text deltas`（tokensUsed 24,188）与 `deadline no terminal event within 120000ms`（tokensUsed 0）——即输出上限 8192 被推理耗尽。
- 提交 `80abb4e`（13:55 重建 `lib/`，14:09 提交）把上限提到 16,384、墙钟提到 300 s；14:03 / 14:32 的 `verify` 转为 `ok`（`tokensUsed` 36,902 / 17,276）。**修复在线上被验证了**，不是纸面修复。
- 另有一条 11-16 的 `management pass failed: surface replace: start seq 4168 not found in surface`——一次性，但同类竞态值得加防御性判定。

---

## 4. 缺陷清单

### P0（静默错误 / 长期停摆 / 无界增长）

| # | 位置 | 机制与影响 | 建议 |
|---|---|---|---|
| 1 | `src/index.ts` 全文；`scripts/phase-map.mjs:361-364` | 装配层零覆盖。所有验收脚本直接调函数，绕过 `on(preStep, …)` 真实接线；仓库自己记了「接错函数而全绿」的事故。任何一次 `apply()` 里的顺序/参数错误都不会被测试发现。 | 加一个 smoke spec：fake `Context` 调 `apply()`，断言 `on()` 的事件名集合、五个工具注册、`/ctx-*` 命令注册、`dream_schedule` 播种、dispose 清理顺序。这是投入产出最高的一项。**状态（2026-11-17）：部分处理**——先做了自检，完整的 `apply()` smoke spec 按实测数据判缓，理由见 §7.1。 |
| 2 | `src/dsh/dream-handlers.ts:632-664`（`autoStageGlobalCandidates`，`src/core/global-autostage.ts:120+` 无 `withDeadline`） | 原本是十一个任务里唯一没有 LLM 墙钟的车道（已修，见 §7 前言）。一次永不 settle 的流会让 `index.ts:523-528` 的 `dreamTickInFlight` 永久为 `true`，本进程**之后所有后台任务永不启动**，且无日志（只有「tick 再也不进来」）。 | 与 verify/classify/curate 一致地包 `withDeadline`（60–120 s），并把 `dreamTickInFlight` 加一个最大持有时长兜底。 |
| 3 | `src/core/dream-lease.ts:27,49`（`renew` 全库零调用） | 租约 TTL 15 分钟且**从不续期**。verify 的墙钟上限是 300 s，但 `buildFileIndex` 的全树遍历不受该预算约束（实测本机 `C:/data/code` 触发 20,001 文件上限）；超 15 分钟后另一进程可合法夺租，两边同时改写同一批记忆行（`dream-lease.ts:12-16` 自己描述过这个事故）。 | runner 在 run 期间每 TTL/3 调一次 `lease.renew`；或按任务声明 TTL（curate/verify 延长）。 |
| 4 | `src/dsh/maintenance-wiring.ts:139-143` + `src/core/stores.ts:2379` | `tail(200)` 返回**新→旧**，循环却从 `rows.length-1` 递减，于是返回窗口内**最旧**的 `dream-run`。面板「上次维护」系统性偏旧、看起来像停了。 | 循环正序，或直接 `find` 第一条 `dream-run`。一行。 |
| 5 | `src/core/verify-memories.ts:279-285`；`src/dsh/dream-handlers.ts:621,657` | 记账失真：verify 的超时/异常分支返回 `tokensUsed: 0`（provider 已烧掉上万 token）；`review-user-memories` 与 `auto-stage` 无论调没调模型都写 `tokensUsed: 0`。而 `dream-runner.ts:319-324` 的预算是**事后按 tokensUsed 判**的 → 55k/60k 等预算对这两条最贵的车道完全失效，成本曲线也读不出来。 | 从各 `outcome` 透传真实 token；超时分支至少回填已知的 usage 快照。 |
| 6 | `src/core/journal.ts:334-341`、`src/dsh/live-journal.ts:60-79`、`src/dsh/dream-handlers.ts:25` + `dream-runner.ts:181-184` | 增长面无收敛：`dream_runs` 全库无 DELETE；journal 裁剪只在挂载或「retention 值变了」时执行（长驻进程数周不重启就不裁）；环境性跳过每 5 分钟落一条 run 行 + 一条 journal 行（无次数上限，仅失败有退避）。现状 journal 已 17,408 行，`/mc-telemetry` 的 `tail`/`journalBounds` 会随之变贵。 | 把 retention 做成一个 dream 任务；环境性跳过加「连续 N 次后按整周期」；`dream_runs` 保留最近 N 条/90 天。**状态（2026-11-17）：journal 部分已处理**，另两项经上游对照后不做，理由见 §7.2。 |

### P1（正确性 / 一致性）

| # | 位置 | 机制与影响 | 建议 |
|---|---|---|---|
| 7 | `src/index.ts:304-308, 347-355` | `engineFailed` 一旦置真**无复位路径**：unmount 分支要求 `engineHandle !== undefined`，而失败恰恰使它为 `undefined`。宿主 compaction 服务晚到一次，本进程终生装不上引擎，meta 只留 `unavailable:`，读起来像「配置关了」。 | unmount 分支在 `wanted === false` 时无条件 `engineFailed = false`。 |
| 8 | `src/core/curate-memories.ts:484-496` | `skip` 分支在 `dryRun` 判断**之前**调 `writer.recordCurateSkip`，dry run 实际写了状态（跳过哈希），改变后续轮次的候选集。与文件头「dry run writes nothing」相反。 | 把 `recordCurateSkip` 移到 `dryRun` 之后，或 dry run 下只计数。 |
| 9 | `src/core/classify-memories.ts:26-31` vs `src/core/memory-write.ts:1871-1894, 709-713` | 文档与实现正面矛盾：`classify-memories.ts` 文件头写「upstream 会重写 scope/shareable，本适配器**有意不写**，共享决定归人工闸门」（`scripts/phase-map.mjs` 阶段 E blind 也这么记），但 `writer.classifyMemories` 里确实按 `entry.shareable` / `entry.blocked` 更新 `shareable/scope`，且 `blocked` 分支写明「保留上一轮分数会让人误读」，说明这是后来有意实现。结果是**文档错**（或实现回退），并且可见性可被夜间模型调用单向扩大——`CLASSIFY_SHARING` 的 `AND shareable = 0` 又使已共享行无法被撤回（该守卫本身在 `memory-write.ts:703-712` 里被声明为有意）。 | 二选一：删掉 classify 的共享写入，或更新两处文档并为扩权补审计行与撤回通道。**状态（2026-11-17）：按「跟随上游、不要人工审批」处理完毕**——删掉单向守卫使共享双向可撤，auto-stage 改走 `approvalGate` 自动发布，卡片降为兜底，见 §7.3。 |
| 10 | `src/dsh/tool-bridge.ts:706-712` + `src/core/memory-write.ts:1266-1268` | 身份即信任边界：`dir:` / `git:` 前缀原样接受，写路径只校验「非空」。`ctx_memory write project="dir:global:org"` 可直接落到全局域，绕过 `publishDomainMemory` 的分享评估、审批卡与域 cap。 | 写路径校验身份形状（`dir:<12hex>`），全局域只允许走 publish 通道。 |
| 11 | `src/index.ts:653-664` | `tools/post-execute` 的标签分配无 `try/catch`、无 `adapterDisposed` 守卫，而 `allocateTag` 是真实写事务；HMR 重挂载后异常会直抛宿主瀑布。同仓 `compaction-engine.ts:160-163` 已有 `usable()` 的范式可抄。 | 包一层 fail-open：失败就原样返回 `decision`。 |
| 12 | `src/index.ts:213-221` | §N§ 标签注册表按**全库 30 天**剪枝，而会话按设计可活数月。剪掉的编号会让旧占位符的 `tagNumber` 变 `undefined`：`ctx_reduce` 回 "no such tool-output tag"，emergency 的 `tagged` 过滤把它排除，但 `§N§` 仍在线上。 | 剪枝按「会话最后活跃时间 + 大于会话跨度」或与 tag 引用计数联动。 |
| 13 | `src/dsh/volatile.ts:56-63` | `liveBoolean` 只解一层 `.get()`，而 `liveValue` 递归解（注释自承双层是实测事实）。双层时静默落默认值，boot 行显示的是回落值，无从发现。 | `liveBoolean` 改用 `liveValue`。 |
| 14 | `src/core/stores.ts:1124-1132` vs `src/core/memory-write.ts:964-968` | 适配器库从不 `PRAGMA foreign_keys = ON`，于是 `stores.ts:881/905` 的 `ON DELETE CASCADE` 是装饰；`tests/store-schema-v8.spec.ts:189-207` 不得不自开 raw 连接手动开 pragma 才能跑级联用例。目前没有删域 API，属潜伏雷。 | 打开 pragma（注意顺序：busy_timeout → foreign_keys → journal_mode）。 |
| 15 | `src/core/chunk-store.ts` / `memory-chunk.ts`（产品路径零调用，仅 `scripts/backfill-chunks.mjs`） | chunk 轨「建好了但没接线」：线上 221 行是手动脚本产物；`updateMemory` 只删 `memory_embeddings`，从不失效 chunk 表 → 一旦接线即命中陈旧文本。 | 要么接进检索与写入失效链，要么删表删码，别留半成品。 |
| 16 | `src/core/memory-search.ts:360-367`、`:1012-1033`；`src/core/global-domains.ts:172-183` | 规模瓶颈：语义通道把池内全部向量读进内存逐条 cosine（无 LIMIT）；`recall` 每个 identity/peer 一条语句（N+1）；`readCorpusMemory` 每次调用新开 `DatabaseSync`，而 auto-stage 在循环里逐行调。 | 语义通道加 `LIMIT`/候选预筛；`readCorpusMemory` 复用连接；`recall` 合并成一条 IN 查询。 |
| 17 | `src/core/stores.ts:1280-1281`（`workMetrics` 全量重算） | 实测单会话 5,285 条 usage；`/ctx-status` 每次触发都全量读并聚合，而 `work-metrics.ts:59-84` 已设计好 `lastSeq` 增量水位却没接。 | 接上增量水位，或按月分片。 |
| 18 | `src/dsh/dashboard.ts:588-591, 307, 28-34` | 只读看板用 `innerHTML` + 逐点 `esc()`（15 处），CSP 允许 `script-src 'unsafe-inline'`，路由无鉴权（无 cookie 门）。本次未发现漏转义点，但「靠人工纪律 + 允许内联脚本」的组合，新增一个字段忘了 `esc` 就是站内执行。 | 改 `textContent`/DOM 构造，或去掉 `unsafe-inline`。 |
| 19 | `src/core/stores.ts:1151-1164` | 迁移只前向、链非原子、失败即 `close()`+throw，恢复手段写在错误文案里；无自动备份（线上目录里那份 `.bak-v13-20261117-072027` 是人工留的）。 | 迁移前自动 `VACUUM INTO` 一份备份，保留最近两份。 |
| 20 | `verify-memories.ts:500-502` → `memory-write.ts`（删向量、清 `classified_at`）→ `backfill`/`classify` | 三条维护通道互相喂活：verify 的 `stale` 重写会删向量并清分类时间，于是该行重新进入 backfill 与 classify 窗口，再次可能被改写。维护队列长期不收敛，成本放大。 | `stale` 重写后保留向量失效标记但不清 `classified_at`，或让 verify 直接重算向量。 |

### P2（整洁度 / 文档漂移）

| # | 位置 | 说明 |
|---|---|---|
| 21 | `src/core/memory-search.ts.bak-*`（2 份）、`src/dsh/tool-bridge.ts.bak-*`（2 份）、`src/dsh/memory-lane.ts.bak-*` | 共 5 份、约 175 KB 的本地回滚件，已被 `.gitignore` 的 `*.bak-*` 覆盖、不参与编译（`include: src/**/*.ts` 不匹配），但留在源码树里会误导读者，且其中一份（`bak-desc`）已明显分叉。建议删除。 |
| 22 | `scripts/phase-map.mjs` 阶段 E blind | 文档漂移：blind 写着「verify / curate / retrospective 有名字无 handler，跑起来记 skipped」，实际 `dream-handlers.ts:316/383/490` 三个 handler 都在、线上也在跑。blind 列表是被人读的，漂移会误导判断。 |
| 23 | `stores.ts` 2,539 行、`memory-write.ts` 2,024 行、`tool-bridge.ts` 1,529 行、`memory-bridge.ts` 1,161 行 | 单文件巨型模块：一个 `openMemoryWriter` 闭包内 30+ 预编译语句、10 个方法共用一条连接；`stores.ts` 同时装 14 张表 DDL、14 条迁移和 60+ 读写方法。 |
| 24 | `stores.ts` 每次调用现场 `prepare`；`memory-bridge.ts:510-531` 则一次性预编译复用 | 同仓两种相反策略；管理轮次一次几十到上百次 prepare。 |
| 25 | `src/client/index.js:216-350`（英文字段 label）、`dashboard.ts`（中文硬编码）、i18n 检查脚本不在 gate 里 | 三套语言策略并存；`mc-i18n-check.mjs` 存在但无人跑。 |
| 26 | `tsconfig.build.json` 的 `noCheck: true`；源码 86 处 `as unknown as`、113 处空 `catch {}` | 类型错误不挡打包（靠 `gate` 的 `tsc --noEmit` 挡）；`as unknown as` 是接缝层的必要之恶，但 86 处也意味着宿主类型漂移只能靠运行时发现。 |
| 27 | 仓库根 `CON`（未跟踪，内容是 `Username for 'https://github.com':`）；Config 的 `policy` 缺 `memoryBudgetTokens`（DEFAULT 8,000 只能改代码） | 前者是命令行重定向事故残留，后者是一个「配置面缺口」。 |

---

## 5. 做得好的地方（不是客套，是这堆代码真正的资产）

1. **决定都有账**：`policy.ts` 文件头、`index.ts` 每条接线、`stores.ts` 每条迁移，都写了为什么这样做、什么时候实测、代价是多少。这在大型插件里极罕见，也直接解释了为什么这份代码能在 6 周内长到 37k 行还不散架。
2. **失败方向统一**：探针失败就 throw（不半活）；工具注册失败就 throw；引擎占位失败 warn + `unavailable` meta 但其余车道不受影响；记忆桥 schema 超前就 `unavailable` 降级而不是崩。
3. **缓存经济学被当成一等公民**：execute band 是「计价写入的许可」，渲染无时钟，baseline 字节比较后才写。CHANGELOG 里记的是 token 账单，不是「功能已完成」。
4. **诊断足以自证**：这次没跑任何调试器，只读 journal 就把 `verify` 的 7 次失败定到「8192 输出上限被推理耗尽」，并确认修复已被线上验证。这是可观测性设计的胜利。
5. **状态机边界清楚**：`pending_drops` 用哨兵 `-1` 表示已退队、`landed_event_seq IS NULL` 唯一表示「排队中」；`dream` 的 run 行与时钟推进同事务；`historian_no_progress` 水印防止对同一段反复付费。
6. **契约先于实现**：`PARITY.md` 用 aligned / host-imposed / intentional 三态逐条记录与上游的差异，并明确「不要修这些」。

---

## 6. 建议的修复顺序

1. **装配层 smoke test**（P0-1）——先有安全带，再动其它。
   *2026-11-17：只做了自检，smoke spec 判缓（§7.1）。*
2. **一行级的 P0-4 / P1-7 / P1-13**：`maintenanceLast` 顺序、`engineFailed` 复位、`liveBoolean` 递归。改动极小，收益立竿见影。
   *已全部完成。*
3. **P0-2 与 P0-3**：auto-stage 接 `withDeadline`、租约续期。这两条决定后台体系在坏网络/长仓库下是否可靠。
   *已全部完成。*
4. **P0-5 记账真实化**，再顺手把 P0-6 的增长收敛（retention 任务 + skip 上限）。
   *P0-5 已完成；P0-6 只做了 journal 一项（§7.2），skip 上限与 `dream_runs` 裁剪经上游对照后不做。*
5. **P1-10 身份形状校验**（安全边界）、**P1-8/P1-9**（dry-run 副作用、classify 越界写共享）。
   *P1-8、P1-10 已完成；P1-9 按「跟随上游、不要人工审批」处理完毕（§7.3）——共享双向、auto-stage 自动发布。*
6. 性能三项（P1-16/17）与 chunk 轨的去留（P1-15），放在功能稳定之后。

---

## 7. 处理记录（2026-11-17）

本轮修了 P0-2 / P0-3 / P0-4 / P0-5、P1-7 / P1-8 / P1-10 / P1-11，加上本节详述的 P0-1 与 P0-6。
两处**没有按报告建议的原样执行**，依据都是实测数据，记录在此以免下次重新论证。

### 7.1 P0-1 装配层：只做自检，不做全量 smoke test

**先给数据。**

| 指标 | 实测值 | 取法 |
|---|---|---|
| 全时段挂载次数 | 354 | `SELECT COUNT(*) FROM journal WHERE kind='boot'` |
| 装配层产生的 warn/error | **0** | `kind='engine'` 81 条，全部 `info` |
| 已知装配事故 | **1** | 2026-11-17，`ensureDreamSchedules` 传给 `injectReduceGuidance` |
| `src/index.ts` 规模 | 1,609 行 / 20+ 处接线 / 测试覆盖 0 | — |

354 次挂载出 1 次错。这个频率不足以支撑「fake Context 调 `apply()`，断言事件名集合 + 五个工具 + 命令注册 + dispose 顺序」这套工程
——那是一个需要持续维护的宿主仿真层，宿主每次改 Context 形状它都要跟着改。

但那次事故的**失效形态**必须处理：它不抛错、不 warn、`dream_schedule` 静默保持 0 行，
而 118 个测试文件、1,415 条用例、五个验收脚本全部通过——因为验收脚本直接调函数，绕过了 `on(preStep, …)`。

**做了的（`src/index.ts`，约 40 行）**：`dreamTick` 里加一次性自检。

```
挂载满 2 分钟 → 查 dream_schedule 行数 → 仍为 0 → journal.warn('dream-seeded') + ctx.logger.warn
```

选 2 分钟是因为播种发生在「本次进程第一次 pre-step」，新挂载的进程合法地空一段时间；
选 `dreamTick` 而不是新开 `setTimeout` 是因为 tick 本来就在跑，加一个定时器正是当年删掉维护扫描的原因。
文案直接点名「通常是 apply() 的接线错误，检查 ensureDreamSchedules 是否到达 pre-step listener」。

**没做的**：完整 smoke spec。留给「装配改动变频繁」或「再出一次同类事故」时。

**这个自检覆盖不到什么**（写进 `scripts/phase-map.mjs` 的 blind 了）：
播种到了错误身份、事件接反但仍然写库——它只看得到「一张表彻底空着」。

### 7.2 P0-6 增长收敛：只做 journal 那一条

报告建议三项：journal 裁剪任务化、环境性跳过加次数上限、`dream_runs` 保留 N 条。
**只有第一项有数据支撑，另两项查了上游后放弃。**

#### 上游对照（`C:\data\code\mc-upstream` @ a1ca346 v0.49.41）

| 报告建议 | 上游有没有 | 证据 |
|---|---|---|
| `dream_runs` 保留 N 条 | **没有** | `storage-db.ts:1533` 只有 `CREATE TABLE`，全仓 `DELETE FROM dream_runs` 零命中 |
| journal 裁剪 | **无对应物** | 上游没有 `journal` 表；日志走 `shared/logger.ts` 的 pino 式写盘，策略是单文件截断到 `MAX_LOG_FILE_BYTES = 32 * 1024 * 1024` |
| 跳过次数上限 | **无对应机制** | 上游 `dream_runs` 是**一次 run 一行**（`tasks_json` 汇总），不写 per-task skip 行 |

所以这三项都不能「跟进上游」——第一、二项上游也没做，第三项上游根本没有这个形状。
本地的 `dream_runs` 是 per-task 一行，与上游结构不同，增长速度也不同。

#### 实测增长

```
db 13.2 MB
├─ journal 相关   6.2 MB  (47%)   journal 4.46 MB + 索引 1.75 MB
├─ usage_records  1.57 MB
├─ tags + idx     3.03 MB
└─ compartments   0.64 MB
```

| 项 | 实测 | 一年推算 | 判断 |
|---|---|---|---|
| journal | 17,507 行 / 10 天（1,200–3,000 行/天） | ≈ 640k 行 / 160 MB | 真问题 |
| `dream_runs` | 57 行 / 半天 | ≈ 41k 行 | 小，不紧迫 |
| 环境性跳过 | **0 次发生**（今日 57 次 run 中 `status='skipped'` 为 0） | — | 纯理论风险 |

「环境性跳过 0 次」是因为路由一直在（有会话在跑）。它只在「进程启动后尚无会话」的窗口里触发，
而这个窗口在正常使用下很短。为它加上限是在修一个没发生过的问题。

#### 做了的：`prune-journal` 成为第十一个 dream 任务

`src/core/dream-registry.ts` + `src/dsh/dream-handlers.ts:buildPruneJournalHandler` + `src/index.ts` 接线。

- cron `7 5 * * *`：排在整夜批次之后。放在午夜会删掉当晚任务正要写的行。
- `host-only` / `tokenBudget: 0` / `mutatesMemories: false`：一次 DELETE，不调模型，不碰记忆语料。
- retention 下限 1 天，与 `live-journal.ts` 对人工配置施加的地板一致——一个手滑的 0 不能清空整表。
- DELETE 抛错 → `failed`（走退避），不重试得更勤：行明天还在，失败多半是 SQLite 争用，调度器解决不了。

**线上验证**：

```
播种  dir:af36666a8eb6 | 7 5 * * * | 11 个任务（原 10）
执行  #60  08:28:11  ok  changed=0  |  nothing past 30d retention
```

`changed=0` 是正确的：库里只有 10 天数据，retention 30 天。删不删得到要等库龄超过 30 天，
行为本身由 `tests/dream-housekeeping.spec.ts` 的四条用例钉住（切点计算、1 天下限、DELETE 抛错、seam 缺失）。

#### 没做的两项

`dream_runs` 保留 N 条、跳过次数上限——上游无先例、本地实测无痛感，属于「按推测修」，不做。
真要动，触发条件写清楚：`dream_runs` 超过 5 万行，或 `status='skipped'` 占到 20% 以上。

### 7.3 P1-9 与「人工审批」：按既定方针全部对齐上游

裁决依据是项目一开始的决定——**跟随上游，不要人工审批**。查了上游 `mc-upstream @ a1ca346` 的实际行为后，本地有两处偏离，都已改掉。

#### 偏离一：`CLASSIFY_SHARING` 的单向守卫

上游 `setMemoryClassification`（`storage-memory.ts:1134+`）对 `importance` / `scope` / `shareable` 一律「值变了就写」，没有任何方向限制。所以 classify 的一次重判**可以把已经共享的行改回私有**。

本地这条 SQL 带着 `AND shareable = 0`：

```sql
UPDATE memories SET shareable = ?, scope = ?
 WHERE ... AND shareable = 0        -- 已共享的行被排除
```

结果是一条只能「私有 → 共享」的单行道。它带来两个具体后果：
1. 内容漂移后重判为「不该共享」，旧的共享标记撤不掉；
2. `tests/shareable-wiring.spec.ts` 里有一条用例把这个行为固化成了契约（`does not disturb a row that is already shared`），等于把偏离写成了规范。

**改法**：删掉守卫。安全不依赖它——`shareable-guard.assessShareability`（移植自上游 `shared/redaction.ts` 的 `hasShareabilitySensitiveText`）在 verdict 应用前运行，`blocked` 强制回写私有，对应上游 `classify.ts:762-766` 的守卫。这一层是**自动**的 fail-closed，不是人工闸门，保留。

那条固化旧行为的用例改写成双向断言，并补了一条反向用例（私有 → 共享仍然工作），避免「撤回」被实现成「永远是私有」。

#### 偏离二：auto-stage 停在候选池，等人工点卡片

`global-review.ts` 的注释写着「Publishing stays a human act — the card IS the human act」。上游没有这个东西：它靠 `shareable` + `scope` 表达可见性，classify 决定，无人工步骤。

实测这条链路的用量：

| 指标 | 值 |
|---|---|
| `global-review` journal 记录 | 4 条（3 天内） |
| 结果分布 | **4/4 全部 approved** |
| 已发布的域行 | 4 行（`dir:global:machine` id 590/765/766/767） |

也就是说：卡片从来没有拦下过任何一条，它只让每一次发布都要等我在会话里点一下。

**改法**：`autoStageGlobalCandidates` 接受一个 `writer`，候选入库后立刻走 `approvalGate` + `publishGlobalCandidate`。

`approvalGate` 是机械闸，不是人工闸，它检查：
- 凭据扫描（`scanForCredentials`）
- 域是否启用、category 是否在域的 `shareCategories` 白名单里
- 域 cap

被 gate 拒绝的候选**留在 `pending`**，`review_global` 卡片对它仍然可用——所以卡片从「唯一通路」降级为「拒绝项的兜底出口」。

outcome 增加了 `published` / `refused` 两个字段，handler 的 `itemsChanged` 从「staged 数」改为「published 数」——staged 只是入池，published 才是真的发生了什么。summary 里 `refused` 非零时明确写「refusals stay pending for review_global」。

无 `writer` 时行为完全不变（候选停在 pending），所以 1,421 条既有断言一条没动。

#### 数据

```
tsc      clean
vitest   118 files / 1424 tests   (1421 → 1424)
phase    PASSED
```

新增用例（`tests/global-autostage.spec.ts` 3 条 + `tests/maintenance.spec.ts` 1 条 + `tests/shareable-wiring.spec.ts` 1 条改 2 条）：
- gate 通过 → 直接发布，候选变 `approved`
- gate 拒绝（凭据）→ 留 pending，`refused` 带扫描器名字
- 无 writer → 停在 pending（旧行为不变）
- 已共享行可被撤回
- 私有行仍可被共享

#### 顺带记录：`review_global` 未被拆除

它是备用通路，不是死代码——gate 拒绝的候选要靠它处理。不删的理由写进 `global-review.ts` 的用法里，而不是靠「暂时留着」。

---

---

## 附录：复现命令

```bash
# 类型与测试
npx tsc --noEmit -p tsconfig.json
npx vitest run --reporter=dot

# 相位门禁（含空阶段判 FAIL、blind 清单每次打印）
node scripts/mc-phase.mjs

# 线上库体检（只读）
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.HOME+'/.local/share/cortexkit/magic-context-dsh-poc/dsh-magic-context.db',{readOnly:true});console.log(db.prepare(\"select kind,count(*) n from journal group by kind order by n desc limit 10\").all())"

# 看板 / 遥测（插件在跑时）
curl -s http://127.0.0.1:<port>/mc-dashboard/api/overview | head -c 400
```
