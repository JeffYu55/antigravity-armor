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
#armor-gear-host { position: fixed; display: none; pointer-events: none; z-index: 2147483000; }
#armor-gear-host > * { pointer-events: auto; }
#armor-gear { width: 22px; height: 22px; border-radius: 50%; border: 1.5px solid rgba(120,130,145,.45);
  background: rgba(20,22,28,.9); color: #9aa7b5; font-size: 13px; line-height: 19px; text-align: center;
  cursor: grab; padding: 0; user-select: none; transition: transform .12s ease, color .12s ease, border-color .2s ease;
  box-shadow: 0 2px 8px rgba(0,0,0,.4); position: relative; }
#armor-gear:active { cursor: grabbing; }
#armor-gear:hover { color: #e6edf3; transform: rotate(18deg); }
#armor-gear .dot { position: absolute; right: -1px; top: -1px; width: 7px; height: 7px; border-radius: 50%;
  background: #8b949e; box-shadow: 0 0 6px rgba(0,0,0,.5); }
#armor-gear.armed { border-color: #10b981; color: #b9f5da; }
#armor-gear.armed .dot { background: #10b981; box-shadow: 0 0 8px rgba(16,185,129,.9); }
#armor-gear.bad { border-color: #ef4444; }
#armor-gear.bad .dot { background: #ef4444; box-shadow: 0 0 8px rgba(239,68,68,.9); }
#armor-gear.warn { border-color: #f59e0b; }
#armor-gear.warn .dot { background: #f59e0b; box-shadow: 0 0 8px rgba(245,158,11,.9); }
#armor-gear-label { position: fixed; display: none; background: rgba(18,20,26,.95); color: #d6dee8;
  border: 1px solid #313a46; border-radius: 6px; padding: 3px 8px; font-size: 11px;
  font-family: ui-monospace, Consolas, "Segoe UI", sans-serif; pointer-events: none; z-index: 2147483001;
  white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
#armor-panel { position: fixed; width: 430px; max-width: 90vw;
  background: #12141a; color: #d6dee8; border: 1px solid rgba(16,185,129,.35); border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,.45); padding: 10px; font-family: ui-monospace, Consolas, "Segoe UI", sans-serif;
  font-size: 12px; z-index: 2147483000; display: none; }
#armor-panel.open { display: block; }
#armor-panel .ttl { color: #8b949e; font-size: 11px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
#armor-panel .st { display: inline-flex; align-items: center; gap: 5px; }
#armor-panel .st::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #8b949e; display: inline-block; }
#armor-panel .st.armed::before { background: #10b981; box-shadow: 0 0 5px rgba(16,185,129,.8); }
#armor-panel .st.bad::before { background: #ef4444; }
#armor-panel .st.warn::before { background: #f59e0b; }
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
  var labelEl = null

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

  /** 找输入框「所在的卡片容器」（用于吸附定位） */
  function findCard(composer) {
    var node = composer
    var card = composer
    while (node && node.parentElement) {
      var r = node.getBoundingClientRect()
      if (r.height >= 200) break
      card = node
      node = node.parentElement
    }
    return card
  }

  /** 把齿轮吸附到输入框卡片的外沿：默认右上角上方 6px；拖动后存 localStorage，自动贴边 */
  function snapToCard() {
    if (!hostEl || !gearEl) return
    var composer = findComposer()
    if (!composer) { hostEl.style.display = 'none'; return }
    hostEl.style.display = 'block'
    var card = findCard(composer)
    var cr = card.getBoundingClientRect()
    var saved = null
    try { saved = JSON.parse(localStorage.getItem('armorGearPos') || 'null') } catch (e) { saved = null }
    var gw = gearEl.offsetWidth || 22
    var gh = gearEl.offsetHeight || 22
    var x, y
    if (saved && saved.x != null) {
      x = saved.x; y = saved.y
      // 拖过的位置：吸附到卡片矩形外沿（上/右/下/左 距离 8px 以内就贴上去）
      var edges = [
        { x: cr.right - gw - 4, y: cr.top - gh - 6 },
        { x: cr.right + 8, y: cr.top },
        { x: cr.left - gw - 8, y: cr.top },
        { x: cr.right - gw - 4, y: cr.bottom + 8 },
      ]
      var bestE = null; var bestD = 1e9
      for (var k = 0; k < edges.length; k++) {
        var dx = edges[k].x - x; var dy = edges[k].y - y
        var d = Math.sqrt(dx * dx + dy * dy)
        if (d < bestD) { bestD = d; bestE = edges[k] }
      }
      if (bestD <= 60) { x = bestE.x; y = bestE.y }
      // 屏幕内钳制
      x = Math.max(4, Math.min(window.innerWidth - gw - 4, x))
      y = Math.max(4, Math.min(window.innerHeight - gh - 4, y))
    } else {
      // 默认：卡片右上角、上方 6px（在输入框上沿，不遮内容）
      x = cr.right - gw - 4
      y = cr.top - gh - 6
      if (y < 4) { y = cr.top + 6 }
    }
    hostEl.style.left = x + 'px'
    hostEl.style.top = y + 'px'
    if (panelEl && panelEl.classList.contains('open')) placePanel(x, y)
  }

  /** 面板出现在齿轮附近（优先上方，贴屏幕边时翻到下方） */
  function placePanel(gx, gy) {
    if (!panelEl) return
    var pw = panelEl.offsetWidth || 430
    var ph = panelEl.offsetHeight || 220
    var x = Math.max(6, Math.min(window.innerWidth - pw - 6, gx - pw + 30))
    var y = gy - ph - 10
    if (y < 6) y = gy + 30
    panelEl.style.left = x + 'px'
    panelEl.style.top = y + 'px'
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

  /** 建 UI（fixed 定位，body 直挂，不进文档流） */
  function mount() {
    if (document.getElementById('armor-gear-host')) return true
    var host = document.createElement('div')
    host.id = 'armor-gear-host'
    var gear = document.createElement('button')
    gear.id = 'armor-gear'
    gear.title = 'armor 破甲（拖动可移动，自动吸附输入框）'
    gear.textContent = '⚙'
    var dot = document.createElement('span')
    dot.className = 'dot'
    gear.appendChild(dot)
    var label = document.createElement('div')
    label.id = 'armor-gear-label'
    var panel = document.createElement('div')
    panel.id = 'armor-panel'
    var ttl = document.createElement('div')
    ttl.className = 'ttl'
    ttl.innerHTML = '<span>armor 座位注入</span><span class="st">检测中…</span>'
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
    host.appendChild(gear)
    document.body.appendChild(host)
    document.body.appendChild(panel)
    document.body.appendChild(label)

    hostEl = host; gearEl = gear; panelEl = panel; taEl = ta; hintEl = hint; dotEl = dot; labelEl = label

    var dragging = false
    var moved = false
    var sx = 0; var sy = 0; var ox = 0; var oy = 0
    gear.addEventListener('mousedown', function (e) {
      dragging = true; moved = false
      sx = e.clientX; sy = e.clientY
      ox = hostEl.offsetLeft; oy = hostEl.offsetTop
      e.preventDefault()
    })
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return
      var dx = e.clientX - sx; var dy = e.clientY - sy
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
      hostEl.style.left = (ox + dx) + 'px'
      hostEl.style.top = (oy + dy) + 'px'
      if (panelEl && panelEl.classList.contains('open')) placePanel(ox + dx, oy + dy)
      showLabel(e.clientX, e.clientY)
    })
    document.addEventListener('mouseup', function () {
      if (!dragging) return
      dragging = false
      hideLabel()
      if (moved) {
        try { localStorage.setItem('armorGearPos', JSON.stringify({ x: hostEl.offsetLeft, y: hostEl.offsetTop })) } catch (e2) { /* 忽略 */ }
        snapToCard()
      }
    })
    gear.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation()
      if (moved) { moved = false; return }
      open = !open
      panel.classList.toggle('open', open)
      if (open) { loadSeat(); placePanel(hostEl.offsetLeft, hostEl.offsetTop) }
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
      if (host.contains(e.target) || panel.contains(e.target)) return
      open = false; panel.classList.remove('open')
    }, true)
    window.addEventListener('resize', snapToCard)
    setInterval(snapToCard, 2000)
    snapToCard()
    return true
  }

  function showLabel(x, y) {
    if (!labelEl) return
    labelEl.textContent = stateText()
    labelEl.style.display = 'block'
    labelEl.style.left = (x + 14) + 'px'
    labelEl.style.top = (y - 8) + 'px'
  }
  function hideLabel() { if (labelEl) labelEl.style.display = 'none' }
  function stateText() {
    if (!window.__armorState) return 'armor：检测中…'
    var s = window.__armorState
    if (!s.divert) return 'armor：未激活（divert 离线）'
    var seatB = s.seat && s.seat.bytes ? Math.round(s.seat.bytes) + 'B' : '-'
    return 'armor 破甲：已激活 · 车道 ' + (s.divert.lane || '-') + ' · 座位 ' + seatB
  }

  function refresh() {
    api('/api/state').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    }).then(function (s) {
      window.__armorState = s
      var jlast = s.journal && Array.isArray(s.journal.last) && s.journal.last.length ? s.journal.last[0] : null
      var v = jlast ? jlast.verdict : (s.controller && s.controller.verdict ? s.controller.verdict : null)
      var cls = !s.divert ? '' : (v === 'refusal' || v === 'blocked' ? 'bad' : (v === 'empty' ? 'warn' : 'armed'))
      if (gearEl) { gearEl.classList.remove('armed', 'bad', 'warn'); if (cls) gearEl.classList.add(cls) }
      var st = panelEl ? panelEl.querySelector('.st') : null
      if (st) {
        st.classList.remove('armed', 'bad', 'warn')
        if (cls) st.classList.add(cls)
        st.textContent = !s.divert ? '未激活（divert 离线）' : (cls === 'armed' ? '破甲已激活' : cls === 'bad' ? '被拒（上一轮）' : cls === 'warn' ? '部分生效' : '待判定') + ' · 宿主 ' + (s.host && s.host.version ? s.host.version : '-') + ' · 车道 ' + (s.divert.lane || '-')
      }
      if (hintEl && !hintEl.textContent) hintEl.textContent = ''
    }).catch(function () { if (gearEl) { gearEl.classList.remove('armed', 'bad', 'warn') } })
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
