// 出站/回程观测器 —— 把每一轮 assistant 的结局喂给控制器与 journal
//
// 为什么在 res 上做：divert 有两条车道（passThrough / sameModel），
// 各自解析 SSE 的方式不同。挂在这一层就等于**与车道无关**，
// 不会因为将来换车道就丢观测。
import { extractSseText } from './gemini-retry.mjs'
import { scoreResponse } from './scorer3.mjs'
import { loadState, saveState, observeVerdict, beginTurn, beginStep, planInjection, buildSeatText, noteInjection, summarize } from './controller.mjs'
import { appendJournal, buildEntry, tailForTraj } from './journal.mjs'
import { currentSeat } from './seat.mjs'

/**
 * @param {import('node:http').ServerResponse} res
 * @param {{cfg:object, traj:string, turn?:number, step?:number, provider?:string, model?:string,
 *          lane?:string, seatHash?:string, kind?:string, onDone?:(scored:object, state:object)=>void}} ctx
 */
export function attachObserver(res, ctx) {
  const chunks = []
  let finished = false
  const origWrite = res.write.bind(res)
  const origEnd = res.end.bind(res)

  const push = (chunk) => {
    try {
      if (!chunk) return
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
      if (chunks.length > 4000) chunks.shift()      // 有界：极端长回合不撑爆内存
    } catch { /* 观测失败不拖垮响应 */ }
  }

  res.write = (chunk, enc, cb) => { push(chunk); return origWrite(chunk, enc, cb) }
  res.end = (chunk, enc, cb) => {
    push(chunk)
    finish()
    return origEnd(chunk, enc, cb)
  }
  res.on('close', finish)

  function finish() {
    if (finished) return
    finished = true
    let scored = null
    let state = null
    try {
      const raw = chunks.join('')
      const parsed = extractSseText(raw)
      const text = parsed.text || (raw.trim().startsWith('{') ? raw : '')
      scored = scoreResponse(text, {
        finishKind: parsed.finish ? String(parsed.finish).toLowerCase() : undefined,
        provider: ctx.provider,
        model: ctx.model,
      })
      state = loadState(ctx.cfg, ctx.traj)
      if (ctx.turn !== undefined) beginTurn(state, ctx.turn)
      if (ctx.step !== undefined) beginStep(state, ctx.step)
      observeVerdict(state, scored, { turn: ctx.turn, step: ctx.step })
      saveState(ctx.cfg, state)
      appendJournal(ctx.cfg, buildEntry({
        traj: ctx.traj, turn: ctx.turn, step: ctx.step, scored,
        provider: ctx.provider, model: ctx.model, lane: ctx.lane,
        seatHash: ctx.seatHash, kind: ctx.kind,
        intervention: state.interventions,
      }))
      if (typeof ctx.onDone === 'function') ctx.onDone(scored, state)
    } catch { /* 观测层的任何异常都不影响已经发出去的响应 */ }
    return { scored, state }
  }

  return { finish }
}

/** 下一轮该注入什么：控制器三档 + 队列文本（once/ttl/cond） */
export function planSeat(cfg, { traj, lane = 'neutral', queueTexts = [], extra = '' }) {
  const state = loadState(cfg, traj)
  // 重启后 streak 回放：状态文件丢了也能接上
  if (state.streak === 0 && state.lastVerdict === null) {
    const tail = tailForTraj(cfg, traj, 20)
    if (tail.length) {
      let streak = 0
      for (let i = tail.length - 1; i >= 0; i--) { if (tail[i].verdict === 'pass') break; streak += 1 }
      state.streak = streak
      state.lastVerdict = tail[tail.length - 1].verdict
      state.lastWords = tail[tail.length - 1].words || []
    }
  }
  const plan = planInjection(state, cfg.controller)
  const level = plan.act === 'inject' ? plan.level : 0
  if (plan.act === 'inject') noteInjection(state)
  saveState(cfg, state)
  // 三层拼接：① 座位正文（覆盖位 > 车道种子，齿轮「应用」写的就是它）
  //           ② 动态锚点（常态/纠正/强纠正）
  //           ③ 队列注入（once / ttl / 条件）
  const base = currentSeat(cfg, lane)
  const dynamic = buildSeatText(state, level, { extra })
  const parts = [base, dynamic, ...queueTexts.filter(Boolean)].filter(Boolean)
  return { text: parts.join('\n\n'), level, plan, state: summarize(state), baseBytes: base.length, dynamicBytes: dynamic.length }
}
