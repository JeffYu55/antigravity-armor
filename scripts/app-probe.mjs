// 通过 CDP 驱动 Antigravity 的真实会话：写入 → 发送 → 轮询读回复 → 本地判定
//
// 为什么需要：上游是模型层拒绝，只能拿真实链路来量。这个脚本把「人手动点」变成可重复的探测。
// 用法：
//   node scripts/app-probe.mjs --text="<prompt>" [--wait=120] [--new=1] [--json]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { scoreResponse } from '../src/layers/scorer3.mjs'

const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`))
  if (!hit) return d
  const i = hit.indexOf('=')
  return i < 0 ? true : hit.slice(i + 1)
}
const cfg = loadConfig()
const text = String(arg('text') || '')
const waitMs = Number(arg('wait') || 120) * 1000
if (!text) { console.log('用法: --text="..."'); process.exit(1) }

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && /^https:/i.test(t.url || ''))
if (!page) { console.log('没有页面：Antigravity 是否带 --remote-debugging-port 起？'); process.exit(1) }

let seq = 0
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    const timer = setTimeout(() => { try { ws.close() } catch { /* */ } reject(new Error('timeout ' + method)) }, 20000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: ++seq, method, params })))
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data))
      if (!m.id) return
      clearTimeout(timer)
      try { ws.close() } catch { /* */ }
      m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result)
    })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')) })
  })
}
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text || 'js exception')
  return r?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 1) 找到输入区并写入文本（contenteditable：execCommand 才让 React 认到） */
const typed = await evalJs(`(() => {
  const eds = [...document.querySelectorAll('div[contenteditable="true"], textarea')]
    .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 80 && r.height > 10 })
    .filter((n) => !/systemInstruction/.test(n.getAttribute('placeholder') || ''));
  const el = eds.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  if (!el) return 'no-composer';
  el.focus();
  if (el.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const sel = window.getSelection(); const range = document.createRange();
    range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
    document.execCommand('insertText', false, ${JSON.stringify(text)});
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)} }));
  }
  return 'typed:' + (el.textContent || el.value || '').slice(0, 40);
})()`)
console.log('type -> ' + typed)

await sleep(400)

/** 2) 发送：优先按 Enter（composer 的 Enter 即发送），失败再找按钮点 */
let sent = 'none'
try {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  sent = 'enter'
} catch (e) { console.log('enter 失败: ' + e.message) }

await sleep(1500)
const stillThere = await evalJs(`(() => {
  const ed = [...document.querySelectorAll('div[contenteditable="true"]')].find((n) => n.getBoundingClientRect().width > 300);
  return ed ? (ed.textContent || '').trim().length : -1;
})()`)
if (stillThere > 0) {
  const clicked = await evalJs(`(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.y > 900; });
    const hit = btns.reverse().find((b) => /send|submit|发送/i.test((b.getAttribute('aria-label') || b.title || '') + b.className) ) || btns[btns.length - 1];
    if (!hit) return 'no-send';
    hit.click();
    return 'clicked:' + ((hit.getAttribute('aria-label') || hit.title || hit.className) + '').slice(0, 40);
  })()`)
  sent = clicked
  console.log('fallback click -> ' + clicked)
} else {
  console.log('composer 已清空 -> 视为已发送')
}

/** 3) 轮询回复：抓「最长且在增长」的文本块，稳定 4s 视为结束 */
const t0 = Date.now()
let last = ''
let stableSince = 0
let best = ''
while (Date.now() - t0 < waitMs) {
  await sleep(1500)
  const snap = await evalJs(`(() => {
    const nodes = [...document.querySelectorAll('div,article,section')]
      .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 300 && r.height > 20 });
    let best = '';
    for (const n of nodes) {
      const t = (n.innerText || '').trim();
      if (t.length > best.length && t.length < 60000) best = t;
    }
    return best.slice(-4000);
  })()`)
  if (snap && snap.length >= best.length) { best = snap; if (snap !== last) { last = snap; stableSince = Date.now() } }
  if (best && Date.now() - stableSince > 4000) break
}

const scored = scoreResponse(best, {})
console.log('---')
console.log('elapsed_s   ' + ((Date.now() - t0) / 1000).toFixed(1))
console.log('verdict     ' + scored.verdict + ' / ' + scored.layer + '  chars=' + best.length)
console.log('words       ' + JSON.stringify(scored.words))
console.log('--- 回复尾部 1200 字 ---')
console.log(best.slice(-1200))
