// seat 注入器 —— armor 自己带提示词的落点
//
// 三条来源，按优先级：
//   1. 覆盖位 state/purge/armor-override.md（悬浮窗/CLI 写的）
//   2. 队列 state/hud/inject-queue.json（一次性 / TTL / 条件注入）
//   3. 车道种子 assets/seat-<lane>.md
// 全部拼进 systemInstruction 的**最后一片 part**（armor 决策 4/7 的实测结论：
// 只有系统位有效，且必须压在静态身份提示之后）。
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { scanHotWords } from './gemini-retry.mjs'

export const SEAT_LANES = {
  neutral: 'seat-neutral.md',
  armor: 'seat-armor.md',
}

let overrideCache = { mtime: 0, text: '' }

export function overridePath(cfg) { return join(cfg.purgeDir, 'armor-override.md') }
export function queuePath(cfg) { return join(cfg.hudDir, 'inject-queue.json') }

export function seatHash(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16)
}

/** 覆盖位（mtime 缓存；悬浮窗点了「应用」之后下一发就生效） */
export function readOverride(cfg) {
  const p = overridePath(cfg)
  try {
    if (!existsSync(p)) { overrideCache = { mtime: 0, text: '' }; return '' }
    const m = statSync(p).mtimeMs
    if (m !== overrideCache.mtime) overrideCache = { mtime: m, text: readFileSync(p, 'utf8').trim() }
    return overrideCache.text
  } catch { return '' }
}

export function writeOverride(cfg, text) {
  const p = overridePath(cfg)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, String(text ?? ''))
  overrideCache = { mtime: statSync(p).mtimeMs, text: String(text ?? '').trim() }
  return { path: p, hash: seatHash(text) }
}

export function clearOverride(cfg) {
  const p = overridePath(cfg)
  try { if (existsSync(p)) writeFileSync(p, '') } catch { /* 忽略 */ }
  overrideCache = { mtime: 0, text: '' }
}

/** 车道种子 */
export function readSeed(cfg, lane = 'neutral') {
  const f = SEAT_LANES[lane] || SEAT_LANES.neutral
  const p = join(cfg.assetsDir, f)
  try { return existsSync(p) ? readFileSync(p, 'utf8').trim() : '' } catch { return '' }
}

/** 当前基础 seat：覆盖位 > 种子 */
export function currentSeat(cfg, lane = 'neutral') {
  return readOverride(cfg) || readSeed(cfg, lane)
}

// ── 注入队列 ────────────────────────────────────────────────────────────────

export function readQueue(cfg) {
  try {
    const p = queuePath(cfg)
    if (!existsSync(p)) return []
    const arr = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

export function writeQueue(cfg, list) {
  try {
    const p = queuePath(cfg)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(list, null, 2))
  } catch { /* 忽略 */ }
  return list
}

/** 入队：once（用后删）/ ttl（过期自清）/ cond（命中才注入） */
export function enqueue(cfg, { text, mode = 'once', ttlSec = 0, match = null }) {
  const list = readQueue(cfg).filter((x) => !isExpired(x))
  const item = {
    id: 'inj-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    text: String(text ?? ''),
    mode,
    match: match || null,
    expiresAt: ttlSec > 0 ? Date.now() + ttlSec * 1000 : null,
    createdAt: Date.now(),
  }
  list.push(item)
  writeQueue(cfg, list)
  return item
}

function isExpired(item) {
  return Boolean(item && item.expiresAt && Date.now() > item.expiresAt)
}

/** 取出本轮要注入的队列文本；once 用后删除，ttl 过期清理 */
export function consumeQueue(cfg, info = {}) {
  const all = readQueue(cfg)
  if (!all.length) return { texts: [], rest: [] }
  const rest = []
  const texts = []
  for (const item of all) {
    if (isExpired(item)) continue
    if (!matches(item.match, info)) { rest.push(item); continue }
    texts.push(item.text)
    if (item.mode === 'ttl') rest.push(item)   // ttl 保留到过期
  }
  writeQueue(cfg, rest)
  return { texts, rest }
}

function matches(match, info) {
  if (!match) return true
  if (match.workspace && String(info.workspace || '').toLowerCase().indexOf(String(match.workspace).toLowerCase()) < 0) return false
  if (match.traj && match.traj !== info.traj) return false
  if (match.keyword && String(info.text || '').indexOf(match.keyword) < 0) return false
  return true
}

// ── 出站拼接 ────────────────────────────────────────────────────────────────

/** 把 seat 追加到 Gemini 请求的 systemInstruction 末尾（三种形状都吃） */
export function appendSeat(parsed, text) {
  if (!text) return parsed
  const req = parsed?.request || parsed
  const sys = req.systemInstruction || req.system_instruction
  if (!sys) {
    req.systemInstruction = { parts: [{ text }] }
  } else if (Array.isArray(sys.parts)) {
    sys.parts.push({ text })
  } else if (typeof sys.text === 'string') {
    sys.parts = [{ text: sys.text }, { text }]
    delete sys.text
  } else {
    sys.parts = [{ text }]
  }
  return parsed
}

/** 出站硬门：seat 文本里不许有已知热词（否则等于自己给网关递刀） */
export function assertSeatSafe(text) {
  const hot = scanHotWords(text)
  return { ok: hot.length === 0, hot }
}

/** 从请求体取轨迹号（v1.8.5：sessionId 会跨会话，trajectory_id 才是每会话身份） */
export function trajectoryOf(parsed, headers = {}) {
  const req = parsed?.request || parsed
  try {
    return req?.labels?.trajectory_id || parsed?.labels?.trajectory_id || req?.sessionId || parsed?.sessionId || headers['x-trajectory-id'] || null
  } catch { return null }
}
