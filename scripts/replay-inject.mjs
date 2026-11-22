// 重放注入表达式并检查结果（定位齿轮为空的原因）
import { readFileSync } from 'node:fs'
import { loadConfig } from '../src/config.mjs'
import { buildInjectExpression } from '../src/hud/cdp.mjs'

const cfg = loadConfig()
const token = readFileSync('state/hud/token.txt', 'utf8').trim()
const expr = buildInjectExpression(cfg, token)
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && /^https:/i.test(t.url || ''))

const call = (expression, awaitP = false) => new Promise((resolve) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: awaitP } })))
  ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id !== 1) return; try { ws.close() } catch { /* */ } resolve(JSON.stringify({ res: m.result?.result?.value, err: m.result?.exceptionDetails?.exception?.description?.slice(0, 300) || m.result?.exceptionDetails?.text || '' })) })
  setTimeout(() => resolve('"timeout"'), 20000)
})

console.log('inject:', await call(expr))
await new Promise((r) => setTimeout(r, 3000))
console.log('after :', await call(`JSON.stringify({kids:(document.getElementById('armor-gear-host')||{children:[]}).children.length, gear:!!document.getElementById('armor-gear'), inst:window.__armorGearInstalled})`))
