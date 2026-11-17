/**
 * How much of every request is fixed?
 *
 * Every step resends the same system prompt, the same tool definitions and the
 * same request envelope. None of that appears in `persisted_docs`, so no
 * character-derived estimate can ever see it — which is exactly why the
 * composition-weighted estimator failed to reduce the error.
 *
 * This measures it directly: the FIRST step of a session carries the fixed
 * overhead plus one user message, so
 *
 *     fixedOverhead ≈ firstPromptTokens − estimate(firstUserMessage)
 *
 * Grouped by route, because the system prompt and tool set differ per model.
 * The number this produces is the term the pressure calculation is missing.
 */
import { DatabaseSync } from 'node:sqlite'

const mdb = new DatabaseSync('C:/Users/yxx/.local/share/cortexkit/magic-context-dsh-poc/dsh-magic-context.db', { readOnly: true })
const sdb = new DatabaseSync('C:/Users/yxx/.dsh/session-search.db', { readOnly: true })
const mq = (s, ...p) => mdb.prepare(s).all(...p)
const sq = (s, ...p) => sdb.prepare(s).all(...p)
const fmt = n => Number(n).toLocaleString('en-US')

console.log('='.repeat(78))
console.log('每步固定开销实测')
console.log('='.repeat(78))

// 每个会话的第一步
const firsts = mq(`
  SELECT u.session_id, u.seq, u.provider, u.model,
         COALESCE(u.input_tokens,0) + COALESCE(u.cache_read_tokens,0) + COALESCE(u.cache_write_tokens,0) AS prompt
  FROM usage_records u
  JOIN (SELECT session_id, MIN(seq) AS s FROM usage_records GROUP BY session_id) f
    ON f.session_id = u.session_id AND f.s = u.seq
  WHERE COALESCE(u.input_tokens,0) + COALESCE(u.cache_read_tokens,0) + COALESCE(u.cache_write_tokens,0) > 0`)

console.log(`\n【1】会话数 ${fmt(firsts.length)}`)

const byRoute = new Map()
for (const f of firsts) {
  const key = `${f.provider}/${f.model}`
  if (!byRoute.has(key)) byRoute.set(key, [])
  byRoute.get(key).push(f)
}

console.log('\n【2】按路由统计首步 prompt（含固定开销 + 1 条用户消息）')
for (const [route, list] of [...byRoute].sort((a, b) => b[1].length - a[1].length)) {
  const vals = list.map(f => f.prompt).sort((a, b) => a - b)
  const med = vals[Math.floor(vals.length / 2)]
  const min = vals[0]
  const max = vals.at(-1)
  console.log(`  ${route.slice(0, 40).padEnd(42)} n=${String(list.length).padStart(4)}  中位 ${fmt(med).padStart(9)}  最小 ${fmt(min).padStart(9)}  最大 ${fmt(max).padStart(9)}`)
}

// ---- 3. 扣掉首条用户消息的字符估算 -------------------------------------
console.log('\n【3】扣掉首条用户消息后的固定开销')
for (const [route, list] of [...byRoute].sort((a, b) => b[1].length - a[1].length).slice(0, 4)) {
  const overheads = []
  for (const f of list.slice(0, 200)) {
    // 该会话第一条 user/message 的字符数
    const first = sq(`SELECT codepoint_length FROM persisted_docs
      WHERE session_id = ? AND type = 'user/message' ORDER BY seq LIMIT 1`, f.session_id)[0]
    const chars = first?.codepoint_length ?? 0
    overheads.push(f.prompt - Math.ceil(chars / 4))
  }
  if (overheads.length === 0) continue
  const vals = overheads.sort((a, b) => a - b)
  const med = vals[Math.floor(vals.length / 2)]
  console.log(`  ${route.slice(0, 40).padEnd(42)} n=${String(vals.length).padStart(3)}  固定开销中位 ${fmt(med).padStart(8)} tok  最小 ${fmt(vals[0]).padStart(8)}`)
}

// ---- 4. 稳态下的 prompt 构成：固定 vs 增量 ------------------------------
console.log('\n【4】稳态对比：每步 prompt 中固定开销占多少')
for (const [route, list] of [...byRoute].sort((a, b) => b[1].length - a[1].length).slice(0, 3)) {
  if (list.length < 20) continue
  const sid = list[0].session_id
  const steps = mq(`SELECT COALESCE(input_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0) AS p
    FROM usage_records WHERE session_id = ? ORDER BY seq`, sid)
  const vals = steps.map(s => s.p).filter(v => v > 0).sort((a, b) => a - b)
  const p50 = vals[Math.floor(vals.length / 2)]
  const p10 = vals[Math.floor(vals.length * 0.1)]
  // 该会话可见文档总字符
  const totalChars = sq(`SELECT COALESCE(SUM(codepoint_length),0) AS c FROM persisted_docs WHERE session_id = ?`, sid)[0].c
  console.log(`  ${route.slice(0, 34).padEnd(36)} 步数 ${String(vals.length).padStart(4)}  prompt p10 ${fmt(p10).padStart(8)} 中位 ${fmt(p50).padStart(8)}`)
  console.log(`    可见文档 ${fmt(totalChars)} 字符 ≈ ${fmt(Math.round(totalChars / 4))} tok（chars/4）`)
  console.log(`    → 固定开销至少 ${fmt(Math.max(0, p10 - Math.round(totalChars / 4))).padStart(8)} tok（p10 − 全量字符估算）`)
}

mdb.close(); sdb.close()
