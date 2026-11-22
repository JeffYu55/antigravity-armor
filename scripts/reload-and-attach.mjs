// 重载 Hub 页面后重新注入一次，并回读 dock 文案（用于验收）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { buildInjectExpression } from '../src/hud/cdp.mjs'

const cfg = loadConfig()
const token = readFileSync(join(cfg.hudDir, 'token.txt'), 'utf8').trim()
const port = 9222

async function targets() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  return list.filter((t) => t.type === 'page' && /^https?:/i.test(t.url || ''))
}
function call(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => { try { ws.close() } catch { /* 忽略 */ } reject(new Error('timeout ' + method)) }, 15000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method, params })))
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data))
      if (m.id !== 1) return
      clearTimeout(timer); try { ws.close() } catch { /* 忽略 */ }
      if (m.error) return reject(new Error(JSON.stringify(m.error)))
      resolve(m.result)
    })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')) })
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let page = (await targets())[0]
if (!page) { console.log('没有页面 target'); process.exit(1) }
console.log('reload ' + page.url)
await call(page.webSocketDebuggerUrl, 'Page.reload', { ignoreCache: false })
await sleep(9000)

page = (await targets())[0]
const expr = buildInjectExpression(cfg, token)
const r = await call(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: expr, returnByValue: true })
console.log('inject -> ' + (r.result ? r.result.value : JSON.stringify(r)))
await sleep(3500)

const probe = `(() => { const q=(s)=>{const n=document.querySelector(s);return n?n.textContent.trim():null};
  return JSON.stringify({title:q('#armor-dock .ad-title'),sub:q('#armor-dock .ad-sub'),hint:q('#armor-dock .ad-hint'),
  ta:(document.querySelector('#armor-dock textarea')||{}).value? 'seat-loaded':'empty'}); })()`
const t = await call(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: probe, returnByValue: true })
console.log('dock -> ' + (t.result ? t.result.value : JSON.stringify(t)))

const shot = await call(page.webSocketDebuggerUrl, 'Page.captureScreenshot', { format: 'png' })
mkdirSync(join(cfg.projectRoot, 'build'), { recursive: true })
const out = join(cfg.projectRoot, 'build', 'page-dock.png')
writeFileSync(out, Buffer.from(shot.data, 'base64'))
console.log('screenshot -> ' + out)
