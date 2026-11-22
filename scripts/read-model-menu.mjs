// 从 Antigravity 的 UI 里直接读出模型列表（点开模型选择器，读菜单文本）
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && /^https:/i.test(t.url || ''))
if (!page) { console.log('no page'); process.exit(1) }

function call(expr) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    const timer = setTimeout(() => reject(new Error('timeout')), 12000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })))
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data))
      if (m.id !== 1) return
      clearTimeout(timer); try { ws.close() } catch { /* 忽略 */ }
      if (m.result?.exceptionDetails) return reject(new Error(m.result.exceptionDetails.text || 'exception'))
      resolve(m.result?.result?.value)
    })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')) })
  })
}

const before = await call(`(() => {
  const els = [...document.querySelectorAll('button, [role=button], div[role=combobox], [aria-haspopup]')];
  const hit = els.find((e) => /gemini|claude|gpt|flash|pro\\b/i.test((e.textContent || '').trim()) && (e.textContent || '').length < 40);
  return hit ? 'pick:' + hit.textContent.trim() : 'none';
})()`)
console.log('current picker: ' + before)

const clicked = await call(`(() => {
  const els = [...document.querySelectorAll('button, [role=button], div[role=combobox], [aria-haspopup]')];
  const hit = els.find((e) => /gemini|claude|gpt|flash|pro\\b/i.test((e.textContent || '').trim()) && (e.textContent || '').length < 40);
  if (!hit) return 'not-found';
  hit.click();
  return 'clicked:' + hit.textContent.trim();
})()`)
console.log('click -> ' + clicked)
await new Promise((r) => setTimeout(r, 1200))

const menu = await call(`(() => {
  const t = document.body.innerText || '';
  const lines = t.split('\\n').map((s) => s.trim()).filter(Boolean);
  const hits = lines.filter((s) => /gemini|claude|gpt|flash|pro|model/i.test(s) && s.length < 60);
  return JSON.stringify([...new Set(hits)].slice(0, 30));
})()`)
console.log('menu lines: ' + menu)
