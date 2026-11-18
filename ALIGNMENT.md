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
| `system-prompt-hash.ts`（882） | — | 用于检测 system prompt 变化触发 HARD；本地用 `renderEpoch` + 路由变化，**未实现 system hash** |

## 已移植但未接线

| 行为 | 上游位置 | 本地 | 状态 |
|---|---|---|---|
| 紧急 fail-closed 判定 | `transform-postprocess-phase.ts:1901` | `core/emergency-fail-closed.ts`（10 条测试） | **纯函数已完成，未接入 pre-step**：DSH 的 pre-step 能否中止一个 turn 尚未确认 |

## 已知缺口

0. **`freezeReasoningOnBustingPass`**（`transform-postprocess-phase.ts:590`）：缓存必然
   失效的那一轮把 assistant 的 reasoning 块剥掉。thinking 文本通常很大，缓存既然已废，
   剥掉是纯收益。**未做**：本地 `replaceSurfaceRange` 是真的替换（原内容只能靠
   `sourceEventSeqs` 追溯），不可逆；上游只是记 id、渲染时跳过。做之前要先实测
   thinking 在本地会话里的 token 占比，否则是拿不可逆换未知收益。

1. **`system-prompt-hash.ts`**：上游把 system prompt 的哈希也算进 HARD 重建条件（system prompt 变了，缓存必然失效）。本地只看路由、记忆 digest、epoch、渲染戳。DSH 的 system prompt 由宿主拼装，插件拿不到稳定哈希 —— 但**可以**在 pre-step 里对当前 system prompt 文本取哈希。这是真实缺口，下一轮评估。

2. **`transform-postprocess-phase`**：5,307 行，是上游最大的单块逻辑，本地对应分散在 `management-pass` 与 `pre-step`。需要按行为清单抽查，不是逐行。
