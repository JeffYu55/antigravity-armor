// 触发模型清单刷新：重载 Hub 根页面（会话页不会触发 fetchAvailableModels）
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { buildInjectExpression } from '../src/hud/cdp.mjs'

const cfg = loadConfig()
const token = readFileSync(join(cfg.hudDir, 'token.txt'), 'utf8').trim()
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const pages = list.filter((t) => t.type === 'page' && /^https:/i.test(t.url || ''))
console.log('pages:')
for (const p of pages) console.log('  ' + p.url)

// 优先根页面（路径为 /）
const root = pages.find((p) => /^https:\/\/127\.0\.0\.1:\d+\/?$/.test(p.url)) || pages[0]

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(root.webSocketDebuggerUrl)
    const timer = setTimeout(() => reject(new Error('timeout ' + method)), 12000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method, params })))
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data))
      if (m.id !== 1) return
      clearTimeout(timer); try { ws.close() } catch { /* 忽略 */ }
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')) })
  })
}

console.log('reload -> ' + root.url)
await call('Page.reload', { ignoreCache: false })
await new Promise((r) => setTimeout(r, 12000))
try {
  await call('Runtime.evaluate', { expression: buildInjectExpression(cfg, token), returnByValue: true })
  console.log('re-injected gear')
} catch (e) { console.log('inject skip: ' + e.message) }
