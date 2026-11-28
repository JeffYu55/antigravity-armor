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

/**
 * 改道（asar 端点补丁）是否**被配置挡住**。
 *
 * 为什么要有这道闸（2026-11 现场）：把 app.asar 里的
 * https://daily-cloudcode-pa.googleapis.com 改成 127.0.0.1:50100 之后，
 * 只要 divert 没有可用 key，聊天请求就会 503 —— 也就是说「补丁打上了，
 * 宿主反而不能用了」。旧实现不看 key 就打，结果一次 ensure 就能把 IDE 聊死。
 *
 * 返回 null = 可以打；'no-key' = 缺 key，跳过改道（其余层照常）。
 * 没有配置 divert 的场景（合成配置、单测）不拦：那是显式要测打补丁这条路径。
 */
export function redirectBlocked(cfg) {
  const d = cfg && cfg.divert
  if (!d || !d.keyRef) return null
  try {
    return resolveKey(cfg, d.keyRef) ? null : 'no-key'
  } catch {
    return 'no-key'
  }
}
