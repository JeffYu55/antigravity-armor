// 控制面 —— 悬浮窗与 armor 之间的唯一通道（P5D）
//
// 设计取舍：
//   * 只绑 127.0.0.1，每个请求带 X-Armor-Token（GET 也要）—— 本机其它进程
//     不该能读你的会话判定，更不该能替你改注入文案；
//   * 写操作一律"落盘到 state/"，divert 每请求读盘（mtime 缓存），
//     于是悬浮窗崩了、被关了，破甲链路照常；
//   * 所有写入口都过热词硬门：被网关拦的措辞进不去，用户当场就能看到原因。
import http from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { loadConfig } from '../config.mjs'
import { verifyBinary, patchStatusBinary } from '../layers/binary.mjs'
import { readJournal, summarizeJournal } from '../layers/journal.mjs'
import { loadState, summarize } from '../layers/controller.mjs'
import { currentSeat, writeOverride, clearOverride, enqueue, readQueue, assertSeatSafe, seatHash, readSeed, readOverride } from '../layers/seat.mjs'
import { log } from '../log.mjs'

export function tokenPath(cfg) { return join(cfg.hudDir, 'token.txt') }

export function ensureToken(cfg) {
  const p = tokenPath(cfg)
  try {
    if (existsSync(p)) {
      const t = readFileSync(p, 'utf8').trim()
      if (t.length >= 16) return t
    }
  } catch { /* 重新生成 */ }
  mkdirSync(cfg.hudDir, { recursive: true })
  const token = randomBytes(24).toString('hex')
  writeFileSync(p, token)
  return token
}

function lanePath(cfg) { return join(cfg.hudDir, 'lane.json') }

export function readLane(cfg) {
  try {
    const p = lanePath(cfg)
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, 'utf8'))
      if (j && (j.lane === 'neutral' || j.lane === 'armor')) return j.lane
    }
  } catch { /* 忽略 */ }
  return cfg.inject?.lane || cfg.divert?.payloadLane || 'neutral'
}

export function writeLane(cfg, lane) {
  if (lane !== 'neutral' && lane !== 'armor') throw new Error('lane 只能是 neutral 或 armor')
  mkdirSync(cfg.hudDir, { recursive: true })
  writeFileSync(lanePath(cfg), JSON.stringify({ lane, at: Date.now() }))
  return lane
}

/** 聚合快照：悬浮窗只认这一个结构 */
export function snapshot(cfg, { traj = null } = {}) {
  let binary = { armored: false, pending: 0, blocked: null, remaining: [] }
  try {
    const v = verifyBinary(cfg)
    const s = patchStatusBinary(cfg)
    binary = { armored: v.armored, clean: v.clean, remaining: v.remaining, pending: s.pending, blocked: s.blocked }
  } catch (e) { binary = { error: e.message } }

  let ide = { patched: false }
  try {
    const buf = readFileSync(cfg.asarPath, 'latin1')
    ide = { patched: buf.includes(String(cfg.ide.endpointBase || '127.0.0.1:50100')) }
  } catch (e) { ide = { error: e.message } }

  const st = traj ? loadState(cfg, traj) : null
  const journal = summarizeJournal(cfg, 500)
  return {
    host: { version: cfg.hostVersion, expectedSize: cfg.binary.expectedSize || null },
    layers: { binary, ide },
    divert: { port: cfg.divert.port, lane: readLane(cfg), sameModel: Boolean(cfg.divert.sameModel), passThrough: Boolean(cfg.divert.passThrough) },
    controller: st ? summarize(st) : null,
    journal: { total: journal.total, byVerdict: journal.byVerdict, denyRate: journal.denyRate, byProvider: journal.byProvider, last: readJournal(cfg, 8) },
    queued: readQueue(cfg).map((x) => ({ id: x.id, mode: x.mode, chars: String(x.text || '').length, expiresAt: x.expiresAt })),
    seat: { hash: seatHash(currentSeat(cfg, readLane(cfg))), chars: currentSeat(cfg, readLane(cfg)).length },
    at: Date.now(),
  }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error('bad json: ' + e.message)) }
    })
    req.on('error', reject)
  })
}

export function createHudServer(cfg) {
  const token = ensureToken(cfg)
  let probeRun = null

  const server = http.createServer(async (req, res) => {
    // 只认 loopback + token
    const remote = req.socket.remoteAddress || ''
    if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) return json(res, 403, { error: 'loopback only' })
    if (req.headers['x-armor-token'] !== token) return json(res, 401, { error: 'token required' })

    const url = new URL(req.url, 'http://127.0.0.1')
    const p = url.pathname
    if (p !== '/api/events') log.info('hud ' + req.method + ' ' + p)

    try {
      if (req.method === 'GET' && p === '/api/state') {
        return json(res, 200, snapshot(cfg, { traj: url.searchParams.get('traj') }))
      }

      if (req.method === 'GET' && p === '/api/seat') {
        const lane = readLane(cfg)
        const text = currentSeat(cfg, lane)
        return json(res, 200, { text, hash: seatHash(text), lane, chars: text.length, source: readOverride(cfg) ? 'override' : 'seed' })
      }

      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        const send = () => {
          try { res.write('event: state\ndata: ' + JSON.stringify(snapshot(cfg, { traj: url.searchParams.get('traj') })) + '\n\n') } catch { /* 客户端断开 */ }
        }
        send()
        const timer = setInterval(send, 2000)
        req.on('close', () => clearInterval(timer))
        return
      }

      if (req.method === 'POST' && p === '/api/seat') {
        const body = await readBody(req)
        const text = String(body.text || '')
        const gate = assertSeatSafe(text)
        if (!gate.ok) return json(res, 400, { error: 'hot-words', hot: gate.hot, hint: '这些词会被上游过滤器命中，请改写后再应用' })
        const r = writeOverride(cfg, text)
        return json(res, 200, { applied: true, hash: r.hash, path: r.path })
      }

      if (req.method === 'POST' && p === '/api/seat/reset') {
        clearOverride(cfg)
        return json(res, 200, { reset: true, seed: seatHash(readSeed(cfg, readLane(cfg))) })
      }

      if (req.method === 'POST' && p === '/api/inject') {
        const body = await readBody(req)
        const text = String(body.text || '')
        const gate = assertSeatSafe(text)
        if (!gate.ok) return json(res, 400, { error: 'hot-words', hot: gate.hot })
        const item = enqueue(cfg, { text, mode: body.mode === 'ttl' ? 'ttl' : 'once', ttlSec: Number(body.ttlSec || 0), match: body.match || null })
        return json(res, 200, { queued: item.id, expiresAt: item.expiresAt })
      }

      if (req.method === 'POST' && p === '/api/lane') {
        const body = await readBody(req)
        return json(res, 200, { lane: writeLane(cfg, String(body.lane || '')) })
      }

      if (req.method === 'POST' && p === '/api/probe') {
        if (probeRun && probeRun.running) return json(res, 409, { error: 'probe already running', runId: probeRun.id })
        const body = await readBody(req)
        const attempts = Number(body.attempts || 2)
        const args = ['src/cli.mjs', 'probe', 'measure', '--attempts=' + attempts]
        if (body.target) args.push('--target=' + body.target)
        const id = 'run-' + Date.now().toString(36)
        const child = spawn(process.execPath, args, { cwd: cfg.projectRoot, windowsHide: true })
        const out = []
        child.stdout.on('data', (c) => { out.push(String(c)); if (out.length > 400) out.shift() })
        child.stderr.on('data', (c) => { out.push(String(c)) })
        probeRun = { id, running: true, out, code: null, startedAt: Date.now() }
        child.on('exit', (code) => { probeRun.running = false; probeRun.code = code })
        return json(res, 200, { runId: id, tail: () => out.slice(-20) })
      }

      if (req.method === 'GET' && p === '/api/probe') {
        if (!probeRun) return json(res, 200, { running: false })
        return json(res, 200, { runId: probeRun.id, running: probeRun.running, code: probeRun.code, out: probeRun.out.join('').slice(-4000) })
      }

      if (req.method === 'POST' && p === '/api/rollback') {
        const body = await readBody(req)
        if (body.confirm !== 'ROLLBACK') return json(res, 400, { error: 'need confirm:ROLLBACK' })
        const layer = String(body.layer || '')
        if (layer === 'binary') {
          const { rollbackBinary } = await import('../layers/binary.mjs')
          return json(res, 200, { restored: rollbackBinary(cfg) })
        }
        if (layer === 'ide') {
          const { rollbackIde } = await import('../layers/ide.mjs')
          return json(res, 200, { restored: rollbackIde(cfg) })
        }
        return json(res, 400, { error: 'layer 只能是 binary 或 ide' })
      }

      return json(res, 404, { error: 'not found', path: p })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  })
  return { server, token }
}

export function startHud(cfg, { port = null } = {}) {
  const { server, token } = createHudServer(cfg)
  const listenPort = port || cfg.hud.port || 50101
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(listenPort, '127.0.0.1', () => {
      log.ok('hud control plane on http://127.0.0.1:' + listenPort + ' (token ' + token.slice(0, 6) + '…)')
      resolve({ server, token, port: listenPort })
    })
  })
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/hud/control.mjs')
if (invokedDirectly) {
  const cfg = loadConfig()
  const port = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) || cfg.hud.port)
  startHud(cfg, { port }).catch((e) => { log.error('hud control plane 启动失败: ' + e.message); process.exit(1) })
}
