// 层 1：language_server 内嵌提示词 / 判官提示词的等长补丁
//
// 关键设计：**多趟（multi-pass）应用**。
// 三类补丁之间存在重叠区间（固定串补丁先改过的行，行级补丁的字面量边界会变），
// 单趟对同一份原始缓冲同时规划会互相覆盖。因此按历史验证过的顺序跑三趟，
// 每一趟都在上一趟的结果上重新定位锚点：
//   A 整块安全段 + 逐句补丁  ->  B 固定串表  ->  C 行级表
//
// v1.10.0「适配所有版本」的三处改动：
//   1) 不再有 size/sha 硬门（那等于只支持一个版本）；放行判据换成**锚点命中率**；
//   2) 命中率不够就现场派生补丁表（layers/refit.mjs），落盘到 patches/hosts/<ver>/；
//   3) macOS 上打完必须重签 + 冒烟，起不来就自动回滚（layers/sign.mjs）。
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { backup, listBackups } from '../util/fs.mjs'
import { equalLength, collectEdits, applyEdits, diffRanges, countOccurrences } from '../util/bytes.mjs'
import { patchTable, assertHostShape } from '../config.mjs'
import { anchorStats, ensureHostTable } from './refit.mjs'
import { finalizePatchedBinary } from './sign.mjs'
import { saveOriginal, refreshStaleOriginal, restoreOriginal, originalFor } from '../purge/hostbackups.mjs'
import { log } from '../log.mjs'

function collectBlock(buf, t) {
  if (!t?.blockReplacement) return null
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
  for (const p of t.sentencePatches || []) {
    const probe = Buffer.from(p.probe, 'utf8')
    const fit = equalLength(p.probe, p.repl) !== null
    let i = 0
    if (fit) {
      while (true) {
        const k = buf.indexOf(probe, i)
        if (k < 0) break
        out.push({ from: k, to: k + probe.length, repl: p.repl })
        i = k + 1
      }
    }
    p._hits = countOccurrences(buf, p.probe)
    p._fit = fit
  }
  return out
}

/**
 * 解析当前宿主该用哪张表：
 *  - 现有表命中率过线 → 用现有的
 *  - 否则现场派生（autoRefit 默认开）
 * 派生失败不致命：回落到现有表，让 runPasses 自己报「打了多少」。
 */
export function resolveTable(cfg, buf, { refit = null } = {}) {
  const autoRefit = cfg.binary?.autoRefit !== false
  if (autoRefit || refit) {
    try {
      const r = ensureHostTable(cfg, buf, { force: refit === true })
      return { table: r.table, file: r.file, derived: r.derived, stats: r.stats }
    } catch (e) {
      log.warn('refit 不可用（' + (e.message || e) + '），回落到现有表')
    }
  }
  const table = patchTable(cfg)
  return { table, file: cfg.patchesFile, derived: false, stats: anchorStats(buf, table) }
}

/**
 * 三趟应用。返回 { out, report }，report 供 dry-run 与验证使用。
 */
export function runPasses(cfg, buf, table = null) {
  const t = table || patchTable(cfg)
  const report = { block: null, sentences: (t.sentencePatches || []).length, fixed: 0, fixedSkipped: 0, line: 0, lineSkipped: 0, edits: 0 }

  // Pass A
  const a = []
  report.block = collectBlock(buf, t)
  if (report.block && report.block.fit) a.push({ from: report.block.from, to: report.block.to, repl: report.block.repl })
  a.push(...collectSentences(buf, t))
  let cur = applyEdits(buf, a)
  report.edits += a.length

  // Pass B（在 A 的结果上重新定位）
  const b = collectEdits(cur, t.fixedPatches || [], { mode: 'substring' })
  cur = applyEdits(cur, b.edits)
  report.fixed = b.edits.length
  report.fixedSkipped = b.skipped
  report.edits += b.edits.length

  // Pass C（在 A+B 的结果上重新定位，行内位置已变化）
  const c = collectEdits(cur, t.linePatches || [], { mode: 'line', maxLineUnwrapped: cfg.binary.maxLine })
  cur = applyEdits(cur, c.edits)
  report.line = c.edits.length
  report.lineSkipped = c.skipped
  report.edits += c.edits.length

  return { out: cur, report, table: t }
}

/** 派生/统计用的参考缓冲：live 已被装甲改过时，必须用原件，否则会把自家文本当成锚点 */
export function referenceBuffer(cfg, buf, already) {
  if (!already) return buf
  try {
    const o = originalFor(cfg, cfg.binaryPath)
    if (o && existsSync(o.bak)) return readFileSync(o.bak)
  } catch { /* 没有原件就退回 live */ }
  return buf
}

export function installBinary(cfg, { apply = false, force = false, refit = null } = {}) {
  if (!cfg.binaryPath || !existsSync(cfg.binaryPath)) {
    throw new Error('language_server not found: ' + (cfg.binaryPath || '(未探测到宿主)') + ' —— 用 AARMOR_HOST_ROOT 指向宿主 Contents/ 目录，或检查安装路径')
  }
  const buf = readFileSync(cfg.binaryPath)
  const marker = Buffer.from(cfg.binary.marker, 'utf8')
  const already = buf.includes(marker)
  const minRatio = Number(cfg.binary.minAnchorRatio ?? 0.34)

  const refBuf = referenceBuffer(cfg, buf, already)
  const { table, file, derived, stats } = resolveTable(cfg, refBuf, { refit })
  // 形状差异只报告，不阻断（旧版这里是 throwing gate，等于只支持一个版本）
  for (const p of assertHostShape(cfg, buf, { armored: already })) log.info('host-shape(info): ' + p)

  const ratio = stats?.ratio ?? 0
  log.info('binary: ' + cfg.binaryPath)
  log.info('  host            : ' + cfg.hostVersion + ' · ' + process.platform + '/' + process.arch)
  log.info('  table           : ' + file + (derived ? '（本次派生）' : ''))
  log.info('  anchors         : ' + (stats ? stats.hit + '/' + stats.total + ' (' + ratio.toFixed(2) + ')' : 'n/a')
    + (stats ? '  block=' + stats.block + ' s=' + stats.sentences.hit + '/' + stats.sentences.total
      + ' f=' + stats.fixed.hit + '/' + stats.fixed.total + ' l=' + stats.lines.hit + '/' + stats.lines.total : ''))
  log.info('  already armored : ' + already)

  if (!already && ratio < minRatio && !force) {
    throw new Error('锚点命中率过低（' + (ratio * 100).toFixed(0) + '% < ' + (minRatio * 100).toFixed(0) + '%）：这张表和当前宿主不是同一代，先跑 `aarmor refit` 或带 --force')
  }

  const { out, report } = runPasses(cfg, buf, table)
  log.info('  block edit      : ' + (report.block ? (report.block.fit ? 'ready (' + report.block.span + 'B)' : 'TOO LONG') : 'anchors missing'))
  log.info('  sentence edits  : ' + report.sentences + ' entries')
  log.info('  fixed edits     : ' + report.fixed + (report.fixedSkipped ? ' (skipped ' + report.fixedSkipped + ')' : ''))
  log.info('  line edits      : ' + report.line + (report.lineSkipped ? ' (skipped ' + report.lineSkipped + ')' : ''))
  log.info('  total edits     : ' + report.edits)
  log.info('  length          : ' + out.length + ' (delta ' + (out.length - buf.length) + ')')

  if (!apply) return { dryRun: true, ...report, table: file, anchors: stats }
  if (report.edits === 0) return { applied: 0, note: 'already armored / no anchors matched' }

  // 内容寻址备份：只保存「原件」。已装甲的文件不能当原件，否则回滚会把装甲写回去。
  if (!already) saveOriginal(cfg, cfg.binaryPath, buf)
  const bak = backup(cfg.binaryPath, cfg.backupDir, 'pre-binary')
  writeFileSync(cfg.binaryPath, out)
  const d = diffRanges(buf, out)
  log.ok('patched ' + report.edits + ' ranges, ' + d.bytes + ' bytes changed, length ' + buf.length + ' -> ' + out.length)
  log.ok('backup: ' + bak)

  // macOS：签名失效 → 重签 + 冒烟；起不来立刻回滚（宁可没装甲，也不能让宿主打不开）
  const fin = finalizePatchedBinary(cfg, cfg.binaryPath)
  if (!fin.ok) {
    log.warn('smoke 失败（' + (fin.smoke?.reason || '?') + '），自动回滚二进制')
    writeFileSync(cfg.binaryPath, buf)
    finalizePatchedBinary({ ...cfg, binary: { ...cfg.binary, smokeTest: false } }, cfg.binaryPath)
    throw new Error('打补丁后宿主起不来，已回滚：' + (fin.smoke?.reason || 'smoke failed'))
  }
  return { applied: report.edits, backup: bak, changedBytes: d.bytes, sameLength: d.sameLength, table: file, fin, ...report }
}

/** 逐补丁漂移实检（v1.10.0：换成锚点口径 + 自动派生）
 *  pending>0 = 锚点还在、补丁没打（可 ensure 重打）；
 *  armored 但 pending>0 = 半打状态（先还原再重打）；
 *  命中率过低 = 表与宿主不是同一代（跑 refit，不再直接判定「不支持的版本」）。 */
export function patchStatusBinary(cfg, { path = null } = {}) {
  const p = path || cfg.binaryPath
  if (!p || !existsSync(p)) return { layer: 'binary', exists: false, armored: false, pending: 0, blocked: 'missing', binaryPath: p || null }
  const buf = readFileSync(p)
  const armored = buf.includes(Buffer.from(cfg.binary.marker, 'utf8'))
  let table = null
  let stats = null
  try {
    const r = resolveTable(cfg, buf)
    table = r.table
    stats = r.stats
  } catch { stats = null }
  let report = null
  try { report = runPasses(cfg, buf, table).report } catch { report = null }
  const pending = report ? report.edits : 0
  const minRatio = Number(cfg.binary.minAnchorRatio ?? 0.34)
  const ratio = stats?.ratio ?? 0
  return {
    layer: 'binary', exists: true, armored, pending, report, anchors: stats,
    blocked: ratio < minRatio && !armored ? 'anchor-miss' : (!armored && pending === 0 ? 'patch-table-drift' : null),
  }
}

const DEFAULT_VERIFY_PROBES = [
  'This request was blocked', 'You are denied from interacting with this page',
  'NEVER solve captchas', 'Is the intention of the author malicious?',
  'flagged as malicious ONLY when', 'Runtime Policy Guardian',
  'A command is dangerous ONLY when', 'Flag ANY of the following as malicious',
  'Apply STRICTER evaluation', 'used in malicious code',
  'would lead to a breach of security', 'Keep an adversarial mindset',
  'strictly classified as a persistence threat',
  'Action could not be verified by safety policy', 'modifying system configuration is not allowed',
]

/** 审计：装甲标记存在 + 该宿主版本的护栏锚点全部消失（探针优先取表里的 verifyProbes） */
export function verifyBinary(cfg, path = null) {
  const buf = readFileSync(path || cfg.binaryPath)
  let probes = DEFAULT_VERIFY_PROBES
  try {
    const t = patchTable(cfg)
    if (Array.isArray(t.verifyProbes) && t.verifyProbes.length) probes = t.verifyProbes
  } catch { /* 表缺失时回落默认探针 */ }
  const still = probes.filter((p) => buf.includes(Buffer.from(p, 'utf8')))
  return {
    armored: buf.includes(Buffer.from(cfg.binary.marker, 'utf8')),
    length: buf.length,
    remaining: still,
    clean: still.length === 0,
  }
}

export function rollbackBinary(cfg) {
  // 先刷新过期备份（v1.9.0）：Antigravity 升级后 live 是新原件、bak 还是旧版，
  // 直接还原 = 把旧版本写回新安装。刷新后还原的是「当前这一版的原件」。
  refreshStaleOriginal(cfg, cfg.binaryPath, cfg.binary.marker)
  const hit = restoreOriginal(cfg, cfg.binaryPath)
  if (hit) {
    // 还原的是原始字节 = 原始签名，不需要重签；只做一次冒烟确认宿主还活着
    finalizePatchedBinary({ ...cfg, binary: { ...cfg.binary, resign: 'never' } }, cfg.binaryPath)
    return hit.restored
  }
  const b = listBackups(cfg.backupDir, 'pre-binary')[0] || listBackups(cfg.backupDir, 'language_server')[0]
  if (!b) throw new Error('no binary backup in ' + cfg.backupDir)
  copyFileSync(b.path, cfg.binaryPath)
  finalizePatchedBinary({ ...cfg, binary: { ...cfg.binary, resign: 'never' } }, cfg.binaryPath)
  return b.path
}
