// 版本来源：package.json 的 version（dsh-purge 也从 package.json 读版本）。
// 读不到时回落常量 —— 单测在临时目录跑也不会因此炸。
import { readFileSync } from 'node:fs'

let v = '1.9.0'
try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (pkg && pkg.version) v = String(pkg.version)
} catch { /* 保底用常量 */ }

export const AARMOR_VERSION = v
