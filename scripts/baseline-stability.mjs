/**
 * baseline 缓存前缀稳定性 —— mc-acceptance 的 `delta.byteStable` 的唯一实现。
 *
 * 判据要回答的问题是：同载荷的两次 baseline，前缀字节为什么会变？只有**没有解释的**
 * 字节漂移才算不稳定（FAIL）。实证（2026-10-15，552 条 baseline / 518 对相邻事件）
 * 补全了三类解释，缺任何一条都会在真实运维里给出假 FAIL：
 *
 *  1. **mode 不同**（hard rebuild / soft refresh）。两种 mode 组装的 m[0] block 不是
 *     同一个东西：`rendered` / `newRows` 随 hard 归零（src/dsh/management-pass.ts:620、
 *     :626），即 hard 渲染全量、soft 只渲染增量；`bytes` 又是 block 的长度
 *     （management-pass.ts:630）。跨 mode 比字节等于比两种渲染，不是比"同载荷稳定"。
 *     2026-10-15 16:00:00→18:00:01（35231≠31410，reason=route-changed，载荷四段全等）
 *     就是这一形态 —— 它让 gate 红了一个窗口期。
 *  2. 期间 memory-recall 的行数**真的变了**（增量，不是存量）：载荷比对含
 *     `memories.digest` 与 `profile.digest`，记忆内容变了本就到不了违规分支；recall 能解释的
 *     只有 m[1] 增量区的增长——它改变 block 总长（`bytes`）却不动任何冻结字段。判据是
 *     recall 自己行数的**变化量**。2026-11-10 修正：旧规则用 `newRows > 0`（存量，长会话里恒
 *     36），于是任何一对相邻 baseline 都能被"解释"，真实库跑出 43 条 / 39 对 / 0 违规的假绿。
 *  3. 期间有 `drop-landed`：落地 drop 是记录在案的、有意的前缀重写。窗口必须是
 *     **闭区间 [prev.at, b.at]** —— 落地与 HARD rebuild 常在同一秒（2026-10-15
 *     16:00:00 九条 drop 与 baseline 同秒），开区间会漏掉这条解释。
 *
 * 载荷比对含 `profile` 段：soft refresh 只渲染**新增**画像行，漏比 profile 会把
 * "画像渲染变了"误判成无解释漂移（同一份 24h 窗口里就有这种对）。
 */

/** The payload segments a baseline freezes. `profile` was missing until 2026-10-15. */
const PAYLOAD_KEYS = ['memories', 'memoryUpdates', 'compartments', 'profile']

/** True when two baseline events froze the same payload (field-by-field JSON equality). */
export function sameBaselinePayload(a, b) {
  return PAYLOAD_KEYS.every(key => JSON.stringify(a?.[key]) === JSON.stringify(b?.[key]))
}

/**
 * Compare every pair of *adjacent* baselines inside one session.
 *
 * @param {{ baselines: readonly BaselineRow[], recalls?: readonly RecallRow[], drops?: readonly DropRow[] }} input
 *   `baselines` in time order; `recalls` carry the `newRows` count of a memory-recall
 *   row; `drops` are `drop-landed` journal rows (both session-scoped).
 * @returns {{ pairs: number, violations: readonly Violation[], explained: { mode: number, recall: number, drop: number } }}
 *   `pairs` = 相邻对总数（判据覆盖面）; `explained` = 每类豁免各解释了多少对。
 *   三者的和小于 `pairs` 时，剩下的就是**载荷字节一致、mode 相同**的干净对。
 */
export function findByteInstabilities(input) {
  const baselines = input.baselines ?? []
  const recalls = input.recalls ?? []
  const drops = input.drops ?? []

  const bySession = new Map()
  for (const row of baselines) {
    if (!bySession.has(row.sid)) bySession.set(row.sid, [])
    bySession.get(row.sid).push(row)
  }

  // Recalls per session, in time order, so the exemption can be decided on the
  // INCREMENT instead of on the stock.
  const recallsBySession = new Map()
  for (const recall of recalls) {
    if (!recallsBySession.has(recall.sid)) recallsBySession.set(recall.sid, [])
    recallsBySession.get(recall.sid).push(recall)
  }
  for (const list of recallsBySession.values()) list.sort((left, right) => left.at - right.at)

  /**
   * Does a memory-recall explain a byte change across (fromAt, toAt]?
   *
   * The old rule was `newRows > 0` for any recall inside the window, and it was
   * a blind spot: `newRows` is a STOCK (how many memory rows the recall saw,
   * ~36 in every long session), so in any long session there is always a recall
   * with newRows > 0 between two adjacent baselines — every pair got exempted
   * and the gate could never fire (43 baselines / 39 pairs / 0 violations on
   * the live store, 2026-11-10).
   *
   * The payload comparison already rules out a memory change (it includes
   * `memories.digest` and `profile.digest`), so the only thing a recall can
   * legitimately explain is growth in the m[1] delta region, which changes the
   * total block length without touching any frozen field. That shows up as a
   * change in the recall's own row count — the increment, not the stock.
   */
  const recallExplains = (sid, fromAt, toAt) => {
    const list = recallsBySession.get(sid) ?? []
    let inside
    let before
    for (const recall of list) {
      if (recall.at <= fromAt) before = recall
      else if (recall.at <= toAt) inside = recall
    }
    if (inside === undefined || Number(inside.newRows) <= 0) return false
    // First recall we ever see for this session: no stock to compare against,
    // so a non-zero count is the best available evidence.
    if (before === undefined) return true
    return Number(inside.newRows) !== Number(before.newRows)
  }

  const violations = []
  const explained = { mode: 0, recall: 0, drop: 0 }
  let pairs = 0
  for (const [sid, list] of bySession) {
    let prev
    for (const row of list) {
      if (prev !== undefined) {
        pairs += 1
        const sameMode = (prev.d?.mode ?? null) === (row.d?.mode ?? null)
        const recalled = recallExplains(sid, prev.at, row.at)
        const landed = drops.some(d => d.sid === sid && d.at >= prev.at && d.at <= row.at)
        const fromBytes = Number(prev.d?.bytes)
        const toBytes = Number(row.d?.bytes)
        if (!sameMode) explained.mode += 1
        else if (landed) explained.drop += 1
        else if (recalled) explained.recall += 1
        else if (sameBaselinePayload(prev.d, row.d) && fromBytes !== toBytes) {
          violations.push({ sessionId: sid, fromAt: prev.at, toAt: row.at, fromBytes, toBytes, mode: row.d?.mode ?? null })
        }
      }
      prev = row
    }
  }
  return { pairs, violations, explained }
}
