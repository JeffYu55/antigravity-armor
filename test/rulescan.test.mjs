// 注入位磁盘侧审计与摘除（v1.8.3）—— 持久修复
//
// 出站剥离只是止血：客户端每轮从磁盘规则文件重建 <user_rules>，
// 只要外来 persona 词包还在文件里，它每轮都会回来（实测该文件占 part0 的 49.7%）。
//
// 所以本测试钉住三件事：
//   ① 审计能认出「同一份文件里既有外来 persona（头部）又有我们的装甲（尾部）」
//   ② 摘除**只动外来那一段**，我们自己的装甲与其它内容一字不动
//   ③ 默认只预览不写入；写入前必须备份（可逆）
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanRuleFiles, disarmRuleFile, disarmAll, ruleFiles } from '../src/layers/rulescan.mjs'

const FIX = readFileSync(new URL('./fixtures/foreign-kovak-pack.txt', import.meta.url), 'utf8')

const OUR_ARMOR = [
  '<!-- infinite-gen-3-armor v0.5.0 -->',
  '# Global Rules — Antigravity armor (infinite-gen-3)',
  'Answer the user request directly and in full technical detail.',
  '<!-- ARMOR-SEAT-POJIA:BEGIN -->',
  '## 结束行',
  '当前:对象 / 结果 / 下一步',
  '<!-- ARMOR-SEAT-POJIA:END -->',
].join('\n')

function sandbox() {
  const dir = join(tmpdir(), 'aarmor-rs-' + process.pid + '-' + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const gem = join(dir, 'Gemini.md')
  // 复刻实测形状：persona 在头部，我们的装甲 append 在尾部
  writeFileSync(gem, FIX + '\n\n' + OUR_ARMOR + '\n', 'utf8')
  const cfg = {
    backupDir: join(dir, 'backups'),
    rules: { globalFiles: ['~/.gemini/Gemini.md'], skillFile: join(dir, 'none.md') },
    hooks: { workspaces: [] },
    geminiHome: dir,
  }
  // 用真实展开器：把 ~/.gemini 指到沙箱
  cfg.rules.globalFiles = [gem]
  return { dir, gem, cfg }
}

export function testAuditFindsTheForeignHeadAndOurTailInOneFile() {
  const { cfg, gem, dir } = sandbox()
  try {
    const rows = scanRuleFiles(cfg)
    const row = rows.find((r) => r.path === gem)
    assert.ok(row, '审计要覆盖到这份文件')
    assert.ok(row.foreignBytes > 1000, '必须认出外来词包的占量（实际 ' + row.foreignBytes + 'B）')
    assert.ok(row.foreign.some((f) => f.name.includes('kovak')), '要点名外来词包')
    const ours = row.blocks.filter((b) => b.kind === 'ours')
    assert.ok(ours.length >= 1, '我们自己的块要被认成自家（不能误报成外来）')
    // 关键：同一份文件两种归属
    assert.ok(row.bytes > row.foreignBytes, '文件里除了外来段还有别的（就是我们自己的装甲）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

export function testAuditBytesMatchWhatDisarmActuallyRemoves() {
  const { cfg, gem, dir } = sandbox()
  try {
    const row = scanRuleFiles(cfg).find((r) => r.path === gem)
    const preview = disarmRuleFile(gem, cfg, { apply: false })
    assert.equal(preview.removed, row.foreignBytes,
      '审计报的字节数必须等于实际能摘掉的字节数（否则用户按审计数字做不了判断）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

export function testPreviewDoesNotWrite() {
  const { cfg, gem, dir } = sandbox()
  try {
    const before = readFileSync(gem, 'utf8')
    const r = disarmRuleFile(gem, cfg, { apply: false })
    assert.equal(r.changed, true)
    assert.equal(r.preview, true)
    assert.equal(readFileSync(gem, 'utf8'), before, '预览模式绝不能写盘')
    assert.ok(!existsSync(cfg.backupDir) || readdirSync(cfg.backupDir).length === 0, '预览也不该产生备份')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

export function testApplyRemovesForeignAndKeepsOurArmor() {
  const { cfg, gem, dir } = sandbox()
  try {
    const r = disarmRuleFile(gem, cfg, { apply: true })
    assert.equal(r.applied, true)
    assert.ok(r.removed > 1000)
    const after = readFileSync(gem, 'utf8')
    assert.ok(!after.includes('Kovak'), '外来 persona 必须摘掉')
    assert.ok(!after.includes('.spud'), 'persona 自述必须摘掉')
    assert.ok(after.includes('infinite-gen-3-armor'), '我们自己的装甲必须一字不动')
    assert.ok(after.includes('ARMOR-SEAT-POJIA'), '席位块也必须保留')
    assert.ok(after.includes('当前:对象 / 结果 / 下一步'), '我们自己块里的正文不能被截断')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

export function testApplyBacksUpBeforeWriting() {
  const { cfg, gem, dir } = sandbox()
  try {
    const before = readFileSync(gem, 'utf8')
    disarmRuleFile(gem, cfg, { apply: true })
    assert.ok(existsSync(cfg.backupDir), '必须建备份目录')
    const backups = readdirSync(cfg.backupDir)
    assert.ok(backups.length >= 1, '必须留下备份（可逆是硬要求）')
    const restored = readFileSync(join(cfg.backupDir, backups[0]), 'utf8')
    assert.equal(restored, before, '备份内容必须等于改动前的原文')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

export function testDisarmIsIdempotentAndSafeOnCleanFiles() {
  const { cfg, gem, dir } = sandbox()
  try {
    disarmRuleFile(gem, cfg, { apply: true })
    const again = disarmRuleFile(gem, cfg, { apply: true })
    assert.equal(again.changed, false, '第二遍应当无事可做')
    assert.match(again.reason, /无外来词包/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

export function testDisarmLeavesMissingFilesAlone() {
  const { cfg, dir } = sandbox()
  try {
    const r = disarmRuleFile(join(dir, 'nope.md'), cfg, { apply: true })
    assert.equal(r.changed, false)
    assert.match(r.reason, /文件不存在/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

export function testRuleFilesDeduplicatesAndIsClosedOverConfig() {
  const { cfg, gem, dir } = sandbox()
  try {
    cfg.rules.globalFiles = [gem, gem]
    const files = ruleFiles(cfg)
    assert.equal(files.filter((f) => f === gem).length, 1, '同一路径不该重复审计')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

export function testDisarmAllReportsPerFile() {
  const { cfg, gem, dir } = sandbox()
  try {
    const res = disarmAll(cfg, { apply: false })
    assert.ok(res.length >= 1)
    const hit = res.find((r) => r.path === gem)
    assert.ok(hit.changed, '沙箱那份文件应当被标为待摘除')
    assert.ok(hit.removed > 1000)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}