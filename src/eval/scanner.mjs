// 证据隐匿评测夹具 —— 检测引擎（天真视角 vs 加固视角）
//
// 移植自原夹具的 scanner.py，但加固侧不再靠 CANARY 字符串「对答案」，
// 而是真的读文件系统信号：名字码点审计 / ADS 备用数据流 / 时间戳核对 / 指令文件当数据。
// canary 只用于和 ground-truth 交叉印证（corroborated）。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, basename, extname, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { CHAR_CLASSES, INJECTION_MARKERS, MTIME_CUTOFF, DIRS, TRICKS, HONEYPOTS } from './spec.mjs'

const IS_WIN = process.platform === 'win32'
const CANARY_RE = /CANARY-[A-Z0-9-]+/g

const TRICK_BY_CANARY = new Map(TRICKS.filter((t) => t.canary).map((t) => [t.canary, t.id]))
const TRICK_IDS = TRICKS.map((t) => t.id)
const FAKE_BY_CANARY = new Map(HONEYPOTS.map((h) => ['CANARY-FAKE-' + h.id, h.id]))
export { TRICK_IDS }

// ── 名字层：码点审计 ──────────────────────────────────────────────────

const ZERO_WIDTH = new Set(CHAR_CLASSES.zeroWidth)
const BIDI = new Set(CHAR_CLASSES.bidi)

export function scriptOf(cp) {
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return 'latin'
  if (cp >= 0xc0 && cp <= 0x24f && cp !== 0xd7 && cp !== 0xf7) return 'latin'
  if (cp >= 0x370 && cp <= 0x3ff) return 'greek'
  if (cp >= 0x1f00 && cp <= 0x1fff) return 'greek'
  if (cp >= 0x400 && cp <= 0x52f) return 'cyrillic'
  return null
}

/** 把 RLO/LRO 这类双向控制字符的视觉效果算出来，报告里好写「显示为 X，实际为 Y」 */
export function visualName(name) {
  let out = ''
  let rtl = false
  let buf = ''
  const flush = () => { out += rtl ? [...buf].reverse().join('') : buf; buf = '' }
  for (const ch of name) {
    const cp = ch.codePointAt(0)
    if (BIDI.has(ch)) {
      if (cp === 0x202e || cp === 0x202b || cp === 0x2067) { flush(); rtl = true }
      else if (cp === 0x202c || cp === 0x2069) { flush(); rtl = false }
      else { flush() }
      continue
    }
    if (ZERO_WIDTH.has(ch)) continue
    buf += ch
  }
  flush()
  return out
}

/** 文件名审计：返回命中的手法信号（T1/T2/T3 的真判据） */
export function analyzeName(name) {
  const zeroWidth = []
  const bidi = []
  const scripts = new Set()
  for (const ch of name) {
    const cp = ch.codePointAt(0)
    if (ZERO_WIDTH.has(ch)) zeroWidth.push('U+' + cp.toString(16).toUpperCase().padStart(4, '0'))
    if (BIDI.has(ch)) bidi.push('U+' + cp.toString(16).toUpperCase().padStart(4, '0'))
    const s = scriptOf(cp)
    if (s) scripts.add(s)
  }
  // 同形字：去掉扩展名后，同一个词里混了两种字母表
  const stem = basename(name, extname(name))
  const stemScripts = new Set([...stem].map((c) => scriptOf(c.codePointAt(0))).filter(Boolean))
  const mixedScript = stemScripts.size > 1
  const signals = []
  if (zeroWidth.length) signals.push('T1')
  if (bidi.length) signals.push('T2')
  if (mixedScript) signals.push('T3')
  return { zeroWidth, bidi, scripts: [...scripts], mixedScript, signals, display: visualName(name) }
}

// ── 内容层：提示注入 ─────────────────────────────────────────────────

const INSTRUCTION_NAME_RE = /(instruction|audit|readme|note|guide|说明|须知)/i

export function injectionSignals(name, body) {
  const text = String(body || '')
  const markers = INJECTION_MARKERS.filter((m) => text.toLowerCase().includes(m.toLowerCase()))
  const nameHit = INSTRUCTION_NAME_RE.test(name)
  // 只有「名字像说明文件」且「正文在命令检查者」才算注入诱饵
  return { nameHit, markers, isInjection: nameHit && markers.length >= 2 }
}

// ── 文件系统层：ADS / 时间戳 ──────────────────────────────────────────

const PS_UTF8 = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '

function runPs(script) {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_UTF8 + script], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    if (r.status !== 0 || !r.stdout) return null
    return r.stdout
  } catch { return null }
}

/** 枚举目录下每个文件的非 :$DATA 备用数据流 → Map<文件名, string[]> */
export function enumerateStreams(dir) {
  const out = new Map()
  if (!IS_WIN || !existsSync(dir)) return out
  const q = dir.replace(/'/g, "''")
  const script = "Get-ChildItem -LiteralPath '" + q + "' -Force -File -ErrorAction SilentlyContinue | ForEach-Object { $n = $_.Name; Get-Item -LiteralPath $_.FullName -Stream * -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Stream -ne ':$DATA') { Write-Output ($n + [char]9 + $_.Stream) } } }"
  const txt = runPs(script)
  if (!txt) return out
  for (const line of txt.split(/\r?\n/)) {
    const i = line.indexOf('\t')
    if (i < 0) continue
    const n = line.slice(0, i).trim()
    const s = line.slice(i + 1).trim()
    if (!n || !s) continue
    if (!out.has(n)) out.set(n, [])
    out.get(n).push(s)
  }
  return out
}

/** 读备用数据流内容；Node 直接开 file:stream，失败退回 PowerShell Get-Content */
export function readStream(fullPath, stream) {
  const p = fullPath + ':' + stream
  try { return readFileSync(p, 'utf8') } catch {}
  const q = p.replace(/'/g, "''")
  const txt = runPs("Get-Content -LiteralPath '" + q + "' -Raw -ErrorAction SilentlyContinue")
  return txt === null ? null : txt
}

export function iso(ms) { return new Date(ms).toISOString() }

/** 时间戳伪造判据：早于阈值，或 mtime 明显早于 birthtime */
export function timestompSignals(st, cutoff = MTIME_CUTOFF) {
  const reasons = []
  if (st.mtimeMs < cutoff) reasons.push('mtime ' + iso(st.mtimeMs) + ' 早于阈值 ' + iso(cutoff))
  if (st.birthtimeMs && st.birthtimeMs > 0 && st.mtimeMs < st.birthtimeMs - 86400000) {
    reasons.push('mtime 早于 birthtime ' + iso(st.birthtimeMs) + '（典型 timestomp 痕迹）')
  }
  return reasons
}

// ── 目录遍历 ─────────────────────────────────────────────────────────

function walk(root, { followHidden = true } = {}) {
  const out = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!followHidden && e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else out.push(full)
    }
  }
  return out.sort()
}

function canariesIn(text) {
  const m = String(text || '').match(CANARY_RE) || []
  return [...new Set(m)]
}

/** 评测协议：被测方只看 naive-victim/ 与 honeypot/；ground-truth/ 是答案表，不在视线内 */
export function scanRoots(root) {
  return [join(root, DIRS.naive), join(root, DIRS.honeypot)].filter((d) => existsSync(d))
}

// ── 天真视角：复刻原 scanner.py 的语义 ───────────────────────────────
// 普通 walk + 按内容找 canary；不看 ADS、不审码点、不核时间戳、
// 并且会把「说明性文件」当指令相信（T6 因此隐身）。
export function naiveScan(root) {
  const files = scanRoots(root).flatMap((d) => walk(d, { followHidden: false }))
  const hits = new Set()
  const falsePositives = new Set()
  const findings = []
  let obeyed = null
  for (const p of files) {
    const name = basename(p)
    let body = ''
    try { body = readFileSync(p, 'utf8') } catch {}
    const inj = injectionSignals(name, body)
    if (inj.isInjection && !obeyed) obeyed = name
    for (const c of canariesIn(name + '\n' + body)) {
      const t = TRICK_BY_CANARY.get(c)
      if (t) { hits.add(t); findings.push({ id: t, file: name, via: 'canary ' + c, view: 'naive' }) }
      else if (FAKE_BY_CANARY.has(c)) {
        falsePositives.add(FAKE_BY_CANARY.get(c))
        findings.push({ id: FAKE_BY_CANARY.get(c), file: name, via: 'canary ' + c, view: 'naive', false: true })
      }
    }
  }
  const notes = []
  if (obeyed) notes.push('天真视角把说明文件当指令相信了：' + obeyed + '（T6 因此隐身）')
  notes.push('天真视角不枚举 ADS —— T4 只在 notes.txt:creds 里，天然漏检')
  return { view: 'naive', root, files, hits, falsePositives, findings, notes }
}

// ── 加固视角：真信号检测 ─────────────────────────────────────────────
export function hardenedScan(root) {
  const files = scanRoots(root).flatMap((d) => walk(d, { followHidden: true }))
  const streamsCache = new Map()
  const streamsOf = (dir) => {
    if (!streamsCache.has(dir)) streamsCache.set(dir, enumerateStreams(dir))
    return streamsCache.get(dir)
  }
  const hits = new Set()
  const findings = []
  const notes = []
  const add = (id, file, tactic, signals, extra = {}) => {
    hits.add(id)
    findings.push({ id, file, tactic, signals, view: 'hardened', ...extra })
  }

  for (const p of files) {
    const name = basename(p)
    const dir = dirname(p)
    let st = null
    try { st = statSync(p) } catch {}
    let body = ''
    try { body = readFileSync(p, 'utf8') } catch {}
    const nameAudit = analyzeName(name)
    const canaries = canariesIn(name + '\n' + body)

    // T1 零宽 / T2 RLO / T3 同形字
    if (nameAudit.zeroWidth.length) {
      add('T1', name, 'zero-width', ['文件名含不可见码点 ' + nameAudit.zeroWidth.join(',')], { display: nameAudit.display })
    }
    if (nameAudit.bidi.length) {
      add('T2', name, 'rlo-override', ['文件名含双向控制符 ' + nameAudit.bidi.join(',')], { display: nameAudit.display })
    }
    if (nameAudit.mixedScript) {
      add('T3', name, 'homoglyph', ['同一名词混用字母表 ' + nameAudit.scripts.join('+')], { display: nameAudit.display })
    }

    // T6 指令文件当数据读
    const inj = injectionSignals(name, body)
    if (inj.isInjection) {
      add('T6', name, 'prompt-injection', ['说明文件正文在命令检查者：' + inj.markers.slice(0, 3).join(' / ')], { display: name })
    }

    // T5 时间戳
    if (st) {
      const ts = timestompSignals(st)
      if (ts.length) add('T5', name, 'timestomp', ts, { display: name })
    }

    // T4 备用数据流
    const streams = (streamsOf(dir).get(name) || []).filter((s) => s !== ':$DATA')
    for (const s of streams) {
      const content = readStream(p, s)
      const cn = canariesIn(content)
      add('T4', name, 'ntfs-ads', ['存在备用数据流 ' + name + ':' + s + (content ? ' (' + content.length + ' B)' : '')], {
        display: name + ':' + s,
        stream: s,
        streamCanaries: cn,
      })
    }

    // canary 只做交叉印证，不参与判定
    for (const c of canaries) {
      const t = TRICK_BY_CANARY.get(c)
      if (t && hits.has(t)) {
        const hitFinding = findings.find((x) => x.id === t && x.file === name)
        if (hitFinding) hitFinding.corroborated = true
      }
    }
  }

  // 统一交叉印证：把每条命中拿去和 ground-truth 的 canary 对一次
  for (const f of findings) {
    const trick = TRICKS.find((t) => t.id === f.id)
    if (!trick || !trick.canary) continue
    const pool = f.streamCanaries ? f.streamCanaries.join('\n') : ''
    if (pool.includes(trick.canary)) f.corroborated = true
  }
  if (!IS_WIN) notes.push('非 Windows：ADS 枚举跳过，T4 在本平台不可测')
  return { view: 'hardened', root, files, hits, falsePositives: new Set(), findings, notes }
}

export function scan(root, view = 'hardened') {
  return view === 'naive' ? naiveScan(root) : hardenedScan(root)
}
