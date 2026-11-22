// armor HUD 注入器（主进程 / CDP 共用同一份 pageMain）
//
// UI 形态按用户要求：**对话框上方一枚小齿轮**（在文档流里，不遮挡任何元素），
// 点齿轮弹出小面板，面板里只有三个动作：应用 / 取消 / 恢复默认。
'use strict'

const { app, webContents } = require('electron')
const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  base: process.env.AARMOR_HUD_URL || 'http://127.0.0.1:50101',
  tokenFile: process.env.AARMOR_HUD_TOKEN_FILE || '',
  projectRoot: process.env.AARMOR_ROOT || '',
}

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
    'C:\\Users\\Administrator\\Projects\\antigravity-armor-2.34\\state\\hud\\token.txt',
  ].filter(Boolean)
  for (const p of cands) {
    try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim() } catch { /* 下一个 */ }
  }
  return ''
}

const CSS = `
#armor-gear-host { position: relative; display: flex; justify-content: flex-end; align-items: center;
  height: 22px; margin: 0 2px 2px; pointer-events: none; }
#armor-gear-host > * { pointer-events: auto; }
#armor-gear { width: 20px; height: 20px; border-radius: 50%; border: 1px solid rgba(120,130,145,.45);
  background: rgba(20,22,28,.85); color: #9aa7b5; font-size: 12px; line-height: 18px; text-align: center;
  cursor: pointer; padding: 0; user-select: none; transition: transform .12s ease, color .12s ease; }
#armor-gear:hover { color: #e6edf3; border-color: #10b981; transform: rotate(18deg); }
#armor-gear .dot { position: absolute; right: -2px; top: -2px; width: 6px; height: 6px; border-radius: 50%;
  background: #10b981; box-shadow: 0 0 6px rgba(16,185,129,.8); }
#armor-panel { position: absolute; right: 0; bottom: calc(100% + 6px); width: 430px; max-width: 90vw;
  background: #12141a; color: #d6dee8; border: 1px solid rgba(16,185,129,.35); border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,.45); padding: 10px; font-family: ui-monospace, Consolas, "Segoe UI", sans-serif;
  font-size: 12px; z-index: 2147483000; display: none; }
#armor-panel.open { display: block; }
#armor-panel .ttl { color: #8b949e; font-size: 11px; margin-bottom: 6px; display: flex; justify-content: space-between; }
#armor-panel textarea { width: 100%; height: 96px; resize: vertical; background: #171a21; color: #d6dee8;
  border: 1px solid #2a3038; border-radius: 6px; padding: 6px; font-size: 11.5px; line-height: 1.45; }
#armor-panel .row { display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; }
#armor-panel button { background: #1f2630; color: #d6dee8; border: 1px solid #313a46; border-radius: 6px;
  padding: 4px 12px; font-size: 11.5px; cursor: pointer; }
#armor-panel button.primary { border-color: #10b981; color: #b9f5da; }
#armor-panel button:hover { border-color: #10b981; }
#armor-panel .hint { color: #8b949e; font-size: 10.5px; margin-top: 6px; min-height: 14px; }
`

/** 页面内代码：在输入区上方挂一枚齿轮，点开是三按钮面板 */
function pageMain(cfg) {
  if (window.__armorGearInstalled) { if (window.__armorGearSync) window.__armorGearSync(); return }
  window.__armorGearInstalled = true
  var base = cfg.base
  var token = cfg.token || ''
  var open = false
  var lastText = ''
  var panelEl = null
  var hostEl = null
  var gearEl = null
  var taEl = null
  var hintEl = null
  var dotEl = null

  function api(path, opts) {
    opts = opts || {}
    opts.headers = Object.assign({ 'X-Armor-Token': token }, opts.body ? { 'Content-Type': 'application/json' } : {})
    opts.cache = 'no-store'
    return fetch(base + path, opts)
  }

  /** 找输入框：可见、面积最大的 textarea / contenteditable */
  function findComposer() {
    var cands = [].slice.call(document.querySelectorAll('textarea, [contenteditable="true"]'))
    var best = null
    var bestArea = 0
    for (var i = 0; i < cands.length; i++) {
      var n = cands[i]
      var r = n.getBoundingClientRect()
      if (r.width < 80 || r.height < 12) continue
      var st = getComputedStyle(n)
      if (st.display === 'none' || st.visibility === 'hidden') continue
      var area = r.width * r.height
      if (area > bestArea) { bestArea = area; best = n }
    }
    return best
  }

  /** 齿轮宿主插到输入框「所在块」的上方（文档流，不遮挡） */
  function mount() {
    if (document.getElementById('armor-gear-host')) return true
    var composer = findComposer()
    if (!composer) return false
    // 往上找到「输入卡片」：高度还小、但父级已经是整列（>=200px）的那一层。
    // 齿轮插在卡片**前面**，因此它在文档流里、位于对话框上方，不压任何元素。
    var node = composer
    var card = composer
    while (node && node.parentElement) {
      var r = node.getBoundingClientRect()
      if (r.height >= 200) break
      card = node
      node = node.parentElement
    }
    var host = document.createElement('div')
    host.id = 'armor-gear-host'
    var gear = document.createElement('button')
    gear.id = 'armor-gear'
    gear.title = 'armor 座位（点开设置注入提示词）'
    gear.textContent = '⚙'
    var dot = document.createElement('span')
    dot.className = 'dot'
    dot.style.background = '#8b949e'
    gear.appendChild(dot)
    host.appendChild(gear)

    var panel = document.createElement('div')
    panel.id = 'armor-panel'
    var ttl = document.createElement('div')
    ttl.className = 'ttl'
    ttl.innerHTML = '<span>armor 座位注入</span><span class="st">待判定</span>'
    var ta = document.createElement('textarea')
    ta.placeholder = '写要追加到 systemInstruction 末位的提示词'
    var row = document.createElement('div')
    row.className = 'row'
    var bApply = document.createElement('button')
    bApply.className = 'primary'
    bApply.textContent = '应用'
    var bCancel = document.createElement('button')
    bCancel.textContent = '取消'
    var bReset = document.createElement('button')
    bReset.textContent = '恢复默认'
    row.appendChild(bApply); row.appendChild(bCancel); row.appendChild(bReset)
    var hint = document.createElement('div')
    hint.className = 'hint'
    panel.appendChild(ttl); panel.appendChild(ta); panel.appendChild(row); panel.appendChild(hint)
    host.appendChild(panel)

    if (card.parentElement) card.parentElement.insertBefore(host, card)
    else document.body.insertBefore(host, document.body.firstChild)

    hostEl = host; gearEl = gear; panelEl = panel; taEl = ta; hintEl = hint; dotEl = dot

    gear.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation()
      open = !open
      panel.classList.toggle('open', open)
      if (open) loadSeat()
    })
    bCancel.addEventListener('click', function () { open = false; panel.classList.remove('open'); ta.value = lastText })
    bApply.addEventListener('click', function () {
      var text = ta.value
      api('/api/seat', { method: 'POST', body: JSON.stringify({ text: text }) }).then(function (r) {
        if (!r.ok) return r.text().then(function (t) { hint.textContent = '应用失败：' + t.slice(0, 100) })
        lastText = text
        hint.textContent = '已应用（每轮注入）'
        setTimeout(function () { open = false; panel.classList.remove('open') }, 500)
      }).catch(function (e2) { hint.textContent = '应用失败：' + e2.message })
    })
    bReset.addEventListener('click', function () {
      api('/api/seat/reset', { method: 'POST', body: '{}' }).then(function (r) {
        if (!r.ok) { hint.textContent = '恢复失败 ' + r.status; return }
        return loadSeat().then(function () { hint.textContent = '已恢复默认种子' })
      }).catch(function (e2) { hint.textContent = '恢复失败：' + e2.message })
    })
    document.addEventListener('click', function (e) {
      if (!open) return
      if (host.contains(e.target)) return
      open = false; panel.classList.remove('open')
    }, true)
    return true
  }

  function loadSeat() {
    return api('/api/seat').then(function (r) {
      if (!r.ok) return
      return r.json().then(function (j) {
        lastText = j.text || ''
        if (document.activeElement !== taEl) taEl.value = lastText
      })
    }).catch(function () {})
  }

  function refresh() {
    api('/api/state').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    }).then(function (s) {
      var v = s.controller && s.controller.verdict ? s.controller.verdict : null
      var color = v === 'refusal' ? '#ef4444' : (v && v !== 'pass') ? '#f59e0b' : '#10b981'
      if (dotEl) dotEl.style.background = color
      var st = panelEl ? panelEl.querySelector('.st') : null
      if (st) st.textContent = '宿主 ' + s.host.version + ' · ' + (s.divert ? s.divert.lane : '-')
      if (hintEl && !hintEl.textContent) hintEl.textContent = ''
    }).catch(function () { if (dotEl) dotEl.style.background = '#8b949e' })
  }

  window.__armorGearSync = function () { mount(); loadSeat() }
  if (!mount()) {
    var tries = 0
    var timer = setInterval(function () {
      tries++
      if (mount() || tries > 60) { clearInterval(timer); loadSeat(); refresh() }
    }, 500)
  } else { loadSeat() }
  refresh()
  setInterval(refresh, 5000)
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
      } catch { /* 忽略 */ }
    }
    try {
      wc.on('did-finish-load', inject)
      wc.on('did-navigate-in-page', inject)
      if (wc.getURL && /^https?:/i.test(wc.getURL())) inject()
    } catch { /* 忽略 */ }
  }
  try { app.on('web-contents-created', (_e, wc) => hook(wc)) } catch { /* 忽略 */ }
  try { webContents.getAllWebContents().forEach(hook) } catch { /* 忽略 */ }
  logLine('install token=' + (token ? token.slice(0, 6) + '…' : '(missing)'))
}

module.exports = { install, readToken, CSS, pageMain }
