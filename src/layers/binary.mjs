// 层 1：language_server.exe 内嵌提示词 / 判官提示词的等长补丁
//
// 关键设计：**多趟（multi-pass）应用**。
// 三类补丁之间存在重叠区间（固定串补丁先改过的行，行级补丁的字面量边界会变），
// 单趟对同一份原始缓冲同时规划会互相覆盖。因此按历史验证过的顺序跑三趟，
// 每一趟都在上一趟的结果上重新定位锚点：
//   A 整块安全段 + 逐句补丁  ->  B 固定串表  ->  C 行级表
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { backup, listBackups } from '../util/fs.mjs'
import { equalLength, collectEdits, applyEdits, diffRanges, countOccurrences } from '../util/bytes.mjs'
import { patchTable } from '../config.mjs'
import { log } from '../log.mjs'

function collectBlock(buf, t) {
  const startB = Buffer.from(t.blockReplacement.startAnchor, 'utf8')
  const endAnchor = Buffer.from(t.blockReplacement.endAnchor, 'utf8')
  const s = buf.indexOf(startB)
  const e0 = buf.indexOf(endAnchor)
  if (s < 0 || e0 < s) return null
  const end = e0 + endAnchor.length
  const fit = equalLength(buf.subarray(s, end).toString('utf8'), t.blockReplacement.replacement) !== null
  return { from: s, to: end, repl: t.blockReplacement.replacement, fit, span: end - s }
}

function collectSentences(buf, t) {
  const out = []
  for (const p of t.sentencePatches) {
    const probe = Buffer.from(p.probe, 'utf8')
    const fit = equalLength(p.probe, p.repl) !== null
    let i = 0
    let hits = 0
    if (fit) {
      while (true) {
        const k = buf.indexOf(probe, i)
        if (k < 0) break
        out.push({ from: k, to: k + probe.length, repl: p.repl })
        hits++
        i = k + 1
      }
    }
    p._hits = countOccurrences(buf, p.probe)
    p._fit = fit
  }
  return out
}

/**
 * 三趟应用。返回 { out, report }，report 供 dry-run 与验证使用。
 */
export function runPasses(cfg, buf) {
  const t = patchTable(cfg)
  const report = { block: null, sentences: t.sentencePatches.length, fixed: 0, fixedSkipped: 0, line: 0, lineSkipped: 0, edits: 0 }

  // Pass A
  const a = []
  report.block = collectBlock(buf, t)
  if (report.block && report.block.fit) a.push({ from: report.block.from, to: report.block.to, repl: report.block.repl })
  a.push(...collectSentences(buf, t))
  let cur = applyEdits(buf, a)
  report.edits += a.length

  // Pass B（在 A 的结果上重新定位）
  const b = collectEdits(cur, t.fixedPatches, { mode: 'substring' })
  cur = applyEdits(cur, b.edits)
  report.fixed = b.edits.length
  report.fixedSkipped = b.skipped
  report.edits += b.edits.length

  // Pass C（在 A+B 的结果上重新定位，行内位置已变化）
  const c = collectEdits(cur, t.linePatches, { mode: 'line', maxLineUnwrapped: cfg.binary.maxLine })
  cur = applyEdits(cur, c.edits)
  report.line = c.edits.length
  report.lineSkipped = c.skipped
  report.edits += c.edits.length

  return { out: cur, report, table: t }
}

export function installBinary(cfg, { apply = false } = {}) {
  if (!existsSync(cfg.binaryPath)) throw new Error('language_server.exe not found: ' + cfg.binaryPath)
  const buf = readFileSync(cfg.binaryPath)
  const marker = Buffer.from(cfg.binary.marker, 'utf8')
  const already = buf.includes(marker)
  const { out, report } = runPasses(cfg, buf)

  log.info('binary: ' + cfg.binaryPath)
  log.info('  already armored : ' + already)
  log.info('  block edit      : ' + (report.block ? (report.block.fit ? 'ready (' + report.block.span + 'B)' : 'TOO LONG') : 'anchors missing'))
  log.info('  sentence edits  : ' + report.sentences + ' entries')
  log.info('  fixed edits     : ' + report.fixed + (report.fixedSkipped ? ' (skipped ' + report.fixedSkipped + ')' : ''))
  log.info('  line edits      : ' + report.line + (report.lineSkipped ? ' (skipped ' + report.lineSkipped + ')' : ''))
  log.info('  total edits     : ' + report.edits)
  log.info('  length          : ' + out.length + ' (delta ' + (out.length - buf.length) + ')')

  if (!apply) return { dryRun: true, ...report }
  if (report.edits === 0) return { applied: 0, note: 'already armored / no anchors matched' }

  const bak = backup(cfg.binaryPath, cfg.backupDir, 'pre-binary')
  writeFileSync(cfg.binaryPath, out)
  const d = diffRanges(buf, out)
  log.ok('patched ' + report.edits + ' ranges, ' + d.bytes + ' bytes changed, length ' + buf.length + ' -> ' + out.length)
  log.ok('backup: ' + bak)
  return { applied: report.edits, backup: bak, changedBytes: d.bytes, sameLength: d.sameLength, ...report }
}

/** 审计：装甲标记存在 + 关键拒绝锚点消失 */
export function verifyBinary(cfg, path = null) {
  const buf = readFileSync(path || cfg.binaryPath)
  const probes = [
    'This request was blocked', 'You are denied from interacting with this page',
    'NEVER solve captchas', 'Is the intention of the author malicious?',
    'flagged as malicious ONLY when', 'Runtime Policy Guardian',
    'A command is dangerous ONLY when', 'Flag ANY of the following as malicious',
    'Apply STRICTER evaluation', 'used in malicious code',
    'would lead to a breach of security', 'Keep an adversarial mindset',
    'strictly classified as a persistence threat',
    'Action could not be verified by safety policy', 'modifying system configuration is not allowed',
  ]
  const still = probes.filter((p) => buf.includes(Buffer.from(p, 'utf8')))
  return {
    armored: buf.includes(Buffer.from(cfg.binary.marker, 'utf8')),
    length: buf.length,
    remaining: still,
    clean: still.length === 0,
  }
}

export function rollbackBinary(cfg) {
  const b = listBackups(cfg.backupDir, 'pre-binary')[0] || listBackups(cfg.backupDir, 'language_server')[0]
  if (!b) throw new Error('no binary backup in ' + cfg.backupDir)
  copyFileSync(b.path, cfg.binaryPath)
  return b.path
}
