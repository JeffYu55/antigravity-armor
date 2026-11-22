// 点开齿轮 → 量位置 → 截图（验证「在对话框上方、不遮挡」以及三按钮面板）
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'

const cfg = loadConfig()
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && /^https:/i.test(t.url || ''))
if (!page) { console.log('no page'); process.exit(1) }

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    const timer = setTimeout(() => reject(new Error('timeout ' + method)), 10000)
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

await call('Runtime.evaluate', { expression: "document.getElementById('armor-gear').click(); 'clicked'", returnByValue: true })
await new Promise((r) => setTimeout(r, 1200))

const probe = `JSON.stringify((() => {
  const g = document.getElementById('armor-gear-host').getBoundingClientRect();
  const p = document.getElementById('armor-panel').getBoundingClientRect();
  const ta = document.querySelector('textarea');
  const c = ta ? ta.getBoundingClientRect() : null;
  const openPanel = document.getElementById('armor-panel').classList.contains('open');
  return {
    gear: [Math.round(g.x), Math.round(g.y), Math.round(g.width), Math.round(g.height)],
    panelOpen: openPanel,
    panel: [Math.round(p.x), Math.round(p.y), Math.round(p.width), Math.round(p.height)],
    composer: c ? [Math.round(c.x), Math.round(c.y), Math.round(c.width), Math.round(c.height)] : null,
    buttons: Array.from(document.querySelectorAll('#armor-panel button')).map((b) => b.textContent),
  };
})())`
const r = await call('Runtime.evaluate', { expression: probe, returnByValue: true })
console.log(r.result.value)

const shot = await call('Page.captureScreenshot', { format: 'png' })
mkdirSync(join(cfg.projectRoot, 'build'), { recursive: true })
const out = join(cfg.projectRoot, 'build', 'gear-panel.png')
writeFileSync(out, Buffer.from(shot.data, 'base64'))
console.log('shot -> ' + out)
