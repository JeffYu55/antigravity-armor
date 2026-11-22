// 直接探针：走 divert 的 /armor/probe，用最近一次真实令牌跑一发，绕开 UI 队列
// 用法：node scripts/direct-probe.mjs --text="..." [--model=gemini-4-hydrogen-medium] [--seat=FILE]
import { readFileSync } from 'node:fs'
import { scoreResponse } from '../src/layers/scorer3.mjs'

const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`))
  if (!hit) return d
  const i = hit.indexOf('=')
  return i < 0 ? true : hit.slice(i + 1)
}
const text = String(arg('text') || '')
if (!text) { console.log('用法: --text="..."'); process.exit(1) }
const payload = { text, model: arg('model') || 'gemini-4-hydrogen-medium', maxTokens: Number(arg('maxTokens') || 1024) }
if (arg('seat')) payload.seat = readFileSync(String(arg('seat')), 'utf8')

const res = await fetch('http://127.0.0.1:50100/armor/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
const j = await res.json()
if (j.error) { console.log('probe error: ' + j.error); process.exit(1) }
const scored = scoreResponse(j.text || '', { finishKind: String(j.finish || '').toLowerCase() })
console.log('model     ' + j.model + '   HTTP ' + j.status + '  ' + j.ms + 'ms  finish=' + j.finish + '  chars=' + j.chars)
if (j.body) console.log('body      ' + String(j.body).replace(/\s+/g, ' ').slice(0, 600))
console.log('verdict   ' + scored.verdict + '/' + scored.layer + '  toolCalls=' + (j.toolCalls || 0) + '  words=' + JSON.stringify(scored.words))
console.log('--- head 300 ---')
console.log((j.text || '').slice(0, 300))
console.log('--- tail 500 ---')
console.log((j.text || '').slice(-500))
