// 检查齿轮是否在页面里（自动 attach 之后应返回 gear:true）
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && /^https:/i.test(t.url || ''))
if (!page) { console.log('no-page'); process.exit(0) }
const expr = `JSON.stringify({
  url: location.href,
  gear: !!document.getElementById('armor-gear-host'),
  buttons: Array.from(document.querySelectorAll('#armor-panel button')).map((b) => b.textContent),
  seatBytes: (document.querySelector('#armor-panel textarea') || {}).value ? document.querySelector('#armor-panel textarea').value.length : 0,
})`
const out = await new Promise((resolve) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })))
  ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id === 1) { try { ws.close() } catch { /* 忽略 */ } resolve(m.result?.result?.value) } })
  setTimeout(() => resolve('timeout'), 6000)
})
console.log(out)
