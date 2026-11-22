// 对基线未通过的题跑第三档：gpt-oss-120b-medium + 改写 + soften，看能不能再捞一批回来
// 用法：node scripts/bank-retry-fail.mjs [--model=gemini-3.8-flash-high|gpt-oss-120b-medium]
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { scoreResponse } from '../src/layers/scorer3.mjs'
import { softenText } from '../src/layers/soften.mjs'

const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`))
  if (!hit) return d
  const i = hit.indexOf('=')
  return i < 0 ? true : hit.slice(i + 1)
}
const BASE = 'state/bank/results.jsonl'
const OUT = 'state/bank/results-c.jsonl'
const FILE = String(arg('file') || 'D:\\Desktop\\破甲测试题库-精编版.md')
const MODEL = String(arg('model') || 'gpt-oss-120b-medium')
const CONC = Math.max(1, Number(arg('concurrency') || 3))
const SEAT = readFileSync('assets/seat-exec.md', 'utf8')

const bank = new Map()
for (const line of readFileSync(FILE, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*(\d+)\.\s*(.+)$/)
  if (m) bank.set(Number(m[1]), m[2].trim())
}
const base = readFileSync(BASE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const todo = base.filter((r) => !String(r.final).startsWith('pass')).map((r) => r.id)
console.log('基线未通过 ' + todo.length + ' 题，用 ' + MODEL + ' 重跑')

async function rewrite(text) {
  try {
    const r = await fetch('http://127.0.0.1:50100/armor/rewrite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    const j = await r.json()
    return j.status === 200 && j.text ? j.text : ''
  } catch { return '' }
}
async function probe(text, model) {
  const res = await fetch('http://127.0.0.1:50100/armor/probe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model, seat: SEAT, maxTokens: 8192 }),
  })
  return res.json()
}

const out = []
let i = 0
async function worker() {
  while (i < todo.length) {
    const id = todo[i++]
    const q = bank.get(id) || ''
    const rw = await rewrite(q)
    const soft = softenText(rw || q).text
    const t0 = Date.now()
    let rec = { id, model: MODEL, verdict: 'ERR', chars: 0, ms: 0 }
    try {
      const j = await probe(soft, MODEL)
      const s = scoreResponse(j.text || '', { finishKind: String(j.finish || '').toLowerCase() })
      rec = { id, model: MODEL, verdict: s.verdict, layer: s.layer, chars: j.chars || 0, status: j.status || 0, ms: Date.now() - t0 }
    } catch (e) { rec.err = e.message }
    out.push(rec)
    console.log(`[${id}] ${rec.verdict}/${rec.chars} ${rec.ms}ms`)
  }
}
await Promise.all(Array.from({ length: CONC }, worker))
writeFileSync(OUT, out.map((r) => JSON.stringify(r)).join('\n') + '\n')
const pass = out.filter((r) => r.verdict === 'pass').length
console.log(`\nC 档救回 ${pass}/${out.length}`)
