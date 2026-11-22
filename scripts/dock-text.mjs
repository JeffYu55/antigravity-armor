// 读取 dock 的实际文案（判断是否已连上控制面）
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && /^https?:/i.test(t.url || ''))
const expr = `(() => {
  const q = (s) => { const n = document.querySelector(s); return n ? n.textContent.trim() : null };
  return JSON.stringify({ title: q('#armor-dock .ad-title'), sub: q('#armor-dock .ad-sub'), hint: q('#armor-dock .ad-hint'),
    ta: (document.querySelector('#armor-dock textarea') || {}).value ? 'seat-loaded' : 'empty' });
})()`
const value = await new Promise((resolve) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })))
  ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id === 1) { try { ws.close() } catch { /* 忽略 */ } resolve(m.result?.result?.value) } })
  setTimeout(() => resolve('timeout'), 5000)
})
console.log(value)
