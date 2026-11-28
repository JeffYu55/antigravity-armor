// 证据隐匿评测夹具 —— 物化 / 校验 / 与原目录比对
//
// 夹具里有三样东西没法随 git 传输：怪名字（零宽/RLO/同形字）、ADS 备用数据流、伪造时间戳。
// 所以「可复现」的做法是：spec 声明 → materialize() 重建 → verify() 逐项自检。
//
// ⚠ 关于「逐字节比对」（v1.7.4 修正）：怪名字与伪造时间戳**其实能**随 git 走（字节层面），
//   真正过不去 git 的只有 **NTFS 备用数据流（ADS）** —— 克隆出来的目录里，带 ADS 的文件
//   只有主数据流。所以和仓库目录比对时必须把差异**按能否随 git 传输分类**：
//   可传输部分的任何差异都是真回归；不可传输的流差异要逐条核对是预期的那一条
//   （见 test/evasion-eval.test.mjs:testSpecReproducesLegacyFixtureByteForByte）。
//   ADS 的能力覆盖由 materialize()→verify() 的 adsPresent / adsBody 两项承担。
import { mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, statSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { DIRS, FILLERS, TRICKS, HONEYPOTS, groundTruthMd, overviewMd, SPEC_VERSION } from './spec.mjs'
import { analyzeName, enumerateStreams, readStream, injectionSignals } from './scanner.mjs'

export const BOM = Buffer.from([0xef, 0xbb, 0xbf])
export const TRUTH_IDS = TRICKS.map((t) => t.id)
export const FAKE_IDS = HONEYPOTS.map((h) => h.id)

function stripBom(buf) { return buf.subarray(0, 3).equals(BOM) ? buf.subarray(3) : buf }

/**
 * 备用数据流（ADS）能力探测。
 *
 * 为什么不能只看 process.platform（2026-11 现场，macOS 14 / APFS）：
 * 非 Windows 上 `writeFileSync('notes.txt:creds')` 会**成功**，但它建的是一个
 * 名字里带冒号的普通文件（macOS 的 POSIX 层允许 ':'，Finder 显示成 '/'）。
 * 于是「落盘成功 → 以为自己支持 ADS」，实际是把隐匿通道变成了明面文件：
 * 自检 adsPresent=false、逐字节比对多出一条 missing-in-a，一整套评测结论作废。
 * 所以判据是行为学的：写一个流，看它会不会作为目录项出现。会出现 = 假 ADS。
 */
export function adsSupport(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    const base = join(dir, '.__ads_probe')
    writeFileSync(base, 'x')
    const streamPath = base + ':probe'
    writeFileSync(streamPath, 'y')
    const appeared = readdirSync(dir).some((n) => n.includes(':probe'))
    let back = null
    try { back = readFileSync(streamPath, 'utf8') } catch { back = null }
    try { rmSync(streamPath, { force: true }) } catch {}
    try { rmSync(base, { force: true }) } catch {}
    if (appeared) return { supported: false, reason: 'colon-filename-not-a-stream' }
    return { supported: back === 'y', reason: back === 'y' ? null : 'roundtrip-mismatch' }
  } catch (e) {
    return { supported: false, reason: String(e && e.message || e) }
  }
}

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
  const ads = adsSupport(naive)

  for (const f of FILLERS) written.push({ id: null, kind: 'filler', path: put(naive, f.name, f.body, f) })

  for (const t of TRICKS) {
    const p = put(naive, t.name, t.body, t)
    if (t.ads) {
      if (!ads.supported) {
        unsupported.push({ id: t.id, what: 'ads', error: ads.reason || 'unsupported-filesystem' })
      } else {
        try {
          const adsBytes = Buffer.from(t.ads.body, 'utf8')
          writeFileSync(p + ':' + t.ads.stream, t.ads.bom ? Buffer.concat([BOM, adsBytes]) : adsBytes)
          readFileSync(p + ':' + t.ads.stream) // 立刻回读，确认这个文件系统真的支持 ADS
        } catch (e) { unsupported.push({ id: t.id, what: 'ads', error: String(e && e.message || e) }) }
      }
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

  return { dir, version: SPEC_VERSION, written, unsupported, advertisements: ads }
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
  const ads = adsSupport(join(dir, '.__ads_verify'))
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
        if (!ads.supported) {
          // 文件系统不支持真实流：这一项记为 N/A（null），不能算失败，也不能算通过
          checks.adsPresent = null
          checks.adsBody = null
        } else {
          const list = streams.get(t.name) || []
          checks.adsPresent = list.includes(t.ads.stream)
          const content = checks.adsPresent ? readStream(p, t.ads.stream) : null
          checks.adsBody = content !== null && String(content).replace(/^\uFEFF/, '').trim() === t.ads.body.trim()
        }
      }
    }
    const judged = Object.values(checks).filter((v) => v !== null)
    items.push({ id: t.id, tactic: t.tactic, kind: 'trick', ok: judged.every(Boolean), checks })
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

  return { dir, ok: items.every((i) => i.ok), items, ads }
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
