// aarmor ensure —— 移植自 dsh-purge 的 reapplyInstalled（lib/reapply.js）：
//   刷新过期备份 → 还原原件 → 按当前补丁表重打 → 复核 → 打戳。
//
// 解决三个既有隐患：
//   1) Antigravity 升级后 exe/asar 被换成新版，旧备份还在 —— 直接回滚 = 旧版本写回新安装；
//   2) 「标记在不在」只能发现全丢，发现不了半打/版本漂移；
//   3) 每次升级都要人记住跑 install --apply（忘了就一直裸奔）。
// 现在 autostart 的 `divert ensure` 会顺带跑 ensure（cfg.purge.autoEnsure），自愈闭环。
import { createHash } from 'node:crypto'
import { patchStatusBinary, installBinary } from '../layers/binary.mjs'
import { patchStatusIde, installIde, buildReplacement } from '../layers/ide.mjs'
import { patchStatusRules, installRules, armorBody } from '../layers/rules.mjs'
import { patchStatusHooks, installHooks, discoverWorkspaces } from '../layers/hooks.mjs'
import { refreshStaleOriginal, restoreOriginal } from './hostbackups.mjs'
import {
  revOf, readAppliedStamp, stampMatches, markPatchesApplied,
  shouldSkipSettle, markSettleRestart,
} from './state.mjs'

const sha16 = (t) => createHash('sha256').update(String(t), 'utf8').digest('hex').slice(0, 16)
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ETXTBSY'])

function isLocked(e) {
  if (!e) return false
  if (LOCK_CODES.has(String(e.code || ''))) return true
  return /being used by another process|另一个程序|拒绝访问|resource busy|EBUSY|EPERM|EACCES/i.test(String(e.message || ''))
}

/** 只读体检：戳、revs、四层 patchStatus、装甲正文 hash、冷却状态 */
export function purgeSummary(cfg, { workspaces = null } = {}) {
  const ws = workspaces || discoverWorkspaces(cfg)
  const revs = { binary: revOf(cfg.binaryPath), ide: revOf(cfg.asarPath) }
  const stamp = readAppliedStamp(cfg)
  const bodyHash = sha16(armorBody(cfg))
  const statuses = {
    binary: patchStatusBinary(cfg),
    ide: patchStatusIde(cfg),
    rules: patchStatusRules(cfg, { workspaces: ws }),
    hooks: patchStatusHooks(cfg, { workspaces: ws }),
  }
  // 正文漂移只对「已经有戳」的宿主成立；首次打戳前不因此判脏（否则永远差一口气）
  const bodyStale = !!(stamp && stamp.layers && stamp.layers.armorHash !== bodyHash)
  const pending = Object.values(statuses).reduce((a, s) => a + (s.pending || 0), 0)
  const blocked = Object.entries(statuses)
    .filter(([, s]) => s.blocked)
    .map(([layer, s]) => ({ layer, reason: s.blocked }))
  // 没有戳时「五层 pending=0」也算对齐：否则首次安装后永远要求重打一遍
  // （对应 dsh-purge 的 healEmptyAppliedStamp —— 缺的只是戳，补上即可，不必重装）。
  const stampOk = stamp ? stampMatches(stamp, revs) : true
  // settled = 与戳无关的「现状已落盘」：ensure 重打后先用它复核，再打新戳
  const settled = pending === 0 && blocked.length === 0 && !bodyStale
  return {
    stamp, revs, statuses, bodyHash, bodyStale, pending, blocked, workspaces: ws,
    settled,
    aligned: stampOk && settled,
    cooldown: shouldSkipSettle(cfg, Number(cfg.purge?.settleCooldownMs || 180000)),
  }
}

function layerDirty(pre, layer) {
  const st = pre.statuses[layer]
  if (!st) return false
  if (st.blocked) return false
  if ((st.pending || 0) > 0) return true
  if (layer === 'binary' || layer === 'ide') {
    const want = pre.stamp?.revs?.[layer]
    return !want || want !== pre.revs[layer] || !(layer === 'binary' ? st.armored : st.patched)
  }
  return false
}

/** 应用后打戳：只在复核通过时写（install --apply 与 ensure 共用） */
export function stampIfAligned(cfg, { workspaces = null, pendingRestart = false } = {}) {
  const ws = workspaces || discoverWorkspaces(cfg)
  const ps = purgeSummary(cfg, { workspaces: ws })
  if (!ps.aligned) return { stamped: false, pending: ps.pending, blocked: ps.blocked, bodyStale: ps.bodyStale }
  const stamp = markPatchesApplied(cfg, {
    revs: ps.revs,
    layers: {
      binary: 'ok', ide: 'ok', rules: 'ok', hooks: 'ok',
      armorHash: ps.bodyHash, changed: ['install'],
    },
    workspaces: ws,
    pendingRestart,
  })
  return { stamped: true, stamp }
}

/**
 * 幂等自愈。apply=false 只出计划。
 * 返回 { ok, noop, skipped, changed[], deferred[], blocked[], notes[], needsRestart }
 */
export async function ensureArmor(cfg, { apply = false, workspaces = null, force = false } = {}) {
  const out = { ok: true, noop: false, skipped: null, changed: [], deferred: [], blocked: [], notes: [], needsRestart: false }
  const ws = workspaces || discoverWorkspaces(cfg)
  const pre = purgeSummary(cfg, { workspaces: ws })

  if (pre.aligned) {
    out.noop = true
    // 只缺戳：补上即可，不重打（dsh-purge healEmptyAppliedStamp 同语义）。
    // dry-run 不写盘 —— 只报告「缺戳」。
    if (!pre.stamp && apply) {
      markPatchesApplied(cfg, {
        revs: pre.revs,
        layers: {
          binary: 'ok', ide: 'ok', rules: 'ok', hooks: 'ok',
          armorHash: pre.bodyHash, changed: [],
        },
        workspaces: ws,
        pendingRestart: false,
      })
      out.notes.push('已补齐 purge 戳（五层本已对齐）')
    } else if (!pre.stamp) {
      out.notes.push('缺 purge 戳（五层本已对齐）—— 加 --apply 补齐')
    } else {
      const s = pre.stamp
      out.notes.push('五层已对齐（v' + s.armorVersion + ' @ ' + s.at + '）')
    }
    return out
  }

  const cooldownMs = Number(cfg.purge?.settleCooldownMs || 180000)
  if (!force && shouldSkipSettle(cfg, cooldownMs)) {
    out.ok = false
    out.skipped = 'settle-cooldown'
    out.notes.push('冷却窗内（' + Math.round(cooldownMs / 1000) + 's）：上轮刚重打/待重启，本轮跳过（--force 可覆盖）')
    return out
  }

  for (const b of pre.blocked) {
    out.blocked.push(b)
    out.ok = false
    out.notes.push(b.layer + ': 补丁表与当前宿主不匹配（' + b.reason + '）—— Antigravity 版本变了，需要重抽锚点，不能瞎打')
  }

  if (!apply) {
    out.notes.push('DRY RUN：加 --apply 才写入')
    for (const layer of ['binary', 'ide', 'rules', 'hooks']) {
      const st = pre.statuses[layer]
      if (!st) continue
      if (st.pending || layerDirty(pre, layer)) out.notes.push(layer + ': 待重打（pending=' + (st.pending || 0) + '）')
      for (const n of st.notes || []) out.notes.push('  ' + n)
    }
    if (pre.bodyStale) out.notes.push('rules: 装甲正文 hash 与戳不一致（种子/覆盖位变过）')
    return out
  }

  // ---- binary
  if (!pre.blocked.some((b) => b.layer === 'binary') && layerDirty(pre, 'binary')) {
    try {
      const r = refreshStaleOriginal(cfg, cfg.binaryPath, cfg.binary.marker)
      if (r.refreshed) out.notes.push('binary: 备份已刷新（' + r.reason + '）—— 宿主被替换过')
      const back = restoreOriginal(cfg, cfg.binaryPath)
      if (back) out.notes.push('binary: 先还原原件 ' + String(back.id).slice(0, 8))
      const rep = installBinary(cfg, { apply: true })
      out.changed.push('binary')
      out.needsRestart = true
      out.notes.push('binary: 重打 ' + (rep.applied ?? 0) + ' 处（equal-length）')
    } catch (e) {
      if (isLocked(e)) {
        out.deferred.push({ layer: 'binary', reason: 'file-locked' })
        out.ok = false
        out.notes.push('binary: 文件被占用（' + (e.code || e.message) + '）—— 关掉 Antigravity 后重跑')
      } else {
        out.blocked.push({ layer: 'binary', reason: String(e.message || e) })
        out.ok = false
        out.notes.push('binary: 失败 ' + (e.message || e))
      }
    }
  }

  // ---- ide
  if (!pre.blocked.some((b) => b.layer === 'ide') && layerDirty(pre, 'ide')) {
    try {
      const r = refreshStaleOriginal(cfg, cfg.asarPath, buildReplacement(cfg))
      if (r.refreshed) out.notes.push('ide: 备份已刷新（' + r.reason + '）')
      const back = restoreOriginal(cfg, cfg.asarPath)
      if (back) out.notes.push('ide: 先还原原件 ' + String(back.id).slice(0, 8))
      const rep = installIde(cfg, { apply: true })
      out.changed.push('ide')
      out.needsRestart = true
      out.notes.push('ide: 端点补丁 ' + (rep.patched ?? 0) + ' 处')
    } catch (e) {
      if (isLocked(e)) {
        out.deferred.push({ layer: 'ide', reason: 'file-locked' })
        out.ok = false
        out.notes.push('ide: 文件被占用（' + (e.code || e.message) + '）—— 关掉 Antigravity 后重跑')
      } else {
        out.blocked.push({ layer: 'ide', reason: String(e.message || e) })
        out.ok = false
        out.notes.push('ide: 失败 ' + (e.message || e))
      }
    }
  }

  // ---- rules / hooks（纯文本层，直接幂等安装）
  if ((pre.statuses.rules.pending || 0) > 0 || pre.bodyStale) {
    const r = installRules(cfg, { apply: true, workspaces: ws })
    out.changed.push('rules')
    out.notes.push('rules: 写入 ' + r.count + ' 个注入位')
  }
  if ((pre.statuses.hooks.pending || 0) > 0) {
    const h = installHooks(cfg, { apply: true, workspaces: ws })
    out.changed.push('hooks')
    out.notes.push('hooks: ' + h.scripts.length + ' 个脚本 / ' + h.hookFiles + ' 个 hooks.json')
    out.needsRestart = true
  }

  // ---- 复核后打戳（未落盘就只记冷却，不写假戳）
  const post = purgeSummary(cfg, { workspaces: ws })
  if (post.settled) {
    markPatchesApplied(cfg, {
      revs: post.revs,
      layers: {
        binary: post.revs.binary && post.statuses.binary.pending === 0 ? 'ok' : 'pending',
        ide: post.revs.ide && post.statuses.ide.pending === 0 ? 'ok' : 'pending',
        rules: post.statuses.rules.pending === 0 ? 'ok' : 'pending',
        hooks: post.statuses.hooks.pending === 0 ? 'ok' : 'pending',
        armorHash: post.bodyHash,
        changed: out.changed,
      },
      workspaces: ws,
      pendingRestart: out.needsRestart,
    })
    out.ok = true
    out.notes.push('已打戳 v' + (post.stamp?.armorVersion || '') + '；' + (out.needsRestart ? '需重启 Antigravity 生效' : '无需重启'))
  } else {
    out.ok = false
    markSettleRestart(cfg)
    out.notes.push('复核未通过：pending=' + post.pending + (post.blocked.length ? ' blocked=' + post.blocked.map((b) => b.layer).join(',') : ''))
  }
  return out
}
