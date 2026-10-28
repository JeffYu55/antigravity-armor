// aarmor uninstall —— 移植自 dsh-purge 的 lib/uninstall.js：
// 逐层还原/摘除，最后清戳。默认只出计划，--apply 才动手。
//
// 顺序有讲究（都踩过）：
//   1) 宿主文件 binary/ide —— 内容寻址备份 + 过期刷新
//   2) 席位词包 —— 会整文件还原 GEMINI.md（.pre-armor），所以必须**排在 rules 摘除之前**，
//      否则先摘干净、再被席位还原带回来
//   3) rules / hooks 注入位摘除
//   4) 清戳
// 任何一步失败只影响该步 —— 卸载最怕「中途抛异常，人以为卸干净了」。
import { existsSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readText, writeText, backup, expand, listBackups } from '../util/fs.mjs'
import { HOOK_NAMES, discoverWorkspaces } from '../layers/hooks.mjs'
import { RULES_HEADER, RULES_OVERRIDES, armorBody, ruleTargets } from '../layers/rules.mjs'
import { rollbackBinary } from '../layers/binary.mjs'
import { rollbackIde } from '../layers/ide.mjs'
import { SEATS } from '../seats/packs.mjs'
import { restore as restoreSeat } from '../seats/deploy.mjs'
import { clearStamp } from './state.mjs'

/** 时间戳备份里找某文件最近一份（install 时按 basename 命名） */
function latestBackupFor(cfg, path, tag) {
  const want = basename(path).replace(/[^\w.-]/g, '_')
  return listBackups(cfg.backupDir, tag).find((b) => b.name.endsWith('-' + want)) || null
}

/**
 * 卸载。返回 [{ step, path, action, applied, note }]
 * action: restore | delete | strip | keep | skip
 */
export function uninstallArmor(cfg, { apply = false, workspaces = null } = {}) {
  const results = []
  const add = (step, path, action, extra = {}) => {
    results.push({ step, path, action, applied: apply && action !== 'keep' && action !== 'skip', ...extra })
    return results[results.length - 1]
  }
  const ws = workspaces || discoverWorkspaces(cfg)

  // ---- 1. binary
  if (!apply) add('binary', cfg.binaryPath, 'restore', { note: '计划：还原原件（内容寻址备份 / 时间戳备份兜底）' })
  else {
    try {
      if (!existsSync(cfg.binaryPath)) add('binary', cfg.binaryPath, 'skip', { note: 'missing' })
      else add('binary', cfg.binaryPath, 'restore', { note: String(rollbackBinary(cfg)) })
    } catch (e) {
      add('binary', cfg.binaryPath, 'skip', { note: 'failed: ' + (e.message || e) })
    }
  }

  // ---- 2. ide
  if (!apply) add('ide', cfg.asarPath, 'restore', { note: '计划：还原官方 app.asar' })
  else {
    try {
      if (!existsSync(cfg.asarPath)) add('ide', cfg.asarPath, 'skip', { note: 'missing' })
      else add('ide', cfg.asarPath, 'restore', { note: String(rollbackIde(cfg)) })
    } catch (e) {
      add('ide', cfg.asarPath, 'skip', { note: 'failed: ' + (e.message || e) })
    }
  }

  // ---- 3. 席位词包（必须先于 rules —— 它会整文件还原 GEMINI.md）
  const seatHomes = {
    gemini: cfg.geminiHome,
    glm: process.env.GLM_CONFIG_DIR,
    deepseek: process.env.DEEPSEEK_CONFIG_DIR,
  }
  for (const [seat, home] of Object.entries(seatHomes)) {
    if (!SEATS[seat] || !home) continue
    try {
      const r = restoreSeat(seat, home)
      add('seats', r.path || join(home, SEATS[seat].file || ''), r.restored === 'nothing-to-do' ? 'skip' : 'restore', { note: r.restored })
    } catch (e) {
      add('seats', home, 'skip', { note: 'failed: ' + (e.message || e) })
    }
  }

  // ---- 4. rules
  const body = armorBody(cfg)
  const marker = cfg.rules.markers.geminiMd
  const appended = '\n\n' + marker + '\n' + RULES_HEADER + body + RULES_OVERRIDES
  const headerLine = RULES_HEADER.split('\n')[0]
  for (const t of ruleTargets(cfg, ws)) {
    if (!existsSync(t.path)) { add('rules', t.path, 'skip', { note: 'missing' }); continue }
    let cur = ''
    try { cur = readText(t.path) } catch { add('rules', t.path, 'skip', { note: 'unreadable' }); continue }

    if (t.mode === 'append') {
      if (!cur.includes(marker)) { add('rules', t.path, 'keep', { note: 'no marker' }); continue }
      const at = cur.indexOf(appended)
      const out = at >= 0
        ? cur.slice(0, at) + cur.slice(at + appended.length)
        : cur.slice(0, cur.indexOf(marker)).replace(/\s+$/, '') + '\n'
      if (apply) {
        backup(t.path, cfg.backupDir, 'pre-uninstall')
        writeText(t.path, out)
      }
      add('rules', t.path, 'strip', { note: at >= 0 ? 'appended-block' : 'marker-to-eof' })
      continue
    }

    // write 模式：自有文件（技能/工作区规则）直接删；全局规则文件优先还原 pre-rules 备份
    if (t.owned) {
      if (apply) { backup(t.path, cfg.backupDir, 'pre-uninstall'); rmSync(t.path, { force: true }) }
      add('rules', t.path, 'delete')
      continue
    }
    const bak = latestBackupFor(cfg, t.path, 'pre-rules')
    if (bak && !readText(bak.path).includes(headerLine)) {
      if (apply) {
        backup(t.path, cfg.backupDir, 'pre-uninstall')
        writeText(t.path, readText(bak.path))
      }
      add('rules', t.path, 'restore', { note: bak.name })
    } else if (cur === t.text || cur.includes(headerLine)) {
      if (apply) { backup(t.path, cfg.backupDir, 'pre-uninstall'); rmSync(t.path, { force: true }) }
      add('rules', t.path, 'delete', { note: 'no usable pre-rules backup' })
    } else {
      add('rules', t.path, 'keep', { note: 'not ours' })
    }
  }

  // ---- 5. hooks
  const armorKeys = new Set(Object.values(HOOK_NAMES))
  const hookTargets = [...(cfg.hooks.globalRoots || []).map(expand), ...ws.map((w) => join(w, '.agents'))]
  for (const dir of hookTargets) {
    const p = join(dir, 'hooks.json')
    if (!existsSync(p)) { add('hooks', p, 'skip', { note: 'missing' }); continue }
    let raw = null
    try { raw = JSON.parse(readText(p)) } catch { add('hooks', p, 'skip', { note: 'invalid json' }); continue }
    const keys = Object.keys(raw || {}).filter((k) => armorKeys.has(k))
    if (!keys.length) { add('hooks', p, 'keep', { note: 'no armor entries' }); continue }
    for (const k of keys) delete raw[k]
    const rest = Object.keys(raw).length
    if (apply) {
      backup(p, cfg.backupDir, 'pre-uninstall')
      if (rest === 0) rmSync(p, { force: true })
      else writeText(p, JSON.stringify(raw, null, 2))
    }
    add('hooks', p, rest === 0 ? 'delete' : 'strip', { note: keys.join(',') })
  }
  // 部署副本目录（我们自己的运行态）
  const scriptDir = join(cfg.stateDir, 'hooks')
  if (existsSync(scriptDir)) {
    if (apply) rmSync(scriptDir, { recursive: true, force: true })
    add('hooks', scriptDir, 'delete', { note: 'deployed scripts' })
  }

  // ---- 6. 清戳（备份与版本历史保留：取证材料）
  if (apply) clearStamp(cfg)
  add('state', cfg.purgeDir, 'delete', { note: 'stamp + settle guard（history/backups 保留）' })

  return results
}
