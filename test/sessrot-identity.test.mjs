// 换号档到底换了什么 —— v1.8.5（2026-10-03 现场定案）
//
// 现场（state/logs/divert.log 逐字）：
//   19:59:45 PASS-SHAPE contents=1条/1片 7285B ... session=-3750763034362895579   ← 会话 5110cdd0（压缩后那一发）
//   19:59:54 PASS-INBAND-BLOCK attempt=0 ... 残留触发词: 卡密,破解,绕过,免杀,逆向
//   ...
//   20:00:51 PASS-SESSROT attempt=6 会话号 -3750763034362895579 -> -3880998288515922
//   20:01:02 PASS-INBAND-BLOCK 额度用尽 -> 中性替代
//   → 7 档全灭，对话就此停住。
//
// 而**同一个** sessionId 在 10 小时后的另一个会话里照用：
//   13:44 新建的会话 913fed1d（任务：安装 dsh-infinite-gen-4）每一发也是 session=-3750763034362895579。
//
// 推论（本轮真正的缺陷）：sessionId **不是每会话身份**，客户端对不同会话送同一个值。
// 所以 v1.8.2 的「换号 = 拿到干净的服务端历史」是错的 —— 那一档从未真正换过身份。
// 每会话身份住在 request.labels.trajectory_id（LS 自己的日志也按 `trajectory <uuid>` 记账）。
//
// 本文件锁三件事：
//   ① 形状体检必须报出 traj（否则下次还是只能靠猜"谁索引历史"）；
//   ② 换身份档必须**同时**换 sessionId 与 labels.trajectory_id（+ last_step_index 归零），
//      当前窗口逐字节不变；
//   ③ 「正文即过滤提示」那一发必须把**上游原文**落进日志 —— 否则"被谁拦的"永远不可归因。
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  requestShape, shapeLine, freshSessionId, freshTrajectoryId,
  blockSnippet, BLOCK_FALLBACK_TEXT,
} from '../src/layers/gemini-retry.mjs'
import { createDivertServer } from '../src/layers/divert.mjs'

// 观测到的真实值：两个**不同**会话共用它 —— 这正是"它不是每会话身份"的证据
const SHARED_SESSION = '-3750763034362895579'
const REAL_TRAJECTORY = 'e64b23a4-9204-4732-9138-60837f7fa637'

const realShapedBody = () => ({
  project: 'aicode-consumers',
  requestId: 'req-1',
  model: 'gemini-3.8-flash-tiered',
  requestType: 'agent',
  userAgent: 'antigravity',
  request: {
    contents: [{ role: 'user', parts: [{ text: '# Resuming from a compaction\n\n<summary>…</summary>' }] }],
    systemInstruction: { role: 'user', parts: [{ text: '<identity>You are Antigravity.</identity>' }] },
    tools: [{ functionDeclarations: [{ name: 'read_file' }] }],
    labels: { trajectory_id: REAL_TRAJECTORY, last_step_index: '522' },
    generationConfig: { maxOutputTokens: 65536 },
    sessionId: SHARED_SESSION,
  },
})

// ── 单测：形状体检必须报出每会话身份 ──

export function testShapeReportsTrajectoryIdentity() {
  const s = requestShape(realShapedBody())
  assert.equal(s.sessionId, SHARED_SESSION, 'sessionId 照旧要报（它对某些中间层仍有效）')
  assert.equal(s.trajectoryId, REAL_TRAJECTORY, '每会话身份在 labels.trajectory_id —— 形状体检必须报出来')
  assert.equal(s.lastStepIndex, '522', 'last_step_index 也要报：换身份时要连它一起归零')
  const line = shapeLine(s)
  assert.ok(line.includes('traj=' + REAL_TRAJECTORY), '形状行必须含 traj=（实际: ' + line + '）')
  assert.ok(line.includes('@step522'), '形状行必须含步号（实际: ' + line + '）')
}

export function testShapeSurvivesMissingLabels() {
  for (const labels of [undefined, null, {}, { trajectory_id: null }, { trajectory_id: 't' }]) {
    const b = realShapedBody()
    b.request.labels = labels
    const s = requestShape(b)
    assert.doesNotThrow(() => shapeLine(s), '缺 labels 时形状体检不能抛异常')
    assert.ok(shapeLine(s).includes('traj='), '缺 labels 也要如实报 traj=无')
  }
  const b = realShapedBody()
  delete b.request.labels
  assert.equal(requestShape(b).trajectoryId, null)
  assert.ok(shapeLine(requestShape(b)).includes('traj=无'))
}

// ── 单测：轨迹号生成器 ──

export function testFreshTrajectoryIdIsUuidShapedAndFresh() {
  for (let i = 0; i < 50; i++) {
    const t = freshTrajectoryId(REAL_TRAJECTORY)
    assert.match(t, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      '轨迹号必须保持观测到的 uuid v4 形状（形状变了服务端可能直接 4xx）：' + t)
    assert.notEqual(t, REAL_TRAJECTORY, '绝不能返回原轨迹号（那就等于没换）')
  }
}

export function testFreshTrajectoryIdDoesNotRepeat() {
  const seen = new Set()
  for (let i = 0; i < 200; i++) seen.add(freshTrajectoryId('x'))
  assert.ok(seen.size > 195, '两次生成不应撞车（实际唯一数 ' + seen.size + '/200）')
}

export function testFreshTrajectoryIdHandlesMissingPrev() {
  for (const p of [undefined, null, '']) {
    const t = freshTrajectoryId(p)
    assert.match(t, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  }
}

// ── 单测：上游原文片段 ──

export function testBlockSnippetIsOneLineAndBounded() {
  const sse = 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"This request was blocked by Gemini\'s filters.\\nPlease try rephrasing your prompt."}]}}]}}\r\n\r\n'
  const s = blockSnippet(sse)
  assert.ok(!/\n/.test(s), '片段必须压成一行（日志一行一条）')
  assert.ok(s.length <= 181, '片段要有上限（实际 ' + s.length + '）')
  assert.equal(blockSnippet(''), '')
  assert.equal(blockSnippet(null), '')
}

// ── 端到端：走真代码路径，看每一档实际发出的字节 ──

const BLOCK_BODY = 'data: ' + JSON.stringify({
  response: {
    candidates: [{
      content: {
        role: 'model',
        parts: [{ text: "This request was blocked by Gemini's filters. Please try rephrasing your prompt." }],
      },
    }],
    modelVersion: 'x', responseId: 'r1',
  },
  traceId: '', metadata: {},
}) + '\r\n\r\n'

async function runLadder(maxAttempts, body, extra = {}) {
  const seen = []
  const up = http.createServer((rq, rs) => {
    let b = ''
    rq.on('data', (d) => { b += d })
    rq.on('end', () => {
      seen.push(b)
      rs.writeHead(200, { 'Content-Type': 'text/event-stream' })
      rs.end(BLOCK_BODY)
    })
  })
  await new Promise((r) => up.listen(0, '127.0.0.1', r))
  const logDir = join(tmpdir(), 'aarmor-sr-' + process.pid + '-' + Date.now())
  mkdirSync(logDir, { recursive: true })
  const cfg = {
    logDir, geminiHome: logDir, stateDir: logDir,
    divert: {
      port: 0, upstream: 'http://127.0.0.1:' + up.address().port, passThrough: true,
      maxAttempts, model: 'm', target: 'http://127.0.0.1:1/x', keyRef: 'K', http2: false,
      capture: false, blockFallback: 'neutral', gateChars: 1200, probeChars: 400, jitter: false,
      ...extra,
    },
  }
  const logs = []
  const logFile = join(logDir, 'divert.log')
  const { server } = createDivertServer(cfg, { key: 'k', logFile })
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/vpppppppppp/v1internal:streamGenerateContent?alt=sse', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    await res.text()
    await new Promise((r) => setTimeout(r, 150))
    try { logs.push(...readFileSync(logFile, 'utf8').split('\n')) } catch { /* 没写日志就是空的 */ }
    return { seen: seen.map((s) => JSON.parse(s)), logs }
  } finally {
    server.close(); up.close(); rmSync(logDir, { recursive: true, force: true })
  }
}

export async function testLastRungRotatesBothIdentities() {
  const input = realShapedBody()
  const { seen, logs } = await runLadder(7, input)
  assert.ok(seen.length >= 5, '七档梯子至少应发出 5 发（实际 ' + seen.length + '）')

  const last = seen[seen.length - 1]
  const first = seen[0]
  // ① sessionId 照旧换（v1.8.2 的行为不变）
  assert.notEqual(String(last.request.sessionId), String(first.request.sessionId), '最后一档必须换掉会话号')
  assert.match(String(last.request.sessionId), /^-\d+$/, '新会话号保持同域')
  // ② 真正的每会话身份：轨迹号必须一起换，步号归零
  assert.equal(first.request.labels.trajectory_id, REAL_TRAJECTORY, '前几档不许动轨迹号')
  assert.notEqual(last.request.labels.trajectory_id, REAL_TRAJECTORY,
    '最后一档必须换掉 labels.trajectory_id —— 只换 sessionId 从未真正换过身份（v1.8.5 现场定案）')
  assert.match(last.request.labels.trajectory_id, /^[0-9a-f-]{36}$/, '新轨迹号保持 uuid 形状')
  assert.equal(String(last.request.labels.last_step_index), '0', 'last_step_index 要归零')
  // ③ 当前窗口逐字节不变
  assert.equal(JSON.stringify(last.request.contents), JSON.stringify(first.request.contents), '换身份不该丢当前窗口')

  const joined = logs.join('\n')
  assert.ok(joined.includes('PASS-SESSROT'), '日志里必须有 PASS-SESSROT')
  assert.ok(joined.includes('traj ' + REAL_TRAJECTORY + '@step522'), '换身份要能逐档归因（实际日志 ' + logs.length + ' 行）')
}

export async function testRotateTrajectoryCanBeDisabled() {
  const { seen, logs } = await runLadder(7, realShapedBody(), { rotateTrajectory: false })
  const last = seen[seen.length - 1]
  assert.notEqual(String(last.request.sessionId), SHARED_SESSION, '关掉轨迹号轮换不影响换会话号')
  assert.equal(last.request.labels.trajectory_id, REAL_TRAJECTORY, 'rotateTrajectory=false 时轨迹号必须原样')
  assert.ok(logs.join('\n').includes('traj=原样'), '日志要如实说明这一档没换轨迹号')
}

export async function testInbandBlockLogCarriesUpstreamBody() {
  const { logs } = await runLadder(3, realShapedBody())
  const lines = logs.filter((l) => l.includes('PASS-INBAND-BLOCK'))
  assert.ok(lines.length > 0, '这一发必然撞正文级过滤，日志里必须有 PASS-INBAND-BLOCK')
  const first = lines[0]
  assert.ok(first.includes('上游原文:'), '必须把上游原文落日志，否则"被谁拦的"不可归因（实际: ' + first + '）')
  assert.ok(/blocked by Gemini|rephrasing/i.test(first), '原文片段要真的是上游那句话（实际: ' + first + '）')
}

// ── 回归锁：中性替代文案不得再断言"历史由 sessionId 索引" ──

export function testFallbackNoLongerClaimsSessionIdIndexesHistory() {
  assert.ok(!BLOCK_FALLBACK_TEXT.includes('sessionId 索引'),
    '现场证据（同一 sessionId 跨两个会话）说明这句是错的，不许再写进给用户看的文案')
  assert.ok(BLOCK_FALLBACK_TEXT.includes('换服务端会话号'), '仍要说清试过换号这个对照')
  assert.ok(BLOCK_FALLBACK_TEXT.includes('会话上下文'), '仍要如实说明触发点在哪')
  assert.ok(BLOCK_FALLBACK_TEXT.includes('不在本机'), '仍要排除"本机故障"这个误解')
}

// ── 反证：只换 sessionId 不足以改变每会话身份 ──

export function testRotatingSessionIdAloneLeavesThePerConversationIdentityUntouched() {
  const b = realShapedBody()
  b.request.sessionId = freshSessionId(b.request.sessionId)
  assert.notEqual(b.request.sessionId, SHARED_SESSION, 'sessionId 确实换了')
  assert.equal(b.request.labels.trajectory_id, REAL_TRAJECTORY,
    '但轨迹号没动 —— 这就是 v1.8.2 那一档从未真正换过身份的证明')
  // 两个不同会话共用同一个 sessionId 的现场事实：锁住它，免得有人再把它当成"每会话钥匙"
  const other = realShapedBody()
  assert.equal(requestShape(other).sessionId, requestShape(realShapedBody()).sessionId,
    '不同会话送同一个 sessionId —— 它不是每会话身份')
  assert.notEqual(requestShape(other).trajectoryId, null, '每会话身份必须存在且可被报出来')
}