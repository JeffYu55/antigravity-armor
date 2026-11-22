// 用 CDP 直接截「页面位图」——不受窗口遮挡/缩放影响，能证明 dock 真的在页面里
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'

const cfg = loadConfig()
const port = 9222
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && /^https?:/i.test(t.url || ''))
if (!page) { console.log('没有 http(s) page target'); process.exit(1) }

const shot = await new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const timer = setTimeout(() => reject(new Error('timeout')), 12000)
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }))
    ws.send(JSON.stringify({ id: 2, method: 'Page.captureScreenshot', params: { format: 'png', captureBeyondViewport: false } }))
  })
  ws.addEventListener('message', (e) => {
    let m
    try { m = JSON.parse(String(e.data)) } catch { return }
    if (m.id !== 2) return
    clearTimeout(timer)
    try { ws.close() } catch { /* 忽略 */ }
    if (m.error) return reject(new Error(JSON.stringify(m.error)))
    resolve(m.result.data)
  })
  ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')) })
})

mkdirSync(join(cfg.projectRoot, 'build'), { recursive: true })
const out = join(cfg.projectRoot, 'build', 'page-dock.png')
writeFileSync(out, Buffer.from(shot, 'base64'))
console.log('saved ' + out + '  (' + Buffer.from(shot, 'base64').length + 'B)  page=' + page.url)
