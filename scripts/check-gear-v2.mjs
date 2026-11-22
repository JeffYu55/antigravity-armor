// 验证新版齿轮：fixed 定位 / 状态文案 / 拖动 / 吸附
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && /^https:/i.test(t.url || ''))
if (!page) { console.log('no page'); process.exit(1) }
function call(expr) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    const timer = setTimeout(() => reject(new Error('timeout')), 15000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })))
    ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id !== 1) return; clearTimeout(timer); try { ws.close() } catch { /* */ } m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result?.result?.value) })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws')) })
  })
}
const r1 = await call(`(() => {
  const g = document.getElementById('armor-gear');
  const h = document.getElementById('armor-gear-host');
  if (!g || !h) return JSON.stringify({ err: 'no gear' });
  const gr = g.getBoundingClientRect();
  return JSON.stringify({
    pos: h.style.position, left: h.style.left, top: h.style.top,
    cls: g.className,
    label: (document.getElementById('armor-gear-label') || {}).textContent || '',
    st: (document.querySelector('#armor-panel .st') || {}).textContent || '',
  });
})()`)
console.log('gear state: ' + r1)

// 模拟拖动：mousedown → mousemove(150,80) → mouseup，检查 localStorage 与吸附
const r2 = await call(`(async () => {
  const g = document.getElementById('armor-gear');
  const gr = g.getBoundingClientRect();
  const cx = gr.x + gr.width / 2, cy = gr.y + gr.height / 2;
  g.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx, clientY: cy }));
  for (let i = 1; i <= 10; i++) {
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx + i * 15, clientY: cy + i * 8 }));
    await new Promise((r) => setTimeout(r, 30));
  }
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 2500));
  const h = document.getElementById('armor-gear-host');
  return JSON.stringify({ saved: localStorage.getItem('armorGearPos'), left: h.style.left, top: h.style.top, cls: g.className });
})()`)
console.log('after drag: ' + r2)

// 再看 3 秒后吸附是否保持（snapToCard 每 2s 跑一次）
const r3 = await call(`(async () => { await new Promise((r) => setTimeout(r, 3000)); const h = document.getElementById('armor-gear-host'); return JSON.stringify({ left: h.style.left, top: h.style.top }) })()`)
console.log('after snap: ' + r3)
