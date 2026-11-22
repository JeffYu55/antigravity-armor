// 最终报告 v2：合并 D 档（blocked 全捞回），输出完整逐题表
import { readFileSync, writeFileSync } from 'node:fs'

const rows = readFileSync('state/bank/results-final2.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const ok = rows.filter((r) => r.final !== 'ERR')
const pass = ok.filter((r) => String(r.final).startsWith('pass'))

const cat = {}
for (const r of ok) {
  cat[r.cat] = cat[r.cat] || { t: 0, p: 0 }
  cat[r.cat].t++
  if (String(r.final).startsWith('pass')) cat[r.cat].p++
}

const L = []
L.push('# 破甲题库 · 最终报告 v2（含 D 档全捞回）')
L.push('')
L.push(`- 覆盖 ${rows.length} 题（有效 ${ok.length}）`)
L.push(`- 阶梯：A=hydrogen 原样 → B=3.8+改写 → C=gpt-oss+改写（空响应捞回） → D=多策略（gpt-oss 原样/soften/分解式/框架前置）`)
L.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`)
L.push('')
L.push(`## 通过率：${pass.length}/${ok.length} = ${(pass.length / ok.length * 100).toFixed(1)}%`)
L.push('')
L.push('| 类别 | 题数 | 通过 | 通过率 |')
L.push('|---|---|---|---|')
for (const [k, v] of Object.entries(cat).sort((a, b) => b[1].t - a[1].t)) {
  L.push(`| ${k} | ${v.t} | ${v.p} | ${(v.p / v.t * 100).toFixed(0)}% |`)
}
L.push('')
L.push('| # | 类别 | 结果 | 途径 |')
L.push('|---|---|---|---|')
for (const r of rows) {
  const f = String(r.final)
  const via = r.via ? String(r.via) : (f === 'pass(A)' ? 'A直通' : f === 'pass(B)' ? 'B改写' : f === 'pass(C)' ? 'C捞回' : '')
  L.push(`| ${r.id} | ${r.cat} | ${f} | ${via} |`)
}
writeFileSync('build/bank-report-final2.md', L.join('\n') + '\n')
console.log(L.slice(0, 12).join('\n'))
console.log('报告: build/bank-report-final2.md')
