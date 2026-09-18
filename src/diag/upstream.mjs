// 上游健康判读 —— 把三种完全不同的故障在**日志层面**分开
//
// 背景（v1.7.5，2026-09-18 实测）：
//   IDE 报 "Agent terminated due to error"，用户第一反应是「装甲又失效了」。
//   实际日志是：
//     23:28:31 RELAY h2 -> 200          <- 两秒前还好好的
//     23:28:32 PASS-STRIP 自家装甲 -14397B
//     23:28:33 RELAY h2 -> 401
//     23:28:33 PASS-UPSTREAM 401 {"code":401,"message":"Request had invalid
//               authentication credentials. Expected OAuth 2 access token..."}
//   请求路径、剥离字节数、header 形态与那次 200 完全一致 —— 唯一变量是**令牌**。
//
//   => 这是「账号登录态失效」，跟破甲毫无关系。修法是重新登录，不是加装甲。
//
// 三类故障必须一眼分开：
//   auth    401/403  账号令牌被上游拒   -> 重新登录（代理链路已验证正常）
//   quota   429      账号额度用尽       -> 等配额恢复 / 换 lane 或模型
//   capacity 503     上游该模型没容量   -> 换模型（与账号、代理都无关）
//
// 判读规则：只看**最后一次成功(200)之后**发生的事。早先的 401 之后又恢复 200 了，
// 那就不算问题 —— 否则会把已经自愈的历史噪声一直挂在告警里。

/** 从 divert 日志文本里抽出响应事件
 *  两种形态都要认（v1.7.6）：
 *    `hh:mm:ss RELAY h2 -> NNN`     模型接口（走 gemini-retry 车道）
 *    `hh:mm:ss PASS-RELAY NNN <path>` 账号接口（loadCodeAssist 等走回退分支）
 *  以前只认前者，于是「账号接口一直在 401」在判读里看不见 —— 而用户感受到的
 *  「Agent terminated due to error」恰恰就是账号接口 401 引起的。
 */
export function parseResponses(logText) {
  const out = []
  for (const line of String(logText || '').split('\n')) {
    const t = (line.match(/^\s*(\d\d:\d\d:\d\d)/) || [])[1]
    if (!t) continue
    const a = (line.match(/RELAY h2 -> (\d{3})/) || [])[1]
    const b = (line.match(/PASS-RELAY (\d{3})/) || [])[1]
    const c = a || b
    if (c) out.push({ at: t, code: Number(c), lane: a ? 'model' : 'account' })
  }
  return out
}

const HINTS = {
  auth: '账号登录态失效（令牌被上游拒）—— 在 Antigravity 里重新登录即可。代理链路本身是通的。',
  quota: '账号额度用尽（429）—— 与代理、与破甲都无关；等配额恢复或换 lane/模型。',
  capacity: '上游该模型暂无容量（503）—— 换模型即可。',
  error: '上游返回了非预期状态码 —— 看 PASS-UPSTREAM 原文。',
}

/** 判读上游健康。返回 { verdict, hint, counts, last, last200At, tail } */
export function scanUpstream(logText) {
  const events = parseResponses(logText)
  const counts = {}
  for (const e of events) counts[e.code] = (counts[e.code] || 0) + 1
  if (!events.length) return { verdict: 'no-data', hint: '日志里还没有上游响应记录（代理刚起或还没跑过请求）。', counts, last: null, last200At: null, tail: [] }

  let idx200 = -1
  for (let i = events.length - 1; i >= 0; i--) if (events[i].code === 200) { idx200 = i; break }
  const tail = events.slice(idx200 + 1)
  const last200At = idx200 >= 0 ? events[idx200].at : null

  // 最后一次成功之后没有任何失败 -> 健康
  if (!tail.length) return { verdict: 'ok', hint: '', counts, last: events[events.length - 1], last200At, tail }

  const code = tail[tail.length - 1].code
  const verdict = code === 401 || code === 403 ? 'auth'
    : code === 429 ? 'quota'
      : code === 503 ? 'capacity' : 'error'
  return { verdict, hint: HINTS[verdict], counts, last: tail[tail.length - 1], last200At, tail }
}

/** status 用的一行摘要（healthy 时返回 null，不占用画面） */
export function upstreamWarning(logText) {
  const r = scanUpstream(logText)
  if (r.verdict === 'ok' || r.verdict === 'no-data') return null
  const fails = r.tail.filter((e) => e.code !== 200)
  const codes = [...new Set(fails.map((e) => e.code))].join('/')
  // 账号接口失败要单独点名 —— 它才是「Agent terminated due to error」的真凶
  const acct = fails.filter((e) => e.lane === 'account').length
  return {
    verdict: r.verdict,
    codes,
    line: '上游最近 ' + fails.length + ' 次请求失败（' + codes + '，最后一次 ' + r.last.at + '）'
      + (acct ? '，其中 ' + acct + ' 次是**账号接口**' : '')
      + (r.last200At ? '，在此之前 ' + r.last200At + ' 还是 200' : ''),
    hint: r.hint,
  }
}