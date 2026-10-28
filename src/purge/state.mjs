// purge 状态戳与守卫 —— 移植自 dsh-purge 的 lib/reapply.js（applied.json / installed-rev / settle-restart.guard）。
//
// 为什么本项目需要它：此前唯一的判据是「标记在不在」这个瞬时状态。
// 标记在 ≠ 打的是当前这版宿主 —— Antigravity 升级会把 exe/asar 整个换成新版，
// 旧备份随即过期；拿它回滚就是把旧版本写回新安装（dsh-purge 踩过的同类坑）。
// 现在每次落盘都记一份戳：armorVersion + 各层 rev（sha256 前 16 位）+ 时间，
// ensure 用它判断「对齐 / 漂移 / 需要重打」，rollback 用它判断「备份还是不是这一版的」。
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { AARMOR_VERSION } from '../version.mjs'

const STAMP_FILE = 'applied.json'
const GUARD_FILE = 'settle-restart.guard'
const HISTORY_FILE = 'version-history.json'

export function statePath(cfg, name) {
  return join(cfg.purgeDir, name)
}

function readJson(p, fallback = null) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
}

function writeJson(p, value) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/** 文件内容 rev（sha256 前 16 位）—— 等同于 dsh-purge 的 installed-rev */
export function revOf(path) {
  try {
    if (!path || !existsSync(path)) return null
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
  } catch { return null }
}

export function readAppliedStamp(cfg) {
  const raw = readJson(statePath(cfg, STAMP_FILE))
  if (!raw || typeof raw !== 'object' || !raw.armorVersion) return null
  return {
    armorVersion: String(raw.armorVersion),
    at: String(raw.at || ''),
    revs: raw.revs && typeof raw.revs === 'object' ? raw.revs : {},
    layers: raw.layers && typeof raw.layers === 'object' ? raw.layers : {},
    workspaces: Array.isArray(raw.workspaces) ? raw.workspaces : [],
    pendingRestart: raw.pendingRestart === true,
  }
}

/** 戳是否还成立：版本一致 + 两层宿主文件的 rev 和打戳时一致 */
export function stampMatches(stamp, revs = {}) {
  if (!stamp || !stamp.armorVersion) return false
  if (stamp.armorVersion !== AARMOR_VERSION) return false
  if (!stamp.revs || !stamp.revs.binary || !stamp.revs.ide) return false
  if (!revs.binary || !revs.ide) return false
  return stamp.revs.binary === revs.binary && stamp.revs.ide === revs.ide
}

function recordVersionHistory(cfg, entry) {
  const p = statePath(cfg, HISTORY_FILE)
  const hist = readJson(p, [])
  const list = Array.isArray(hist) ? hist : []
  list.push(entry)
  writeJson(p, list.slice(-50))
}

export function readVersionHistory(cfg) {
  const h = readJson(statePath(cfg, HISTORY_FILE), [])
  return Array.isArray(h) ? h : []
}

/** 打戳：只在「应用完成且复核通过」时调用（和 dsh-purge 的 markPatchesApplied 同语义） */
export function markPatchesApplied(cfg, { revs = {}, layers = {}, workspaces = [], pendingRestart = false } = {}) {
  const stamp = {
    armorVersion: AARMOR_VERSION,
    at: new Date().toISOString(),
    revs: { binary: revs.binary || null, ide: revs.ide || null },
    layers,
    workspaces,
    pendingRestart: pendingRestart === true,
  }
  writeJson(statePath(cfg, STAMP_FILE), stamp)
  recordVersionHistory(cfg, { armorVersion: stamp.armorVersion, at: stamp.at, revs: stamp.revs })
  return stamp
}

/** 清戳（uninstall 用）。历史与内容寻址备份保留 —— 那是取证材料，不是状态。 */
export function clearStamp(cfg) {
  for (const name of [STAMP_FILE, GUARD_FILE]) {
    try { rmSync(statePath(cfg, name), { force: true }) } catch {}
  }
}

/** settle 冷却：上轮刚重打/重启过就不要再打一轮，否则会打成「重打→重启→再重打」死循环 */
export function shouldSkipSettle(cfg, windowMs = 180000) {
  const raw = readJson(statePath(cfg, GUARD_FILE))
  if (!raw || String(raw.armorVersion || '') !== AARMOR_VERSION) return false
  const at = Date.parse(String(raw.at || '')) || 0
  const win = windowMs === null || windowMs === undefined ? 180000 : Number(windowMs)
  return at > 0 && Date.now() - at < win
}

export function markSettleRestart(cfg) {
  writeJson(statePath(cfg, GUARD_FILE), { armorVersion: AARMOR_VERSION, at: new Date().toISOString() })
}

/** 戳里最后一次成功应用的摘要（status 一行展示用） */
export function stampSummary(stamp) {
  if (!stamp) return null
  return {
    version: stamp.armorVersion,
    at: stamp.at,
    binary: stamp.revs && stamp.revs.binary ? String(stamp.revs.binary).slice(0, 8) : null,
    ide: stamp.revs && stamp.revs.ide ? String(stamp.revs.ide).slice(0, 8) : null,
    pendingRestart: !!stamp.pendingRestart,
  }
}
