# 缓存命中率与错误审计 — 2026-11-09 11:57 → 2026-11-10 17:03（约 29 小时）

数据源（只读打开，未写任何内容）：

- `C:\Users\杨新鑫\.local\share\cortexkit\magic-context-dsh-poc\dsh-magic-context.db`（1.8 MB + 4.1 MB WAL）
- 相关表：`usage_records`(1726) `journal`(2508) `compartments`(14) `baseline_state`(4) `tags`(1729) `pending_drops`(113) `memory_stats`(85) `meta`(12)

命中率口径：DSH 的 `TokenUsage` 把输入拆成「未命中输入 + 缓存读 + 缓存写」，故

```
命中率 = cache_read / (input + cache_read + cache_write)
```

本数据集 `cache_write` 恒为 0（DeepSeek 系自动缓存，provider 不上报写量），所以等价于 `cache_read / 总输入`。

---

## 一、结论先行

| 指标 | 数值 |
| --- | --- |
| 总步数（provider 上报的 usage 行） | 1,726 |
| 未命中输入 | **12,503,777** tok |
| 缓存命中读 | **308,432,640** tok |
| 总输入 | 320,936,417 tok |
| **整体命中率** | **96.10%** |
| 输出 | 1,141,032 tok |
| 模型 | 全部 `deepseek-v4.1-flash`（`dsh-opencode-go` 1440 行 / `workbuddy` 286 行，两路命中率都 96.1%） |

**96.1% 这个数字不能用来判断好坏**，因为分布是双峰的：

| 单步命中率区间 | 步数 | 未命中合计 | 占比 |
| --- | --- | --- | --- |
| ≥ 99% | 1,118（64.8%） | 1,032,673 | 8.3% |
| 90–99% | 510 | 1,787,869 | 14.3% |
| 50–90% | 44 | 687,464 | 5.5% |
| < 50% | 48 | 8,236,486 | 65.9% |
| = 0% | 9 | 765,060 | 6.1% |

也就是说：**64.8% 的步数几乎完美命中，但 30 步（1.7%）吃掉了 59.9% 的未命中量**（单步未命中 > 150k 的 30 步合计 7,494,491 tok）。平均命中率被这几次「整段击穿」拉低了，实际体验是「大部分时候很好，偶尔一次把 27–30 万 token 全部重算」。

按天：

| 日期 | 步数 | 未命中 | 命中率 |
| --- | --- | --- | --- |
| 2026-11-09 | 969 | 5,864,456 | 96.96% |
| 2026-11-10 | 815 | 6,776,441 | **95.04%** |

11-10 更差，正好是「配置改成 30% 阈值 + 长会话」那天。

最贵的几个 turn（全在 `session-55068019`）：

| turn | 起 | 步数 | 未命中 | 命中率 |
| --- | --- | --- | --- | --- |
| 31 | 11-10 16:50:37 | 23 | 1,871,701 | **49.3%** |
| 27 | 11-10 16:05:47 | 58 | 1,494,730 | 81.6% |
| 6 | 11-09 14:19:27 | 89 | 752,992 | 94.1% |
| 30 | 11-10 16:37:03 | 40 | 623,813 | 93.9% |

---

## 二、根因 1（代码）：baseline 的渲染字节随墙钟变化 → 每次 execute 都判「变了」→ 整段 prefix 失效

### 证据链

**(a) 一次 execute 前后两步的用量对比**（同一会话，间隔 14 秒）：

```
16:48:34  input=    716  cacheRead=299,776   →  99.8% 命中
16:48:48  input=270,433  cacheRead= 32,768   →   8.2% 命中   ← execute 之后
```

`32,768` 这个数字是签名：**系统提示 + 工具目录（≈32k）还命中，之后的全部内容作废**。全库符合该签名（`cache_read BETWEEN 24576 AND 40960 且 input > 100k`）的步数 = **25 步，合计 6,186,106 tok = 全部未命中的 49.5%**。

**(b) journal 里自证**：`kind='baseline'` 共 43 行 = `hard/first-baseline` 4 + `hard/memory-digest-changed` 4 + **`soft/-`（软刷新）35 行**。而该会话只发布了 10 个 compartment（C1–C10）。35 次软刷新里约 25 次是空转。

**(c) 空转 execute 的完整序列**（16:47–16:53，9 连发）：

```
16:48:34 p=30.0 published=[] baseline=refreshed delta=-53
16:48:48 p=30.3 published=[] baseline=refreshed delta=0
16:50:19 p=30.5 published=[] baseline=refreshed delta=0
16:50:38 p=31.2 published=[] baseline=refreshed delta=0
16:50:56 p=31.5 published=[] baseline=refreshed delta=0
16:51:11 p=31.8 published=[] baseline=refreshed delta=0
16:51:35 p=32.0 published=[] baseline=refreshed delta=0
16:52:00 p=32.3 published=[] baseline=refreshed delta=0
16:52:14 p=32.3 published=[10] baseline=refreshed delta=-104410   ← 真正落地的那次
```

8 次 `published=[]`、`tokensDelta=0`、`baseline=refreshed` —— 什么都没回收，却每次都改写了 baseline 节点，每次都把 27–30 万 token 打成未命中。

### 机制

`src/dsh/management-pass.ts:518` 的「字节相同就不动」保护：

```ts
if (baselineBlockOf(target.text) === block) { /* 不动，不付 bust 钱 */ }
```

而 `block` 由 `renderBaseline()` 现算，其中每个 compartment 的表头是

```ts
// src/core/compartments.ts:109-113
export function compartmentHeader(compartment, now) {
  const { tier } = tierText(compartment, now)   // ← 档位也按 ageMs 选
  const minutes = Math.max(0, Math.round((now - compartment.createdAt) / 60_000))
  return `§C${compartment.id}§ [${tier}, importance ${…}, ${minutes}m ago]`   // ← 墙钟
}
```

`now` 每次 pass 都是 `Date.now()`，而 `Math.round(分钟)` 每 60 秒必变、`selectTier()`（`compartments.ts:93-100`，10 min / 2 h / 24 h 三档）还会整体换掉 digest 文本。**只要会话里有 ≥1 个 compartment，任何一次 execute 都必然「看起来变了」**，字节相等判断形同虚设。

用真实的库数据复现（`renderBaseline` 取两次 `now`，间隔 70 秒）：

```
§C1§ [p4, importance 74, 1661m ago]   →   §C1§ [p4, importance 74, 1662m ago]
§C6§ [p2, importance 84, 1398m ago]   →   §C6§ [p2, importance 84, 1399m ago]
blocks equal? false
```

### 为什么代价这么大

baseline 挂在**第一个 user 节点**上（`management-pass.ts:511-517`「The baseline rides the first ordinary user node」），位置就在系统提示之后。所以改写它 = 从 ~32k 处切断缓存，后面 27 万 token 的历史全部重算。这跟「m[1] 增量区永远不会扰动缓存前缀」的设计初衷正好相反。

### 修法（三选一，推荐 A+B 组合）

**A. 让渲染对时间免疫（最小改动，1 行级）**

表头不带相对时间、档位不进渲染（档位在 publish 时定型并落库）：

```ts
// compartments.ts
return `§C${compartment.compartmentId}§ [importance ${String(compartment.importance)}]`
```

若确实想保留「多久之前」的信息，改成**绝对日期**（`2026-11-10 16:05`），它不随时间漂移。档位同理：在 `publishCompartment` 时把 `p1..p4` 选定结果写进新列 `rendered_tier`，`renderCompartment` 只读列，不再算 `selectTier`。

**B. 用「冻结时钟」渲染，而不是 live 时钟**

`refreshBaseline()` 里已有 `state.frozenAt`。把

```ts
const block = renderBaseline({ now, … })
```

改成

```ts
// 基线集合用折叠时刻的时钟；增量集合用各自 createdAt（age=0）
const block = renderBaseline({ now: previous?.frozenAt ?? now, … })
```

这样两次 pass 之间的字节严格相等，`===` 判断才真正生效；只有 `published`/HARD 重建才改变输入。

**C.（可选，结构性）把 baseline 挪到尾部**

m[0] 放在第一个 user 节点意味着任何变化都是全局 bust。若把 m[0] 挂到**最新一条 user 消息之前**（和 m[1] 同侧），改写的代价从「整段」降到「尾部几百 token」。代价是 m[0] 不再是「冻结前缀」，需要在 next-wire 组装处确认 DSH 的 prompt 组装顺序允许。

### 验收标准

改完之后跑同样的活：

- `journal.kind='baseline'` 的 `soft/-` 行数应 ≈ 0（只允许随 `published` 或 HARD 出现）；
- `cache_read BETWEEN 24576 AND 40960 AND input > 100k` 的步数应为 **0**；
- 单步命中率不应再出现 `< 90%` 的步（除首步冷启动）。

---

## 三、根因 2（配置）：1M 窗口上把 execute 阈值设成 30%，等于「永远在 execute band 里」

当前生效配置（`C:\Users\杨新鑫\.dsh\profiles\desktop\cordis.patch.yml` 末尾）：

```yaml
- id: magic-context-dsh
  name: dsh-plugin-magic-context
  config:
    policy:
      executeThreshold: 30
      forceThreshold: 50
```

而 `DEFAULT_POLICY` 是 `executeThreshold: 65 / forceThreshold: 85`（`src/core/policy.ts:79-81`）。路由 `deepseek-v4.1-flash` 的窗口是 **1,000,000**（`journal` 里 `contextWindow:1000000`），所以 30% = **300k token 就开始压缩**。

后果是复合的：

1. 会话一旦过了 300k，**每一步** `decidePass()` 都返回 `execute`（65 次 execute vs 77 次 defer，且 execute 全集中在长会话）；
2. execute band 是唯一允许改 wire 的时机，于是每一步都在花钱 bust —— 叠加上「根因 1」，就是「每步 27 万 token 重算」；
3. 真正让压力下降的是 historian 落地 compartment（16:52:14 那次 `-104,410`），而 historian 一次要 77–176 秒。**在这 1–3 分钟里，前面 8 次 execute 全是纯浪费**：压力单调 30.0 → 32.3 上升，`tokensDelta` 全是 0。

也就是说：阈值 30% 把「压缩一次」变成了「压缩窗口期内每步都试一次」，而试一次的成本是 27 万 token。

### 修法

**配置层（立刻可做）**

```yaml
- id: magic-context-dsh
  config:
    policy:
      executeThreshold: 65      # 1M 窗口 = 650k 才压，留 35% 余量
      forceThreshold: 85
```

如果希望「压得勤一点」，用绝对 token 表达更安全，而不是百分比：1M 窗口上 30% 的语义是「600k 余量」，对 agentic 长任务没必要。

**代码层（防止再踩）**

- `policy` 增加 `minExecuteTokens`（例如 250k）：`decidePass` 里 `pressure >= threshold && totalInput >= minExecuteTokens` 才算 execute。百分比在小窗口上合理、在大窗口上过激，绝对下限能兜住。
- **execute 无进展要退避**：在 `PreStepDeps` 里记住「上 N 次 execute 的 `tokensDelta` 之和」。若连续 ≥3 次 execute 的 `published` 为空且 `tokensDelta === 0`，则把该会话的 band 临时抬高（或直接 `defer`，reason=`no-progress`），直到 `pending_drops` / historian 有实际产出。这与 historian 已有的 `historian_no_progress:<session>` 门（`meta` 表里 4 条）是同一思路，只是没用在 pass 上。
- 阈值报错/告警：设置卡片上 `executeThreshold < 40` 且窗口 ≥ 512k 时，在面板上打一条黄字提示（「按当前窗口 ≈ X00k token 触发，压缩会变频繁」）。

---

## 四、错误清单（29 小时里一共 4 条 error / 1 条 warn）

| 时间 | 级别 | kind | 现象 | 定性 |
| --- | --- | --- | --- | --- |
| 11-10 16:49:17 | error ×3 | `historian` / `error` | historian 输出非法 JSON（pos 1132, line 3 col 1116） | **真 bug（输出格式）** |
| 11-09 14:08:27 | error | `historian` | `historian call failed: … terminated`（16.5 s 后断流） | provider 抖动 |
| 11-09 14:10:30 | warn | `maintenance` | verify 调用 `Connection error`，下一 tick 重试 | provider 抖动，处理正确 |
| 11-09 13:05:55 | error | `historian` | `adapter-remount`（HMR/重启时 run 在飞），`recovered:true` | 环境事件，已恢复 |

### 4.1 historian 输出非法 JSON（唯一实质缺陷）

```
phase=failed trigger=automatic nodes=342 tokens=105633 route=dsh-opencode-go/deepseek-v4.1-flash
maxTokens=8192 timeoutMs=120000 chunks=3 stage="chunk 1/3" kind=invalid-output
attempts=2 attemptCaps=[8192,16384] durationMs=42861 finishReason=stop outputChars=6131
```

读法：

- 只花了 42.9 秒、输出 6,131 字符就 `finishReason=stop` —— **不是被 maxTokens 截断**，是模型自己收尾但 JSON 结构坏了（第 3 行第 1116 列，典型的字符串里未转义引号/换行，中文长句最容易踩）；
- 重试只把 `maxTokens` 抬到 16384，**没有换策略**，同样的 prompt 再问一遍，同样的地方再坏一次；
- 一个 105k token 的 span 分 3 块，每块要求输出结构化 JSON，单块就 6k 字符 —— 这已经接近小模型稳定输出的上限。

**改法（按性价比排序）**

1. **失败后不要只抬 cap，要降难度**：第一次失败后，把该 chunk 的 `chunkTokens` 减半重新切（同样的节点，更多更小的块），而不是原样重发。现在的 `attemptCaps` 逻辑只动 `maxTokens`，对「格式坏」这个错误类型是无效重试。
2. **解析前做一次修复**：`HistorianOutputError` 抛之前，先试 `repairJson`（去尾逗号、补闭合括号、把裸换行转义、把 `"` 收尾）。便宜且能救回大部分 6k 字符级别的坏 JSON。
3. **换承载格式**：让模型输出「每行一条 JSONL」或分字段（先 `facts`、再 `events`），单次输出体积降到 1–2k 字符，坏一个字段不毁整块。
4. **失败降级**：`invalid-output` 时把该 span 直接落一个 `tier_p4` 兜底 compartment（`nodes`/`tokens` 已知，摘要可以是首尾两条人类可读的截断），而不是整次 run 作废——现在这次失败意味着 16:48–16:50 那 105k token 白烧了，两分钟后 16:50:19 才重跑。

### 4.2 同一事件写了 3 行 error

`16:49:17` 同一秒写了 3 行：`historian promise rejected`（×2，`scope: historian-unhandled`）+ `historian run failed`。前者是 `management-pass.ts` 的 `.catch()`，后者是 `runHistorian` 自己的终态行。`runHistorian` 已经「journals its own terminal events」（代码注释也这么说），`.catch()` 只应该在「promise 本身 reject」这种 plumbing bug 上触发。现在正常失败也会双写，导致：

- 错误计数虚高 2 倍（`/ctx-status` 的 `last 24h: N error(s)` 和面板都受影响）；
- 定位时要先人工去重。

改法：`runHistorian` 内部已经 resolve（失败只 journal）时，`.catch()` 里判断 `error instanceof HistorianOutputError || error instanceof HistorianStreamError` 就只记 debug 或不记。

### 4.3 `adapter-remount` 被算成 error

11-09 13:05:55 那次：HMR 时 run 在飞，`recovered:true`，`journal.level='error'`。这会让「真实错误率」永远含一条噪声。建议级别降为 `warn` 且 `kind='adapter-remount'`（不是 `failed`），或在统计时按 `recovered:true` 过滤。

### 4.4 `historianStarted: true` 与实际不符

16:51:35 / 16:52:00 两次 pass 的 `historianStarted=true`，但 journal 里**没有新的 `start` 行**。

原因是 `inFlight` 去重（`historian.ts:894-898`）：16:50:19 那次 run 一直到 16:52:05 才 `done`，这期间的 pass 全部命中 `const existing = inFlight.get(sessionId); if (existing) return existing` —— 直接返回旧 promise，**不留任何 journal 行**。同理 `runHistorianExclusive` 里 `no-progress-skip` 有日志、`inFlight` 去重没有。

所以 `historianStarted` 这个名字在多处是假的：既包含「被 in-flight 吞掉」，也包含「被 #802 门挡住」。建议改成 `historianRequested` + `historianOutcome: 'started' | 'in-flight' | 'no-progress'`，并给 `in-flight` 分支补一条 `info` 行——否则「historian 到底跑没跑」在库里根本查不出来（面板想统计也统计不了）。

---

## 五、其它待优化（按 ROI 排）

### 5.1 historian 的花费完全在账外（高）

- 16 次 start，覆盖 **1,525,289 span token**，39 个 chunk 调用（+每个 chunk 一次 merge）；
- 平均 **110.1 s**，最长 **175.7 s**。这个数值**不是超时失效**：预算按调用数放大（`historian.ts:583` `deadline = startedAt + min(600s, timeoutMs × plannedCalls + merge 一份)`），3 chunk + merge = 480 s，所以 175 s 在预算内。真实情况是「一次压缩要吃掉 1.5–3 分钟」，而这段时间主会话还在跑，压力继续涨（见根因 2 的 8 连空转）；
- 这些调用是**独立请求、全新前缀**（不走主 wire 的缓存），但 `usage_records` 只记主会话的 `sessionEvent`（`src/index.ts:400-403`），**historian 的 token 一分钱都没进库**。面板和 `/ctx-status` 的「缓存/用量」因此系统性低估——按 span token 粗算，historian 一天至少等量于 1.5M 未命中输入，占主 wire 未命中的 ~12%。

改法：`runHistorian` 的 `collected.usage` 已经在手上（`historian.ts:325` 读 `chunk.usage`），落一张 `aux_usage(scope='historian', …)` 或直接复用 `usage_records` 加 `scope` 列；面板加「historian 花费」卡。

### 5.2 每步写 2 行 journal（中）

`context-pressure` 1051 行 + `search-hint` 591 行 = 2508 行里的 65%，24h 252 KB。

- `context-pressure` 每步一条，只用于诊断；
- `search-hint` 591 行只有 **3 种** summary（`no-hits` / `hinted` / …），语义重复严重。

改法：`context-pressure` 改成「每 turn 一条 + 变化超阈值才补记」；`search-hint` 的 `quiet` 分支不落盘（只在 `hinted` 时记）。

### 5.3 `pending_drops` 有 1 条永久卡住（中）

113 条里 1 条 `landed_event_seq IS NULL`，`queued_at = 11-10 09:33`。它只可能在 execute band 下落，而该 tag 已被回收/节点已消失时会永远等着。建议在 execute pass 里对「目标节点已不在 surface」的 pending drop 直接 `markDropped(reason='target-gone')` 清掉（现在只有 `replace-failed` 一种退休理由）。

### 5.4 `memory_stats.hits` 恒为 0（中，影响排序）

85 行统计，`injections` 合计 1,595，`hits` **全部 = 0**，`last_hit_at` 全部 NULL。

如果 hits 只在 `ctx_memory search` 命中时累加，那么这套 S(t) 衰减打分（`scoring.enabled: true`）就只有「注入次数」这一路正反馈，没有任何「被真正用上」的信号——半年后所有记忆按半衰期一起掉到 `archiveThreshold`（默认 2）以下。需要确认 hits 的采集点是否漏了：`ctx_memory` search 返回行、`ctx_expand`、以及面板搜索都该记 hit。

### 5.5 数据质量小坑（低）

- `usage_records` 有 2 行 `input/cache_read/output` 全 0（session `c0db0e91`）：压力被算成 0%，面板命中率显示 `n/a`。建议 `recordUsage` 跳过全零行。
- `~/.local/share/cortexkit/magic-context-dsh-poc/policy-override.json.orphan-20261110` 是「阈值覆盖文件」删除后残留的空壳，没有任何代码引用；可以清掉。
- `%TEMP%` 下有数百个 `mc-*` 残留目录（`mc-cmd-*` / `mc-dashboard-*` / `mc-domain-checks-*` / `mc-recon*` / `mc-wrapup-*` …，每个含一套 `dsh-magic-context.db` + WAL）。是测试与命令路径用完不删造成的，跑一次 `find %TEMP% -maxdepth 1 -name 'mc-*' -newermt ...` 就能看出规模。建议测试统一用 `mkdtemp` + `afterEach` 清理，生产路径不写 TEMP。

### 5.6 面板缺「缓存」视图（低，但是你这次问的东西）

`src/dsh/dashboard.ts` 的卡片只有：会话 / 压缩快照 / 待落地回收 / 笔记 / 项目 / 记忆。**没有任何缓存命中或 token 花费的展示**，所以「命中率掉到多少」只能像我这样直接查库。

建议加两个卡（数据都已入库，纯读）：

- **缓存（24h）**：`cache_read / (input + cache_read)`、未命中 token 数、**bust 次数**（= `journal kind='baseline'` 的 row 数）、最后一条 baseline 距今；
- **historian**：run 次数 / span token / 平均耗时 / 失败率（配合 5.1 落表后才有花费）。

---

## 六、优先级与预计收益

| # | 项 | 改动量 | 预计收益 |
| --- | --- | --- | --- |
| 1 | baseline 渲染去时间化（`compartmentHeader` / `selectTier` 冻结）+ `refreshBaseline` 用 `previous.frozenAt` | 20–40 行 + 测试 | 直接消掉 25 步签名 bust，**日省 ≈ 6.2M 未命中 token（未命中总量的 50%）** |
| 2 | `executeThreshold` 30 → 65（配置），并加 `minExecuteTokens` / 无进展退避 | 1 行配置 + 30 行代码 | 消掉 8/9 的空转 execute，顺带减少 historian 无效触发 |
| 3 | historian 失败：降难度重切 + JSON 修复 + p4 兜底 | 60–100 行 | 失败率 3/17 → 期望 <1/17；单次失败不再白烧 105k |
| 4 | aux usage 落库 + 面板缓存卡 | 80–120 行 | 从「看不见」到「可观测」，后续优化才有依据 |
| 5 | 重复 error 行去重、`historianStarted` 语义、journal 降噪、pending_drop 退休 | 40–60 行 | 噪声降 60%，`/ctx-status` 的错误计数恢复可用 |

按这个顺序做，1+2 是当天能验证的：**目标是把整体未命中从 12.5M 压到 ~5M 以内，单步命中率不再出现 < 90% 的塌陷**。

---

## 附：复现脚本

数据快照与复现脚本在 `%TEMP%\mc-audit\`（`schema.mjs` / `usage.mjs` / `deep.mjs` / `attr.mjs` / `hist.mjs` / `repro.mjs`），全部只读打开库。核心复现：

```bash
node repro.mjs "<data>\dsh-magic-context.db" session-55068019-13df-4d79-9ba5-a113ef871ddc
# → blocks equal? false   （同一批 compartment，now 差 70 秒）
```

---

## 七、后续：上游对照的结论（2026-11-10 同日）

对照上游 v0.49.48 后本报告有两处需要修正与一处可以销案，详见
[upstream-findings-2026-11-10.md](upstream-findings-2026-11-10.md)：

1. **根因 1 是移植偏差，不是我们的设计**。上游把「同输入 → 同字节」写进文件头（`crates/mc-module/src/m0_compose.rs:1-9`：「the expiry cutoff is frozen at the HARD by the caller, **never read here from a live clock**」），而且档位用的是**序号年龄**（`decay.rs:61-62`），渲染里根本没有相对时间。**已修**：`refreshBaseline` 改为 SOFT 用 `previous.frozenAt` 渲染，回归见 `tests/baseline-clock-freeze.spec.ts`（删掉该行即两条用例全红）。
2. **第五节 5.6「面板缺缓存视图」仍是待办，但第六节 #2 的「阈值 30→65」不是正解**。上游给了 `execute_threshold_tokens`（按模型绝对 token，clamp 到 90% × 窗口，`CONFIGURATION.md:296`）：1M 窗口该按 token 定阈，而不是按百分比。
3. **「中断后用 idle 触发重建」这一条在本报告里被我判成纯损失，需要销案**。上游保留 idle-TTL 作为 execute band（`scheduler.ts:116-119`），并把它当成「缓存已经没了」的证据用于给 HARD fold 开票（`transform.rs:4641`）；它之所以不亏，是因为**空转的 pass 输出与上一轮逐字节相同**。前提正是根因 1 被修掉——所以顺序是「先修字节稳定，再恢复 TTL band」，而不是「为避免重写而抬高阈值」。
4. 本报告的 §5.4（`memory_stats.hits` 恒 0）与「`baseline-stability` 门盲点」两条，对照 upstream 后确认都属于我们自己的车道，上游没有对应实现可抄。


## 八、落地状态（2026-11-10 18:40）

第七节的三条建议已按「先修字节稳定，再恢复 band」的顺序落地，全量 849/849 绿、`typecheck` + `build` 通过：

| 项 | 状态 | 落点 |
|---|---|---|
| 渲染器去时间化（表头去 `Nm ago`、档位按序号） | ✅ | `src/core/compartments.ts`（`selectTier` / `compartmentHeader` / `renderCompartment` / `renderBaseline`） |
| baseline 字节守卫（冻结时钟 + 字节相同不写） | ✅ | `src/dsh/management-pass.ts` `refreshBaseline` |
| idle band 恢复（`cache-ttl-idle`，`ttlMs:0`=never） | ✅ | `src/core/policy.ts` `decidePass` |
| `executeThresholdTokens`（clamp 90%×窗口） | ✅ | `src/core/policy.ts` `withTokenThreshold`；`pre-step.ts` 决策点求值 |
| historian 输出就地修复（裸换行 / 非法转义；截断仍失败） | ✅ | `src/core/compartments.ts` `repairHistorianJson` |

补记（同日 19:05，全量 861/861 绿）：下表四行之外又落了五项 ——
historian **认标签信封**（`parseHistorianEnvelope`，双格式分流）、`pending_drops` **目标消失退休**
（`retireDrop` + `drop-retired`）、`memory_stats.hits` **不再恒 0**（主动提示车道记 hit；实测旧数据
85 行 / 1645 injection / 0 hit）、`historianStarted` → `historianRequested`、
`baseline-stability` 的 recall 豁免改**增量**并把三类豁免拆账进判据文本。

剩下唯一一件（一件，不是一类）：**把 historian 的提示词切成信封**。解析侧已经双格式，所以这一步只
影响"模型愿不愿意按信封写"。动手前必须先给 `CompartmentDraft.userObservations` 在信封路径里找到
落点——否则提示词一换，画像采集车道会静默停摆。

一条新增的判据：`/ctx-status` 现在打 `idle band 300s|off` 与 `execute-tokens N tok (overrides the %)`，
巡检配置漂移时以这两行为准——旧输出里的 `ttl … (diagnostic only)` 已不再成立。
