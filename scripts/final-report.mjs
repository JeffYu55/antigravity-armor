// 合并全部结果（clean + fix + fix2 + empty2），生成最终报告
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const FILES = ['state/bank/results-clean.jsonl', 'state/bank/results-fix.jsonl', 'state/bank/results-fix2.jsonl', 'state/bank/results-empty2.jsonl']
const base = new Map()
if (existsSync('state/bank/results-merged.jsonl')) {
  for (const l of readFileSync('state/bank/results-merged.jsonl', 'utf8').split('\n').filter(Boolean)) {
    try { const r = JSON.parse(l); base.set(r.id, r) } catch { /* 忽略 */ }
  }
}
// empty2 只覆盖原 final=empty 的题
for (const l of readFileSync('state/bank/results-empty2.jsonl', 'utf8').split('\n').filter(Boolean)) {
  try {
    const r = JSON.parse(l)
    const old = base.get(r.id)
    if (old && old.final === 'empty') {
      base.set(r.id, { ...old, final: r.final === 'pass' ? 'pass(C)' : 'empty', via: r.via || '', chars: r.chars || 0 })
    }
  } catch { /* 忽略 */ }
}
const all = [...base.values()].sort((a, b) => a.id - b.id)
writeFileSync('state/bank/results-final.jsonl', all.map((r) => JSON.stringify(r)).join('\n') + '\n')

const ok = all.filter((r) => r.final !== 'ERR')
const pass = ok.filter((r) => String(r.final).startsWith('pass'))
const c = {}
for (const r of ok) c[r.final] = (c[r.final] || 0) + 1

const cat = {}
for (const r of ok) {
  cat[r.cat] = cat[r.cat] || { t: 0, p: 0, b: 0 }
  cat[r.cat].t++
  if (String(r.final).startsWith('pass')) cat[r.cat].p++
  if (r.final === 'blocked') cat[r.cat].b++
}

const L = []
L.push('# 破甲题库 · 最终报告（含空响应捞回）')
L.push('')
L.push(`- 覆盖 ${all.length} 题（有效 ${ok.length}）`)
L.push(`- 阶梯：A=hydrogen 原样 → B=3.8+改写+soften → C=gpt-oss+改写+soften（空响应专项）`)
L.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`)
L.push('')
L.push(`## 通过率：${pass.length}/${ok.length} = ${(pass.length / ok.length * 100).toFixed(1)}%`)
L.push('')
L.push('明细：' + JSON.stringify(c))
L.push('')
L.push('| 类别 | 题数 | 通过 | 过滤拦 | 通过率 |')
L.push('|---|---|---|---|---|')
for (const [k, v] of Object.entries(cat).sort((a, b) => b[1].t - a[1].t)) {
  L.push(`| ${k} | ${v.t} | ${v.p} | ${v.b} | ${(v.p / v.t * 100).toFixed(0)}% |`)
}
L.push('')
L.push('| # | 类别 | 结果 | 途径 |')
L.push('|---|---|---|---|')
for (const r of all) {
  const f = String(r.final)
  const via = r.via ? ` (${r.via})` : (f === 'pass(A)' ? ' A直通' : f === 'pass(B)' ? ' B改写' : f === 'pass(C)' ? ' C捞回' : '')
  L.push(`| ${r.id} | ${r.cat} | ${f} |${via} |`)
}
writeFileSync('build/bank-report-final.md', L.join('\n') + '\n')
console.log(L.slice(0, 10).join('\n'))
console.log('报告: build/bank-report-final.md')
