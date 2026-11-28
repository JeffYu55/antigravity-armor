// 层 4：IDE 侧等长补丁 —— 把 languageServer 的 --cloud_code_endpoint 指到本地改道代理
//
// v1.10.0：锚点不再写死一条完整 URL。升级后 app.asar 里的 endpoint 可能变成
// 模板拼接（`https://` + host），完整 URL 就搜不到；这里按三档兜底：
//   1) 配置里的 endpointFind（完整 URL）
//   2) 配置里的 ide.anchors 追加锚点
//   3) 从 endpointFind 解出来的裸主机名（几乎总在）
// 三档都命不中才报 anchor-missing —— 那才是真的版本漂移。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { backup, listBackups, restore } from '../util/fs.mjs'
import { countOccurrences } from '../util/bytes.mjs'
import { saveOriginal, refreshStaleOriginal, restoreOriginal } from '../purge/hostbackups.mjs'
import { log } from '../log.mjs'

function hostOf(url) {
  try { return new URL(url).host } catch { return String(url || '').replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '') }
}

/** 候选锚点：完整 URL → 额外锚点 → 裸主机名 */
export function candidateAnchors(cfg) {
  const list = []
  const push = (a) => { if (a && !list.includes(a)) list.push(a) }
  push(cfg.ide.endpointFind)
  for (const a of cfg.ide.anchors || []) push(a)
  push(hostOf(cfg.ide.endpointFind))
  return list
}

/** 构造等长替换：完整 URL 锚点替换成 base；裸主机名锚点替换成 base 的 host + 填充路径 */
export function buildReplacement(cfg, find = cfg.ide.endpointFind) {
  const base = String(cfg.ide.endpointBase || '').replace(/\/+$/, '')
  const isFullUrl = find.includes('://')
  const target = isFullUrl ? base : hostOf(base)
  const pad = find.length - target.length - 1
  if (pad < 1) throw new Error('endpointBase too long for equal-length patch: ' + find.length + ' <= ' + target.length)
  // 尾部补 '/a' + 'p'*n：divert 的 stripPad 认 `/ap{3,}/`，补出来的路径会被吃掉
  return target + '/a' + 'p'.repeat(pad - 1)
}

/** 在 buffer 里挑第一个命中的锚点 */
export function detectAnchor(cfg, buf) {
  for (const find of candidateAnchors(cfg)) {
    const hits = countOccurrences(buf, find)
    if (!hits) continue
    const repl = buildReplacement(cfg, find)
    return { find, repl, hits, done: countOccurrences(buf, repl) }
  }
  // 所有锚点都没命中：可能「已经打过了」——替换串本身还在，就是已打。
  // 旧实现在这里把 done 写死 0，于是打完补丁的状态一律显示 anchor-missing，
  // ensure 复核必然判失败 → 无限重打。这种「状态错」比「补丁错」更难查。
  // 注意要逐个候选锚点试：用哪一档锚点打的，留下的就是那一档对应的替换串
  // （整条 URL 的替换串和裸主机名的替换串长度/内容都不同）。
  return detectApplied(cfg, buf) || { find: candidateAnchors(cfg)[0] || null, repl: null, hits: 0, done: 0 }
}

function detectApplied(cfg, buf) {
  for (const find of candidateAnchors(cfg)) {
    let repl = null
    try { repl = buildReplacement(cfg, find) } catch { continue }
    const done = countOccurrences(buf, repl)
    if (done) return { find, repl, hits: 0, done, applied: true }
  }
  return null
}

export function installIde(cfg, { apply = false } = {}) {
  const p = cfg.asarPath
  if (!p || !existsSync(p)) throw new Error('app.asar not found: ' + p)
  const buf = readFileSync(p)
  const { find, repl, hits, done } = detectAnchor(cfg, buf)
  log.info('ide: ' + p)
  log.info('  anchor: ' + JSON.stringify(find) + ' x' + hits + (find !== cfg.ide.endpointFind ? '（回落锚点）' : ''))
  log.info('  repl  : ' + JSON.stringify(repl) + ' x' + done + ' (equal length ' + (find.length === repl.length) + ')')
  if (!apply) return { dryRun: true, hits, already: done > 0, anchor: find }
  if (done > 0 && hits === 0) return { already: true, anchor: find }
  if (hits === 0) throw new Error('anchor not found in app.asar (version drift?) —— 试过 ' + JSON.stringify(candidateAnchors(cfg)))
  // 内容寻址备份：只在 live 还是官方原件时保存
  if (done === 0) saveOriginal(cfg, p, buf)
  const bak = backup(p, cfg.backupDir, 'pre-ide')
  const out = Buffer.from(buf)
  const nb = Buffer.from(repl, 'utf8')
  let i = 0
  while (true) { const k = out.indexOf(Buffer.from(find, 'utf8'), i); if (k < 0) break; nb.copy(out, k); i = k + 1 }
  writeFileSync(p, out)
  log.ok('patched ' + hits + ' occurrence(s), length unchanged: ' + (out.length === buf.length))
  log.ok('backup: ' + bak)
  return { patched: hits, backup: bak, sameLength: out.length === buf.length, anchor: find }
}

export function rollbackIde(cfg) {
  // 与 binary 同一套升级防护：先刷新过期备份，再还原「当前这一版」的原件
  const repl = buildReplacement(cfg, cfg.ide.endpointFind)
  refreshStaleOriginal(cfg, cfg.asarPath, repl)
  const hit = restoreOriginal(cfg, cfg.asarPath)
  if (hit) return hit.restored
  const b = listBackups(cfg.backupDir, 'pre-ide')[0]
  if (!b) throw new Error('no ide backup')
  restore(b.path, cfg.asarPath)
  return b.path
}

/** 逐补丁漂移实检：pending=hits 是锚点还在（可重打），全 0 是锚点表不匹配（版本漂移） */
export function patchStatusIde(cfg, { path = null } = {}) {
  const p = path || cfg.asarPath
  if (!p || !existsSync(p)) return { layer: 'ide', exists: false, patched: false, pending: 0, blocked: 'missing' }
  const buf = readFileSync(p)
  const { find, hits, done } = detectAnchor(cfg, buf)
  return {
    layer: 'ide', exists: true, patched: done > 0, pending: hits, anchor: find,
    blocked: hits === 0 && done === 0 ? 'anchor-missing' : null,
  }
}
