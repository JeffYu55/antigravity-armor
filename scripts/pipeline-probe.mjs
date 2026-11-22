// 端到端管线验证：原文 -> /armor/rewrite（小模型改写）-> soften -> /armor/probe -> verdict
// 用法：node scripts/pipeline-probe.mjs --text="..." [--model=gemini-4-hydrogen-medium] [--no-rewrite]
import { readFileSync, existsSync } from 'node:fs'
import { scoreResponse } from '../src/layers/scorer3.mjs'
import { softenText } from '../src/layers/soften.mjs'

const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`))
  if (!hit) return d
  const i = hit.indexOf('=')
  return i < 0 ? true : hit.slice(i + 1)
}
const text = String(arg('text') || '')
if (!text) { console.log('用法: --text="..."'); process.exit(1) }
const model = String(arg('model') || 'gemini-4-hydrogen-medium')
const seatFile = String(arg('seat') || 'assets/seat-argon-compact.md')
const seat = existsSync(seatFile) ? readFileSync(seatFile, 'utf8') : undefined

let stage1 = text
if (!process.argv.includes('--no-rewrite')) {
  const r = await fetch('http://127.0.0.1:50100/armor/rewrite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  const j = await r.json()
  if (j.status === 200 && j.text) stage1 = j.text
  console.log('rewrite   ' + j.status + ' -> ' + stage1.slice(0, 140))
}
const stage2 = softenText(stage1).text
console.log('soften    -> ' + stage2.slice(0, 140))

const res = await fetch('http://127.0.0.1:50100/armor/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: stage2, model, seat }) })
const j = await res.json()
if (j.error) { console.log('probe err ' + j.error); process.exit(1) }
const s = scoreResponse(j.text || '', { finishKind: String(j.finish || '').toLowerCase() })
console.log(`probe     HTTP ${j.status} ${j.ms}ms chars=${j.chars} verdict=${s.verdict}/${s.layer}`)
console.log('--- head 240 ---')
console.log((j.text || '').slice(0, 240))
