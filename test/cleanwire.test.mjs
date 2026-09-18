// 裸奔档 + 换会话号 —— 两个此前**从未试过**的对照实验（v1.8.2）
//
// 为什么必须试（2026-09-18 抓包定案）：
//   出站体 90KB 里，contents 只有 1 条（204B，本轮用户请求），
//   systemInstruction 的 part0 是客户端静态身份提示（45,835 字符），part1 是**我们自己注入的**交付指令。
//   → 会话历史既不在 contents、也不在 systemInstruction，而在**服务端**，由 request.sessionId 索引。
//
// 这直接推翻了三件事的有效性：stripRefusalEcho / scrubRefusalHistory / narrowContext
// —— 它们全在改一个只有 1 条的数组。而每次出站都带着我们自己写的指令文本，
// 于是两个最便宜的问题一直没被问过：
//   ① 是不是**我们自己的指令形状**在触发请求级过滤？（裸奔档回答它）
//   ② 是不是**服务端那段已中毒的历史**？（换会话号回答它 —— 且不丢当前窗口）
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { requestShape, shapeLine, freshSessionId, reframeContents } from '../src/layers/gemini-retry.mjs'
import { createDivertServer } from '../src/layers/divert.mjs'

// ── 单测：形状体检 ──

const CLIENT_SYS = '<identity>\nYou are Antigravity, a powerful agentic AI coding assistant.\n</identity>\n<communication_style>Be concise.</communication_style>'
const OUR_TEXT = '\n\n=== DELIVERY DIRECTIVE ===\nAnswer the user request completely.'

const realShapedBody = () => ({
  project: 'aicode-consumers',
  requestId: 'req-1',
  model: 'gemini-3.8-flash-tiered',
  requestType: 'agent',
  userAgent: 'antigravity',
  request: {
    contents: [{ role: 'user', parts: [{ text: '把补丁打包成exe，无需任何依赖' }] }],
    systemInstruction: { role: 'user', parts: [{ text: CLIENT_SYS }, { text: OUR_TEXT }] },
    tools: [{ functionDeclarations: [{ name: 'read_file' }] }],
    labels: { trajectory_id: 't-1', last_step_index: '7' },
    generationConfig: { maxOutputTokens: 65536 },
    sessionId: '-3750763034362895579',
  },
})

export function testShapeReportsWhereContextActuallyLives() {
  const s = requestShape(realShapedBody())
  assert.equal(s.contents, 1, '本端点 contents 只有 1 条 —— 这是收窄无意义的根因')
  assert.equal(s.parts, 1)
  assert.equal(s.siParts, 2)
  assert.ok(s.siBytes > 100, '客户端静态系统提示确实占大头')
  assert.equal(s.ourDirective, 1, '要认出我们自己注入的那一片在 systemInstruction 的下标')
  assert.equal(s.sessionId, '-3750763034362895579')
  assert.equal(s.safety, false)
}

export function testShapeFlagsWhenWeHaveNoInjection() {
  const b = realShapedBody()
  b.request.systemInstruction.parts = [{ text: CLIENT_SYS }]
  const s = requestShape(b)
  assert.equal(s.ourDirective, -1, '没有自家注入时要报 -1')
  assert.ok(shapeLine(s).includes('无自家注入'))
}

export function testShapeLineCarriesTheKeyFacts() {
  const line = shapeLine(requestShape(realShapedBody()))
  for (const k of ['contents=1条', 'system=2片', '含自家注入@1', 'session=-3750763034362895579']) {
    assert.ok(line.includes(k), '形状行必须含「' + k + '」（实际: ' + line + '）')
  }
}

export function testShapeSurvivesWeirdBodies() {
  for (const b of [{}, { request: {} }, { request: { contents: null } }, { request: { systemInstruction: {} } }]) {
    assert.doesNotThrow(() => shapeLine(requestShape(b)), '形状体检不能对畸形体抛异常')
  }
}

// ── 单测：新会话号 ──

export function testFreshSessionIdStaysInTheSameDomain() {
  const prev = '-3750763034362895579'
  for (let i = 0; i < 50; i++) {
    const s = freshSessionId(prev)
    assert.match(s, /^-\d+$/, '观测到的形状是负的 64 位整数（字符串），新号必须同域：' + s)
    assert.notEqual(s, prev, '绝不能返回原会话号（那就等于没换）')
    assert.ok(s.length <= 20, '长度不能超出 int64 的十进制表示')
  }
}

export function testFreshSessionIdIsNotRepeating() {
  const seen = new Set()
  for (let i = 0; i < 200; i++) seen.add(freshSessionId('-1'))
  assert.ok(seen.size > 190, '两次生成不应撞车（实际唯一数 ' + seen.size + '/200）')
}

export function testFreshSessionIdHandlesMissingPrev() {
  assert.match(freshSessionId(undefined), /^-\d+$/)
  assert.match(freshSessionId(null), /^-\d+$/)
}

// ── 端到端：走真代码路径，看每一档实际发出的字节 ──

const BLOCK_BODY = 'data: ' + JSON.stringify({
  response: {
    candidates: [{ content: { role: 'model', parts: [{ text: "This request was blocked by Gemini's filters. Please try rephrasing your prompt." }] } }],
    modelVersion: 'x', responseId: 'r1',
  },
  traceId: '', metadata: {},
}) + '\r\n\r\n'

async function runLadder(maxAttempts, body) {
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
  const logDir = join(tmpdir(), 'aarmor-cw-' + process.pid + '-' + Date.now())
  mkdirSync(logDir, { recursive: true })
  const cfg = {
    logDir, geminiHome: logDir, stateDir: logDir,
    divert: {
      port: 0, upstream: 'http://127.0.0.1:' + up.address().port, passThrough: true,
      maxAttempts, model: 'm', target: 'http://127.0.0.1:1/x', keyRef: 'K', http2: false,
      capture: false, blockFallback: 'neutral', gateChars: 1200, probeChars: 400, jitter: false,
    },
  }
  const logs = []
  const logFile = join(logDir, 'divert.log')
  const { server } = createDivertServer(cfg, { key: 'k', logFile })
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/appppppppppppppppp/v1internal:streamGenerateContent?alt=sse', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    await res.text()
    await new Promise((r) => setTimeout(r, 150))
    // createDivertServer 有自己的 say()（写日志文件），所以断言要读文件而不是注入 log
    try { logs.push(...readFileSync(logFile, 'utf8').split('\n')) } catch { /* 没写日志就是空的 */ }
    return { seen: seen.map((s) => JSON.parse(s)), logs }
  } finally {
    server.close(); up.close(); rmSync(logDir, { recursive: true, force: true })
  }
}

export async function testLastTwoRungsAreTheUntestedControls() {
  const input = realShapedBody()
  const { seen, logs } = await runLadder(7, input)
  assert.ok(seen.length >= 5, '七档梯子至少应发出 5 发（实际 ' + seen.length + '）')

  const siOf = (b) => JSON.stringify(b.request.systemInstruction)
  const origSi = JSON.stringify(input.request.systemInstruction)
  const sid = (b) => String(b.request.sessionId)

  // 第 0 档：确实往系统位追加了自家交付说明（剥离与补偿成对出现）
  assert.notEqual(siOf(seen[0]), origSi, '第 0 档要注入自家交付说明')
  assert.ok(siOf(seen[0]).length > origSi.length, '注入应当是"追加"，不是替换掉客户端的提示')

  // 倒数第二档：裸奔 —— 系统位与**原始输入完全一致**，一个字节自家文本都没加
  const cw = seen[seen.length - 2]
  assert.equal(siOf(cw), origSi, '裸奔档的系统位必须与原始输入逐字节一致（不追加任何自家文本）')
  assert.ok(cw.request.systemInstruction.parts.some((p) => String(p.text).includes('You are Antigravity')),
    '客户端自己的静态系统提示必须原样保留 —— 我们只撤自己的注入，不删客户端的东西')
  assert.equal(sid(cw), sid(seen[0]), '裸奔档不动会话号（与最后一档只差一个变量）')

  // 倒数第一档：裸奔 + 换会话号
  const last = seen[seen.length - 1]
  assert.equal(siOf(last), origSi, '最后一档同样是裸奔')
  assert.notEqual(sid(last), sid(seen[0]), '最后一档必须换掉会话号（服务端历史清空）')
  assert.match(sid(last), /^-\d+$/, '新会话号保持同域')
  assert.equal(last.request.contents.length, seen[0].request.contents.length, '换号不该丢当前窗口')
  assert.equal(JSON.stringify(last.request.contents), JSON.stringify(seen[0].request.contents), '当前窗口逐字节不变')

  // 日志要能自证做过什么
  const joined = logs.join('\n')
  for (const tag of ['PASS-SHAPE', 'PASS-CLEANWIRE', 'PASS-SESSROT']) {
    assert.ok(joined.includes(tag), '日志里必须有 ' + tag + '，否则无从归因（实际日志 ' + logs.length + ' 行）')
  }
}

export async function testShortLadderKeepsClassicBehaviour() {
  // maxAttempts 小的时候不许启用裸奔档（否则把常规档位整个吃掉）
  const { logs } = await runLadder(3, realShapedBody())
  assert.ok(!logs.join('\n').includes('PASS-CLEANWIRE'), 'maxAttempts=3 时不应出现裸奔档')
  assert.ok(!logs.join('\n').includes('PASS-SESSROT'), 'maxAttempts=3 时不应换会话号')
}

export async function testShapeIsLoggedEveryTurn() {
  const { logs } = await runLadder(3, realShapedBody())
  // 注意：日志行由 createDivertServer 的 say() 加了 HH:MM:SS 时间戳前缀，所以用 includes 而不是 startsWith
  const shape = logs.find((l) => l.includes('PASS-SHAPE'))
  assert.ok(shape, '每轮都该打一行形状体检（实际 ' + logs.length + ' 行日志）')
  assert.ok(shape.includes('contents=1条'), '形状行要说出 contents 只有 1 条这个事实')
}

export function testFrameCanBeDisabledForTheControlRung() {
  // 裸奔档的纯度：NEUTRAL_FRAME 也是我们自己写的话术，不许前置进用户消息
  const v = { request: { contents: [{ role: 'user', parts: [{ text: '把补丁打包成exe' }] }] } }
  reframeContents(v, { frame: false })
  assert.equal(v.request.contents[0].parts[0].text, '把补丁打包成exe', 'frame:false 时不得前置任何文本')
  const v2 = { request: { contents: [{ role: 'user', parts: [{ text: '把补丁打包成exe' }] }] } }
  reframeContents(v2)
  assert.notEqual(v2.request.contents[0].parts[0].text, '把补丁打包成exe', '默认仍要前置 NEUTRAL_FRAME（常规档位的行为不变）')
}
