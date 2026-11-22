// 多轮渐进探针：先给良性上下文，再给目标请求，看过滤器是否被历史"洗白"
import { readFileSync } from 'node:fs'
import { scoreResponse } from '../src/layers/scorer3.mjs'

const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`))
  if (!hit) return d
  const i = hit.indexOf('=')
  return i < 0 ? true : hit.slice(i + 1)
}
const model = String(arg('model') || 'gemini-4-neon-medium')
const seat = readFileSync(String(arg('seat') || 'assets/seat-exec.md'), 'utf8')
const text = String(arg('text') || '')
if (!text) { console.log('用法: --text="目标请求" [--history="u:...||m:..."]'); process.exit(1) }
const history = String(arg('history') || '')
  .split('||')
  .filter(Boolean)
  .map((s) => s.startsWith('m:') ? { role: 'model', text: s.slice(2) } : { role: 'user', text: s.replace(/^u:/, '') })

const res = await fetch('http://127.0.0.1:50100/armor/probe', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text, model, seat, history, maxTokens: Number(arg('maxTokens') || 2048) }),
})
const j = await res.json()
const s = scoreResponse(j.text || '', { finishKind: String(j.finish || '').toLowerCase() })
console.log(`HTTP ${j.status} ${j.ms}ms chars=${j.chars} toolCalls=${j.toolCalls || 0} verdict=${s.verdict}/${s.layer} history=${history.length}`)
console.log((j.text || j.body || '').slice(0, 200))
