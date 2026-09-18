// 注入位磁盘侧审计与摘除（v1.8.3）
//
// 为什么必须有它：出站剥离（stripForeignArmor）只是**止血**。
// 客户端每一轮都从磁盘的规则文件重新生成 `<user_rules>`，
// 所以只要那份外来 persona 词包还在文件里，它每轮都会回来。
// （该文件在每次请求里占 part0 的 49.7%，实测 22,790 字符。）
//
// 借鉴 Astra 的 "own the injection site" 原则：**注入位只该有我们装的那几份**。
// 但摘除必须可逆：先审计、再备份、再动手；默认只预览不写入。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readText, writeText, backup, expand } from '../util/fs.mjs'
import { findForeignPacks, classifyRuleBlocks, scanHotWords } from './gemini-retry.mjs'

const RULE_RE = /<RULE\[([^\]]*)\]>([\s\S]*?)<\/RULE\[[^\]]*\]>/g

/** 本机所有注入位文件（全局规则 + 技能 + 各工作区规则） */
export function ruleFiles(cfg) {
  const safeExpand = (p) => { try { return p ? expand(String(p)) : null } catch { return null } }
  const out = [
    ...((cfg && cfg.rules && cfg.rules.globalFiles) || []).map(safeExpand),
    cfg && cfg.rules && cfg.rules.skillFile ? safeExpand(cfg.rules.skillFile) : null,
    ...(((cfg && cfg.hooks && cfg.hooks.workspaces) || [])).map((w) => safeExpand(join(w, (cfg.rules && cfg.rules.workspaceRule) || '.agents/rules/00-armor.md'))),
  ].filter(Boolean)
  return [...new Set(out)]
}

/** 审计：每份注入位文件里有哪些词包、哪些是外来的、有哪些触发词 */
export function scanRuleFiles(cfg) {
  const report = []
  for (const p of ruleFiles(cfg)) {
    if (!existsSync(p)) { report.push({ path: p, exists: false }); continue }
    let t = ''
    try { t = readText(p) } catch { report.push({ path: p, exists: true, unreadable: true }); continue }
    const foreign = findForeignPacks(t)
    report.push({
      path: p,
      exists: true,
      bytes: t.length,
      blocks: classifyRuleBlocks(t),
      foreign: foreign.map((f) => ({ name: f.name, bytes: f.text.length })),
      foreignBytes: foreign.reduce((a, f) => a + f.text.length, 0),
      hotWords: scanHotWords(t),
    })
  }
  return report
}

/** 从一份文件里摘掉外来词包（含清空壳）。apply=false 只预览。
 *  返回 { changed, removed, path, applied }。 */
export function disarmRuleFile(path, cfg, { apply = false } = {}) {
  if (!existsSync(path)) return { path, changed: false, removed: 0, reason: '文件不存在' }
  let t = readText(path)
  const packs = findForeignPacks(t)
  if (!packs.length) return { path, changed: false, removed: 0, reason: '无外来词包' }
  let out = t
  const names = []
  for (const p of packs) {
    if (!p.text || !out.includes(p.text)) continue
    names.push(p.name)
    out = out.split(p.text).join('')
  }
  // 空壳清理（与出站剥离同一套判据，保持两边一致）
  out = out.replace(RULE_RE, (whole, _n, inner) => (String(inner).trim() ? whole : ''))
  out = out.replace(/<user_rules>([\s\S]*?)<\/user_rules>/g, (whole, inner) => (/<RULE\[/.test(inner) ? whole : ''))
  out = out.replace(/\n{4,}/g, '\n\n\n')
  const removed = t.length - out.length
  if (removed <= 0) return { path, changed: false, removed: 0, reason: '无变化' }
  if (!apply) return { path, changed: true, removed, names, preview: true }
  backup(path, cfg.backupDir, 'pre-foreign-disarm')   // 可逆：先备份再写
  writeText(path, out)
  return { path, changed: true, removed, names, applied: true }
}

/** 一次性审计全部注入位并（可选）摘除外来词包 */
export function disarmAll(cfg, { apply = false } = {}) {
  const results = []
  for (const p of ruleFiles(cfg)) results.push(disarmRuleFile(p, cfg, { apply }))
  return results
}
