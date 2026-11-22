// 打印页面可见文本尾部（看 Working / 回复 / 队列状态）
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && /^https:/i.test(t.url || ''))
if (!page) { console.log('no page'); process.exit(0) }
const out = await new Promise((resolve) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: "document.body.innerText.slice(-600)", returnByValue: true } })))
  ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id === 1) { try { ws.close() } catch { /* */ } resolve(m.result?.result?.value) } })
  setTimeout(() => resolve('timeout'), 6000)
})
console.log(out)
