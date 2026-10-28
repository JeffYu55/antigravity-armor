// 无 key 降级语义（v1.8.4）—— 2026-09-30 事故的回归锁
//
// 现场：credentials.yaml 被改丢 KUAIPAOGLM_API_KEY，createDivertServer 直接 throw，
// 代理 3 秒崩一次、watchdog 每 5 分钟白拉一次，50100 永远没人听 —— 而 IDE 的 L4 补丁
// 把**登录**也指向 50100，于是连账号设置页都打不开（connectex: No connection could be made）。
// 修复后：无 key 也要起来（仅透传），账号接口照常转发，只有真改道请求 503 + 修复指引。
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createDivertServer } from '../src/layers/divert.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))

function makeCfg(logDir) {
  return {
    logDir,
    geminiHome: logDir,
    dshHome: logDir, // resolveKey 找 ~/.dsh/.credentials.yaml 的根 —— 指向空目录即「无 key」
    divert: {
      port: 0,
      upstream: 'https://127.0.0.1:9/unused', // relay 分支硬编码 https —— 用一个必拒端口，看的是「不 503」
      passThrough: false,
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

async function withServer(cfg, opts, fn) {
  const { server } = createDivertServer(cfg, opts)
  const port = await listen(server)
  try { return await fn(port) } finally { server.close() }
}

export async function testNoKeyDoesNotThrowAndReportsMissing() {
  // 事故本体：这句话以前是 throw —— 代理根本起不来
  const logDir = join(tmpdir(), 'aarmor-nokey-' + process.pid + '-' + Date.now())
  mkdirSync(logDir, { recursive: true })
  try {
    const r = createDivertServer(makeCfg(logDir), {})
    assert.equal(r.keyMissing, true, '要标记 keyMissing，status/日志靠它报告降级')
    assert.equal(r.key, null)
    r.server.close()
  } finally { rmSync(logDir, { recursive: true, force: true }) }
}

export async function testNoKeyDivertRequestsReturn503WithHint() {
  const logDir = join(tmpdir(), 'aarmor-nokey-' + process.pid + '-' + Date.now())
  mkdirSync(logDir, { recursive: true })
  try {
    await withServer(makeCfg(logDir), {}, async (port) => {
      const res = await fetch('http://127.0.0.1:' + port + '/appppppppppppppppp/v1internal:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] } }),
      })
      assert.equal(res.status, 503, '无 key 的改道请求要 503（不是断流/连接拒绝）')
      const body = await res.json()
      assert.match(body.error.message, /DUMMY_KEY_FOR_TEST/, '错误信息必须带上 keyRef，照着就能修')
      assert.match(body.error.message, /credentials\.yaml/, '错误信息要指到凭据文件')
    })
  } finally { rmSync(logDir, { recursive: true, force: true }) }
}

export async function testNoKeyAccountRelayIsNotBlocked() {
  // 关键区分：登录/账号接口不碰 key —— 无 key 时它们走的是 relay（对必拒端口 502），
  // 绝不能落进 NO-KEY 503，否则又回到「连登录都被拖死」的事故形态。
  const logDir = join(tmpdir(), 'aarmor-nokey-' + process.pid + '-' + Date.now())
  mkdirSync(logDir, { recursive: true })
  try {
    await withServer(makeCfg(logDir), {}, async (port) => {
      const res = await fetch('http://127.0.0.1:' + port + '/appppppppppppppppp/v1internal:loadCodeAssist', { method: 'POST', body: '{}' })
      assert.equal(res.status, 502, '账号接口要走 relay（连不上上游=502），不能被 NO-KEY 拦成 503')
    })
  } finally { rmSync(logDir, { recursive: true, force: true }) }
}

export async function testWithKeyBehaviorUnchanged() {
  const logDir = join(tmpdir(), 'aarmor-nokey-' + process.pid + '-' + Date.now())
  mkdirSync(logDir, { recursive: true })
  try {
    const r = createDivertServer(makeCfg(logDir), { key: 'test-key-not-real' })
    assert.equal(r.keyMissing, false)
    assert.ok(r.key.startsWith('test-'), '有 key 时照常报前缀')
    r.server.close()
  } finally { rmSync(logDir, { recursive: true, force: true }) }
}
