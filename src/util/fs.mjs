// 文件工具：BOM 安全读写、原子写、备份/还原、时间戳
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, copyFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { homedir } from 'node:os'

export const BOM = Buffer.from([0xef, 0xbb, 0xbf])

/** 展开 ~ / 反斜杠，返回绝对路径 */
export function expand(p) {
  if (!p) return p
  let out = p
  if (out.startsWith('~/') || out === '~') out = join(homedir(), out.slice(1))
  return out
}

export function ensureDir(p) { mkdirSync(p, { recursive: true }); return p }

/** 读文本并剥离 BOM —— Antigravity 的 JSON 解析器不认 BOM，这是本工程踩过的坑 */
export function readText(p) {
  const buf = readFileSync(p)
  const body = buf.subarray(0, 3).equals(BOM) ? buf.subarray(3) : buf
  return body.toString('utf8')
}

export function hasBom(p) {
  if (!existsSync(p)) return false
  const buf = readFileSync(p)
  return buf.subarray(0, 3).equals(BOM)
}

/** 原子写，永不写 BOM */
export function writeText(p, text) {
  ensureDir(dirname(p))
  const tmp = p + '.tmp-' + process.pid
  writeFileSync(tmp, Buffer.from(text, 'utf8'))
  renameSync(tmp, p)
  return p
}

export function readJson(p) { return JSON.parse(readText(p)) }

export function backup(p, backupDir, tag = 'bak') {
  if (!existsSync(p)) return null
  ensureDir(backupDir)
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const dest = join(backupDir, stamp + '-' + tag + '-' + basename(p).replace(/[^\w.-]/g, '_'))
  copyFileSync(p, dest)
  return dest
}

export function listBackups(backupDir, tag) {
  if (!existsSync(backupDir)) return []
  return readdirSync(backupDir)
    .filter((f) => !tag || f.includes(tag))
    .map((f) => ({ name: f, path: join(backupDir, f), mtime: statSync(join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
}

export function restore(from, to) {
  copyFileSync(from, to)
  return to
}

/** 从 CWD 向上找 repo 根（含 .git 的目录），用于工作区归属判断 */
export function findRepoRoot(start = process.cwd()) {
  let cur = start
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(cur, '.git'))) return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
  return null
}
