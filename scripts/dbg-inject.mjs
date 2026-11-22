// 调试版注入：pageMain 调用包 try/catch，把真实错误带出来
import { readFileSync } from 'node:fs'
import { loadConfig } from '../src/config.mjs'
import { buildInjectExpression } from '../src/hud/cdp.mjs'

const cfg = loadConfig()
const token = readFileSync('state/hud/token.txt', 'utf8').trim()
let expr = buildInjectExpression(cfg, token)
// 注入表达式末尾结构： ... pageMain({...}); const g = ...; return 'ok:...' })()
// 把裸调用包上 try/catch
expr = expr.replace(/(pageMain\(\{[\s\S]*?\n\s*\}\);)/, 'try {\n$1\n} catch (e) { window.__armorErr = String((e && e.message) || e) }')
expr += `; JSON.stringify({ gear: !!document.getElementById('armor-gear'), err: window.__armorErr || '' })`

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && /^https:/i.test(t.url || ''))
const out = await new Promise((resolve) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })))
  ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id !== 1) return; try { ws.close() } catch { /* */ } resolve(JSON.stringify({ res: m.result?.result?.value, err: m.result?.exceptionDetails?.exception?.description?.slice(0, 400) || '' })) })
  setTimeout(() => resolve('"timeout"'), 20000)
})
console.log(out)
