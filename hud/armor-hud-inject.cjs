// armor HUD 注入器（主进程侧）—— P8' 内嵌 UI
//
// 与「悬浮窗」的区别：这不是独立窗口，而是注入到 Antigravity 自己的渲染页里，
// 贴在输入区上方的一条 dock（和富江在 DSH 里的 badge 同一个位置语义）。
//
// 为什么走主进程注入而不是 preload：宿主窗口是 sandbox:true + contextIsolation:true，
// preload 里拿不到 fs（读不到控制面 token）；主进程有 Node，可以用
// webContents.insertCSS / executeJavaScript 把 DOM 打进页面主世界。
'use strict'

const { app, webContents } = require('electron')
const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  base: process.env.AARMOR_HUD_URL || 'http://127.0.0.1:50101',
  tokenFile: process.env.AARMOR_HUD_TOKEN_FILE || '',
  projectRoot: process.env.AARMOR_ROOT || '',
}

/** 由安装脚本写在 dist/armor-hud.json：{ base, tokenFile } */
function readSidecar() {
  try {
    const p = path.join(__dirname, 'armor-hud.json')
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch { /* 忽略 */ }
  return {}
}

function logLine(msg) {
  try { fs.appendFileSync(path.join(require('os').tmpdir(), 'armor-hud-inject.log'), new Date().toISOString() + ' ' + msg + '\n') } catch { /* 忽略 */ }
}

function readToken() {
  if (process.env.AARMOR_HUD_TOKEN) return String(process.env.AARMOR_HUD_TOKEN).trim()
  const side = readSidecar()
  const cands = [
    DEFAULTS.tokenFile,
    side.tokenFile,
    side.projectRoot ? path.join(side.projectRoot, 'state', 'hud', 'token.txt') : '',
    DEFAULTS.projectRoot ? path.join(DEFAULTS.projectRoot, 'state', 'hud', 'token.txt') : '',
    'C:\\Users\\Administrator\\Projects\\antigravity-armor-2.34\\state\\hud\\token.txt',
  ].filter(Boolean)
  for (const p of cands) {
    try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim() } catch { /* 下一个 */ }
  }
  return ''
}

const CSS = `
#armor-dock, #armor-dock * { box-sizing: border-box; font-family: ui-monospace, Consolas, "Segoe UI", sans-serif; }
#armor-dock { position: fixed; left: 50%; transform: translateX(-50%); bottom: 10px; z-index: 2147483000;
  width: min(560px, 92vw); background: rgba(16,17,21,.96); color: #d6dee8; border: 1px solid rgba(16,185,129,.45);
  border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.45); font-size: 12px; overflow: hidden; }
#armor-dock .ad-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; user-select: none; }
#armor-dock .ad-dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; flex: none; }
#armor-dock .ad-title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#armor-dock .ad-sub { color: #8b949e; font-size: 11px; padding: 0 10px 6px; }
#armor-dock .ad-body { display: none; padding: 0 10px 10px; }
#armor-dock.ad-open .ad-body { display: block; }
#armor-dock textarea { width: 100%; height: 74px; resize: vertical; background: #171a21; color: #d6dee8;
  border: 1px solid #2a3038; border-radius: 6px; padding: 6px; font-size: 11.5px; line-height: 1.4; }
#armor-dock .ad-row { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
#armor-dock button { background: #1f2630; color: #d6dee8; border: 1px solid #313a46; border-radius: 6px;
  padding: 4px 9px; font-size: 11.5px; cursor: pointer; }
#armor-dock button:hover { border-color: #10b981; }
#armor-dock select { background: #1f2630; color: #d6dee8; border: 1px solid #313a46; border-radius: 6px; padding: 3px 6px; font-size: 11.5px; }
#armor-dock .ad-hint { color: #8b949e; font-size: 10.5px; margin-top: 6px; min-height: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`

/** 页面内代码（序列化后注入主世界；不要引用外部变量） */
function pageMain(cfg) {
  if (window.__armorDockInstalled) return
  window.__armorDockInstalled = true
  var base = cfg.base
  var token = cfg.token || ''
  var lane = 'neutral'
  var open = false
  var lastText = ''

  function el(tag, cls, text) {
    var d = document.createElement(tag)
    if (cls) d.className = cls
    if (text != null) d.textContent = text
    return d
  }
  function api(path, opts) {
    opts = opts || {}
    opts.headers = Object.assign({ 'X-Armor-Token': token }, opts.body ? { 'Content-Type': 'application/json' } : {})
    return fetch(base + path, opts).then(function (r) { return r.text().then(function (t) { return { ok: r.ok, code: r.status, body: t } }) })
  }
  function setDot(dock, color) { dock.querySelector('.ad-dot').style.background = color }

  var dock = el('div')
  dock.id = 'armor-dock'
  var head = el('div', 'ad-head')
  var dot = el('span', 'ad-dot')
  var title = el('span', 'ad-title', 'armor · 连接中…')
  var caret = el('span', null, '▾')
  head.appendChild(dot); head.appendChild(title); head.appendChild(caret)
  var sub = el('div', 'ad-sub', '')
  var body = el('div', 'ad-body')
  var ta = el('textarea')
  ta.placeholder = '在这里写要注入的提示词（会追加到 systemInstruction 末位）'
  var row1 = el('div', 'ad-row')
  var bApply = el('button', null, '应用(持久)')
  var bOnce = el('button', null, '注入一次')
  var bTtl = el('button', null, '注入10min')
  var bReset = el('button', null, '恢复默认')
  row1.appendChild(bApply); row1.appendChild(bOnce); row1.appendChild(bTtl); row1.appendChild(bReset)
  var row2 = el('div', 'ad-row')
  var sel = el('select')
  ;['neutral', 'armor'].forEach(function (v) { var o = el('option', null, v); o.value = v; sel.appendChild(o) })
  var bProbe = el('button', null, 'probe')
  var bHide = el('button', null, '收起')
  row2.appendChild(sel); row2.appendChild(bProbe); row2.appendChild(bHide)
  var hint = el('div', 'ad-hint', '')
  body.appendChild(ta); body.appendChild(row1); body.appendChild(row2); body.appendChild(hint)
  dock.appendChild(head); dock.appendChild(sub); dock.appendChild(body)

  function mount() {
    if (!document.body) return
    if (!document.getElementById('armor-dock')) document.body.appendChild(dock)
  }
  mount()
  new MutationObserver(function () { mount() }).observe(document.documentElement, { childList: true, subtree: true })

  head.addEventListener('click', function () {
    open = !open
    dock.classList.toggle('ad-open', open)
    caret.textContent = open ? '▴' : '▾'
    if (open) loadSeat()
  })
  bHide.addEventListener('click', function () {
    open = false; dock.classList.remove('ad-open'); caret.textContent = '▾'
  })

  function flash(msg) { hint.textContent = msg; }

  function refresh() {
    api('/api/state').then(function (r) {
      if (!r.ok) { title.textContent = 'armor · 控制面离线（aarmor hud start）'; dot.style.background = '#8b949e'; return }
      var s = JSON.parse(r.body)
      var v = s.controller && s.controller.verdict ? s.controller.verdict : null
      var label = v === 'pass' ? '已交付' : v === 'refusal' ? '拒答' : v === 'fallback' ? '软拒答'
        : v === 'blocked' ? '网关拦截' : v === 'truncated' ? '流截断' : v === 'empty' ? '空响应' : '待判定'
      var color = v === 'pass' ? '#10b981' : v === 'refusal' ? '#ef4444' : v ? '#f59e0b' : '#10b981'
      dot.style.background = color
      var extra = ''
      if (s.controller && s.controller.streak > 1) extra += ' · 连续' + s.controller.streak
      if (s.controller && s.controller.interventions && s.controller.interventions.injections) extra += ' · 纠正x' + s.controller.interventions.injections
      title.textContent = 'armor · ' + label + extra
      var layers = (s.layers.binary && s.layers.binary.armored ? '●' : '○') + (s.layers.ide && s.layers.ide.patched ? '●' : '○')
      sub.textContent = '宿主 ' + s.host.version + ' · 层 ' + layers + ' · 车道 ' + s.divert.lane + ' · 队列 ' + s.queued.length
      lane = s.divert.lane
      sel.value = lane
    }).catch(function () { title.textContent = 'armor · 控制面离线'; dot.style.background = '#8b949e' })
  }

  function loadSeat() {
    api('/api/seat').then(function (r) {
      if (!r.ok) return
      var j = JSON.parse(r.body)
      lastText = j.text || ''
      if (document.activeElement !== ta) ta.value = lastText
    }).catch(function () {})
  }

  function post(path, payload, okMsg) {
    api(path, { method: 'POST', body: JSON.stringify(payload) }).then(function (r) {
      if (!r.ok) { flash('失败 ' + r.code + ': ' + r.body.slice(0, 120)); return }
      flash(okMsg); refresh()
    }).catch(function (e) { flash('失败: ' + e.message) })
  }

  bApply.addEventListener('click', function () { post('/api/seat', { text: ta.value }, '已应用（每轮注入）') })
  bOnce.addEventListener('click', function () { post('/api/inject', { text: ta.value, mode: 'once' }, '已排队（下一发生效）') })
  bTtl.addEventListener('click', function () { post('/api/inject', { text: ta.value, mode: 'ttl', ttlSec: 600 }, '已排队（10 分钟内每轮生效）') })
  bReset.addEventListener('click', function () { post('/api/seat/reset', {}, '已恢复默认种子'); setTimeout(loadSeat, 300) })
  bProbe.addEventListener('click', function () { post('/api/probe', { attempts: 2 }, '已开始跑分（离线 mock）') })
  sel.addEventListener('change', function () { post('/api/lane', { lane: sel.value }, '车道已切换为 ' + sel.value) })

  refresh()
  setInterval(refresh, 2500)
}

function install() {
  const token = readToken()
  const cfg = { base: DEFAULTS.base, token }
  const page = '(' + pageMain.toString() + ')(' + JSON.stringify(cfg) + ')'
  const hooked = new WeakSet()

  const hook = (wc) => {
    if (!wc || hooked.has(wc)) return
    hooked.add(wc)
    const inject = () => {
      try {
        const url = wc.getURL ? wc.getURL() : ''
        if (!/^https?:/i.test(url)) return
        wc.insertCSS(CSS).catch(() => {})
        wc.executeJavaScript(page, true).then(() => logLine('injected ' + url)).catch((e) => logLine('inject-fail ' + url + ' ' + (e && e.message)))
      } catch { /* 注入失败不影响宿主 */ }
    }
    try {
      wc.on('did-finish-load', inject)
      wc.on('did-navigate-in-page', inject)
      if (wc.getURL && /^https?:/i.test(wc.getURL())) inject()
    } catch { /* 忽略 */ }
  }

  try { app.on('web-contents-created', (_e, wc) => hook(wc)) } catch { /* 忽略 */ }
  try { webContents.getAllWebContents().forEach(hook) } catch { /* 忽略 */ }
  logLine('install token=' + (token ? token.slice(0, 6) + '…' : '(missing)') + ' base=' + DEFAULTS.base)
  try { console.log('[armor-hud] installed, token=' + (token ? token.slice(0, 6) + '…' : '(missing)')) } catch { /* 忽略 */ }
}

module.exports = { install, readToken, CSS, pageMain }
