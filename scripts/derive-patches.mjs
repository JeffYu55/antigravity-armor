// derive-patches —— 补丁表漂移勘测器（P2 第 2 件）
//
// 干什么：把旧表（patches/binary-patches.json）的每一条锚点/探针，在当前宿主
// 上重新定位一遍，报出 hit / miss / span / fit，并生成该版本专属表骨架。
//
// 为什么必须工具化：2.12.2 → 2.34.0 这次实测 25 抽样里 3 条锚点消失；
// 靠人记「哪条还在」必然误判，而且升级后每次都要重来。
//
// 用法：
//   node scripts/derive-patches.mjs                 # 只报告
//   node scripts/derive-patches.mjs --emit          # 生成 patches/hosts/<ver>/binary-patches.json
//   node scripts/derive-patches.mjs --json          # 机器可读
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConfig, patchTable } from '../src/config.mjs'
import { equalLength, lineBounds, applyEdits } from '../src/util/bytes.mjs'
import { log } from '../src/log.mjs'

function collectSentences(buf, table) {
  const edits = []
  for (const p of table.sentencePatches || []) {
    const probe = Buffer.from(p.probe, 'utf8')
    if (!equalLength(p.probe, p.repl)) continue
    let i = 0
    while (true) {
      const k = buf.indexOf(probe, i)
      if (k < 0) break
      edits.push({ from: k, to: k + probe.length, repl: p.repl })
      i = k + 1
    }
  }
  return edits
}

function collectFixed(buf, table) {
  const edits = []
  let skipped = 0
  for (const p of table.fixedPatches || []) {
    const probe = Buffer.from(p.probe, 'utf8')
    const rl = Buffer.byteLength(p.repl, 'utf8')
    let i = 0
    while (true) {
      const k = buf.indexOf(probe, i)
      if (k < 0) break
      i = k + 1
      if (rl > probe.length) { skipped++; continue }
      edits.push({ from: k, to: k + probe.length, repl: p.repl })
    }
  }
  return { edits, skipped }
}

function collectLines(buf, table, maxLine) {
  const edits = []
  let skipped = 0
  for (const p of table.linePatches || []) {
    const probe = Buffer.from(p.probe, 'utf8')
    const rl = Buffer.byteLength(p.repl, 'utf8')
    let i = 0
    while (true) {
      const k = buf.indexOf(probe, i)
      if (k < 0) break
      i = k + 1
      const [a, b] = lineBounds(buf, k)
      if (b - a > maxLine) { if (rl > probe.length) { skipped++; continue } edits.push({ from: k, to: k + probe.length, repl: p.repl }) }
      else { if (rl > b - a) { skipped++; continue } edits.push({ from: a, to: b, repl: p.repl }) }
    }
  }
  return { edits, skipped }
}

/** 三趟模拟（与 layers/binary.mjs runPasses 同序），返回报告 */
export function simulate(buf, table, { maxLine = 1400 } = {}) {
  const report = { block: null, sentenceEdits: 0, fixed: 0, fixedSkipped: 0, line: 0, lineSkipped: 0, total: 0 }
  const a = []
  const bs = Buffer.from(table.blockReplacement?.startAnchor || '', 'utf8')
  const be = Buffer.from(table.blockReplacement?.endAnchor || '', 'utf8')
  if (bs.length && be.length) {
    const s = buf.indexOf(bs)
    const e0 = buf.indexOf(be)
    if (s >= 0 && e0 >= s) {
      const end = e0 + be.length
      const span = end - s
      const fit = equalLength(buf.subarray(s, end).toString('utf8'), table.blockReplacement.replacement)
      report.block = { offset: s, span, fit: Boolean(fit) }
      if (fit) a.push({ from: s, to: end, repl: table.blockReplacement.replacement })
    }
  }
  const se = collectSentences(buf, table)
  report.sentenceEdits = se.length
  a.push(...se)
  let cur = applyEdits(buf, a)
  report.total += a.length
  const fx = collectFixed(cur, table)
  cur = applyEdits(cur, fx.edits)
  report.fixed = fx.edits.length; report.fixedSkipped = fx.skipped; report.total += fx.edits.length
  const ln = collectLines(cur, table, maxLine)
  report.line = ln.edits.length; report.lineSkipped = ln.skipped; report.total += ln.edits.length
  return report
}

function shiftFor(buf, table, report) {
  // 逐条锚点定位（用于生成表骨架：只保留命中项，miss 的单独列出）
  const out = { sentences: [], fixed: [], lines: [] }
  for (const p of table.sentencePatches || []) {
    const probe = Buffer.from(p.probe, 'utf8')
    const k = buf.indexOf(probe)
    out.sentences.push({ ...p, hit: k >= 0, fit: Boolean(equalLength(p.probe, p.repl)) })
  }
  for (const p of table.fixedPatches || []) {
    const probe = Buffer.from(p.probe, 'utf8')
    const k = buf.indexOf(probe)
    out.fixed.push({ ...p, hit: k >= 0, fit: Buffer.byteLength(p.repl, 'utf8') <= probe.length })
  }
  for (const p of table.linePatches || []) {
    const probe = Buffer.from(p.probe, 'utf8')
    const k = buf.indexOf(probe)
    let fit = true
    if (k >= 0) {
      const [a, b] = lineBounds(buf, k)
      fit = b - a > 1400 ? Buffer.byteLength(p.repl, 'utf8') <= probe.length : Buffer.byteLength(p.repl, 'utf8') <= b - a
    }
    out.lines.push({ ...p, hit: k >= 0, fit })
  }
  return out
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/derive-patches.mjs')
if (invokedDirectly) {
  const cfg = loadConfig()
  const buf = readFileSync(cfg.binaryPath)
  const table = JSON.parse(readFileSync(cfg.legacyPatchesFile, 'utf8'))
  const report = simulate(buf, table, { maxLine: cfg.binary.maxLine || 1400 })
  const detail = shiftFor(buf, table, report)

  const count = (arr, key) => arr.filter((x) => x[key]).length
  const summary = {
    hostVersion: cfg.hostVersion,
    binary: cfg.binaryPath,
    bytes: buf.length,
    block: report.block,
    sentences: `${count(detail.sentences, 'hit')}/${detail.sentences.length}`,
    fixed: `${count(detail.fixed, 'hit')}/${detail.fixed.length}`,
    lines: `${count(detail.lines, 'hit')}/${detail.lines.length}`,
    expectedEdits: report.total,
    skipped: report.fixedSkipped + report.lineSkipped,
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ summary, detail, report }, null, 2))
  } else {
    log.info(`host ${summary.hostVersion}  bytes=${summary.bytes}`)
    log.info(`block        : ${report.block ? `span=${report.block.span} fit=${report.block.fit}` : 'anchors missing'}`)
    log.info(`sentences    : ${summary.sentences} hit   edits=${report.sentenceEdits}`)
    log.info(`fixed        : ${summary.fixed} hit   edits=${report.fixed} skipped=${report.fixedSkipped}`)
    log.info(`lines        : ${summary.lines} hit   edits=${report.line} skipped=${report.lineSkipped}`)
    log.info(`expected edits: ${report.total}`)
    for (const [kind, arr] of Object.entries(detail)) {
      const miss = arr.filter((x) => !x.hit)
      if (miss.length) log.warn(`${kind} 未命中 ${miss.length} 条：`)
      for (const m of miss) console.log(`    - ${JSON.stringify(m.probe).slice(0, 120)}`)
    }
  }

  if (process.argv.includes('--emit')) {
    const dir = join(cfg.projectRoot, 'patches', 'hosts', cfg.hostVersion)
    mkdirSync(dir, { recursive: true })
    const keep = {
      hostVersion: cfg.hostVersion,
      note: 'auto-derived by scripts/derive-patches.mjs；miss 条目已剔除，需按 guardrails.json 重抽',
      blockReplacement: report.block?.fit ? table.blockReplacement : null,
      sentencePatches: detail.sentences.filter((x) => x.hit && x.fit).map(({ hit, fit, ...p }) => p),
      fixedPatches: detail.fixed.filter((x) => x.hit && x.fit).map(({ hit, fit, ...p }) => p),
      linePatches: detail.lines.filter((x) => x.hit && x.fit).map(({ hit, fit, ...p }) => p),
      missing: [...detail.sentences, ...detail.fixed, ...detail.lines].filter((x) => !x.hit).map((x) => x.probe),
    }
    writeFileSync(join(dir, 'binary-patches.json'), JSON.stringify(keep, null, 2))
    log.ok(`emit -> ${join(dir, 'binary-patches.json')}  (sentences=${keep.sentencePatches.length} fixed=${keep.fixedPatches.length} lines=${keep.linePatches.length} missing=${keep.missing.length})`)
  }
}
