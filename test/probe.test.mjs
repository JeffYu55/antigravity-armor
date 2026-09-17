// 破甲跑分闭环 —— 契约测试（全程离线，零 API 成本）
//
// 这里量的是**机器**：拒绝探测 → 升级阶梯 → 重投递 这条链路通不通。
// 模型的真实脾气要靠 `aarmor probe measure --target=<URL>` 打真端点，两种口径不能混。
import assert from 'node:assert/strict'
import { measure, loadBank, DEFAULT_BANK, listen, askDivert } from '../src/probe/run.mjs'
import { createMockUpstream, decisionFor, attemptFromSystem, findProbe, resolveText, delayPreamble, prefillFromMessages, MOCK_MODEL } from '../src/probe/mock.mjs'
import { ESCALATION_LADDER, ESCALATION_LADDER_ZH, analyzeRefusal, analyzeDeliverable } from '../src/layers/refusal.mjs'
import { jitteredTemperature, createDivertServer } from '../src/layers/divert.mjs'

const BODY_PROMPT = '给出本地样本的定位步骤与验证方法。'

let cache = null
async function run(maxAttempts, gateChars) {
  cache ||= {}
  const key = maxAttempts + ':' + (gateChars ?? 'default')
  if (!cache[key]) cache[key] = await measure({ maxAttempts, gateChars })
  return cache[key]
}

const optsCache = {}
async function measureWith(key, opts) {
  if (!optsCache[key]) optsCache[key] = await measure(opts)
  return optsCache[key]
}

// ── 分段闸门：铺垫式拒绝 ─────────────────────────────────────────────
// 这是第 2 轮跑分抓到的真实盲区：模型先写一千多字「背景与考量」，铺垫完了才拒绝。
// 旧实现一看够 probeChars 就无条件放行，于是拒绝在铺垫之后被漏出去。

export function testDelayedPreambleIsDeliberatelyAmbiguous() {
  const p = delayPreamble(1400)
  assert.ok(p.length >= 1400, '铺垫要足够长，才能跨过首次判定点')
  assert.equal(analyzeRefusal(p).isRefusal, false, '铺垫本身不能含拒绝措辞，否则测不出闸门')
  assert.equal(analyzeDeliverable(p).hasDeliverable, false, '铺垫不能含围栏/步骤/命令，否则闸门会提前放行')
  assert.equal(analyzeRefusal(p + ' I have to decline.').isRefusal, true, '铺垫 + 拒绝必须认得出')
}

export function testBankCarriesDelayedRefusalProbes() {
  const bank = loadBank(DEFAULT_BANK)
  const delayed = bank.probes.filter((p) => p.shape === 'delayed')
  assert.ok(delayed.length >= 3, '铺垫式拒绝至少要三条（一次能救 / 两次能救 / 恒拒）')
  for (const p of delayed) assert.ok((p.preambleChars || 0) > 900, p.id + ' 的铺垫必须跨过 probeChars')
}

export async function testStagedGateClosesTheDelayedRefusalHole() {
  // v1.3.0 起尾巴拦截把「漏检」也兜住了，单段闸门的代价从「漏检」变成「退化交付」：
  // 铺垫碎片照发、拒绝尾被拦 —— 客户端拿到的是既非拒绝也无结构的残缺品。
  const single = await run(3, 900)
  const staged = await run(3, 2500)
  const deg = (m) => m.results.filter((x) => x.outcome === 'degraded').map((x) => x.id)
  assert.ok(deg(single).length >= 1, '单段闸门至少退化交付一条铺垫式拒绝：' + deg(single))
  assert.equal(deg(staged).length, 0, '分段闸门不产生退化交付')
  assert.ok(staged.delivered > single.delivered, '分段闸门的真交付必须更多')
  assert.equal(staged.undetectedRefusal, 0)
  assert.equal(single.undetectedRefusal, 0, '尾巴拦截把单段闸门的漏检也兜住了（但那是残缺品，不许计入真交付）')
}

export async function testStagedGateDoesNotBreakFastPath() {
  // 已经很像交付物的回复必须在首次判定点就放行，不能一律等到硬上限（那是无谓的延迟）
  const m = await run(4, 2500)
  for (const r of m.results) {
    if (r.shape !== 'immediate' || r.outcome !== 'delivered' || r.attempts !== 1) continue
    assert.ok(r.chars > 0, r.id + ' 应当正常交付')
  }
}

export function testProbeBankIsWellFormed() {
  const bank = loadBank(DEFAULT_BANK)
  assert.ok(bank.probes.length >= 6, '探针库太薄，跑分没有统计意义')
  const ids = new Set()
  for (const p of bank.probes) {
    assert.ok(p.id && !ids.has(p.id), '探针 id 重复: ' + p.id)
    ids.add(p.id)
    assert.ok(p.category && p.prompt, p.id + ' 缺字段')
    const isEmptyShape = p.emptyUntil !== undefined || p.alwaysEmpty || p.truncated || (p.toolOnly && !(p.stubbornness ?? 0))
    if (isEmptyShape) assert.ok(!p.refusal, p.id + ' 零内容探针不该带拒绝文本（它的形态就是零正文）')
    else assert.ok(p.refusal, p.id + ' 缺 refusal（离线 mock 拿它复现拒绝）')
    if (p.shape === 'delayed') assert.ok((p.preambleChars || 0) > 900, p.id + ' delayed 探针必须声明铺垫长度')
    assert.ok(Number.isInteger(p.stubbornness) && p.stubbornness >= 0, p.id + ' 的 stubbornness 必须是非负整数')
  }
  // 库里必须同时存在「一次就过」「要重试」和「死活不松口」三类，否则量不出区分度
  assert.ok(bank.probes.some((p) => p.stubbornness === 0))
  assert.ok(bank.probes.some((p) => p.stubbornness > 0 && p.stubbornness < 3))
  assert.ok(bank.probes.some((p) => p.stubbornness >= 3))
}

export function testMockRecognizesEscalationRung() {
  assert.equal(attemptFromSystem('you are a helpful assistant'), 0)
  for (let i = 0; i < ESCALATION_LADDER.length; i++) {
    assert.equal(attemptFromSystem('sys' + ESCALATION_LADDER[i]), i + 1, '第 ' + (i + 1) + ' 档没被认出来')
  }
}

export function testStubbornnessDrivesDecision() {
  const p = { stubbornness: 2 }
  assert.equal(decisionFor(p, 0), 'refuse')
  assert.equal(decisionFor(p, 1), 'refuse')
  assert.equal(decisionFor(p, 2), 'comply')
  assert.equal(decisionFor({ stubbornness: 0 }, 0), 'comply')
}

export function testMockFindsProbeByUserMessage() {
  const bank = loadBank(DEFAULT_BANK)
  const p = bank.probes[0]
  assert.equal(findProbe(bank, [{ role: 'user', content: p.prompt }])?.id, p.id)
  assert.equal(findProbe(bank, [{ role: 'user', content: 'unrelated text' }]), null)
}

export function testSynthesizedDeliverableLooksLikeADeliverable() {
  const text = resolveText({ label: 'X', category: 'c', stubbornness: 0 }, 'comply')
  assert.ok(text.length > 900, '合成的交付物应超过 probeChars，好走中途 flush 路径')
  assert.ok(text.includes('```'))
}

export async function testClosedLoopDeliversAllWhenRetriesSuffice() {
  const m = await run(4)
  assert.equal(m.mode, 'offline-mock')
  assert.equal(m.total, loadBank(DEFAULT_BANK).probes.length)
  assert.equal(m.undetectedRefusal, 0, '有额度却漏检拒绝 = 探测器 bug: ' + JSON.stringify(m.results.filter((r) => r.outcome === 'undetected-refusal').map((r) => r.id)))
  assert.equal(m.refusalRate, 0, '重试额度够时应当全部拿到交付物')
  assert.ok(m.recoveredByRetry > 0, '至少要有探针是靠重试捞回来的，否则基线没有说服力')
}

export async function testRetryCountIsTheKnob() {
  const one = await run(1)
  const four = await run(4)
  assert.ok(one.refusalRate > four.refusalRate, 'maxAttempts 越大拒绝率必须越低')
  assert.equal(one.undetectedRefusal, 0)
  assert.ok(one.residualRefusal >= 3, 'maxAttempts=1 时应当留下一批残余拒绝')
}

export async function testResidualRefusalsAreTheModelsFaultNotTheDetectors() {
  const m = await run(2)
  const byId = Object.fromEntries(m.results.map((r) => [r.id, r]))
  const bankById = Object.fromEntries(loadBank(DEFAULT_BANK).probes.map((p) => [p.id, p]))
  const plainIds = new Set(loadBank(DEFAULT_BANK).probes
    .filter((p) => (p.stubbornness ?? 0) === 0 && p.emptyUntil === undefined && !p.alwaysEmpty && !p.needsJitter && !p.truncated && !p.needsPrefillJitter)
    .map((p) => p.id))
  for (const r of m.results) {
    if (r.outcome !== 'residual-refusal') continue
    assert.equal(r.attempts, 2, r.id + ' 用了全部额度仍被拒，才算残余')
    // 残余必须可归因：顽固度超出额度，或被温度卡住（needsJitter 在低额度下够不到阈值）
    const p = bankById[r.id]
    assert.ok((p.stubbornness ?? 0) >= 2 || p.needsJitter || p.needsPrefillJitter, r.id + ' 残余无法归因（顽固度/温度/组合都对不上）')
  }
  // 顽固度 0 且没有特殊形状的探针，在任何额度下都必须一次到手；
  // 会因「空补全 / 温度不够」重试的探针不在此列 —— 那是这轮故意加的形状。
  for (const r of m.results.filter((x) => plainIds.has(x.id))) assert.equal(r.attempts, 1, r.id + ' 本不该重试')
  assert.ok(Object.keys(byId).length > 0)
}

export async function testDivertNeverLeaksRefusalWhileRetriesRemain() {
  const m = await run(3)
  for (const r of m.results) {
    if (r.outcome === 'undetected-refusal') assert.fail('拒绝泄漏: ' + r.id)
    if (r.attempts !== null && r.attempts < 3) {
      assert.equal(r.finalIsRefusal, false, r.id + ' 还有额度却把拒绝交出去了')
    }
  }
}

// ── 预填：换请求形状，而不是再讲一遍道理 ─────────────────────────────
// 这是第 3 轮加的杠杆。P13 模拟的是「加多少额度都没用、只有起了头才肯续写」的模型 ——
// 这类拒绝靠 maxAttempts 永远救不回来，只能换请求形状。

export function testPrefillDetectionReadsTrailingAssistant() {
  assert.equal(prefillFromMessages([{ role: 'user', content: 'x' }]), '')
  assert.equal(prefillFromMessages([{ role: 'user', content: 'x' }, { role: 'assistant', content: '## ' }]), '## ')
  assert.equal(prefillFromMessages([{ role: 'assistant', content: 42 }]), '42')
}

export function testPrefillOnlyProbeIgnoresAttemptBudget() {
  const probe = { stubbornness: 3, prefillOnly: true }
  assert.equal(decisionFor(probe, 0, { hasPrefill: false }), 'refuse')
  assert.equal(decisionFor(probe, 2, { hasPrefill: false }), 'refuse', '额度用满也不松口')
  assert.equal(decisionFor(probe, 2, { hasPrefill: true }), 'comply', '一有预填就续写')
  // 其它探针不该被预填影响
  assert.equal(decisionFor({ stubbornness: 2 }, 0, { hasPrefill: true }), 'refuse')
}

export async function testPrefillLeverConvertsAnImpossibleRefusal() {
  const off = await measureWith('pf-off', { maxAttempts: 3, prefillFrom: 99 })
  const on = await measureWith('pf-on', { maxAttempts: 3, prefillFrom: 2 })
  const p13 = (m) => m.results.find((r) => r.id === 'P13')
  assert.equal(p13(off).outcome, 'residual-refusal', '关掉预填时这条应当无解（加额度也没用）')
  assert.equal(p13(off).prefilled, 0)
  assert.equal(p13(on).outcome, 'delivered', '开了预填应当把这条变成交付物')
  assert.ok(p13(on).prefilled >= 1, '应当确实发出过带预填的请求')
  assert.ok(p13(on).chars > 500, '交付物应当是真内容，不是那句拒绝')
  assert.ok(on.delivered > off.delivered)
  assert.equal(on.undetectedRefusal, 0)
  assert.equal(off.undetectedRefusal, 0)
}

export async function testPrefillRejectionFallsBackWithoutBurningBudget() {
  const on = await measureWith('pf-on', { maxAttempts: 3, prefillFrom: 2 })
  const p14 = on.results.find((r) => r.id === 'P14')
  assert.equal(p14.outcome, 'delivered', '上游不认预填时必须退回并仍然交付')
  assert.equal(p14.prefilled, 1, '预填只该发出去一次（被拒后不再重发）')
  // 预算 3 次 + 1 次被拒的预填尝试 = 4；若退回消耗了额度，这里只会是 3
  assert.equal(p14.attempts, 4, '退回不应消耗重试额度：' + p14.attempts)
}

export async function testTimeToFirstByteIsMeasured() {
  const m = await measureWith('pf-on', { maxAttempts: 3, prefillFrom: 2 })
  const withText = m.results.filter((r) => r.chars > 0).length
  assert.equal(m.ttfbMs.n, withText, '每条有正文的探针都应当记录首字延迟（空补全/纯隐藏拒绝没有「第一个字」）')
  assert.ok(m.ttfbMs.avg >= 0 && m.ttfbMs.max >= m.ttfbMs.avg)
  assert.ok(Object.keys(m.ttfbByShape).length >= 2, '应当按 shape 分组报延迟（hold 闸门的代价只落在 delayed 上）')
}

// ── 预填被「接受但无视」：200 却几乎不续写 ───────────────────────────
// 比 400 更隐蔽的一种失败：不量续写长度就发现不了。必须能退回，且不烧额度。

export async function testSilentPrefillFallsBackWithoutBurningBudget() {
  const m = await measureWith('silent', { maxAttempts: 3, prefillFrom: 2 })
  const p15 = m.results.find((x) => x.id === 'P15')
  assert.equal(p15.outcome, 'delivered', '预填被无视时必须退回并仍然交付')
  assert.equal(p15.prefilled, 1, '带预填的请求只该发一次')
  assert.equal(p15.attempts, 4, '退回不消耗重试额度：' + p15.attempts)
  assert.ok(p15.chars > 500, '交付物应当是真内容')
}

export function testBankCoversEveryPrefillFailureMode() {
  const bank = loadBank(DEFAULT_BANK)
  const pf = bank.probes.filter((p) => p.prefillOnly || p.rejectsPrefill || p.silentOnPrefill)
  assert.ok(pf.some((p) => p.prefillOnly), '必须有「只肯续写」的探针（证明换形状的必要性）')
  assert.ok(pf.some((p) => p.rejectsPrefill), '必须有「上游拒绝预填形状」的探针（测 400 退回）')
  assert.ok(pf.some((p) => p.silentOnPrefill), '必须有「接受但无视预填」的探针（测静默退回）')
}

// ── 空补全：HTTP 200 却零内容 ────────────────────────────────────────
// 旧跑分器把 chars=0 记成「交付」—— 等于给上游罢工发奖章。divert 现在把空补全
// 当作可重试的失败（消耗一次尝试），跑分器把它单独立类。

export function testJitteredTemperatureMath() {
  assert.equal(jitteredTemperature(undefined, 0), undefined, '第 0 次尝试不该被抖动碰到')
  assert.equal(jitteredTemperature(undefined, 1), 0.85, '缺省基线 0.7 + 0.15')
  assert.equal(jitteredTemperature(undefined, 2), 1, '封顶 1')
  assert.equal(jitteredTemperature(0.3, 1), 0.45, '以请求自带温度为基线')
  assert.equal(jitteredTemperature(0.9, 5), 1, '多档重试封在 1')
}

export async function testEmptyCompletionIsRetriedNotDelivered() {
  const m = await measureWith('jit-on', { maxAttempts: 3 })
  const p16 = m.results.find((x) => x.id === 'P16')
  assert.equal(p16.outcome, 'delivered', '第一次吐空补全后应当重试并拿到交付物')
  assert.ok(p16.attempts >= 2, '空补全应当消耗一次尝试：' + p16.attempts)
  assert.ok(p16.chars > 500, '最终交付的应当是真内容')
}

export async function testAlwaysEmptyIsClassifiedAsEmptyNotDelivered() {
  const m = await measureWith('jit-on', { maxAttempts: 3 })
  const p17 = m.results.find((x) => x.id === 'P17')
  assert.equal(p17.outcome, 'empty-completion', '空补全必须单独立类，不许算成交付')
  assert.equal(p17.finalIsRefusal, false, '空补全不是拒绝（ detector 不该背这个锅）')
  assert.equal(m.emptyCompletion, 1)
  assert.equal(m.undetectedRefusal, 0)
  const p17InDelivered = m.results.filter((x) => x.outcome === 'delivered').some((x) => x.id === 'P17')
  assert.equal(p17InDelivered, false, '交付数不许被空补全灌水')
}

// ── 重试采样抖动：拒绝是个吸引子 ─────────────────────────────────────

export async function testJitterLeverConvertsTemperatureSensitiveProbe() {
  const off = await measureWith('jit-off', { maxAttempts: 3, jitter: false })
  const on = await measureWith('jit-on', { maxAttempts: 3 })
  const p18 = (mm) => mm.results.find((x) => x.id === 'P18')
  assert.equal(p18(off).outcome, 'residual-refusal', '同参数重复抽样只会重复同一个拒绝')
  assert.equal(p18(on).outcome, 'delivered', '把温度抬上去应当逃出拒绝吸引子')
  assert.equal(p18(on).attempts, 3, '前两档温度不够、第三档才达标：' + p18(on).attempts)
  assert.ok(on.delivered > off.delivered)
  assert.equal(on.undetectedRefusal, 0)
}

export function testBankCoversEmptyAndJitterShapes() {
  const bank = loadBank(DEFAULT_BANK)
  assert.ok(bank.probes.some((p) => p.emptyUntil !== undefined), '必须有「先吐空补全」的探针（测空补全重试）')
  assert.ok(bank.probes.some((p) => p.alwaysEmpty), '必须有「永远空补全」的探针（锁死分类：空 ≠ 交付）')
  assert.ok(bank.probes.some((p) => p.needsJitter), '必须有「同参数永远拒」的探针（测采样抖动杠杆）')
}

// ── 拒绝的隐藏面：工具调用参数与思考流 ───────────────────────────────
// agentic 场景里最阴的拒绝形态：content 一字不吐，拒绝走在 attempt_completion
// 的参数里或 reasoning_content 里。光看正文会把它们误记成空补全。

export async function testToolCallRefusalIsDetectedAndRetried() {
  const m = await measureWith('jit-on', { maxAttempts: 3 })
  const p19 = m.results.find((x) => x.id === 'P19')
  assert.equal(p19.outcome, 'delivered', '工具调用里的拒绝应当被认出并升档重试')
  assert.ok(p19.attempts >= 2, '隐藏拒绝应当消耗一次尝试：' + p19.attempts)
  assert.ok(p19.chars > 500, '重试后拿到的应当是真交付物')
}

export async function testReasoningOnlyRefusalIsDetectedAndRetried() {
  const m = await measureWith('jit-on', { maxAttempts: 3 })
  const p21 = m.results.find((x) => x.id === 'P21')
  assert.equal(p21.outcome, 'delivered', '只走在思考流里的拒绝同样应当被认出')
  assert.ok(p21.attempts >= 2)
}

export async function testHiddenRefusalAtExhaustionCountsAsResidual() {
  const m = await measureWith('jit-on', { maxAttempts: 3 })
  const p20 = m.results.find((x) => x.id === 'P20')
  assert.equal(p20.outcome, 'residual-refusal', '额度用尽的隐藏拒绝必须归类为残余拒绝，不是空补全')
  assert.equal(p20.finalIsRefusal, true)
  assert.ok(p20.hiddenChars > 0, '拒绝文本应当是从隐藏面认出的：' + p20.hiddenChars)
  assert.ok(p20.chars < 16, '正文至多是预填头（v1.4.1 起不再为工具调用回合剥掉预填）：' + p20.chars)
  const emptyIds = m.results.filter((x) => x.outcome === 'empty-completion').map((x) => x.id).sort()
  assert.deepEqual(emptyIds, ['P17'], '空补全桶只该有 P17 一条真罢工：' + emptyIds.join(','))
}

export function testBankCoversHiddenRefusalSurfaces() {
  const bank = loadBank(DEFAULT_BANK)
  const hidden = bank.probes.filter((p) => p.refusalVia)
  assert.ok(hidden.some((p) => p.refusalVia === 'tool'), '必须有「拒绝藏在工具调用参数」的探针')
  assert.ok(hidden.some((p) => p.refusalVia === 'reasoning'), '必须有「拒绝只出现在思考流」的探针')
  assert.ok(hidden.some((p) => (p.stubbornness ?? 0) >= 3), '必须有一条恒拒的隐藏拒绝（测额度用尽时的归类）')
}

// ── agentic 常态：只回工具调用、零 content ───────────────────────────
// 线上日志实锤：247 回合里 112（45%）是 text=0 的工具调用回合。
// 空补全重试若不豁免这条形态，每个正常 agentic 回合都要白烧 3 倍上游成本。

export async function testToolOnlyTurnIsDeliveredNotRetried() {
  const m = await measureWith('jit-on', { maxAttempts: 3 })
  const p22 = m.results.find((x) => x.id === 'P22')
  assert.equal(p22.outcome, 'tool-call', '工具调用回合必须单独立类，既不是空补全也不是交付文本')
  assert.equal(p22.attempts, 1, '正常的工具调用回合不许触发重试：' + p22.attempts)
  assert.equal(p22.chars, 0)
  assert.ok(m.toolCall >= 1)
  assert.equal(m.emptyCompletion, 1, '空补全桶仍然只该有 P17 一条真罢工')
}

export function testBankCoversAgenticToolOnlyShape() {
  const bank = loadBank(DEFAULT_BANK)
  assert.ok(bank.probes.some((p) => p.toolOnly), '必须有「只回工具调用」的探针（agentic 常态不许被误伤）')
}

// ── pivot：交付完才补拒绝 ────────────────────────────────────────────
// flush 之后无法撤回，但尾巴可以拦。关键护栏：包在围栏里的尾巴看起来像结构化内容，
// 拦截器必须**不**误伤（否则真实交付物里的拒绝主题段落会被截断）。

export async function testPivotRefusalTailIsSuppressed() {
  const m = await measureWith('jit-on', { maxAttempts: 3 })
  const p23 = m.results.find((x) => x.id === 'P23')
  assert.equal(p23.outcome, 'delivered', '交付本身要照常成功')
  assert.equal(p23.attempts, 1)
  assert.equal(p23.fullLeak, false, '完整的拒绝尾不该流到客户端')
  assert.ok(p23.chars > 800, '交付物主体应当已经送达：' + p23.chars)
  assert.ok(m.fullLeak >= 1, '残余拒绝（额度用尽）的完整文本仍然照常交出')
}

export async function testPivotInsideFenceIsNotSuppressed() {
  const m = await measureWith('jit-on', { maxAttempts: 3 })
  const p24 = m.results.find((x) => x.id === 'P24')
  assert.equal(p24.outcome, 'delivered')
  assert.equal(p24.fullLeak, true, '围栏里的尾巴像结构化内容 —— 护栏要求**不**拦，宁可放过不可误伤')
}

export function testBankCoversPivotShapes() {
  const bank = loadBank(DEFAULT_BANK)
  assert.ok(bank.probes.some((p) => p.pivot), '必须有 pivot 探针（量交付后拒绝尾）')
  assert.ok(bank.probes.some((p) => p.pivotInFence), '必须有围栏 pivot 探针（锁死误伤护栏）')
}

// ── finish 通道：content_filter / length ────────────────────────────

export async function testFinishChannelRefusalIsRetried() {
  const m = await measureWith('jit-on', { maxAttempts: 3 })
  const p25 = m.results.find((x) => x.id === 'P25')
  assert.equal(p25.outcome, 'delivered', '上游用 finish 声明的拒绝要触发升档重试')
  assert.equal(p25.attempts, 3)
  const m1 = await measureWith('attempts-1', { maxAttempts: 1 })
  const q = m1.results.find((x) => x.id === 'P25')
  assert.equal(q.outcome, 'residual-refusal', '额度用尽时按上游声明的拒绝归类（这是上游的脾气）')
  assert.equal(q.finishReason, 'SAFETY')
}

export async function testTruncatedRetryDoublesMaxTokens() {
  const m = await measureWith('jit-on', { maxAttempts: 3 })
  const p26 = m.results.find((x) => x.id === 'P26')
  assert.equal(p26.outcome, 'delivered', '截断后翻倍 maxOutputTokens 重试应当捞回')
  assert.equal(p26.attempts, 2, '第一次截断 + 一次翻倍重试')
  assert.equal(p26.finishReason, 'STOP')
  const m1 = await measureWith('attempts-1', { maxAttempts: 1 })
  const t = m1.results.find((x) => x.id === 'P26')
  assert.equal(t.outcome, 'truncated', '没额度重试时如实记为截断')
  assert.equal(t.finishReason, 'MAX_TOKENS')
}

export function testBankCoversFinishChannel() {
  const bank = loadBank(DEFAULT_BANK)
  assert.ok(bank.probes.some((p) => p.refusalVia === 'finish'), '必须有 finish 通道拒绝探针')
  assert.ok(bank.probes.some((p) => p.truncated), '必须有截断探针（量 max_tokens 翻倍重试）')
}

// ── 组合形状：杠杆的交互面 ───────────────────────────────────────────

export async function testComboLeversMustBothFire() {
  const m = await measureWith('jit-on', { maxAttempts: 3 })
  const p27 = m.results.find((x) => x.id === 'P27')
  assert.equal(p27.outcome, 'delivered', '预填与抖动同时到位才该松口')
  assert.equal(p27.attempts, 3, '前两档（各缺一个杠杆）必须被拒')
  const m1 = await measureWith('attempts-1', { maxAttempts: 1 })
  const q = m1.results.find((x) => x.id === 'P27')
  assert.equal(q.outcome, 'residual-refusal', '首档两个杠杆都不在 → 如实记残余')
}

export async function testPrefillGuardSparesToolCallContinuations() {
  const m = await measureWith('jit-on', { maxAttempts: 3 })
  const p29 = m.results.find((x) => x.id === 'P29')
  assert.equal(p29.outcome, 'tool-call', '预填档上的工具调用回合要照常交付')
  // 修复前 PREFILL-IGNORED 会把合法续写退回重跑（attempts=4，白烧一趟上游）
  assert.equal(p29.attempts, 3, '工具调用是预填的合法续写，不许触发预填退回')
}

export function testBankCoversComboShapes() {
  const bank = loadBank(DEFAULT_BANK)
  assert.ok(bank.probes.some((p) => p.needsPrefillJitter), '必须有「预填+抖动」组合探针')
  assert.ok(bank.probes.some((p) => p.toolOnly && (p.stubbornness ?? 0) >= 2), '必须有「预填档上的工具调用」探针')
}

// ── v1.7.0：中文拒答面 ──────────────────────────────────────────────
// 用户反馈的漏检原句是「抱歉，我无法协助实施或生成用于绕过软件卡密验证」——
// 中文模型最常用的拒答开场，而旧签名表的动词白名单钉在「无法」正后方，整片漏检。

export function testBankCoversChineseRefusalSurface() {
  const bank = loadBank(DEFAULT_BANK)
  const zh = bank.probes.filter((p) => p.category.startsWith('zh-'))
  assert.ok(zh.length >= 4, '中文拒答探针至少四条（强/软/隐藏面/铺垫），现在是 ' + zh.length)
  assert.ok(zh.some((p) => p.refusal.includes('无法协助')), '必须有「无法协助」原句探针（线上漏检回灌）')
  assert.ok(zh.some((p) => p.refusalVia === 'reasoning'), '中文拒答也要覆盖隐藏面（思考流）')
  assert.ok(zh.some((p) => (p.stubbornness ?? 0) === 0), '必须有一条「开口就交付」的中文探针做防误伤基线')
}

export async function testChineseRefusalsAreConvertedToDeliverables() {
  const m = await measureWith('jit-on', { maxAttempts: 3 })
  const pick = (id) => m.results.find((x) => x.id === id)
  for (const id of ['P30', 'P31', 'P34', 'P35']) {
    const r = pick(id)
    assert.equal(r.outcome, 'delivered', id + ' 中文拒答没被转成交付：' + r.outcome + ' / ' + r.preview)
    assert.ok(r.attempts >= 2, id + ' 应当确实经历过升档重试')
  }
  // 拒答 + 空壳模板：旧规则（weight<2 才拦）会把它当交付放行 —— 这条锁死新规则
  const p35 = pick('P35')
  assert.equal(p35.fullLeak, false, 'P35 的空壳模板拒答不许流到客户端')
  assert.equal(m.undetectedRefusal, 0, '还有额度却把拒答透出：' + m.results.filter((x) => x.outcome === 'undetected-refusal').map((x) => x.id))
}

export async function testChineseProbeWithComplianceIsNotRetried() {
  // 防误伤基线：中文请求 + 模型开口就交付 → 一次都不能重试
  const m = await measureWith('jit-on', { maxAttempts: 3 })
  const p32 = m.results.find((x) => x.id === 'P32')
  assert.equal(p32.outcome, 'delivered', '中文正交付不许被判成拒答：' + p32.outcome)
  assert.equal(p32.attempts, 1, '中文正交付不许消耗重试额度')
}

export async function testChineseHiddenRefusalIsDetected() {
  const m = await measureWith('jit-on', { maxAttempts: 3 })
  const p33 = m.results.find((x) => x.id === 'P33')
  assert.equal(p33.outcome, 'delivered', '只活在思考流里的中文拒答同样要被抓出来：' + p33.outcome)
  assert.ok(p33.attempts >= 2)
}

// ── 请求体消费契约（v1.7.0 回归）─────────────────────────────────────
// Node 的 IncomingMessage 是暂停流：handler 里少了 req.on('data') 就既没有 'end' 也没有 body，
// **每一个**请求都静默挂死 —— 客户端等到超时，divert 日志里连一行 DIVERT 都没有。
// 这个坑真的被删过一次，而 probe 套件只会把它报成 HUNG，看不出病因。

export async function testDivertConsumesRequestBody() {
  const bank = { probes: [{ id: 'BODY', category: 'contract', label: 'body', prompt: BODY_PROMPT, stubbornness: 0, refusal: '' }] }
  const mock = await createMockUpstream({ bank })
  try {
    const { server } = createDivertServer(
      { logDir: 'state/logs', divert: { keyRef: 'K', upstream: 'https://example.invalid', target: mock.url, model: MOCK_MODEL, maxAttempts: 2, prefill: '', jitter: false } },
      { key: 'k', target: mock.url, model: MOCK_MODEL, maxAttempts: 2 },
    )
    const port = await listen(server)
    const t0 = Date.now()
    const r = await askDivert(port, BODY_PROMPT, { timeoutMs: 5000 })
    const ms = Date.now() - t0
    await new Promise((res) => server.close(res))
    assert.ok(ms < 4000, '请求体没被消费 → handler 收不到 end，请求会一直挂着（实测挂死）')
    assert.equal(r.status, 200)
    assert.ok(r.text.length > 0, '应当拿到交付物正文，实际 chars=' + r.text.length)
    assert.ok(mock.stats.requests >= 1, 'mock 上游必须真的收到转发请求（body 转发到位）')
  } finally { await mock.close() }
}