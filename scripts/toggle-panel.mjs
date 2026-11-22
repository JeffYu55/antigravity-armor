// 开/关齿轮面板：node scripts/toggle-panel.mjs open|close
const want = (process.argv[2] || 'open') === 'open'
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && /^https:/i.test(t.url || ''))
if (!page) { console.log('no page'); process.exit(1) }
const expr = `(() => {
  const p = document.getElementById('armor-panel');
  const isOpen = p.classList.contains('open');
  if (${want ? '!isOpen' : 'isOpen'}) document.getElementById('armor-gear').click();
  return JSON.stringify({ open: p.classList.contains('open'), cls: p.className });
})()`
const out = await new Promise((resolve) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })))
  ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id === 1) { try { ws.close() } catch { /* 忽略 */ } resolve(m.result?.result?.value) } })
  setTimeout(() => resolve('timeout'), 6000)
})
console.log(out)
