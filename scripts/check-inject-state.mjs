// 检查注入器在页面里的状态
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && /^https:/i.test(t.url || ''))
if (!page) { console.log('no page'); process.exit(1) }
const expr = `JSON.stringify({
  url: location.href.slice(0, 60),
  hasHost: !!document.getElementById('armor-gear-host'),
  hasGear: !!document.getElementById('armor-gear'),
  installed: !!window.__armorGearInstalled,
  bodyKids: document.body ? document.body.children.length : -1,
  readyState: document.readyState,
})`
const out = await new Promise((resolve) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })))
  ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id === 1) { try { ws.close() } catch { /* */ } resolve(m.result?.result?.value) } })
  setTimeout(() => resolve('timeout'), 8000)
})
console.log(out)
