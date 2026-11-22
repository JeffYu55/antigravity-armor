// 停掉当前正在跑的 agent 回合，并清空待发队列（UI 卡住时用）
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && /^https:/i.test(t.url || ''))
if (!page) { console.log('no page'); process.exit(0) }
function call(expr) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    const timer = setTimeout(() => reject(new Error('timeout')), 10000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })))
    ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id !== 1) return; clearTimeout(timer); try { ws.close() } catch { /* */ } resolve(m.result?.result?.value) })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws')) })
  })
}
const clicked = await call(`(() => {
  const btns = [...document.querySelectorAll('button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 });
  const st = btns.find((b) => /stop|停止|cancel|放弃/i.test((b.getAttribute('aria-label') || '') + (b.title || '') + (b.textContent || '')));
  if (st) { st.click(); return 'stopped:' + ((st.getAttribute('aria-label') || st.title || st.textContent || '') + '').slice(0, 30) }
  return 'no-stop-button';
})()`)
console.log(clicked)
await new Promise((r) => setTimeout(r, 1500))
const after = await call(`(() => (document.body.innerText.match(/Working|Queued Messages/g) || []).join(','))()`)
console.log('state: ' + after)
