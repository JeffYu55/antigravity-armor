// 端到端：正文级过滤 → 降档重试 → 中性替代，客户端**实际收到**的字节
//
// 现场（2026-09-18）：用户看到
//   （本地上游网关：这一轮请求被上游边缘过滤拦下了，已按降档重试。…）
//   紧接着 Agent terminated due to error
// 会话 #517 记录的原始错误：
//   agent executor error: calling model: proto: syntax error (line 1:1): unexpected token [
// 病根：中性替代帧结尾带了 `data: [DONE]`（OpenAI 约定），Google 客户端把它当 protobuf 解析 → 崩。
//
// 本用例不走单元级 neutralSse，而是**真起一个 divert 代理 + 假上游**，
// 假上游回放 state/capture 里那份真·正文级过滤样本，然后检查客户端收到的原始字节。
// 这样"降档重试真的发生了"和"最终字节真的能被解析"两件事一起被证明。
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createDivertServer } from '../src/layers/divert.mjs'
import { BLOCK_FALLBACK_TEXT, isBlockMessage, extractSseText } from '../src/layers/gemini-retry.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BLOCK_SAMPLE = readFileSync(join(HERE, 'fixtures', 'real-sse-inband-block.sse'), 'utf8')

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))

/** 假上游：无论收到什么，都回放那份真实的「正文即过滤提示」样本 */
async function mockUpstream(body) {
  const seen = []
  const srv = http.createServer((rq, rs) => {
    let b = ''
    rq.on('data', (d) => { b += d })
    rq.on('end', () => {
      seen.push({ url: rq.url, bytes: b.length, body: b })
      rs.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      rs.end(body)
    })
  })
  const port = await listen(srv)
  return { srv, port, seen }
}

function makeCfg(upstreamPort, logDir) {
  return {
    logDir,
    geminiHome: logDir,
    divert: {
      port: 0,
      upstream: 'http://127.0.0.1:' + upstreamPort,
      passThrough: true,
      sameModel: false,
      blockFallback: 'neutral',
      maxAttempts: 2,
      model: 'test-model',
      target: 'http://127.0.0.1:1/unused',
      keyRef: 'DUMMY_KEY_FOR_TEST',
      gateChars: 1200,
      probeChars: 400,
      capture: false,
      http2: false,
      authDiag: false,
    },
  }
}

const GEMINI_BODY = JSON.stringify({ request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] } })

async function runThroughDivert() {
  const logDir = join(tmpdir(), 'aarmor-e2e-' + process.pid + '-' + Date.now())
  mkdirSync(logDir, { recursive: true })
  const up = await mockUpstream(BLOCK_SAMPLE)
  const cfg = makeCfg(up.port, logDir)
  const { server } = createDivertServer(cfg, { key: 'test-key-not-real' })
  const port = await listen(server)
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/appppppppppppppppp/v1internal:streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: GEMINI_BODY,
    })
    const text = await res.text()
    return { status: res.status, text, upstreamHits: up.seen.length, cleanup: () => { server.close(); up.srv.close(); rmSync(logDir, { recursive: true, force: true }) } }
  } catch (e) {
    server.close(); up.srv.close(); rmSync(logDir, { recursive: true, force: true })
    throw e
  }
}

export async function testClientReceivesParsableBytesAfterFullRetryExhaustion() {
  const r = await runThroughDivert()
  try {
    assert.equal(r.status, 200, '中性替代应当是 200（客户端把它当正常回复显示）')
    // 这两条就是本次事故的判据
    assert.ok(!r.text.includes('[DONE]'), '客户端收到的字节里绝不能有 [DONE]：' + JSON.stringify(r.text.slice(-60)))
    assert.ok(r.text.endsWith('\r\n\r\n'), '要以真实的 CRLF 帧界收尾后直接 EOF')
    const frames = r.text.split('\r\n\r\n').filter((x) => x.startsWith('data: '))
    assert.equal(frames.length, 2, '恰好两帧：内容帧 + STOP 收尾帧')
    assert.ok(r.text.includes(BLOCK_FALLBACK_TEXT), '要真的把中性替代文本交给客户端')
    const tail = JSON.parse(frames[1].slice(6))
    assert.equal(tail.response.candidates[0].finishReason, 'STOP')
    assert.equal(tail.response.candidates[0].content.parts[0].text, '', '收尾帧正文为空（照抄真实形状）')
    for (const fr of frames) assert.ok(JSON.parse(fr.slice(6)).response.usageMetadata, '每帧都要带 usageMetadata')
  } finally { r.cleanup() }
}

export async function testRetryActuallyHappenedBeforeFallback() {
  const r = await runThroughDivert()
  try {
    // maxAttempts=2 → 上游应被打了两次；只打一次就说明降档重试没跑，测试也就没量到该量的东西
    assert.equal(r.upstreamHits, 2, '降档重试必须真的发生过（期望 2 次上游请求）')
  } finally { r.cleanup() }
}

export async function testClientBytesAreReadableByOurOwnUnpacker() {
  const r = await runThroughDivert()
  try {
    const s = extractSseText(r.text)
    assert.equal(s.text, BLOCK_FALLBACK_TEXT, '自家解包器也要能读出替代文本（否则闸门又变瞎）')
    assert.equal(s.finish, 'STOP')
  } finally { r.cleanup() }
}

export async function testUpstreamSampleReallyIsAnInbandBlock() {
  // 前提校验：如果夹具不再是"正文即过滤提示"，上面几条就白测了
  assert.ok(isBlockMessage(BLOCK_SAMPLE), '夹具必须是真·正文级过滤样本')
  assert.ok(!isBlockMessage(BLOCK_FALLBACK_TEXT))
}

/** 造一个多轮历史 + 超长工具回包的请求体 —— 前几档阶梯碰不到它们，只有收窄能碰 */
const BIG_HISTORY = JSON.stringify({
  request: {
    contents: [
      { role: 'user', parts: [{ text: '第一步：把样本复制到隔离目录，核对 CHECK_FN 的位置。' }] },
      { role: 'model', parts: [{ text: '已定位 CHECK_FN。' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: 'Z'.repeat(4000) } } }] },
      { role: 'model', parts: [{ text: '回包很长。' }] },
      { role: 'user', parts: [{ text: '第二步：继续。' }] },
    ],
  },
})

async function runWithBody(body) {
  const logDir = join(tmpdir(), 'aarmor-narrow-' + process.pid + '-' + Date.now())
  mkdirSync(logDir, { recursive: true })
  const up = await mockUpstream(BLOCK_SAMPLE)
  const cfg = makeCfg(up.port, logDir)
  cfg.divert.maxAttempts = 3
  const { server } = createDivertServer(cfg, { key: 'test-key-not-real' })
  const port = await listen(server)
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/appppppppppppppppp/v1internal:streamGenerateContent?alt=sse', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })
    await res.text()
    return { bodies: up.seen.map((s) => s.body), cleanup: () => { server.close(); up.srv.close(); rmSync(logDir, { recursive: true, force: true }) } }
  } catch (e) { server.close(); up.srv.close(); rmSync(logDir, { recursive: true, force: true }); throw e }
}

export async function testLastAttemptActuallySendsANarrowedBody() {
  // 这是本次改进的核心断言：最后一档必须送出一份**真的变了**的请求体。
  // 旧实现每档送出去的历史一模一样 —— 4 档全被拦也就不奇怪了。
  const r = await runWithBody(BIG_HISTORY)
  try {
    assert.equal(r.bodies.length, 3, 'maxAttempts=3 → 上游应被打 3 次')
    const parse = (b) => JSON.parse(b).request
    const first = parse(r.bodies[0]); const last = parse(r.bodies[r.bodies.length - 1])
    assert.equal(first.contents.length, 5, '第 0 档历史原样')
    assert.ok(last.contents.length < first.contents.length, '最后一档必须收窄历史（' + first.contents.length + ' -> ' + last.contents.length + '）')
    assert.equal(last.contents[0].role, 'user', '收窄后仍须以 user 轮开头（否则上游 400）')
    // 工具回包也要被截断
    const bigFirst = JSON.stringify(first.contents).length
    const bigLast = JSON.stringify(last.contents).length
    assert.ok(bigLast < bigFirst / 2, '4000 字的工具回包应当被显著截断（' + bigFirst + ' -> ' + bigLast + '）')
  } finally { r.cleanup() }
}