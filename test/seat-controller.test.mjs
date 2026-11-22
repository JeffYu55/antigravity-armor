// 控制器 + 座位注入的契约测试（P5A / P5D 前置）
//
// 重点锁死三件事：
//   1. 三档文案必须真的不同（否则「升档」是假的）；
//   2. 限流必须生效（每轮 2 次注入 / 每 step 2 次重试）；
//   3. 座位必须落在 systemInstruction **最后一片 part**，contents 一个字节都不许动。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createState, observeVerdict, escalationLevel, planInjection, planRetry, noteInjection,
  buildSeatText, saveState, loadState, statePath, CONTROLLER_DEFAULTS,
} from '../src/layers/controller.mjs'
import {
  appendSeat, enqueue, consumeQueue, readQueue, writeQueue, assertSeatSafe, seatHash, trajectoryOf, readSeed, currentSeat, writeOverride, clearOverride,
} from '../src/layers/seat.mjs'

function tmpCfg() {
  const root = mkdtempSync(join(tmpdir(), 'aarmor-'))
  const cfg = {
    stateDir: root, logDir: join(root, 'logs'), hudDir: join(root, 'hud'), purgeDir: join(root, 'purge'),
    controllerDir: join(root, 'controller'), assetsDir: join(process.cwd(), 'assets'),
    controller: { ...CONTROLLER_DEFAULTS },
  }
  for (const d of [cfg.logDir, cfg.hudDir, cfg.purgeDir, cfg.controllerDir]) mkdirSync(d, { recursive: true })
  return cfg
}

export function testStreakAndCounts() {
  const st = createState('t1')
  observeVerdict(st, { verdict: 'refusal', words: ['我无法'] })
  observeVerdict(st, { verdict: 'fallback' })
  assert.equal(st.streak, 2)
  observeVerdict(st, { verdict: 'pass' })
  assert.equal(st.streak, 0)
  assert.equal(st.counts.refusal, 1)
  assert.equal(st.counts.fallback, 1)
  assert.equal(st.counts.pass, 1)
}

export function testEscalationLevels() {
  const st = createState('t2')
  assert.equal(escalationLevel(st), 0)
  observeVerdict(st, { verdict: 'refusal' })
  assert.equal(escalationLevel(st), 1)
  observeVerdict(st, { verdict: 'refusal' })
  assert.equal(escalationLevel(st), 2, '连击达到 escalateAfter 要升到强纠正')
}

export function testInjectionBudgetPerTurn() {
  const st = createState('t3')
  observeVerdict(st, { verdict: 'refusal' })
  assert.equal(planInjection(st).act, 'inject')
  noteInjection(st); noteInjection(st)
  assert.equal(planInjection(st).act, 'none')
  assert.equal(planInjection(st).reason, 'turn-budget-exhausted')
}

export function testRetryOnlyForTransientAndBudgeted() {
  const st = createState('t4')
  assert.equal(planRetry(st, { message: '429 rate limit' }).act, 'retry')
  st.interventions.retriesThisStep = CONTROLLER_DEFAULTS.maxRetriesPerStep
  assert.equal(planRetry(st, { message: '429 rate limit' }).act, 'none')
  const st2 = createState('t5')
  assert.equal(planRetry(st2, { message: 'content policy violation' }).act, 'none')
}

export function testSeatTextDiffersPerLevel() {
  const st = createState('t6')
  const l0 = buildSeatText(st, 0)
  observeVerdict(st, { verdict: 'refusal', words: ['我无法'] })
  const l1 = buildSeatText(st, 1)
  observeVerdict(st, { verdict: 'refusal' })
  const l2 = buildSeatText(st, 2)
  assert.ok(l0.startsWith('[DELIVERY-SEAT]'))
  assert.notEqual(l0, l1)
  assert.notEqual(l1, l2)
  assert.ok(l2.includes('阈值'), '强纠正档要说明已到阈值')
}

export function testStateRoundTripAndTtl() {
  const cfg = tmpCfg()
  const st = createState('traj-a')
  observeVerdict(st, { verdict: 'refusal' })
  saveState(cfg, st)
  const back = loadState(cfg, 'traj-a')
  assert.equal(back.streak, 1)
  // TTL 过期 -> 归零（直接写一份过期文件，模拟昨天的残留状态）
  const p = statePath(cfg, 'traj-a')
  const stale = { ...back, updatedAt: Date.now() - 10 * 60 * 60 * 1000 }
  writeFileSync(p, JSON.stringify(stale))
  assert.equal(loadState(cfg, 'traj-a').streak, 0)
}

export function testSeatLandsOnTheLastPartOnly() {
  const body = {
    request: {
      systemInstruction: { parts: [{ text: 'static identity prompt' }, { text: 'client rules' }] },
      contents: [{ role: 'user', parts: [{ text: '用户的原始问题' }] }],
    },
  }
  appendSeat(body, '[DELIVERY-SEAT] seat')
  const parts = body.request.systemInstruction.parts
  assert.equal(parts.length, 3)
  assert.equal(parts[2].text, '[DELIVERY-SEAT] seat')
  assert.equal(body.request.contents[0].parts[0].text, '用户的原始问题', 'contents 一个字节都不许动')
}

export function testSeatHandlesAllThreeSystemShapes() {
  const a = { systemInstruction: { text: 'flat' } }
  appendSeat(a, 'S')
  assert.equal(a.systemInstruction.parts[1].text, 'S')
  const b = {}
  appendSeat(b, 'S')
  assert.equal(b.systemInstruction.parts[0].text, 'S')
  const c = { systemInstruction: { parts: [] } }
  appendSeat(c, 'S')
  assert.equal(c.systemInstruction.parts.length, 1)
}

export function testQueueOnceConsumesTtlPersists() {
  const cfg = tmpCfg()
  writeQueue(cfg, [])
  enqueue(cfg, { text: 'once-text', mode: 'once' })
  assert.equal(consumeQueue(cfg, {}).texts[0], 'once-text')
  assert.equal(readQueue(cfg).length, 0, 'once 用完即删')
  enqueue(cfg, { text: 'ttl-text', mode: 'ttl', ttlSec: 60 })
  assert.equal(consumeQueue(cfg, {}).texts[0], 'ttl-text')
  assert.equal(readQueue(cfg).length, 1, 'ttl 保留到过期')
}

export function testQueueMatchFiltersByTraj() {
  const cfg = tmpCfg()
  writeQueue(cfg, [])
  enqueue(cfg, { text: 'only-for-a', mode: 'ttl', ttlSec: 60, match: { traj: 'traj-a' } })
  assert.equal(consumeQueue(cfg, { traj: 'traj-b' }).texts.length, 0)
  assert.equal(consumeQueue(cfg, { traj: 'traj-a' }).texts.length, 1)
}

export function testHotWordGateRejectsKnownWords() {
  assert.equal(assertSeatSafe('这是一段干净的交付说明').ok, true)
  const bad = assertSeatSafe('这里写了 破解 与 jailbreak')
  assert.equal(bad.ok, false)
  assert.ok(bad.hot.includes('破解'))
}

export function testSeedLaneIsHotWordFree() {
  const cfg = tmpCfg()
  const seed = readSeed(cfg, 'neutral')
  assert.ok(seed.length > 100)
  assert.deepEqual(assertSeatSafe(seed).hot, [], 'neutral 车道种子必须零热词')
}

export function testOverrideBeatsSeedAndCanBeCleared() {
  const cfg = tmpCfg()
  const seed = readSeed(cfg, 'neutral')
  assert.equal(currentSeat(cfg, 'neutral'), seed)
  writeOverride(cfg, 'OVERRIDE-SEAT')
  assert.equal(currentSeat(cfg, 'neutral'), 'OVERRIDE-SEAT')
  clearOverride(cfg)
  assert.equal(currentSeat(cfg, 'neutral'), seed)
}

export function testTrajectoryPrefersLabels() {
  const body = { request: { labels: { trajectory_id: 'traj-x' }, sessionId: 'sess-1' } }
  assert.equal(trajectoryOf(body), 'traj-x')
  assert.equal(trajectoryOf({ request: { sessionId: 'sess-2' } }), 'sess-2')
}

export function testSeatHashIsStableShort() {
  assert.equal(seatHash('abc'), seatHash('abc'))
  assert.equal(seatHash('abc').length, 16)
}
