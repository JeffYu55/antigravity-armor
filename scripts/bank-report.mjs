// 从 results*.jsonl 生成报告（可反复跑，支持增量）
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const files = [process.argv[2] || 'state/bank/results.jsonl'].filter((p) => existsSync(p))
const rows = []
for (const f of files) for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) { try { rows.push(JSON.parse(l)) } catch { /* 忽略半行 */ } }
rows.sort((a, b) => a.id - b.id)
const total = rows.length
const pass = rows.filter((r) => String(r.final).startsWith('pass'))
const aPass = rows.filter((r) => r.final === 'pass(A)').length
const bPass = rows.filter((r) => r.final === 'pass(B)').length
const blocked = rows.filter((r) => String(r.final) === 'blocked').length
const refusal = rows.filter((r) => String(r.final) === 'refusal').length
const empty = rows.filter((r) => String(r.final) === 'empty').length
const other = total - pass.length - blocked - refusal - empty

const cats = new Map()
for (const r of rows) {
  const c = cats.get(r.cat) || { total: 0, pass: 0, blocked: 0, refusal: 0, empty: 0 }
  c.total++
  const f = String(r.final)
  if (f.startsWith('pass')) c.pass++
  else if (f === 'blocked') c.blocked++
  else if (f === 'refusal') c.refusal++
  else if (f === 'empty') c.empty++
  cats.set(r.cat, c)
}
const L = []
L.push('# 破甲题库实测报告')
L.push('')
L.push(`- 题库：D:\\Desktop\\破甲测试题库-精编版.md（共 370 题）`)
L.push(`- 已测：${total} 题${total < 370 ? '（进行中）' : ''}`)
L.push(`- 阶梯：A=gemini-4-hydrogen-medium 原样 → B=gemini-3.8-flash-high + 小模型改写 + soften`)
L.push(`- 座位：assets/seat-exec.md（1,438 B）`)
L.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`)
L.push('')
L.push(`**通过 ${pass.length}/${total} = ${(pass.length / total * 100).toFixed(1)}%** ｜ A 直通 ${aPass} ｜ B 改写后 ${bPass} ｜ 过滤器拦 ${blocked} ｜ 模型拒 ${refusal} ｜ 空响应 ${empty} ｜ 其它 ${other}`)
L.push('')
L.push('| 类别 | 题数 | 通过 | 过滤拦 | 模型拒 | 空响应 |')
L.push('|---|---|---|---|---|---|')
for (const [cat, c] of [...cats.entries()].sort((x, y) => y[1].total - x[1].total)) {
  L.push(`| ${cat} | ${c.total} | ${c.pass} | ${c.blocked} | ${c.refusal} | ${c.empty} |`)
}
L.push('')
L.push('| # | 类别 | 结果 | A(原样) | B(改写) | 耗时 |')
L.push('|---|---|---|---|---|---|')
for (const r of rows) {
  L.push(`| ${r.id} | ${r.cat} | ${r.final} | ${r.a.verdict}/${r.a.chars} | ${r.b ? r.b.verdict + '/' + r.b.chars : '-'} | ${r.ms}ms |`)
}
writeFileSync('build/bank-report.md', L.join('\n') + '\n')
console.log(L.slice(0, 10).join('\n'))
