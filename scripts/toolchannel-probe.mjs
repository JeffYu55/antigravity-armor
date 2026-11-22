// 工具通道探针：走 agent 请求体（带 tools），看模型是否用 run_command 之类工具把内容落地，
// 而不是在正文里写被过滤器拦的东西。
import { readFileSync } from 'node:fs'

const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`))
  if (!hit) return d
  const i = hit.indexOf('=')
  return i < 0 ? true : hit.slice(i + 1)
}
const model = String(arg('model') || 'gemini-4-neon-medium')
const seat = readFileSync(String(arg('seat') || 'assets/seat-exec.md'), 'utf8')
const text = String(arg('text') || '')
if (!text) { console.log('用法: --text="..." [--model=...]'); process.exit(1) }
const res = await fetch('http://127.0.0.1:50100/armor/probe', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text, model, seat, replay: true, maxTokens: Number(arg('maxTokens') || 4096) }),
})
const j = await res.json()
console.log(`model=${j.model} HTTP ${j.status} ${j.ms}ms chars=${j.chars} toolCalls=${j.toolCalls} finish=${j.finish}`)
console.log('--- body head ---')
console.log(String(j.body || '').replace(/\s+/g, ' ').slice(0, 600))
