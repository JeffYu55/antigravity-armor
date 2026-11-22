// 在 Antigravity 页面里直接试一次到控制面的 fetch，确认是不是被混内容/CSP 拦
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'

const cfg = loadConfig()
const token = readFileSync(join(cfg.hudDir, 'token.txt'), 'utf8').trim()
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && /^https:/i.test(t.url || ''))
if (!page) { console.log('no page'); process.exit(1) }

const expr = `fetch('http://127.0.0.1:50101/api/state', { headers: { 'X-Armor-Token': ${JSON.stringify(token)} } })
  .then(r => 'status=' + r.status + ' acao=' + r.headers.get('access-control-allow-origin'))
  .catch(e => 'ERR ' + e.message)`

const out = await new Promise((resolve) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })))
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data))
    if (m.id !== 1) return
    try { ws.close() } catch { /* 忽略 */ }
    resolve(m.result?.result?.value ?? JSON.stringify(m.result))
  })
  setTimeout(() => resolve('timeout'), 8000)
})
console.log(out)
