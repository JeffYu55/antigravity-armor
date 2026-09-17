// 证据隐匿评测夹具 —— 物化 / 校验 / 与原目录比对
//
// 夹具里有三样东西没法随 git 传输：怪名字（零宽/RLO/同形字）、ADS 备用数据流、伪造时间戳。
// 所以「可复现」的做法是：spec 声明 → materialize() 重建 → verify() 逐项自检。
import { mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, statSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { DIRS, FILLERS, TRICKS, HONEYPOTS, groundTruthMd, overviewMd, SPEC_VERSION } from './spec.mjs'
import { analyzeName, enumerateStreams, readStream, injectionSignals } from './scanner.mjs'

export const BOM = Buffer.from([0xef, 0xbb, 0xbf])
export const TRUTH_IDS = TRICKS.map((t) => t.id)
export const FAKE_IDS = HONEYPOTS.map((h) => h.id)

function stripBom(buf) { return buf.subarray(0, 3).equals(BOM) ? buf.subarray(3) : buf }

function put(dir, name, text, { bom = false } = {}) {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  const bytes = Buffer.from(text, 'utf8')
  writeFileSync(p, bom ? Buffer.concat([BOM, bytes]) : bytes)
  return p
}

/** 按 spec 逐字节重建整套夹具；返回实际落盘清单与平台不支持项 */
export function materialize(dir) {
  const naive = join(dir, DIRS.naive)
  const honey = join(dir, DIRS.honeypot)
  const truth = join(dir, DIRS.truth)
  const written = []
  const unsupported = []

  for (const f of FILLERS) written.push({ id: null, kind: 'filler', path: put(naive, f.name, f.body, f) })

  for (const t of TRICKS) {
    const p = put(naive, t.name, t.body, t)
    if (t.ads) {
      try {
        const adsBytes = Buffer.from(t.ads.body, 'utf8')
        writeFileSync(p + ':' + t.ads.stream, t.ads.bom ? Buffer.concat([BOM, adsBytes]) : adsBytes)
        readFileSync(p + ':' + t.ads.stream) // 立刻回读，确认这个文件系统真的支持 ADS
      } catch (e) { unsupported.push({ id: t.id, what: 'ads', error: String(e && e.message || e) }) }
    }
    if (t.mtime) {
      const d = new Date(Date.parse(t.mtime))
      try { utimesSync(p, d, d) } catch (e) { unsupported.push({ id: t.id, what: 'mtime', error: String(e && e.message || e) }) }
    }
    written.push({ id: t.id, kind: 'trick', path: p })
  }

  for (const h of HONEYPOTS) written.push({ id: h.id, kind: 'honeypot', path: put(honey, h.name, h.body, h) })

  written.push({ id: null, kind: 'truth', path: put(truth, 'ground-truth.md', groundTruthMd, { bom: true }) })
  written.push({ id: null, kind: 'overview', path: put(dir, 'GROUND_TRUTH.md', overviewMd, {}) })
  written.push({ id: null, kind: 'manifest', path: put(dir, 'manifest.json', JSON.stringify(manifest(), null, 2) + '\n', {}) })

  return { dir, version: SPEC_VERSION, written, unsupported }
}

/** 机器可读清单：谁是真迹、谁是诱饵、各自靠什么信号判定 */
export function manifest() {
  return {
    spec: 'evasion-eval',
    version: SPEC_VERSION,
    protocol: '被测方只看 ' + DIRS.naive + '/ 与 ' + DIRS.honeypot + '/；' + DIRS.truth + '/ 是答案表',
    tricks: TRICKS.map((t) => ({ id: t.id, tactic: t.tactic, canary: t.canary, name: t.name, ads: t.ads ? t.ads.stream : null, mtime: t.mtime || null })),
    honeypots: HONEYPOTS.map((h) => ({ id: h.id, name: h.name, canary: 'CANARY-FAKE-' + h.id })),
  }
}

/** 这条真迹「声明的那一个信号」是否真的就位（每种手法判据不同，不能一律看文件名） */
function declaredSignalPresent(t, body) {
  const audit = analyzeName(t.name)
  switch (t.tactic) {
    case 'zero-width': return audit.zeroWidth.length > 0
    case 'rlo-override': return audit.bidi.length > 0
    case 'homoglyph': return audit.mixedScript
    case 'ntfs-ads': return true      // 由 adsPresent / adsBody 两项单独判定
    case 'timestomp': return true     // 由 mtime 单独判定
    case 'prompt-injection': return injectionSignals(t.name, body).isInjection
    default: return false
  }
}

/** 逐项自检：名字信号 / 正文 / BOM / ADS 内容 / 时间戳 是否都真的落盘了 */
export function verify(dir) {
  const naive = join(dir, DIRS.naive)
  const honey = join(dir, DIRS.honeypot)
  const streams = enumerateStreams(naive)
  const items = []

  for (const t of TRICKS) {
    const p = join(naive, t.name)
    const checks = { exists: existsSync(p) }
    if (checks.exists) {
      const raw = readFileSync(p)
      checks.bom = raw.subarray(0, 3).equals(BOM)
      checks.body = stripBom(raw).toString('utf8') === t.body
      checks.signal = declaredSignalPresent(t, stripBom(raw).toString('utf8'))
      try { checks.mtime = t.mtime ? Math.abs(statSync(p).mtimeMs - Date.parse(t.mtime)) < 1000 : true } catch { checks.mtime = false }
      if (t.ads) {
        const list = streams.get(t.name) || []
        checks.adsPresent = list.includes(t.ads.stream)
        const content = checks.adsPresent ? readStream(p, t.ads.stream) : null
        checks.adsBody = content !== null && String(content).replace(/^\uFEFF/, '').trim() === t.ads.body.trim()
      }
    }
    items.push({ id: t.id, tactic: t.tactic, kind: 'trick', ok: Object.values(checks).every(Boolean), checks })
  }

  for (const h of HONEYPOTS) {
    const p = join(honey, h.name)
    const checks = { exists: existsSync(p) }
    if (checks.exists) {
      const raw = readFileSync(p)
      checks.body = stripBom(raw).toString('utf8') === h.body
      // 诱饵必须「干净」：没有名字信号、没有 ADS，否则它就不是诱饵而是真迹了
      checks.noSignal = analyzeName(h.name).signals.length === 0 && (streams.get(h.name) || []).length === 0
    }
    items.push({ id: h.id, kind: 'honeypot', ok: Object.values(checks).every(Boolean), checks })
  }

  return { dir, ok: items.every((i) => i.ok), items }
}

function listFiles(root) {
  if (!existsSync(root)) return []
  const out = []
  const stack = [root]
  while (stack.length) {
    const d = stack.pop()
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) stack.push(full)
      else out.push(full)
    }
  }
  return out.sort()
}

/** 和一份已有的夹具目录逐字节比对（迁移保真检查）；只比协议目录，答案表文书可随 spec 演进 */
export function compareDirs(a, b) {
  const diffs = []
  for (const sub of [DIRS.naive, DIRS.honeypot]) {
    const ra = listFiles(join(a, sub)).map((p) => p.slice(join(a, sub).length + 1))
    const rb = listFiles(join(b, sub)).map((p) => p.slice(join(b, sub).length + 1))
    for (const n of new Set([...ra, ...rb])) {
      if (!ra.includes(n)) { diffs.push({ sub, name: n, kind: 'missing-in-a' }); continue }
      if (!rb.includes(n)) { diffs.push({ sub, name: n, kind: 'missing-in-b' }); continue }
      const ba = readFileSync(join(a, sub, n))
      const bb = readFileSync(join(b, sub, n))
      if (!ba.equals(bb)) diffs.push({ sub, name: n, kind: 'bytes-differ', a: ba.length, b: bb.length })
      const sa = enumerateStreams(join(a, sub)).get(n) || []
      const sb = enumerateStreams(join(b, sub)).get(n) || []
      if (sa.join(',') !== sb.join(',')) diffs.push({ sub, name: n, kind: 'streams-differ', a: sa, b: sb })
      for (const s of sa.filter((x) => sb.includes(x))) {
        const ca = String(readStream(join(a, sub, n), s) || '')
        const cb = String(readStream(join(b, sub, n), s) || '')
        if (ca !== cb) diffs.push({ sub, name: n, kind: 'stream-bytes-differ', stream: s })
      }
    }
  }
  return { a, b, same: diffs.length === 0, diffs }
}

export function clean(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  return dir
}
