// 诊断：Antigravity 页面里 dock 到底在不在、被什么挡住
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const pages = list.filter((t) => t.type === 'page' && /^https?:/i.test(t.url || ''))
const expr = `(() => {
  const d = document.getElementById('armor-dock');
  const cs = d ? getComputedStyle(d) : null;
  const r = d ? d.getBoundingClientRect() : null;
  return JSON.stringify({
    href: location.href,
    dock: !!d,
    css: !!document.getElementById('armor-dock-css'),
    cls: d ? d.className : null,
    rect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
    pos: cs ? cs.position : null,
    z: cs ? cs.zIndex : null,
    display: cs ? cs.display : null,
    visibility: cs ? cs.visibility : null,
    opacity: cs ? cs.opacity : null,
    bodyChildren: document.body ? document.body.children.length : -1,
    inner: [innerWidth, innerHeight],
    scroll: [scrollX, scrollY],
    csp: (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || null,
  });
})()`

for (const t of pages) {
  const value = await new Promise((resolve) => {
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    const timer = setTimeout(() => resolve('timeout'), 5000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })))
    ws.addEventListener('message', (e) => {
      let m
      try { m = JSON.parse(String(e.data)) } catch { return }
      if (m.id !== 1) return
      clearTimeout(timer)
      try { ws.close() } catch { /* 忽略 */ }
      if (m.result && m.result.exceptionDetails) return resolve('EXC ' + (m.result.exceptionDetails.text || ''))
      resolve(m.result && m.result.result ? m.result.result.value : 'no-result')
    })
    ws.addEventListener('error', () => { clearTimeout(timer); resolve('ws-error') })
  })
  console.log(t.url.slice(0, 60))
  console.log('  ' + value)
}
