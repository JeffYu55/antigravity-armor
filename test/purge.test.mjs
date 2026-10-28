// v1.9.0 PURGE-REFIT 测试：状态戳 / 内容寻址备份 / ensure 自愈 / uninstall / 覆盖位
//
// 夹具是自造的小文件（假 exe = 26 字节的 block 锚点、假 asar = endpoint 串），
// 不碰真机 155MB 二进制 —— 但走的是**同一套 install/verify 代码**，不是 mock。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  revOf, readAppliedStamp, markPatchesApplied, stampMatches,
  shouldSkipSettle, markSettleRestart, clearStamp,
} from '../src/purge/state.mjs'
import {
  saveOriginal, listOriginals, refreshStaleOriginal, restoreOriginal,
} from '../src/purge/hostbackups.mjs'
import { ensureArmor, purgeSummary } from '../src/purge/reapply.mjs'
import { uninstallArmor } from '../src/purge/uninstall.mjs'
import { armorEdit, armorReset, armorStatus } from '../src/purge/override.mjs'
import { installBinary, rollbackBinary } from '../src/layers/binary.mjs'
import { installIde, buildReplacement } from '../src/layers/ide.mjs'
import { installRules, armorBody } from '../src/layers/rules.mjs'
import { installHooks, HOOK_SCRIPTS } from '../src/layers/hooks.mjs'

const MARKER = '**[ARMOR v3]'
const SPAN = 'AAA' + 'x'.repeat(20) + 'ZZZ'          // 26B block 锚点
const REPL = MARKER + 'x'.repeat(26 - MARKER.length) // 等长 26B，含 marker
const FIND = 'https://daily-cloudcode-pa.googleapis.com'

function makeCfg() {
  const root = mkdtempSync(join(tmpdir(), 'aarmor-purge-'))
  const ag = join(root, 'ag')
  const state = join(root, 'state')
  const assets = join(root, 'assets')
  const gemini = join(root, 'gemini')
  mkdirSync(join(ag, 'resources'), { recursive: true })
  mkdirSync(join(assets, 'hooks'), { recursive: true })
  mkdirSync(join(gemini, 'config'), { recursive: true })
  mkdirSync(join(root, 'hooksroot'), { recursive: true })
  for (const f of HOOK_SCRIPTS) writeFileSync(join(assets, 'hooks', f), '// ' + f + '\n')
  writeFileSync(join(assets, 'armor.md'), 'ARMOR BODY\n')
  writeFileSync(join(root, 'patches.json'), JSON.stringify({
    blockReplacement: { startAnchor: 'AAA', endAnchor: 'ZZZ', replacement: REPL },
    sentencePatches: [], fixedPatches: [], linePatches: [],
  }))
  writeFileSync(join(ag, 'resources', 'language_server.exe'), SPAN)
  writeFileSync(join(ag, 'resources', 'app.asar'), 'PREFIX-' + FIND + '-SUFFIX')
  return {
    root,
    cfg: {
      projectRoot: root,
      root,
      stateDir: state,
      backupDir: join(state, 'backup'),
      logDir: join(state, 'logs'),
      captureDir: join(state, 'capture'),
      purgeDir: join(state, 'purge'),
      antigravityRoot: ag,
      binaryPath: join(ag, 'resources', 'language_server.exe'),
      asarPath: join(ag, 'resources', 'app.asar'),
      geminiHome: gemini,
      assetsDir: assets,
      patchesFile: join(root, 'patches.json'),
      binary: { marker: MARKER, maxLine: 1400 },
      ide: { endpointFind: FIND, endpointBase: 'http://127.0.0.1:50100' },
      hooks: { globalRoots: [join(root, 'hooksroot')], workspaces: [] },
      rules: {
        globalFiles: [join(gemini, 'Gemini.md'), join(gemini, 'config', 'AGENTS.md')],
        skillFile: join(gemini, 'config', 'skills', 'x', 'SKILL.md'),
        workspaceRule: '.agents/rules/00-armor.md',
        markers: { geminiMd: '<!-- infinite-gen-3-armor v0.5.0 -->' },
      },
      purge: { autoEnsure: false, settleCooldownMs: 180000 },
    },
  }
}

function installAll(cfg) {
  installBinary(cfg, { apply: true })
  installIde(cfg, { apply: true })
  installRules(cfg, { apply: true, workspaces: [] })
  installHooks(cfg, { apply: true, workspaces: [] })
}

const read = (p) => readFileSync(p, 'utf8')

export async function testRevOfAndStampRoundtrip() {
  const { cfg } = makeCfg()
  assert.equal(revOf(join(cfg.root, 'nope')), null)
  assert.match(revOf(cfg.binaryPath), /^[0-9a-f]{16}$/)
  assert.equal(readAppliedStamp(cfg), null)
  const stamp = markPatchesApplied(cfg, { revs: { binary: 'b1', ide: 'i1' }, layers: { armorHash: 'h' } })
  assert.equal(stamp.armorVersion, '1.9.0')
  const back = readAppliedStamp(cfg)
  assert.equal(back.revs.binary, 'b1')
  assert.equal(stampMatches(back, { binary: 'b1', ide: 'i1' }), true)
  assert.equal(stampMatches(back, { binary: 'b2', ide: 'i1' }), false)
  assert.equal(stampMatches({ armorVersion: '0.0.1', revs: back.revs }, { binary: 'b1', ide: 'i1' }), false)
  clearStamp(cfg)
  assert.equal(readAppliedStamp(cfg), null)
}

export async function testSettleCooldownGuard() {
  const { cfg } = makeCfg()
  assert.equal(shouldSkipSettle(cfg), false)
  markSettleRestart(cfg)
  assert.equal(shouldSkipSettle(cfg, 180000), true)
  assert.equal(shouldSkipSettle(cfg, 0), false)
}

export async function testContentAddressedBackupDedupes() {
  const { cfg } = makeCfg()
  const a = saveOriginal(cfg, cfg.binaryPath)
  const b = saveOriginal(cfg, cfg.binaryPath)
  assert.equal(a.id, b.id)
  assert.equal(a.saved, true)
  assert.equal(b.saved, false)                 // 同内容不重复写盘
  assert.equal(listOriginals(cfg).length, 1)
}

export async function testRefreshStaleOriginalOnlyForMarkerlessDiff() {
  const { cfg, root } = makeCfg()
  const p = join(root, 'host.bin')
  writeFileSync(p, 'orig')
  assert.equal(refreshStaleOriginal(cfg, p, 'MARK').refreshed, true)   // 首次 seed
  assert.equal(refreshStaleOriginal(cfg, p, 'MARK').reason, 'same')    // 同内容不刷
  writeFileSync(p, 'orig+MARK')
  assert.equal(refreshStaleOriginal(cfg, p, 'MARK').reason, 'armored') // 装甲内容不能当原件
  writeFileSync(p, 'new-original-v2')
  const r = refreshStaleOriginal(cfg, p, 'MARK')
  assert.equal(r.refreshed, true)
  assert.equal(r.reason, 'stale-bak-refreshed')
  const hit = restoreOriginal(cfg, p)
  assert.equal(read(p), 'new-original-v2')
  assert.equal(hit.id, r.id)
}

export async function testEnsureInstallsFromScratchAndStamps() {
  const { cfg } = makeCfg()
  const r = await ensureArmor(cfg, { apply: true, workspaces: [] })
  assert.equal(r.ok, true, r.notes.join(' | '))
  assert.equal(read(cfg.binaryPath).includes(MARKER), true)
  assert.equal(read(cfg.asarPath).includes(buildReplacement(cfg)), true)
  assert.equal(read(join(cfg.geminiHome, 'Gemini.md')).includes(cfg.rules.markers.geminiMd), true)
  assert.equal(existsSync(join(cfg.hooks.globalRoots[0], 'hooks.json')), true)
  const stamp = readAppliedStamp(cfg)
  assert.ok(stamp)
  assert.equal(stamp.revs.binary, revOf(cfg.binaryPath))
  assert.equal(stampMatches(stamp, { binary: revOf(cfg.binaryPath), ide: revOf(cfg.asarPath) }), true)
}

export async function testEnsureNoopWhenAligned() {
  const { cfg } = makeCfg()
  await ensureArmor(cfg, { apply: true, workspaces: [] })
  const before = { b: revOf(cfg.binaryPath), i: revOf(cfg.asarPath) }
  const again = await ensureArmor(cfg, { apply: true, workspaces: [] })
  assert.equal(again.noop, true)
  assert.equal(again.changed.length, 0)
  assert.equal(revOf(cfg.binaryPath), before.b)
  assert.equal(revOf(cfg.asarPath), before.i)
}

export async function testEnsureReappliesAfterUpgradeAndRollbackIsSafe() {
  const { cfg } = makeCfg()
  await ensureArmor(cfg, { apply: true, workspaces: [] })
  assert.equal(read(cfg.binaryPath).includes(MARKER), true)

  // 模拟 Antigravity 升级：宿主文件被换成新版原件（无 marker）
  const v2 = 'AAA' + 'y'.repeat(20) + 'ZZZ'
  writeFileSync(cfg.binaryPath, v2)
  writeFileSync(cfg.asarPath, 'NEW-' + FIND + '-TAIL')

  // 关键：rollback 不能把旧版装甲写回新安装
  rollbackBinary(cfg)
  assert.equal(read(cfg.binaryPath), v2)
  assert.equal(read(cfg.binaryPath).includes(MARKER), false)

  const r = await ensureArmor(cfg, { apply: true, workspaces: [] })
  assert.equal(r.ok, true, r.notes.join(' | '))
  assert.equal(read(cfg.binaryPath).includes(MARKER), true)
  assert.equal(read(cfg.asarPath).includes(buildReplacement(cfg)), true)
  const stamp = readAppliedStamp(cfg)
  assert.equal(stamp.revs.binary, revOf(cfg.binaryPath))
}

export async function testUninstallRestoresEverything() {
  const { cfg } = makeCfg()
  installAll(cfg)
  markPatchesApplied(cfg, { revs: { binary: revOf(cfg.binaryPath), ide: revOf(cfg.asarPath) } })

  const dry = uninstallArmor(cfg, { apply: false, workspaces: [] })
  assert.ok(dry.length > 0)
  assert.equal(read(cfg.binaryPath).includes(MARKER), true)   // dry-run 不动盘

  uninstallArmor(cfg, { apply: true, workspaces: [] })
  assert.equal(read(cfg.binaryPath), SPAN)                     // binary 回到原件
  assert.equal(read(cfg.asarPath).includes(FIND), true)        // asar 指回官方
  assert.equal(read(cfg.asarPath).includes(buildReplacement(cfg)), false)
  assert.equal(read(join(cfg.geminiHome, 'Gemini.md')).includes(cfg.rules.markers.geminiMd), false)
  assert.equal(existsSync(join(cfg.geminiHome, 'config', 'AGENTS.md')), false)
  assert.equal(existsSync(join(cfg.hooks.globalRoots[0], 'hooks.json')), false)
  assert.equal(existsSync(join(cfg.stateDir, 'hooks')), false)
  assert.equal(readAppliedStamp(cfg), null)
}

export async function testEnsureDryRunAndForce() {
  const { cfg } = makeCfg()
  const before = revOf(cfg.binaryPath)
  const dry = await ensureArmor(cfg, { apply: false, workspaces: [] })
  assert.equal(dry.changed.length, 0)
  assert.equal(revOf(cfg.binaryPath), before)                     // dry-run 不写盘
  assert.ok(dry.notes.some((n) => n.includes('DRY RUN')), dry.notes.join(' | '))

  markSettleRestart(cfg)
  const skipped = await ensureArmor(cfg, { apply: true, workspaces: [] })
  assert.equal(skipped.skipped, 'settle-cooldown')                // 冷却窗内不重打
  assert.equal(read(cfg.binaryPath).includes(MARKER), false)

  const forced = await ensureArmor(cfg, { apply: true, workspaces: [], force: true })
  assert.equal(forced.ok, true, forced.notes.join(' | '))
  assert.equal(read(cfg.binaryPath).includes(MARKER), true)
}

export async function testArmorOverrideTakesPrecedence() {
  const { cfg } = makeCfg()
  assert.equal(armorBody(cfg).trim(), 'ARMOR BODY')

  const edit = armorEdit(cfg)
  writeFileSync(edit.user, 'CUSTOM BODY\n')
  assert.equal(armorBody(cfg).trim(), 'CUSTOM BODY')

  const st = armorStatus(cfg)
  assert.equal(st.customized, true)
  assert.equal(st.seedChanged, false)

  writeFileSync(join(cfg.assetsDir, 'armor.md'), 'SEED V2\n')
  assert.equal(armorStatus(cfg).seedChanged, true)   // 种子变了要让人看见，不静默覆盖

  armorReset(cfg)
  assert.equal(armorBody(cfg).trim(), 'SEED V2')
  assert.equal(armorStatus(cfg).customized, false)
}
