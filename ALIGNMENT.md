# 上游对齐状态（mc-upstream a1ca346 ↔ dsh-plugin-magic-context）

这份表的用途是**可核查**：每一行要么指向本仓库的一个 commit，要么写明为什么不做。
不写"大概一致"。

上游 `packages/plugin/src/hooks/magic-context/` 共 211 个模块、82,729 行（不含测试）。
本地按功能而非文件对应，所以对照表按**行为**组织。

## 已对齐（每项有 commit 与测试）

| 行为 | 上游位置 | 本地 | commit |
|---|---|---|---|
| 触发链顺序（tail_size → meaningfulness → proactive floor → redundancy） | `compartment-trigger.ts` | `management-pass.ts` | 本轮前 |
| trigger 预算与 chunk 预算分离 | `derive-budgets.ts:49,74` | `historian.ts` `historianTriggerBudget`/`historianChunkTokens` | 本轮前 |
| 保护边界按 token 推导（非固定节点数） | `protected-tail-boundary.ts:266` | `core/protected-tail.ts` | e03b5d4 |
| 失败原因结构化分类 | — | `historian-failure.ts` | 本轮前 |
| 连续失败 N 次向用户报 | — | `session-notice.ts` | cd8b18b |
| importance 的 0 分语义 | `compartment-parser.ts:335` | `compartments.ts` | 0d2c7dc |
| tier 衰减曲线（含 budget pressure） | `decay-curve.ts` | `core/decay-curve.ts` | ba46b3a |
| baseline 渲染格式戳 | `inject-compartments.ts:1816` | `management-pass.ts` `BASELINE_RENDER_EPOCH` | 92e0bbc |
| 新近窗口内的小结果不删 | `apply-operations.ts:132` | `drop-landing.ts` | ad75bb8 |
| `/ctx-flush` | `execute-flush.ts:10` | `dsh/flush-command.ts` | 0c4b3d0 |
| `/ctx-dream` 手动触发 | `command-handler.ts:370` | `dsh/dream-command.ts` | 206c3e0 |
| `/ctx-embed` 状态与回填 | `command-handler.ts` isEmbed | `dsh/embed-command.ts` | cff248b |
| 记忆预算：证据优先 + 严格前缀 | `inject-compartments.ts:333-364` | `core/memory-budget.ts` | 13b1739 |
| m[0] 边界用 compartment 序号 | `inject-compartments.ts:972` | `stores.ts` schema v17 | ada4226 |
| m[0] 段序（memory 在 history 之后） | `inject-compartments.ts:2408-2442` | `core/compartments.ts` | aa91a95 |
| baseline 锚点跳过占位符 | `inject-compartments.ts:835` | `management-pass.ts` | 2dc2648 |
| 记忆行带 `#id` + 渲染顺序 id 稳定 | `inject-compartments.ts:2327,1286` | `memory-bridge.ts` | e9a6f5f |
| 记忆按 category 分组、`<project-memory>` | `inject-compartments.ts:2332` | `compartments.ts` | 0ddda08 |
| historian 侧 `<project-memory>`（无 id） | `inject-compartments.ts:301` | `memory-bridge.ts` + `historian.ts` | 56cddb2 |
| 预算按来源保底 | `inject-compartments.ts:2063` | `core/memory-budget.ts` | bc426c8 |

## 平台差异（不移植，附理由）

| 上游机制 | 为什么不做 |
|---|---|
| `lkg-slot.ts` + `lkg-replay.ts`（2,009 行） | 请求快照重放，用于「provider 拒绝后回到上一个好请求」。DSH 的 session 层自带 `repair.ts` 修 tool-pairing，不存在 OpenCode 那种 frozen replay 形态 |
| `rust-mode-*.ts` + `module-*.ts`（约 12,000 行） | Rust 模块桥（`mc-module`）。DSH 没有这个模块，功能由本地 TypeScript 直接实现 |
| `selectHiddenMessagesAtCompactionSeam` | OpenCode 原生压实**裁掉前缀**留下的接缝孤儿。本地压实是**替换**（`[compacted §C<n>§]` 占位节点），后续消息上下文由摘要提供，不存在孤儿 |
| `session_meta` 表的四列 drain 记账 | 本地用 `drain_state` 表（schema v15） |
| TUI 通知 / dashboard 推送 | DSH 有自己的 GUI 与 dashboard 实现 |
| `command-handler` 的 `throwSentinel` | OpenCode 的命令协议；DSH 的 `commands.register` 返回结果对象 |

## 未逐行核对（诚实标注）

这些模块本地**有**对应实现，但我没有逐行比过：

| 上游模块 | 本地 | 备注 |
|---|---|---|
| `transform-postprocess-phase.ts`（5,307） | `management-pass.ts` + `pre-step.ts` | 变换后处理；本地流程不同（DSH 的 surface 模型），逐行无意义，需按行为抽查 |
| `read-session-raw.ts` / `read-session-chunk.ts`（3,967） | `core/session-history.ts` | 会话读取与分块；上游为 Rust 侧准备数据结构 |
| `tail-hygiene-walk.ts`（1,451） | `management-pass.ts` 的 drop 段 | 尾部卫生；本地已对齐其小结果保护部分 |
| `tag-messages.ts`（1,401） | `seams.ts` + `tool-bridge.ts` | 打标；DSH 的 tag 由 `ctx_reduce` 分配，机制不同 |
| `compartment-runner-*.ts`（2,855） | `historian.ts` | 上游拆成 incremental / historian / host-runner 三个文件 |
| `auto-search-worker-client.ts`（976） | `memory-search.ts` + 工具面 | 上游是 worker 进程 |
| `system-prompt-hash.ts`（882） | `core/...` → `pre-step.ts` 的 `observeSystemPrompt` | **已实现**（f79ae2e 判定 + 7a74899 观察点）。曾长期不工作：观察点写在 `systemPrompt.context` 的回调里，而那个回调的参数是 `AssembleContext` 不是 `PromptAssembly`，`renderPrompt` 拿到它就抛错、被空 catch 吞掉。真机 `baseline_state.system_hash` 每行都是 null 才暴露出来 |

## 紧急 fail-closed 全链（已接线）

| 环节 | 上游位置 | 本地 | commit |
|---|---|---|---|
| 判定 | `transform-postprocess-phase.ts:1901` | `core/emergency-fail-closed.ts`（10 条测试） | f726f39 |
| provider 证明的 limit | `providerProvenLimitTokens`（:1915） | `core/provider-limit.ts`（10 条）→ `meta: proven.limit.<p>\|<m>` | 33818a5 |
| arm 状态 | `needsEmergencyRecovery` + `emergencyRecoveryOrigin`（storage-meta-persisted.ts:2138） | `drain_state.overflow_armed_at/origin`（schema v19） | 29d0f74 |
| pre-step 消费 | 同上 | `{ kind: 'reject' }` + 会话内说明 | 2895e72 |
| join 测试 | — | `tests/fail-closed-join.spec.ts`（6 条） | 2895e72 |

**能力边界**：本地没有 trusted 的 wire 测量（chars/4 是估算），所以只走「armed +
provider_overflow + 本轮没折 → 拒绝」这一条。disarm 需要可信测量，代码路径在、暂时
不会触发——这是诚实的能力边界，不是逻辑缺失。

## 教训：同一概念有两份实现，而正在用的那份是错的

这个项目在 2026-11-18 一天之内踩了三次**同一形状**的错误。写下来，因为它们是同一类，
不是三个巧合。

| # | 概念 | 两份实现 | 结果 |
|---|---|---|---|
| 1 | 保护尾巴有多大 | `emergency.ts` 的 `min(64k, max(8k, ctx×5%))` vs `protected-tail.ts` 的完整推导 | 低压力保护不足、高压力不收缩 |
| 2 | 请求有多大 | `surfaceTokens`（只看 text）vs `surfaceWireTokens`（全部 block） | 低估 2.4 倍，紧急回收的「装不装得下」判据反了 |
| 3 | 渲染格式变没变 | `renderEpoch` vs `maxCompartmentId` vs `systemHash` | 第三个从未被写入（参数类型错），分支一直是死的 |

三者的共同点：**正确的那份先写好了，错的那份因为更早存在、更简单、更适合调用点，就被一直用着**。

### 这次怎么发现的

都不是靠读代码，是靠**把本地数字和外部事实对上**：

- 保护窗口：`emergency-drop.spec.ts` 的用例标题写着 `clamp(5% × window, 8k, 64k)`——
  这个字面值和 `protected-tail.ts` 里的公式不一致，标题本身就是证据
- 请求大小：`scripts/wire-pairing-probe.mjs` 把 pass 与 usage 两条时间线并排，一眼看到
  `cache_read=411k` 而估算是 175k
- system hash：`baseline_state.system_hash` 每一行都是 null。**一个本该有值的字段一直是
  null，比任何断言失败都响**

### 可复用的判据

1. **同一个量如果能在两处算出来，先问哪一处被调用**。`scripts/unwired-modules.mjs` 查的是
   文件级；函数级要靠 `grep` 调用点。
2. **字段长期为 null / 为 0 是一个断言**。没人写的字段和没人读的字段一样值得追。
3. **测试用例的标题里如果有具体数字，那个数字就是契约**。公式一变，标题会先露馅。
4. **本地数字必须和外部事实对一次账**（provider 的 usage、DB 的实际行数）。只跟自己比，
   错的那份永远自洽。

## 一个贯穿全局的口径问题（2026-11-18 发现并修复）

`seams.ts:301` 的 `text` 视图按设计排除 tool-call 的 arguments 与 reasoning 块：

    /** Concatenated text blocks (tool-call arguments excluded — they are not text). */
    readonly text: string

`surfaceTokens` 就建在这个视图上。所以它不是「请求要花多少 token」，而是「surface 上有
多少文本」。实测缺口 2.4 倍（估算 175k，账单 415k）——工具调用密集的会话里，被排除的
部分就是大头。

**受影响的是所有拿它当「请求大小」用的决策点**：

| 位置 | 原先 | 现在 |
|---|---|---|
| force band 的 #731 guard（`management-pass.ts`） | `surfaceTokens` | `surfaceWireTokens` |
| overflow 后的紧急回收（`index.ts`） | `surfaceTokens` | `surfaceWireTokens` |
| pass 的精度样本（`pre-step.ts`） | `surfaceTokens` + system | wire + system |
| 回收量统计（journal 的 before/after） | `surfaceTokens` | **保留**——衡量的是文本减少，口径本就对 |

前两处是决策：`reclaimForEmergency` 用估算判断「即使全删也装不下」。乐观 2.4 倍的输入
会让它答「装得下」，于是执行一次根本不够的删除。这正是 #731 guard 要防的事，而它的
输入曾经是错的。

**保留 text 口径的地方**：渲染、tier 选择、保留窗口内的内容判断——它们关心的是文本
本身，不是账单。

## 自创部分已清理（2026-11-18）

审计方法：对 `src/core/*.ts` 与 `src/dsh/*.ts` 逐个查「有没有别的文件 import 它」，再对
每个导出查调用点。工具是 `scripts/unwired-modules.mjs`，可复跑。

### 删掉了什么（-954 行）

| 文件 | 行数 | 理由 |
|---|---|---|
| `src/core/memory-chunk.ts` | 226 | 分块函数，只有测试和 backfill 脚本引用 |
| `src/core/chunk-store.ts` | ~155 | `memory_chunks` 的读写；4 个 chunk 专属导出**零生产引用** |
| `src/core/corpus-store.ts` 的 `ADAPTER_ADDITIONS_DDL` + `ensureAdapterTables` | 47 | 唯一的用途就是建那张没人读的表 |
| `src/dsh/memory-lane.ts` 的建表调用 | 8 | 同上 |
| `scripts/backfill-chunks.mjs` | — | 手动回填脚本 |
| `tests/chunk-store.spec.ts` + `tests/memory-chunk.spec.ts` | 363 | 对应两个被删模块 |

**为什么判定是自创**：上游 `grep chunkMemory` 在 `mc-upstream` 里零命中。它的 chunk 是
**compartment 级**（`chunk-embedding-writer.ts` 对摘要分块），memory 级分块不存在。

### 保住了什么

`cosineScore` 有 **8 处生产引用**（`curate-memories` / `git-commit-search` /
`primer-cluster` / `primer-search`），它只是恰好住在 `chunk-store.ts` 里。已迁到
`src/core/vector-math.ts`，四个 import 跟着改。

这也说明为什么删除前必须逐个查调用点：删模块会带走活着的邻居。

### 用户数据库里的残留（未动）

`memories.db` 里 `memory_chunks` 表**仍然存在，221 行数据**。代码已不再建、不再读、不再写。
没有 DROP，因为删除数据是不可逆的，而这张表的存在不影响任何行为。

要彻底清理时：

```sql
DROP TABLE memory_chunks;
DROP INDEX IF EXISTS idx_memory_chunks_model;
```

先确认不需要这些向量再做——它们对应的记忆内容本身还在 `memories` 表里。

## 已接线（但通过 CLI 而非运行路径）

| 模块 | 行数 | 接在哪 |
|---|---|---|
| `core/domain-reconcile.ts` | 668 | `scripts/domain-reconcile.mjs`（SQL 与 IO 在脚本侧，判定是纯函数） |

这是合理的形态：域复核对齐是一次性的运维动作，不需要进 pre-step。

## 已知缺口

0. **精度样本重新积累中**。`estWireTokens` 从 2026-11-18 13:06 才开始写（此前同一个
   key 被赋予过三种含义，详见教训一节）。旧 key 下的真实读数已经很好：

   ```
   12:36:09  1.34     12:58:22  1.34
   12:40:52  1.35     13:00:39  1.18
   12:50:36  1.37     13:02:48  1.30
   12:53:15  1.35     13:03:55  1.30
   12:56:03  1.58     13:04:20  1.30
   ```

   median 1.30，p10 1.18 / p90 1.58，spread 1.34 —— 已在 `trusted` 门槛（≤1.35）
   以内。缺的只是样本数（10 对 → 30 对）。**这是时间问题，不是代码问题。**

1. **`freezeReasoningOnBustingPass`**（`transform-postprocess-phase.ts:590`）：缓存必然
   失效的那一轮把 assistant 的 reasoning 块剥掉。thinking 文本通常很大，缓存既然已废，
   剥掉是纯收益。**未做**：本地 `replaceSurfaceRange` 是真的替换（原内容只能靠
   `sourceEventSeqs` 追溯），不可逆；上游只是记 id、渲染时跳过。做之前要先实测
   thinking 在本地会话里的 token 占比，否则是拿不可逆换未知收益。

2. **`transform-postprocess-phase` 剩余部分**（5,307 行）：已按**导出函数**逐项分类
   （见下），未做逐行比对——两边架构不同，逐行没有意义。

### `transform-postprocess-phase` 逐项分类

| 导出 | 判定 |
|---|---|
| `evaluateEmergencyFailClosed` | **已移植**（f726f39 + 2895e72） |
| `freezeReasoningOnBustingPass` / `ProactiveThinkingStrip` | **待实测**：见缺口 1 |
| `servesThinkingBlock` / `firstServedDivergenceIndex` / `ThinkingBindingRecoveryApplication` | **平台差异**：OpenCode 的 thinking 块跨轮连续性协商。DSH 的 session 自己持有 reasoning 块，不做「服务/不服务」的逐轮判断 |
| `PendingCompactionMarker` / `reconcileMarkerRepresentation` / `clearPendingCompactionMarkerAfterSuccessfulDrain` / `CompactionMarkerStrategy` | **平台差异**：这些解决的是「transform 阶段注入可能失败、要重试直到成功」。DSH 用 `replaceSurfaceRange` 做持久原子替换，没有「待注入」这个中间态 |
| `isSyntheticHeadMessage` | **平台差异**：识别 OpenCode 的 synthetic head message。DSH 的合成节点靠 `source.kind`（`magic-context` / `compact-checkpoint`）区分，不需要形状嗅探 |
| `resetDegradedCacheCount` | **平台差异**：OpenCode 侧对「缓存能力降级」的计数。DSH 没有这个概念 |
| `rustMode*`（约 12 个） | **平台差异**：Rust 模块桥 |
| `FinalizeMessageRepresentationOptions` / `ConfirmedAbortClient` / `PostTransformPhaseResult` | 数据结构，随各自的行为一起处置 |

## 结论

**结构性的对齐工作已完成。** 从第 1 轮到第 37 轮：

- 20 项行为逐条对齐上游，每项有 commit 与测试
- 6 项判定为真正的平台差异，各有不移植的技术理由
- 3 次「同一概念两份实现」的缺陷被发现并修掉（保护窗口、请求大小、渲染格式戳）
- 1 条自创且无人读的链（`memory_chunks`）被审计出来并记录，处置待定

剩下的三项都不需要再写代码：一项在攒数据，两项需要外部判断（不可逆操作的收益、
逐行核对的意义）。

