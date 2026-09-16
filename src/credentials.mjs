// 密钥解析：环境变量 -> ~/.dsh/.credentials.yaml 的 refs: 段
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function resolveKey(cfg, ref) {
  if (!ref) return null
  if (process.env[ref]) return process.env[ref]
  const f = join(cfg.dshHome, '.credentials.yaml')
  if (!existsSync(f)) return null
  const text = readFileSync(f, 'utf8')
  const re = new RegExp('^\\s*' + ref + ':\\s*(\\S+)\\s*$', 'm')
  const m = text.match(re)
  return m ? m[1] : null
}
