// CDP 注入 —— 不改宿主任何文件的内嵌 UI 路线
//
// 为什么换成这条路：重打包 asar 被 Electron 判为无效（应用退回 default_app），
// 解包目录与 NODE_OPTIONS 两条也实测起不来。剩下的干净路径是
// **用 Chromium 调试协议把 dock 打进已经在跑的 Hub 页面**：
//   * 需要应用带 --remote-debugging-port 启动（我们提供 launch / shortcut 两个入口）；
//   * 不碰 app.asar，不需要重打包，随宿主升级自然失效（只需重新 attach）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../config.mjs'

const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`))
  if (!hit) return d
  const i = hit.indexOf('=')
  return i < 0 ? true : hit.slice(i + 1)
}

export async function listTargets(port = 9222) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!res.ok) throw new Error('CDP /json/list ' + res.status + '（应用是否带 --remote-debugging-port 启动？）')
  const arr = await res.json()
  return arr.filter((t) => t.type === 'page' && /^https?:/i.test(t.url || ''))
}

/** 在某个 target 上执行一段表达式，返回结果值（字符串或 JSON） */
export function evaluate(wsUrl, expression, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let id = 1
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => { try { ws.close() } catch { /* 忽略 */ } reject(new Error('CDP evaluate 超时')) }, timeoutMs)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    })
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (msg.id !== id) return
      clearTimeout(timer)
      try { ws.close() } catch { /* 忽略 */ }
      if (msg.error) return reject(new Error('CDP error: ' + JSON.stringify(msg.error)))
      const r = msg.result && msg.result.result
      if (msg.result && msg.result.exceptionDetails) return reject(new Error('页面异常: ' + (msg.result.exceptionDetails.text || 'unknown')))
      resolve(r ? r.value : undefined)
    })
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('CDP 连接失败: ' + (e && e.message ? e.message : 'ws error'))) })
  })
}

/** 组装注入表达式：CSS + pageMain（取自 assets/armor-hud-inject.js，保证与主进程注入同一份代码） */
export function buildInjectExpression(cfg, token) {
  const src = readFileSync(join(cfg.projectRoot, 'assets', 'armor-hud-inject.js'), 'utf8')
  const s = src.indexOf('const CSS = `')
  const e = src.indexOf('\n`', s)
  const css = src.slice(s + 'const CSS = `'.length, e)
  const fnStart = src.indexOf('function pageMain(')
  let i = src.indexOf('{', fnStart)
  let depth = 0
  let fnEnd = -1
  for (let j = i; j < src.length; j++) {
    const c = src[j]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { fnEnd = j + 1; break } }
  }
  const pageMain = src.slice(fnStart, fnEnd)
  return `(() => {
    const CSS = ${JSON.stringify(css)};
    if (document.getElementById('armor-gear-host') && typeof window.__armorGearSync === 'function') {
      window.__armorGearSync();
      return 'reuse:' + location.href;
    }
    document.querySelectorAll('#armor-gear-host, #armor-dock').forEach((n) => n.remove());
    if (!document.getElementById('armor-gear-css')) {
      const st = document.createElement('style'); st.id = 'armor-gear-css'; st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    }
    window.__armorGearInstalled = false;
    ${pageMain}
    pageMain({ base: ${JSON.stringify('http://127.0.0.1:' + (cfg.hud.port || 50101))}, token: ${JSON.stringify(token)} });
    const g = document.getElementById('armor-gear-host');
    return 'ok:' + location.href + ' gear=' + !!g;
  })()`
}

export async function attachAll(cfg, token, { port = 9222 } = {}) {
  const targets = await listTargets(port)
  const out = []
  for (const t of targets) {
    try {
      const v = await evaluate(t.webSocketDebuggerUrl, buildInjectExpression(cfg, token))
      out.push({ url: t.url, ok: true, value: v })
    } catch (e) {
      out.push({ url: t.url, ok: false, error: e.message })
    }
  }
  return out
}

const invoked = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/hud/cdp.mjs')
if (invoked) {
  const cfg = loadConfig()
  const port = Number(arg('port') || 9222)
  const tokenPath = join(cfg.hudDir, 'token.txt')
  const token = readFileSync(tokenPath, 'utf8').trim()
  const rows = await attachAll(cfg, token, { port })
  for (const r of rows) console.log((r.ok ? 'ok   ' : 'fail ') + r.url + (r.ok ? '  -> ' + r.value : '  ' + r.error))
  if (!rows.length) console.log('没有可注入的 http(s) 页面 target')
}
