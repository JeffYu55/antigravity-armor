// 诊断齿轮点击为什么没打开面板
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && /^https:/i.test(t.url || ''))
const expr = `(() => {
  const g = document.getElementById('armor-gear');
  const p = document.getElementById('armor-panel');
  const before = p.className;
  let err = null;
  const onErr = (e) => { err = String(e.message || e); };
  window.addEventListener('error', onErr, { once: true });
  try { g.click(); } catch (e) { err = 'click-throw ' + e.message; }
  const after = p.className;
  return JSON.stringify({ before, after, err,
    hasSync: typeof window.__armorGearSync,
    hostY: Math.round(document.getElementById('armor-gear-host').getBoundingClientRect().y),
    panelDisplay: getComputedStyle(p).display,
    panelZ: getComputedStyle(p).zIndex });
})()`
const out = await new Promise((resolve) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })))
  ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id === 1) { try { ws.close() } catch { /* 忽略 */ } resolve(m.result?.result?.value) } })
  setTimeout(() => resolve('timeout'), 6000)
})
console.log(out)
