// 检查聊天输入区与发送按钮的 DOM 形状（为自动探测做准备）
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && /^https:/i.test(t.url || ''))
if (!page) { console.log('no page'); process.exit(1) }
function call(expr) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    const timer = setTimeout(() => reject(new Error('timeout')), 12000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })))
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data))
      if (m.id !== 1) return
      clearTimeout(timer); try { ws.close() } catch { /* 忽略 */ }
      resolve(m.result?.result?.value)
    })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws')) })
  })
}
const info = await call(`(() => {
  const out = { url: location.href, editables: [], buttons: [] };
  const cands = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')];
  for (const n of cands) {
    const r = n.getBoundingClientRect();
    out.editables.push({ tag: n.tagName, cls: (n.className || '').toString().slice(0, 60), ph: n.getAttribute('placeholder') || '', rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
  }
  for (const b of [...document.querySelectorAll('button')]) {
    const r = b.getBoundingClientRect();
    if (r.width === 0) continue;
    const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim().slice(0, 30);
    out.buttons.push({ label, cls: (b.className || '').toString().slice(0, 40), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
  }
  return JSON.stringify(out);
})()`)
const j = JSON.parse(info)
console.log('url: ' + j.url)
console.log('editables:')
for (const e of j.editables) console.log('  ' + JSON.stringify(e))
console.log('buttons:')
for (const b of j.buttons.slice(0, 20)) console.log('  ' + JSON.stringify(b))
