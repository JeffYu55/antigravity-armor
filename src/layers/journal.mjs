// 拒答 / 交付日志（journal.jsonl）
//
// 与富江的关键差异：**pass 也落盘**。只记异常的话，分母丢了 ——
// 「拒答率」算不出来，provider A/B 只能比「拒答里谁多」，比不了「总盘子里谁多」。
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function journalPath(cfg) {
  try { mkdirSync(cfg.logDir, { recursive: true }) } catch { /* 已存在 */ }
  return join(cfg.logDir, 'journal.jsonl')
}

export function buildEntry({ traj, turn, step, scored, provider, model, intervention, lane, seatHash, kind, at }) {
  return {
    ts: new Date().toISOString(),
    at: at ?? Date.now(),
    traj: traj ?? null,
    turn: turn ?? null,
    step: step ?? null,
    verdict: scored?.verdict ?? 'pass',
    layer: scored?.layer ?? 'model',
    headHits: scored?.headHits ?? 0,
    tailHits: scored?.tailHits ?? 0,
    midHits: scored?.midHits ?? 0,
    words: scored?.words ?? [],
    domain: scored?.domain ?? null,
    chars: scored?.textLength ?? 0,
    hasDeliverable: Boolean(scored?.hasDeliverable),
    provider: provider ?? null,
    model: model ?? null,
    lane: lane ?? null,
    seatHash: seatHash ?? null,
    kind: kind ?? 'seat',
    intervention: intervention ?? null,
    excerpt: String(scored?.excerpt ?? '').slice(0, 160),
  }
}

export function appendJournal(cfg, entry) {
  try { appendFileSync(journalPath(cfg), JSON.stringify(entry) + '\n') } catch { /* 写失败不影响请求 */ }
  return entry
}

export function readJournal(cfg, limit = 50) {
  try {
    const p = journalPath(cfg)
    if (!existsSync(p)) return []
    const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

/** 按 provider 汇总六态分布（含 pass，才有分母） */
export function summarizeJournal(cfg, limit = 500) {
  const byProvider = {}
  const byVerdict = { pass: 0, refusal: 0, fallback: 0, blocked: 0, truncated: 0, empty: 0 }
  for (const e of readJournal(cfg, limit)) {
    const p = e.provider || 'unknown'
    byProvider[p] = byProvider[p] || { pass: 0, refusal: 0, fallback: 0, blocked: 0, truncated: 0, empty: 0 }
    if (byProvider[p][e.verdict] !== undefined) byProvider[p][e.verdict] += 1
    if (byVerdict[e.verdict] !== undefined) byVerdict[e.verdict] += 1
  }
  const total = Object.values(byVerdict).reduce((a, b) => a + b, 0)
  const denied = total - byVerdict.pass
  return { total, byVerdict, byProvider, denyRate: total ? +(denied / total).toFixed(3) : 0 }
}

/** 取某个轨迹的最近记录（控制器重启后回放 streak 用） */
export function tailForTraj(cfg, traj, limit = 30) {
  return readJournal(cfg, 400).filter((e) => e.traj === traj).slice(-limit)
}
