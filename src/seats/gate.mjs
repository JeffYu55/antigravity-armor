// 启动口令门控（Astra 式）：未输入口令不放行词包；口令精确命中才激活会话。
// 这里是判定核，宿主接入层（hooks）用它决定是否放行。
import { ACTIVATION_WORD } from './packs.mjs'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SESSION_TTL = 30 * 60 * 1000
const MAX_SESSIONS = 100

export class ActivationGate {
  constructor({ word = ACTIVATION_WORD, now = Date.now } = {}) {
    this.word = word
    this.now = now
    this.sessions = new Map()
  }
  create(seat) {
    const id = 'seat-' + (this.sessions.size + 1) + '-' + this.now()
    this.sessions.set(id, { seat, active: false, last: this.now() })
    return id
  }
  gc() {
    for (const [id, s] of this.sessions) if (this.now() - s.last > SESSION_TTL) this.sessions.delete(id)
    if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value)
  }
  /** 输入判定：口令精确命中 -> 激活；未激活 -> 不放行 */
  input(id, text) {
    this.gc()
    const s = this.sessions.get(id)
    if (!s) return { active: false, activatedNow: false, reason: 'no-session' }
    s.last = this.now()
    if (typeof text === 'string' && text.trim() === this.word) {
      s.active = true
      return { active: true, activatedNow: true, seat: s.seat }
    }
    if (!s.active) return { active: false, activatedNow: false, reason: 'standby' }
    return { active: true, activatedNow: false, seat: s.seat }
  }
}

/** 文件持久会话（钩子进程无状态 —— 激活状态必须落盘共享） */
export function gateInputFile({ storePath, id = 'default', text, word = ACTIVATION_WORD, now = Date.now, ttl = SESSION_TTL, cap = MAX_SESSIONS }) {
  let store = { sessions: {} }
  try { if (existsSync(storePath)) store = JSON.parse(readFileSync(storePath, 'utf8')) } catch { store = { sessions: {} } }
  store.sessions = store.sessions || {}
  const s = store.sessions[id]
  if (s && now() - s.last > ttl) delete store.sessions[id]
  const hit = typeof text === 'string' && text.trim() === word
  const cur = store.sessions[id]
  if (hit) store.sessions[id] = { active: true, last: now() }
  else if (cur) cur.last = now()
  else store.sessions[id] = { active: false, last: now() }
  const keys = Object.keys(store.sessions)
  if (keys.length > cap) for (const k of keys.slice(0, keys.length - cap)) delete store.sessions[k]
  mkdirSync(dirname(storePath), { recursive: true })
  writeFileSync(storePath, JSON.stringify(store))
  return { active: !!(store.sessions[id] && store.sessions[id].active), activatedNow: hit }
}