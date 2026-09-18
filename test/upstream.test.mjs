// 上游健康判读 —— 契约测试
//
// 这组用例锁死一条纪律：**「装甲失效」和「账号令牌失效」必须在日志层面就能分开**。
// 现场（2026-09-18 07:28 本地）：
//   23:28:31 RELAY h2 -> 200
//   23:28:32 PASS-STRIP 自家装甲 -14397B
//   23:28:33 RELAY h2 -> 401   <- 路径与剥离字节数和刚才那次 200 完全一致
// 用户看到的是 "Agent terminated due to error"，第一反应是装甲坏了；实际是账号登录态失效。
import assert from 'node:assert/strict'
import { parseResponses, scanUpstream, upstreamWarning } from '../src/diag/upstream.mjs'

const line = (t, code, extra = '') => `${t} RELAY h2 -> ${code}${extra ? '  ' + extra : ''}`

export function testParseResponsesReadsOnlyRelayLines() {
  const text = [
    '23:28:31 PASS-GATE frames=2 text=0 thought=0 fc=1 finish=STOP refusal=no',
    line('23:28:31', 200),
    line('23:28:33', 401),
    '23:28:33 PASS-AUTH 401 上游拒绝本机令牌 —— 账号登录态失效，不是破甲问题',
    line('23:52:39', 401),
  ].join('\n')
  const evts = parseResponses(text)
  assert.deepEqual(evts.map((e) => e.code), [200, 401, 401])
  assert.equal(evts[0].at, '23:28:31')
}

export function testAuthFailureAfterSuccessIsAuthVerdict() {
  // 真实现场：成功两秒后被拒
  const text = [line('23:28:31', 200), line('23:28:33', 401), line('23:52:39', 401)].join('\n')
  const r = scanUpstream(text)
  assert.equal(r.verdict, 'auth')
  assert.equal(r.last.code, 401)
  assert.equal(r.last200At, '23:28:31')
  assert.match(r.hint, /重新登录/)
  assert.match(r.hint, /代理链路/)
}

export function testRecoveredAuthIsNotReportedAsProblem() {
  // 早先的 401 之后又恢复了 200 —— 不许把已自愈的历史噪声一直挂在告警上
  const text = [line('23:28:33', 401), line('23:30:00', 200), line('23:31:00', 200)].join('\n')
  const r = scanUpstream(text)
  assert.equal(r.verdict, 'ok')
  assert.equal(upstreamWarning(text), null)
  // 但计数仍保留历史
  assert.equal(r.counts[401], 1)
  assert.equal(r.counts[200], 2)
}

export function testQuotaAndCapacityAreDistinguished() {
  const quota = scanUpstream([line('15:10:00', 200), line('15:54:00', 429)].join('\n'))
  assert.equal(quota.verdict, 'quota')
  assert.match(quota.hint, /额度/)
  const cap = scanUpstream([line('23:22:59', 503, '{"error":{"message":"No capacity available for model gemini-3.8-flash-high"}}')].join('\n'))
  assert.equal(cap.verdict, 'capacity')
  assert.match(cap.hint, /换模型/)
}

export function testAccountLaneRelayIsCounted() {
  // v1.7.6：账号接口走 divert 的回退分支，日志形态是 PASS-RELAY，不是 RELAY h2 ->
  // 以前不认这种，于是「账号接口一直 401」在判读里完全隐形
  const text = [
    '11:00:00 RELAY h2 -> 200',
    '11:01:00 PASS-RELAY 401 //v1internal:loadCodeAssist',
    '11:02:00 PASS-RELAY 401 //v1internal:loadCodeAssist',
  ].join('\n')
  const r = scanUpstream(text)
  assert.equal(r.verdict, 'auth')
  assert.equal(r.tail.length, 2)
  assert.ok(r.tail.every((e) => e.lane === 'account'), '必须标成账号车道')
  const w = upstreamWarning(text)
  assert.match(w.line, /2 次是\*\*账号接口\*\*/, '账号接口失败要点名：' + w.line)
}

export function testModelLaneIsLabelledSeparately() {
  const text = ['12:00:00 RELAY h2 -> 200', '12:00:01 RELAY h2 -> 401'].join('\n')
  const r = scanUpstream(text)
  assert.equal(r.tail[0].lane, 'model')
  const w = upstreamWarning(text)
  assert.ok(!/账号接口/.test(w.line), '模型车道的失败不该被说成账号接口')
}

export function testNoDataIsSilent() {
  assert.equal(scanUpstream('').verdict, 'no-data')
  // 没有上游响应记录时不占画面：返回 null（status 里只在有问题时才多打一行）
  assert.equal(upstreamWarning(''), null)
  assert.equal(upstreamWarning('divert listening on 127.0.0.1:50100'), null)
  // 但 scanUpstream 本身仍给出结构化结果，供别的调用方判读
  assert.equal(scanUpstream('divert listening on 127.0.0.1:50100').last, null)
}

export function testWarningLineCarriesTheContrastWithLastSuccess() {
  const text = [line('23:28:31', 200), line('23:28:33', 401), line('23:52:39', 401)].join('\n')
  const w = upstreamWarning(text)
  assert.equal(w.verdict, 'auth')
  assert.equal(w.codes, '401')
  assert.match(w.line, /2 次请求失败/)
  assert.match(w.line, /23:28:31 还是 200/)   // 关键对比：两秒前还是好的
}

export function testRealCapturedLogShapeProducesAuthVerdict() {
  // 逐字抄自 state/logs/divert.log（含中文与 JSON 片段），确保解析不被杂行干扰
  const text = [
    '23:28:31 RELAY h2 -> 200',
    '23:28:31 PASS-GATE frames=2 text=0 thought=0 fc=1 finish=STOP refusal=no',
    '23:28:32 PASS-THROUGH POST //v1internal:streamGenerateContent?alt=sse',
    '23:28:32 PASS-STRIP 自家装甲 -14397B',
    '23:28:33 RELAY h2 -> 401',
    '23:28:33 PASS-UPSTREAM 401 {   "error": {     "code": 401,     "message": "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie',
    '23:52:38 PASS-THROUGH POST //v1internal:streamGenerateContent?alt=sse',
    '23:52:38 PASS-STRIP 自家装甲 -14397B',
    '23:52:39 RELAY h2 -> 401',
    '23:52:39 PASS-UPSTREAM 401 {   "error": {     "code": 401,     "message": "Request had invalid authentication credentials.',
  ].join('\n')
  const r = scanUpstream(text)
  assert.equal(r.verdict, 'auth')
  assert.equal(r.counts[200], 1)
  assert.equal(r.counts[401], 2)
  assert.equal(r.tail.length, 2)
}