// 事务式席位词包部署（备份 -> 原子写入 -> SHA-256 校验 -> 可恢复）
// 参考 Astra 桌面端的部署合同：preview 不写入；deploy 自动备份；verify 对账；restore 恢复。
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { SEATS, renderPack, MARKERS } from './packs.mjs'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 席位配置文件路径（home 为目标客户端配置目录） */
export function seatFile(seat, home) {
  if (!SEATS[seat]) throw new Error('未知席位: ' + seat)
  return join(home, SEATS[seat].file)
}

/** 预览：只读，不写入。返回将要发生的变更 */
export function preview(seat, home, opts = {}) {
  const path = seatFile(seat, home)
  const want = renderPack(seat, opts)
  const cur = existsSync(path) ? readFileSync(path, 'utf8') : null
  const already = cur !== null && cur.includes(MARKERS.begin)
  const merged = already
    ? cur.replace(new RegExp(MARKERS.begin + '[\\s\\S]*?' + MARKERS.end, 'g'), want)
    : cur === null ? want : cur.replace(/\s*$/, '') + '\n\n' + want + '\n'
  return { seat, path, exists: cur !== null, alreadyDeployed: already, after: merged, sha256After: sha256(Buffer.from(merged, 'utf8')) }
}

/** 部署：备份原件 -> 原子写入（临时文件+改名）-> 返回对账信息 */
export function deploy(seat, home, opts = {}) {
  const pv = preview(seat, home, opts)
  let backup = null
  if (pv.exists) {
    backup = pv.path + '.pre-armor'
    copyFileSync(pv.path, backup)
  } else {
    mkdirSync(dirname(pv.path), { recursive: true })
  }
  const tmp = pv.path + '.tmp'
  writeFileSync(tmp, pv.after)
  renameSync(tmp, pv.path)
  return { seat, path: pv.path, backup, sha256: pv.sha256After, bytes: Buffer.byteLength(pv.after) }
}

/** 校验：文件里的词包块哈希与期望渲染是否一致 */
export function verify(seat, home, opts = {}) {
  const path = seatFile(seat, home)
  if (!existsSync(path)) return { ok: false, reason: 'missing' }
  const cur = readFileSync(path, 'utf8')
  const m = cur.match(new RegExp(MARKERS.begin + '[\\s\\S]*?' + MARKERS.end))
  if (!m) return { ok: false, reason: 'no-block' }
  const want = renderPack(seat, opts)
  return { ok: m[0] === want, reason: m[0] === want ? 'match' : 'drift', sha256: sha256(Buffer.from(m[0], 'utf8')) }
}

/** 恢复：删词包块；有 .pre-armor 备份则整文件还原 */
export function restore(seat, home) {
  const path = seatFile(seat, home)
  const backup = path + '.pre-armor'
  if (existsSync(backup)) {
    copyFileSync(backup, path)
    return { restored: 'from-backup', path }
  }
  if (!existsSync(path)) return { restored: 'nothing-to-do' }
  const cur = readFileSync(path, 'utf8')
  const next = cur.replace(new RegExp('\n*' + MARKERS.begin + '[\\s\\S]*?' + MARKERS.end + '\n*', 'g'), '\n')
  writeFileSync(path, next)
  return { restored: 'block-removed', path }
}