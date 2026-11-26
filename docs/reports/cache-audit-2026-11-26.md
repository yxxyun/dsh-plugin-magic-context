# 缓存命中共性缺陷审计（2026-11-23 → 11-26）

数据源：`~/.local/share/cortexkit/magic-context-dsh-poc/dsh-magic-context.db`（只读）。
对照组：`D:\code\magic-context`（OpenCode 原版，HEAD `237099f`，v0.49.69 之后）。
回放脚本：`%TEMP%\mc-audit3\*.mjs`。

## 一、总体

| 日期 | 步数 | 未命中 input | cache_read | 命中率 |
|---|---|---|---|---|
| 11-23 | 888 | 3,827,010 | 231,492,224 | 98.37% |
| 11-24 | 1571 | 18,603,281 | 533,229,711 | 96.63% |
| 11-25 | 1013 | 11,567,270 | 335,232,128 | 96.66% |
| 11-26 | 978 | 10,803,186 | 376,959,744 | 97.21% |

表面命中率不低，但未命中高度集中：**126 步（2.8%）占 87.6% 的未命中**
（`cacheRead < 60k 且 input > 50k` 的签名步，合计 39,229,814 token）。

严格归因（同会话配对，前一步复用 > 70% + 间隔 < 5 min + 后一步复用 < 30%）：
**97 次可配对的 baseline 重建中，31 次有害，合计 12,026,151 token。**

按 `mode × m0 是否变` 分层：

| 类别 | 次数 | 其中有害 | 有害代价 |
|---|---|---|---|
| soft / m0 未变 | 18 | **15** | **5,865,247** |
| hard / m0 变了 | 46 | 8 | 3,170,600 |
| soft / m0 变了 | 8 | 7 | 2,545,867 |
| 未知 | 7 | 1 | 444,437 |

`soft / m0 未变` 那一行是纯浪费：**m[0] 一个字节都没动，只改了 m[1]，却重写了整个前缀。**

## 二、缺陷 A：m[0] 与 m[1] 同块同锚点，SOFT 也失效整个前缀

**证据。** `src/core/compartments.ts:361-547` `renderBaseline` 把 m[0] 段和 m[1] 段
push 进同一个 `sections` 数组，最后 `[BASELINE_OPEN, ...sections, BASELINE_CLOSE].join('\n')`
返回**一个字符串**。`src/dsh/management-pass.ts:748` 拿它和锚点上的旧块做字节比较：

```ts
if (baselineBlockOf(target.text) === block) { /* 不动 */ }
```

锚点是**首条非占位 user 节点**（`management-pass.ts:698-712`）。m[1] 一变，整个块变，
这条消息变，从它开始的一切失效。

**上游怎么做的。** m0 与 m1 是**两条独立的 frozen unit**，在 wire 上是两条独立消息：

```rust
// crates/mc-module/src/transform.rs:16974-16999
if let Some(unit) = frozen_units.by_key("m0") {
    ... out.push(served); frame_block_stems.push(Some(M0_ID));
}
if let Some(unit) = frozen_units.by_key("m1") {
    ... CkWireMessage::synthetic_user_text(unit.frozen_payload.clone())
    ... out.push(served);
}
```

`m1` 用 `synthetic_user_text`（transform.rs:16986），是紧跟 m0 的第二条合成用户消息。
改 m[1] 只让 m[1] 及其后失效，m[0] 那段仍在缓存里。

**影响。** 15 次 × 平均 39 万 = 587 万 token / 4 天。这些 pass 全都是 SOFT
（`m0 未变`），本该只付 m[1] 那几百 token 的代价。

## 三、缺陷 B：m[0] 的记忆池 digest 用 `updated_at` 当输入

**证据。** `src/core/memory-bridge.ts:1244-1247`：

```ts
const digest = createHash('sha1')
  .update(orderedPool.map(row => `${String(row.id)}:${String(row.updatedAt)}`).join('|'))
  .digest('hex')
```

`updated_at` 是「这行被写过」的时间戳，**不是内容**。verify / classify / promote
只要写回任一字段（`verification_status`、`classified_at`、`scope`、`shareable`、
`seen_count`），digest 就变 → `memoriesChanged` → HARD。

实测 `memories.db`：974 行 active 中，**11-23 之后 469 行的 `updated_at` 被改过**。
最近的几个时间戳 `16:46:22 | 17:17:50 | 18:06:01 | 21:44:10 | 22:30:13`
与有害重建的时间点逐个重合（`17:17:50`、`18:06:01`、`21:44:10` 都在有害列表里）。

按 reason 统计：`memories-digest` 6 次重建**全部有害**（2,337,877），
`route-changed` 2 次全部有害（832,723）。

**上游怎么做的。** 上游的 m0 身份不是时间戳，是**渲染结果与修订号**：

- `mc-module/src/m0_compose.rs:70` `rendered_memory_ids` —— HARD 时把「实际渲染进
  m0 的记忆 id」持久化，SOFT 时只渲染 id 不在其中的新行；
- `meta.memory_revision.mutation_cursor`（`transform.rs:3972`）—— 非增量的
  更新走 `<memory-updates>` 进 m[1]，不进 m[0]；
- HARD 触发条件是 `project_memory_epoch` / `external_revision`（真正的**外部**
  写入），且 `marker_hard_keeps_provider_cache`（`transform.rs:5490+`）明确说这类
  HARD **不价格化**：内容可能没变，就不该为它付一次前缀重写。

**修法。** digest 换成 `id:hash(content)`，或者直接照上游持久化
`rendered_memory_ids` + `memory_revision`，让「行被 touch」不再等于「内容变了」。

## 四、缺陷 C：ttl-fold 少了上游的第二半条件

**证据。** `src/dsh/management-pass.ts:589`：

```ts
const ttlFold = input.policy.ttlRebuild === true && input.pass.reason === 'cache-ttl-idle'
```

**上游。** `transform.rs:3776-3779`（另见 5285-5288）：

```rust
let idle_fold_due = scheduler_outcome.idle_ttl_fired
    && ctx.observed_last_response_at_ms
        .is_some_and(|response| response > loaded.meta.expiry_cutoff_ms);
```

即：**上一次 HARD 之后必须真的有过一次模型响应**，才允许再 fold。否则是在同一段
空闲里反复折叠同一个前缀。

**回放。** 拿这条闸回放我们的库：43 次放行、**3 次拒绝**，被拒的 3 次其后一步
合计未命中 896,575：

```
2026-11-23 17:12:52  205,590   上次 fold 17:10:24，最后响应 11:19:48
2026-11-24 00:14:21  362,466   上次 fold 00:12:29，最后响应 23:53:41
2026-11-26 09:05:54  328,519   上次 fold 09:05:38，最后响应 09:04:35
```

前两次都是「同一空闲窗口内 2 分钟内折了两次」。

## 五、缺陷 D：publish 没有最小回收闸

**证据。** 27 次 publish 落在「前一步复用 > 70% 且间隔 < 5 min」的缓存存活期内：

- 回收合计 **417,616**，重写代价合计 **9,896,469** → 净 −9,478,853；
- 其中回收 **< 2k token 的 10 次**，代价合计 3,821,155。

最极端的两个：

```
C73  12 nodes / 471 tok   回收 471    代价 355,880
C26  19 nodes / 1,267 tok 回收 1,267  代价 418,526
```

**上游怎么做的。** 两道闸：

1. `mc-module/src/selection.rs:1414-1420` `EMERGENCY_MIN_ACHIEVABLE_RECLAIM_TOKENS`：
   算得出能回收的不足门槛就不动，把候选留给下一次真的需要重写的机会
   （`skipped_below_minimum_reclaim`）。
2. `historian_chunk.rs:917` `MIN_FIT_CHUNK_TOKENS = 1_000`：**内容** token 不足
   1000 不开 historian run（除非紧急或 fold 是唯一回收手段）。注意这是对 chunk
   正文的测量，不是节点数。

**我们这边的缺口。** `management-pass.ts:1081` 的 meaningfulness 判据是
`eligibleNodes >= 12`（节点数）——12 个节点可以只有 471 token 正文，正好穿过闸门。
`historian.ts:1276-1290` 则明确写着 `// No size gate here.`（那是为了修
「span cap 等于 trigger budget 导致 historian 完全禁掉」，删对了，但 chunk 正文的
下限没有补回来）。

## 六、优先级

| 缺陷 | 4 天代价 | 修法风险 |
|---|---|---|
| A. m0/m1 同块 | 587 万 | 中：要改锚点布局（两条合成消息），涉及 surface 替换与 placeholder 判据 |
| D. publish 无最小回收闸 | 382 万（<2k 那 10 次） | 低：加一个阈值判断 |
| B. digest 用 updated_at | 317 万 | 低：换 digest 输入 |
| C. ttl-fold 缺第二条件 | 90 万 | 低：加一个条件 |

四项不重叠相加，因为一次重写可能同时命中多个原因。

## 七、不做的事

以下三项经数据检验后判定「不是问题」，不列入：

- **`ttl-fold` 本身**（50 次）：严格配对判有害 **0** 次。间隔 5 min 以上的 fold
  都是缓存已死之后的免费重写，与上游 `hard_fold_loses_provider_cache`
  （`transform.rs:5477-5484`）的读法一致。
- **dream 任务的 LLM 调用**：verify/classify 的 token 不进 `usage_records`，
  与本表无关。
- **provider 5 分钟 TTL**：间隔 > 5 min 的 32 次签名步属物理上限，任何本地实现
  都躲不开。

---

# 八、修正记录（2026-11-27）

四项全部按 OpenCode 原版行为改完，每项配可钉住的测试。
门禁：**150 文件 / 1699 用例全绿**，`tsc --noEmit` 与 `npm run build` 干净。

| # | 缺陷 | 上游依据 | 改动 |
|---|---|---|---|
| D | publish / historian 无最小回收闸 | `historian_chunk.rs:916,1364` | `HISTORIAN_MIN_CHUNK_TOKENS = 1000`，独立一档 |
| C | ttl-fold 缺后半条件 | `transform.rs:3776-3779` | `lastResponseAt > previous.frozenAt` |
| B | m[0] digest 用 `updated_at` | `m0_compose.rs:70`, `transform.rs:3972` | digest = 渲染行 |
| A | m[0]/m[1] 同块同锚 | `transform.rs:16974-16999` | 两块两锚 + `BASELINE_RENDER_EPOCH = 7` |

## 8.1 D — chunk floor

`management-pass.ts`：

```ts
const HISTORIAN_MIN_CHUNK_TOKENS = 1_000
const belowChunkFloor = windowForTrigger > HISTORIAN_MIN_CHUNK_TOKENS
  && eligibleTokens < HISTORIAN_MIN_CHUNK_TOKENS
```

三处按上游写全：

- **独立一档**，不塞在 `tail_size` 里面。上游是两道闸（`historian_chunk.rs:1364`
  与 `tail_size`），工具弧占满的尾巴能过 `tail_size` 却几乎没有正文。
- **force band 绕过**（上游 `in_emergency`）：窗口要炸了，能回收的都算。
- **窗口不够大时不适用**：上游常量的理由是「再小的话固定 prompt 就占满窗口」
  （`historian_chunk.rs:914-916`），这预设窗口远大于 1000。窗口 ≤ 1000 时这条闸
  永远无法满足，套用等于把 historian 彻底关掉——正是 2026-11-18 那次
  span cap = trigger budget 的病。
- `fold_is_only_reclaim` 恒为 false（本适配器始终有 drop lane），所以不额外处理。

顺带修掉的：`if (skip !== null) { // TEMP journal disabled for bisect }` ——跳过原因
算完就丢掉了，这正是本次审计里 38 次重建「无 hardReason」无法归因的原因之一。
现在每次跳过写一行 `historian` journal，`data.phase` 即阶段
（`below-chunk-floor` / `below-proactive-floor` / `redundancy-skip` / `not-meaningful`）。

## 8.2 C — ttl-fold 的后半条件

`management-pass.ts`：

```ts
const responseSinceFold = previous !== undefined
  && previous.frozenAt !== undefined
  && lastResponseAt !== undefined
  && lastResponseAt > previous.frozenAt
const ttlFold = input.policy.ttlRebuild === true
  && input.pass.reason === 'cache-ttl-idle'
  && responseSinceFold
```

`lastResponseAt` 是新增的 input 字段（`usage_records.recorded_at` 的最新值），由
pre-step 传入。`expiry_cutoff_ms` 上游在 HARD 时写成 `ctx.now_ms`，对应我们的
`frozenAt`（SOFT 不推进，见 2026-11-10 的 renderNow 修复）。
未观察 = 不 fold（上游 `is_some_and` 的语义）。

回放本库：43 次放行、3 次拒绝，省 896,575。

## 8.3 B — 记忆池 digest 改用渲染结果

`memory-bridge.ts` 新增并导出：

```ts
export function memoryPoolDigest(renderedLines: readonly string[]): string {
  return createHash('sha1').update(renderedLines.join('\n')).digest('hex')
}
```

调用点从 `id:updatedAt` 改为 `orderedPool.map(renderMemoryLine)`。
`updated_at` 是「这行被写过」，verify / classify / promote 改的
`verification_status` / `classified_at` / `seen_count` / `scope` 都不进 prompt。
抽成导出函数是为了直接测——和不增设新闸同源的理由（同 2026-11-17 的
`dreamRootNeedsPersist`）。

上游从没有这个暴露面：m0 身份是 `rendered_memory_ids` + `memory_revision`
（`m0_compose.rs:70`、`transform.rs:3972`），即「哪些行渲染了」，不是时间戳。
哈希渲染后的字节是这个不变式的另一种写法：digest 恰好在 m[0] 会变化时变化。

## 8.4 A — m[0] 与 m[1] 拆成两块两锚

`compartments.ts`：

- 新增 `DELTA_OPEN = '<magic-context-delta>'` / `DELTA_CLOSE`；
- `renderBaseline` 增加 `region?: 'm0' | 'm1' | 'both'`，默认 `'both'` 保证既有
  调用与 golden 不变；
- `stripBaseline` 改成循环剥离两块（短会话里同一节点会同时带两对标记，
  只剥一块会让 delta 每轮再叠一份）。

`management-pass.ts`：

- m[0] 落在**第一个**普通 user 节点（原逻辑）；
- m[1] 落在**最后一个**普通 user 节点。它之后的都是本轮材料，本来就每步重写，
  delta 改动在那里不额外付费；落在第一个节点就会为一次 delta 改动毁掉整段前缀。
- 同一节点（会话只有一轮）时一次写入两块，并在 journal 记 `sameAnchor: true`，
  免得审计把「拆不开」误读成「没拆」。
- `BASELINE_RENDER_EPOCH` 6 → 7：epoch 6 的 baseline 把 delta 放在 m[0] 块里，
  升级后必须折一次，且只折一次（`render-epoch` 门）。

上游是两条独立 frozen unit，因而仍是两条 wire 消息
（`transform.rs:16974-16999`）。本平台只能就地替换节点、不能往历史之前插消息，
所以用两个锚点表达同一条不变式：**delta 变化只让 delta 及其之后失效**。

## 8.5 测试

| 文件 | 用例 | 钉住什么 |
|---|---|---|
| `tests/historian-chunk-floor.spec.ts` | 4 | 低于 1000 拒绝；高于放行（以 drain 预约证明过了全部闸）；force band 绕过；窗口 ≤1000 不适用 |
| `tests/memory-pool-digest.spec.ts` | 5 | 同池同 digest；改行不同；集合与顺序敏感；**真实 memories.db 上只改 `updated_at`/status 字段 → digest 不变**，改 content → 变 |
| `tests/baseline-two-anchors.spec.ts` | 4 | m[0] 在首节点、delta 在尾节点；**只改 delta 时首节点字节不变**（epoch 仍为 1，证明是 SOFT）；单轮会话同锚并记录 `sameAnchor`；epoch-6 旧块折一次且 `hardReason = render-epoch` |
| `tests/ttl-rebuild.spec.ts` | 6 | 原有 4 条 + 新增「上次 fold 后无响应不折」「从未观察到响应不折」 |

夹具调整（都是新语义的正确后果，不是放宽断言）：

- `memory-promotion`、`phase2`、`historian-terminal` 里的一词轮次（`'go'` / `'more'`）
  改为 `narratable(...)`：chunk floor 之后，一个单词的轮次本来就不该触发摘要。
  `phase2` 另两条「no-op 不突变」用例保留短轮次——它们测的正是没材料时不动。
- `memory-delta` 新增 `injectedOf()`：`blockOf()` 仍只量 m[0]（「前缀没动」该量的
  就是它），比较整份注入的地方改用两者之和。
- `baseline-two-anchors` 的假 surface 在 replace 时**保持原位置**：宿主是就地重写，
  简化成 push 会让「第一个 user 节点」失去意义。

## 8.6 未做

- **`EMERGENCY_MIN_ACHIEVABLE_RECLAIM_TOKENS`**（`selection.rs:1414`）没有单独移植：
  它的场景是 emergency drop 的选择定价，而本次代价来自 publish 的极小回收，
  已由 chunk floor 覆盖（§五里 10 次 <2k 的 publish 都低于 1000 正文门槛或落在
  force 带内）。
- **`rendered_memory_ids` 持久化**：上游用它让 SOFT 只渲染新行。本适配器已有等价
  机制（`maxMemoryId` 水位 + `baselineIds`），digest 修正后不需要再存一份。
- 真实数据的收益（预估 4 天 1,203 万未命中里的大部分）要等下一次审计用同一套脚本
  回放才能确认；本次只做代码与夹具层面的证据。

