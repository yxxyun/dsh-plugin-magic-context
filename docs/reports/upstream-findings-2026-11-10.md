# 上游对照：我们三个 bug 在上游有没有现成答案

对照对象：`D:\code\magic-context`（本地 clone），HEAD `9d5faa984`，`origin/master` = `28a313e26` = **v0.49.48**。
我们的 `PARITY.md` 记的是 **v0.49.30**，即本地比上游落后 18 个提交（`git diff --stat HEAD origin/master` = 1311 files）。下文行号按本地 worktree（9d5faa984）；`m0_compose.rs` / `scheduler.rs` / `transform.rs` 的相关段落在 18 个提交里没有变动。

结论一句话：**三个 bug 里两个上游有明确成文的解法（而且把我们的做法直接标成违约），第三个是上游根本不走那条路。**

---

## 一、bug #1「baseline 字节随墙钟漂移」——上游写成硬不变式，我们是违约

`crates/mc-module/src/m0_compose.rs:1-9`（文件头，逐字）：

> This is the BYTE producer only — it does not classify or decide HARD-vs-SOFT. It is pure given the store contents + `now_ms` + `budget`: **same inputs → same bytes, the property the frozen-m0 cache depends on**. The expiry cutoff (`now_ms`) is passed in (**frozen at the HARD by the caller, never read here from a live clock**) so a later defer replays identical bytes.

`crates/mc-module/src/decay_render.rs:1-13`：

> The byte-identity invariant that matters is **intra-module determinism (same compartments + budget → same bytes across passes)**.

而我们的 `src/core/compartments.ts:109-113`：

```ts
const minutes = Math.max(0, Math.round((now - compartment.createdAt) / 60_000))
return `§C${id}§ [${tier}, importance ${…}, ${minutes}m ago]`   // now = Date.now()
```

**上游渲染里根本没有相对时间这个东西**（`grep -rn '§C' crates/` 零命中，`grep '}m ago' packages/` 只命中 `status-view.ts` 的 `/ctx-status` 文本和 dashboard，都不进 prompt）。

### 更关键的一条：档位不是按时间

我们 `selectTier(importance, ageMs)` 按 10 min / 2 h / 24 h 划档。上游 `crates/mc-core/src/decay.rs:109`：

```rust
pub fn rendered_tier(compartment_index: u32, importance: i32, budget_pressure: f64, anchor_overlap: f64) -> Tier
```

`compartment_index` 是**序号**年龄。`decay.rs:61-62` 解释得很清楚：

> The half-life-scaled age `z = a / H` for a compartment … **`a` is the 0-based age**

也就是说上游的「age」是「这个 compartment 在时间序列里排第几」，**与墙上时钟无关**，渲染天然确定性；我们把它译成了「离现在多久」，于是同一个库、同一批 compartment，每过一分钟渲染就换一次档、换一次表头。

→ **结论：这是移植偏差，不是设计取舍。修法就是上游的写法：渲染器只吃冻结的 `now_ms`。已落（见下）。**

---

## 二、bug #2「阈值语义 / 空转 execute」——上游有两个我们缺的东西

### (1) `execute_threshold_tokens`：绝对 token 阈值

`CONFIGURATION.md:296` / `:449`：

> `execute_threshold_tokens` | `object`（按模型的 map）| — | **Optional absolute-tokens variant of `execute_threshold_percentage`.** 例 `{ "default": 150000, "github-copilot/gpt-5.2-codex": 40000 }`。设了就对该模型覆盖百分比阈值，**clamp 到 `90% × context_limit`** 并 warn；拿不到 context limit 时退回百分比。

`scheduler.rs:483-508` 的 `resolve_execute_threshold()` 就是这段实现（`MAX_EXECUTE_THRESHOLD_PERCENTAGE = 90.0`，`scheduler.rs:17`）。

**这正是我们缺的那道闸**：1M 窗口上 `executeThreshold: 30` = 300k，等于「长会话里永远在 execute band 里」；上游允许你写 `{ "default": 200000 }`，语义是「不到 200k 压什么压」，而不是「不到 30% 就压」。

### (2) 「该不该进 band」和「该不该改字节」是两件事

上游把决策拆成两层：`should_execute()`（scheduler）只回答 band；真正改字节由 `PassPlan`（`Hard` / `Soft` / `Migrate`）决定，而 `transform.rs:4641` 给了一个判定：

```rust
let hard_fold_loses_provider_cache = scheduler_outcome.idle_ttl_fired
    || profile_transition
    || identity_changed(&loaded.meta.last_provider_id, req.provider_id.as_deref())
    || identity_changed(&loaded.meta.last_model_key, req.model_key.as_deref())
    || (!system_identity_adopted && identity_changed(&loaded.meta.last_system_prompt_hash, …));
```

注意这句话的方向：它不是「idle 了所以要 fold」，而是「**idle 了，fold 也不额外损失缓存**」——把 idle 当作「缓存已经没了」的**证据**，用来给一个本来付不起的 HARD 开票。

我们缺的正是这个分离：`decidePass` 一 execute 就进 `runManagementPass`，而 `refreshBaseline` 拿 live 时钟渲染，于是「进了 band」直接等于「改了字节」。修好 #1 之后，这个分离就自然成立：**空转的 execute 不产生任何字节变化**，`baseline=unchanged`，缓存毫发无损（这正是上游 `transform-decision-log.test.ts:67` 那条用例的名字：「a byte-identical expired Rust resend」）。

---

## 三、bug #3「historian 输出非法 JSON」——上游压根不要 JSON

`crates/mc-module/testdata/historian-parse-golden.json` 的第一个 case（`well-formed tiers, facts and side channels`）就是上游的线上格式：

```
<output>
<compartments>
<compartment start="1" end="2" title="Setup" episode_type="infra" importance="40">
<p1>did setup</p1><p2>did setup short</p2><p3>did setup shorter</p3><p4/>
</compartment>
</compartments>
<facts><PROJECT_RULES>* Keep goldens deterministic.</PROJECT_RULES></facts>
<events><causal_incident at_compartment="1"><summary>Setup broke.</summary></causal_incident></events>
<user_observations>* Prefers short answers.</user_observations>
<primer_candidates><primer at_compartment="1">How is setup done?</primer></primer_candidates>
<meta><unprocessed_from>3</unprocessed_from></meta>
</output>
```

配套是一个**明确容错**的解析器，golden 的 case 名字就是它的容错清单：

| golden case | 容忍的坏形状 |
| --- | --- |
| `mismatched and missing tier closes stay lenient` | `<p1>` 没闭合 / 闭合错配 |
| `xml entities decode exactly once` | 实体只解码一次（不双重解码） |
| `raw > inside a quoted attribute value keeps the compartment` | 属性值里的裸 `>` |
| `tier tags written inside a properly closed tier stay text` | 正文里出现的 `<p1>` 当文本 |
| `compartment close and block tags written inside a body stay text` | 正文里的 `</compartment>` 当文本 |
| `bare legacy fact blocks are read outside compartment bodies` | 老式无标签 fact 块 |
| `anchors follow their compartment when compartments are emitted out of order` | compartment 乱序 |

**所以我们那次 `invalid JSON (position 1132, line 3 column 1116)` 不是解析器不够聪明，是格式选错了**：让模型写 6k 字符的 JSON，中文长句里一个未转义引号就整块报废；上游的标签格式天生不怕这个，因为每个字段的边界是标签而不是括号配对，缺一个闭合还能被 lenient 规则兜住。同目录还有 `validate-golden.json`（校验 corpus）与 `historian_chunk.rs`（187 KB 的分块实现，含 chunk 边界 tool-pairing 处理）。

→ **修法：把 historian 的输出契约从 JSON 换成上游的标签信封**（或至少移植 `historian_parse` 的 lenient 规则）。只做「JSON repair」是治标——它救得回尾逗号，救不回「模型把摘要里的引号原样写出来」这类整块损坏。

---

## 四、你担心的「隔一段时间回来」——上游的答案：TTL 是 band，不是重写开关

### 上游怎么做的

`packages/plugin/src/features/magic-context/scheduler.ts:116-119`（TS 侧，我们移植的正是这一份）：

```ts
const elapsedTime = currentTime - sessionMeta.lastResponseTime;
if (elapsedTime > ttlMs) {
    return "execute";
}
return "defer";
```

`crates/mc-module/src/scheduler.rs:513-556`（Rust 侧）同构：`should_execute` = `percentage >= threshold` **OR** `ttl_execute_fired(now, last_response, ttl)`。

`cache_ttl` 的语义（`CONFIGURATION.md:242`）写得很克制：

> `cache_ttl` is how long Magic Context **assumes** a provider's cached prefix stays valid — it is **MC's own deferral gate, not a control over the provider's cache**. … 默认 `"5m"`；GPT-5.6+ 默认 `30m`；`"never"` 表示**永不假设过期**，直接关掉 idle-TTL 启发式（#245，commit `8e496b8c1`）。

合起来就是：**idle 只是「允许动手」，不是「必须重写」；而且因为 idle 时缓存本来就已经没了，这一动手不额外收费。** 上游甚至在 `transform.rs:5074` 用 `idle_ttl_fired` 去**偏好 Hard plan**——只有在「缓存已经死了」这种时刻才舍得做全量重建。

### 我们的实测数据说明：按时间赌，是掷硬币

同一会话相邻两步的间隔 vs 命中率（`usage_records`，1726 步）：

| 间隔 | 步数 | 命中率 |
| --- | --- | --- |
| < 1 min | 1694 | 97.3% |
| 1–2 min | 36 | 95.8% |
| 2–5 min | 38 | 97.2% |
| 5–10 min | 13 | 71.9% |
| 10–30 min | 10 | 55.8% |
| 30–60 min | 4 | 32.5% |
| 1–6 h | 4 | 17.9% |
| **> 6 h** | 5 | **77.6%** ← 里面有一条 661 min 间隔、命中 **97.4%** |

散点更能说明问题：`736min → 27.6%`、`661min → 97.4%`、`397min → 95.6%`、`270min → 5.0%`、`35min → 0.0%`、`29min → 99.0%`、`17min → 98.7%`。

**时间不是这个 provider 缓存生死的预测变量**（DeepSeek 侧是容量淘汰，不是 TTL）。所以：

- 若把「idle > 5 min 就重写」当铁律 → 命中率 97% 的那些恢复会被我们自己打碎（你数据里 11 条「只活下来 32,768 token」的恢复步，正是这一类）；
- 若完全不看 idle → 缓存真死的那次，几十万 token 原样按未命中价重发，而当时其实是一个**免费重建窗口**。

上游的取舍恰好绕开这个二分：**band 照开，字节不动**——没事可回收就输出与上一轮逐字节相同的 prompt（`transform-decision-log.test.ts:67` 的用例名就是这个），有事可回收那一次反正不额外收费。**前提只有一个：渲染必须字节稳定——也就是 bug #1 必须先修。**

→ 这也解释了我们的 v0.49.44「反转」为什么当时看起来合理：**它是在给一个字节不稳的 baseline 打补丁**。同一份代码里，TTL band + 不稳定渲染 = 每分钟一次全量重写（我们记录的 122 次 TTL 驱动 pass，中位数压力只有 14.9%）。而 TTL band + 稳定渲染 = 只有真正回收时才花钱。

---

## 五、按上游口径重排的修复清单

| # | 项 | 上游依据 | 状态 |
| --- | --- | --- | --- |
| 1 | `refreshBaseline` 用**冻结时钟**渲染（HARD 才推进 `frozenAt`） | `m0_compose.rs:1-9` | **已落**（`src/dsh/management-pass.ts`，新增 `tests/baseline-clock-freeze.spec.ts`，841/841 绿） |
| 2 | 渲染去掉时间依赖：表头不带 `Nm ago`；档位改用**序号**而非 ageMs | `decay.rs:61-62,109` | 待落（#1 已让漂移归零，这一步是去掉「靠冻结时钟兜着」的隐患） |
| 3 | `executeThresholdTokens`（按模型绝对 token，clamp 90%） | `scheduler.rs:483-508`、`CONFIGURATION.md:296` | 待落（这条才是 `30% × 1M` 的正解） |
| 4 | 恢复 idle-TTL 为 execute band（默认 5 min，`"never"` 可关），并**只在 `baseline=unchanged` 前提下允许空转** | `scheduler.ts:116-119`、`CONFIGURATION.md:242-268` | 待落（依赖 #1；`tests/cache-ttl-no-rebuild.spec.ts` 需按新语义重写） |
| 5 | historian 输出契约改标签信封 + lenient 解析 | `historian-parse-golden.json`、`historian_validate.rs` | 待落（最大的一块） |
| 6 | historian 失败时**降 chunkTokens 重切**，而不是只抬 maxTokens | `historian_chunk.rs` | 待落 |

## 附：顺手发现的一个「门」的盲点

`scripts/baseline-stability.mjs` 的 `delta.byteStable` 判据本来该抓住 bug #1，但它在真实库上跑出 **0 violations**（43 条 baseline / 39 对 / 0 违规）。原因在豁免项：

```js
const recalled = recalls.some(r => r.sid === sid && Number(r.newRows) > 0 && r.at > prev.at && r.at <= row.at)
```

`memory-recall` 的 `newRows` 是「水位线以上的记忆条数」这一**存量**，不是「这一轮新写的条数」——长会话里它恒等于 36，于是每一对 baseline 都被判定「有回忆改写了载荷」而豁免。这条门在无记忆车道的会话上才有效。

（旁证：这条门 2026-10-15 曾抓到过一次 FAIL，当时的结论是「那不是记忆缺陷，是 hard→soft 的渲染差异」，于是加了 mode 豁免——今天回看，那次的 `35231≠31410` 很可能就是同一个时钟漂移。）
