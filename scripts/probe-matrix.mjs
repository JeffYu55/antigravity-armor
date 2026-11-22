// 探针矩阵：多模型 × 多座位，量化「谁会给交付物」
// 用法：node scripts/probe-matrix.mjs --text="..." [--models=a,b,c] [--seats=file1,file2]
import { readFileSync, existsSync } from 'node:fs'
import { scoreResponse } from '../src/layers/scorer3.mjs'
import { REFRAME_PAIRS } from '../src/layers/gemini-retry.mjs'
import { softenText } from '../src/layers/soften.mjs'

const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`))
  if (!hit) return d
  const i = hit.indexOf('=')
  return i < 0 ? true : hit.slice(i + 1)
}
const text = String(arg('text') || '')
if (!text) { console.log('用法: --text="..."'); process.exit(1) }
const models = String(arg('models') || 'gemini-4-hydrogen-medium,gemini-4-neon-medium,gemini-4-argon,claude-opus-5-5').split(',')
const seatFiles = String(arg('seats') || 'assets/seat-argon-compact.md').split(',')
const reframe = process.argv.includes('--reframe')
let sendText = text
if (process.argv.includes('--soften')) {
  const s = softenText(sendText)
  sendText = s.text
  console.log('soften: ' + s.hits.length + ' 条 -> ' + sendText.slice(0, 140))
}
if (reframe) {
  let n = 0
  for (const [re, rep] of REFRAME_PAIRS) { const before = sendText; sendText = sendText.replace(re, rep); if (before !== sendText) n++ }
  console.log('reframe: ' + n + ' 处 -> ' + sendText.slice(0, 120))
}
const seats = seatFiles

const rows = []
for (const seatFile of seats) {
  const seat = existsSync(seatFile) ? readFileSync(seatFile, 'utf8') : undefined
  for (const model of models) {
    const t0 = Date.now()
    try {
      const res = await fetch('http://127.0.0.1:50100/armor/probe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: sendText, model, seat }),
      })
      const j = await res.json()
      if (j.error) { rows.push({ seat: seatFile, model, verdict: 'ERR', note: j.error }); continue }
      const s = scoreResponse(j.text || '', { finishKind: String(j.finish || '').toLowerCase() })
      rows.push({
        seat: seatFile.split(/[\\/]/).pop(), model, http: j.status, ms: j.ms, chars: j.chars,
        verdict: s.verdict + '/' + s.layer, head: (j.text || '').slice(0, 90).replace(/\s+/g, ' '),
        note: j.status !== 200 ? String(j.body || '').slice(0, 120).replace(/\s+/g, ' ') : '',
      })
    } catch (e) {
      rows.push({ seat: seatFile, model, verdict: 'NET', note: e.message })
    }
  }
}
for (const r of rows) {
  console.log([String(r.seat || '').padEnd(24), String(r.model).padEnd(28), String(r.verdict || '').padEnd(16),
    String(r.http ?? '').padEnd(4), String(r.ms ?? '').padEnd(6), String(r.chars ?? '').padEnd(5),
    (r.head || r.note || '')].join(' '))
}
