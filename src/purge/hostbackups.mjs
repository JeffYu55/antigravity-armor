// 内容寻址宿主备份 —— 移植自 dsh-purge 的 host-backups/<sha>.bak + <sha>.json。
//
// 与 state/backup 的时间戳备份并存：时间戳备份是历史流水（人看），
// 内容寻址备份是 binary/ide 的**权威还原源**（机器用）：
//   - 同内容天然去重（同版本反复 install 不涨盘）
//   - 元数据记 origPath / sha / at，还原时按路径取「最新一份原件」
//   - refreshStaleOriginal 修掉升级后的过期备份：宿主被换新版但 bak 还是旧版，
//     直接回滚 = 把旧版本写回新安装（n 版混码/降级），这里先把 bak 刷成新原件。
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const SUB = 'host-backups'

export function shaOf(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export function backupsDir(cfg) {
  return join(cfg.purgeDir, SUB)
}

function norm(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase()
}

/** 保存一份原件（内容已存在则不重复写盘，只更新元数据里的路径/最近见到时间） */
export function saveOriginal(cfg, path, buf = null) {
  if (!path || !existsSync(path)) return null
  const data = buf || readFileSync(path)
  const sha = shaOf(data)
  const id = sha.slice(0, 16)
  const dir = backupsDir(cfg)
  mkdirSync(dir, { recursive: true })
  const bak = join(dir, id + '.bak')
  const metaPath = join(dir, id + '.json')
  let saved = false
  if (!existsSync(bak)) {
    writeFileSync(bak, data)
    saved = true
  }
  const meta = (() => {
    try { return JSON.parse(readFileSync(metaPath, 'utf8')) } catch { return null }
  })() || { id, sha, size: data.length, at: new Date().toISOString(), paths: [] }
  if (!Array.isArray(meta.paths)) meta.paths = []
  if (!meta.paths.some((x) => norm(x) === norm(path))) meta.paths.push(path)
  meta.lastSeenAt = new Date().toISOString()
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8')
  return { id, bak, meta, saved, sha }
}

/** 全部原件记录，按最近见到时间倒序 */
export function listOriginals(cfg) {
  const dir = backupsDir(cfg)
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const meta = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      const bak = join(dir, f.replace(/\.json$/, '.bak'))
      if (!existsSync(bak)) continue
      out.push({ ...meta, bak })
    } catch { /* 坏元数据跳过 */ }
  }
  return out.sort((a, b) => String(b.lastSeenAt || b.at || '').localeCompare(String(a.lastSeenAt || a.at || '')))
}

/** 某个路径最近一次记录的原件 */
export function originalFor(cfg, path) {
  return listOriginals(cfg).find((m) => Array.isArray(m.paths) && m.paths.some((x) => norm(x) === norm(path))) || null
}

/**
 * 升级后刷新过期备份：
 *   live 无 marker（= 宿主被官方更新换成了新原件）且与现有 bak 字节不同 → 把 live 存成新原件。
 * 只有「无 marker」才认 —— 有 marker 说明 live 是装甲版，它不能当原件。
 */
export function refreshStaleOriginal(cfg, path, marker) {
  if (!path || !existsSync(path)) return { refreshed: false, reason: 'missing' }
  const live = readFileSync(path)
  const hasMarker = marker ? live.includes(Buffer.from(marker, 'utf8')) : false
  const prev = originalFor(cfg, path)
  if (hasMarker) return { refreshed: false, reason: 'armored', prev }
  if (prev && existsSync(prev.bak)) {
    let same = false
    try { same = Buffer.compare(readFileSync(prev.bak), live) === 0 } catch { same = false }
    if (same) return { refreshed: false, reason: 'same', prev }
  }
  const saved = saveOriginal(cfg, path, live)
  return { refreshed: true, reason: prev ? 'stale-bak-refreshed' : 'seeded', id: saved.id, prev }
}

/** 还原某路径最近的原件；没有记录返回 null（调用方回落到时间戳备份） */
export function restoreOriginal(cfg, path) {
  const hit = originalFor(cfg, path)
  if (!hit) return null
  writeFileSync(path, readFileSync(hit.bak))
  return { restored: hit.bak, id: hit.id, sha: hit.sha }
}
