// 检查 host 里有没有 gear、panel 在不在
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && /^https:/i.test(t.url || ''))
const expr = `JSON.stringify({
  hostHTML: (document.getElementById('armor-gear-host') || { innerHTML: '(missing)' }).innerHTML.slice(0, 300),
  panel: !!document.getElementById('armor-panel'),
  label: !!document.getElementById('armor-gear-label'),
})`
const out = await new Promise((resolve) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })))
  ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id === 1) { try { ws.close() } catch { /* */ } resolve(m.result?.result?.value) } })
  setTimeout(() => resolve('timeout'), 8000)
})
console.log(out)
