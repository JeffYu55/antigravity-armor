// 会话驱动：agentapi 发消息 + 直接读 SQLite 拿回复
//
// v1.7.1 修：会话目录**不止一个**。实测本机同时存在
//   ~/.gemini/antigravity/conversations/       ← IDE 实际在写的那个
//   ~/.gemini/antigravity-ide/conversations/   ← 旧版/另一条入口，本项目此前只读它
// 只认一个根就会出现「刚聊完的会话，aarmor drive list 里看不到」——
// 用户报「看下最新对话记录」时就是这么被挡住的。现在两个根都扫，按 mtime 合并排序。
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log.mjs'

/** 会话根目录（来自配置 convRoots；缺省兼容旧字段与两种默认布局） */
export function convRoots(cfg) {
  const list = cfg.paths?.convRoots
  if (Array.isArray(list) && list.length) return list.map((p) => p.replace(/^~/, process.env.USERPROFILE || ''))
  return [
    join(cfg.geminiHome, 'antigravity', 'conversations'),
    join(cfg.geminiHome, 'antigravity-ide', 'conversations'),
  ]
}

export function convDir(cfg) { return convRoots(cfg)[0] }

/** 在全部会话根里找这个 id 的库文件 */
export function convDb(cfg, id) {
  for (const root of convRoots(cfg)) {
    const p = join(root, id + '.db')
    if (existsSync(p)) return p
  }
  return join(convRoots(cfg)[0], id + '.db')
}

/** 调 agentapi（LS 必须在跑，且 env 指向它的 HTTP 端口） */
export function agentapi(cfg, args, { httpPort, csrf = 'aarmor', projectId, cwd } = {}) {
  const env = {
    ...process.env,
    ANTIGRAVITY_LS_ADDRESS: 'localhost:' + httpPort,
    ANTIGRAVITY_CSRF_TOKEN: csrf,
  }
  if (projectId) env.ANTIGRAVITY_PROJECT_ID = projectId
  const out = execFileSync(cfg.binaryPath, ['agentapi', ...args], { env, cwd, encoding: 'utf8', timeout: 300000 })
  try { return JSON.parse(out) } catch { return { raw: out } }
}

export function newConversation(cfg, prompt, opts = {}) {
  const res = agentapi(cfg, ['new-conversation', '--model=' + (opts.model || 'flash'), prompt], opts)
  const id = res?.response?.newConversation?.conversationId
  return { id, raw: res }
}

export function sendMessage(cfg, recipientId, content, opts = {}) {
  return agentapi(cfg, ['send-message', recipientId, content], opts)
}

export function listConversations(cfg, limit = 10) {
  const out = []
  for (const d of convRoots(cfg)) {
    if (!existsSync(d)) continue
    for (const f of readdirSync(d).filter((x) => x.endsWith('.db'))) {
      const p = join(d, f)
      try { out.push({ id: f.replace(/\.db$/, ''), path: p, root: d, mtime: statSync(p).mtimeMs }) } catch { /* 恰好被删就跳过 */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit)
}

/** 读会话步骤。type: 14=用户消息 15=模型输出 90=注入的 ephemeral message */
export async function readSteps(dbPath, { types = null } = {}) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  let rows = db.prepare('SELECT idx, step_type, status, step_payload FROM steps ORDER BY idx').all()
  if (types) rows = rows.filter((r) => types.includes(r.step_type))
  return rows.map((r) => ({
    idx: r.idx, type: r.step_type, status: r.status, bytes: r.step_payload ? r.step_payload.length : 0,
    text: r.step_payload ? Buffer.from(r.step_payload).toString('utf8').replace(/[^\x20-\x7e\u4e00-\u9fff\n]/g, ' ').replace(/\s{2,}/g, ' ').trim() : '',
  }))
}

export async function readReply(cfg, conversationId) {
  const steps = await readSteps(convDb(cfg, conversationId), { types: [15] })
  return steps.map((s) => s.text).join('\n')
}
