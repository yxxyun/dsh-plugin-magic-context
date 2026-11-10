/**
 * baseline-stability — the `delta.byteStable` criterion's regression suite.
 *
 * 2026-10-15 18:00/20:00 巡检在 gate 上抓到 FAIL：
 *   `delta.byteStable 1 处缓存前缀不稳定: session- 08:00:00→10:00:01 35231≠31410`
 * 取证实证（.tmp-diag/bytestable-pairs.cjs，552 条 baseline / 518 对）显示那不是记忆
 * 缺陷：该对是 **hard rebuild(reason=route-changed) → soft refresh**，四段载荷（含画像）
 * 逐字节相同，而 hard/soft 组装的 block 本来就不是同一个东西（management-pass.ts:620/:626
 * —— hard 把 rendered/newRows 归零），`bytes` 又是 block 长度（:630）。
 * 同时发现 profile 段从未参与"同载荷"比对，落地 drop 与 baseline 同秒发生时开区间漏判。
 *
 * 判据因此补两条豁免（mode 必须相同；drop-landed 闭区间）并把 profile 纳入比对。
 * 这些用例钉住两侧：**真实运维形态必须不再误报**，而**真有漂移必须仍然报**（纪律 ④）。
 */
import { describe, expect, it } from 'vitest'
import { findByteInstabilities, sameBaselinePayload } from '../scripts/baseline-stability.mjs'

const SID = 'session-byte-stable'
const T0 = 1_760_000_000_000
const HOUR = 3_600_000

interface Row { id: number; at: number; sid: string; d: Record<string, unknown> }

/** A frozen payload: the four segments the criterion compares. */
const payload = (over: Record<string, unknown> = {}) => ({
  memories: { rows: 40, digest: '69b2e96c6fae' },
  memoryUpdates: { pending: 0, rendered: 0, cursor: 546 },
  compartments: { baseline: 21, delta: 0 },
  profile: { rows: 18, newRows: 0, digest: '4689be992a54', watermark: 21 },
  ...over,
})

const baseline = (id: number, at: number, bytes: number, over: Record<string, unknown> = {}): Row =>
  ({ id, at, sid: SID, d: { mode: 'soft', bytes, estTokens: Math.round(bytes / 4), ...payload(), ...over } })

const run = (baselines: Row[], recalls: unknown[] = [], drops: unknown[] = []) =>
  findByteInstabilities({ baselines, recalls, drops } as never)

describe('sameBaselinePayload', () => {
  it('compares all four segments, including the profile block', () => {
    expect(sameBaselinePayload(payload(), payload())).toBe(true)
    expect(sameBaselinePayload(payload(), payload({ profile: { rows: 18, newRows: 4, digest: '4689be992a54', watermark: 21 } }))).toBe(false)
    expect(sameBaselinePayload(payload(), payload({ compartments: { baseline: 21, delta: 1 } }))).toBe(false)
  })
})

describe('findByteInstabilities', () => {
  it('flags the live soft→soft shape: same payload, same mode, no explanation, bytes differ', () => {
    const { pairs, violations } = run([baseline(1, T0, 30_000), baseline(2, T0 + HOUR, 29_500)])
    expect(pairs).toBe(1)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ sessionId: SID, fromBytes: 30_000, toBytes: 29_500, mode: 'soft' })
  })

  it('does NOT flag the live hard→soft pair (35231≠31410) — mode is the explanation', () => {
    // The exact 2026-10-15 16:00:00→18:00:01 pair: HARD rebuild (route-changed) then a
    // soft refresh, payload byte-identical, bytes −3821.
    const hard = baseline(1, T0, 35_231, { mode: 'hard', reason: 'route-changed' })
    const soft = baseline(2, T0 + 2 * HOUR, 31_410)
    expect(run([hard, soft]).violations).toEqual([])
    // …and the same byte pair WITH the same mode still fires, so the exemption is
    // about mode, not about "big deltas are fine".
    const softTwin = baseline(2, T0 + 2 * HOUR, 31_410)
    expect(run([{ ...hard, d: { ...hard.d, mode: 'soft' } }, softTwin]).violations).toHaveLength(1)
  })

  it('does NOT flag a pair whose window holds a landed drop at the previous baseline instant', () => {
    const before = baseline(1, T0, 35_231, { mode: 'hard' })
    const after = baseline(2, T0 + 2 * HOUR, 31_410, { mode: 'hard' })
    expect(run([before, after]).violations).toHaveLength(1)
    // Same-second landing (2026-10-15 16:00:00: nine drops landed with the baseline).
    expect(run([before, after], [], [{ sid: SID, at: T0 }]).violations).toEqual([])
    // A drop in the *previous* interval is not an explanation for this pair.
    expect(run([before, after], [], [{ sid: SID, at: T0 - HOUR }]).violations).toHaveLength(1)
    // Another session's landing never explains this session's drift.
    expect(run([before, after], [], [{ sid: 'session-other', at: T0 + HOUR }]).violations).toHaveLength(1)
  })

  it('does NOT flag a pair explained by a new-memory recall in between', () => {
    const before = baseline(1, T0, 30_000)
    const after = baseline(2, T0 + HOUR, 29_000)
    expect(run([before, after], [{ sid: SID, at: T0 + 60_000, newRows: 3 }]).violations).toEqual([])
    // newRows=0 (a recall that found nothing new) is not an explanation.
    expect(run([before, after], [{ sid: SID, at: T0 + 60_000, newRows: 0 }]).violations).toHaveLength(1)
  })

  it('does NOT flag a payload change — only unexplained byte drift counts', () => {
    const before = baseline(1, T0, 30_000)
    const after = baseline(2, T0 + HOUR, 26_000, { profile: { rows: 18, newRows: 4, digest: '4689be992a54', watermark: 21 } })
    expect(run([before, after]).violations).toEqual([])
  })

  it('stays clean on a byte-identical pair and only compares inside one session', () => {
    expect(run([baseline(1, T0, 30_000), baseline(2, T0 + HOUR, 30_000)]).violations).toEqual([])
    const other = { ...baseline(2, T0 + HOUR, 12_000), sid: 'session-other' }
    const { pairs, violations } = run([baseline(1, T0, 30_000), other])
    expect(pairs).toBe(0)
    expect(violations).toEqual([])
  })
})

/**
 * 2026-11-10 修正的假绿：`recalled` 曾经判 `newRows > 0`，而 `newRows` 是**存量**
 * （一次 recall 看见多少行记忆，长会话里恒 ~36）。于是任何一对相邻 baseline 之间都存在
 * 一条 `newRows > 0` 的 recall → 每一对都被"解释"→ 真实库 43 条 baseline / 39 对 /
 * 0 违规。判据改成看**增量**：载荷比对已含 `memories.digest`，记忆内容变了本就到不了
 * 违规分支，recall 能解释的只有 m[1] 增量区的增长（改 block 总长、不动任何冻结字段）。
 */
describe('findByteInstabilities — recall 豁免看增量，不看存量', () => {
  const recallRow = (at: number, newRows: number) => ({ sid: SID, at, newRows })

  it('恒定的存量行数不再豁免（假绿的根因）', () => {
    const { pairs, violations, explained } = run(
      [baseline(1, T0, 30_000), baseline(2, T0 + HOUR, 29_500)],
      [recallRow(T0 - 10 * HOUR, 36), recallRow(T0 + HOUR / 2, 36)],
    )
    expect(pairs).toBe(1)
    expect(explained.recall).toBe(0)
    expect(violations).toHaveLength(1)
  })

  it('行数真的涨了才豁免', () => {
    const { violations, explained } = run(
      [baseline(1, T0, 30_000), baseline(2, T0 + HOUR, 30_400)],
      [recallRow(T0 - 10 * HOUR, 36), recallRow(T0 + HOUR / 2, 39)],
    )
    expect(explained.recall).toBe(1)
    expect(violations).toHaveLength(0)
  })

  it('会话里第一次见到的 recall，只要非零就算证据', () => {
    const { violations, explained } = run(
      [baseline(1, T0, 30_000), baseline(2, T0 + HOUR, 30_400)],
      [recallRow(T0 + HOUR / 2, 12)],
    )
    expect(explained.recall).toBe(1)
    expect(violations).toHaveLength(0)
  })

  it('窗口外的 recall 不算（它解释不了这一段）', () => {
    const { violations, explained } = run(
      [baseline(1, T0, 30_000), baseline(2, T0 + HOUR, 29_500)],
      [recallRow(T0 - 5 * HOUR, 30), recallRow(T0 - 2 * HOUR, 36)],
    )
    expect(explained.recall).toBe(0)
    expect(violations).toHaveLength(1)
  })

  it('豁免拆账：三类计数之和不超过对数', () => {
    const rows = [
      baseline(1, T0, 30_000),
      baseline(2, T0 + HOUR, 30_100, { mode: 'hard' }),
      baseline(3, T0 + 2 * HOUR, 30_100),
      baseline(4, T0 + 3 * HOUR, 30_100),
    ]
    const { pairs, violations, explained } = run(
      rows,
      [recallRow(T0 - 10 * HOUR, 36), recallRow(T0 + 2.5 * HOUR, 38)],
      [{ sid: SID, at: T0 + 3 * HOUR }],
    )
    expect(pairs).toBe(3)
    expect(explained.mode).toBe(2) // soft→hard 与 hard→soft
    expect(explained.drop).toBe(1) // 同一秒落地的 drop
    expect(explained.recall).toBe(0)
    expect(violations).toHaveLength(0)
  })
})
