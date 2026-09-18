// 上下文收窄 —— 请求级过滤的最后一个确定性杠杆（v1.8.0）
//
// 现场：用户看到「本地上游网关：…被上游边缘过滤拦下了」，问「为什么会这样」。
// 真实上游原文：This request was blocked by Gemini's filters.（请求级，拦整个请求体）
// 而旧阶梯每档只改 system 位与触发词，**对话历史一个字没动** ——
// 里面躺着原始任务描述、exe 路径、工具回包全文，那才是最大的携带者。
// 所以 4 档全被拦：每档送出去的历史都一模一样。
import assert from 'node:assert/strict'
import { narrowContext, BLOCK_FALLBACK_TEXT, scanHotWords } from '../src/layers/gemini-retry.mjs'

const turn = (role, text) => ({ role, parts: [{ text }] })
const body = (contents, sys) => ({ request: { contents, ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}) } })

export function testKeepsOnlyTheLastTurns() {
  const p = body([turn('user', 'a'), turn('model', 'b'), turn('user', 'c'), turn('model', 'd'), turn('user', 'e')])
  const r = narrowContext(p, { keepTurns: 2 })
  // 注意：纯按"最后 2 轮"切会落在 [model d, user e] 上 → 首轮不是 user → 上游 400。
  // 所以会往前多取一轮停在 user 上，结果是 3 条。多取一轮是**对的**，不是多保留。
  assert.equal(r.kept, 3)
  assert.equal(r.dropped, 2)
  assert.equal(p.request.contents.length, 3)
  assert.equal(p.request.contents[0].role, 'user')
  assert.equal(p.request.contents[0].parts[0].text, 'c', '最早的历史被丢掉')
  assert.equal(p.request.contents[p.request.contents.length - 1].parts[0].text, 'e', '必须留住最后一轮（那才是本次任务）')
  assert.equal(p.request.contents.length, 5 - r.dropped)
}

export function testNarrowedConversationStillStartsWithUser() {
  // Gemini 要求会话以 user 轮开头，否则上游 400 —— 收窄后必须仍然成立
  const p = body([turn('user', 'a'), turn('model', 'b'), turn('user', 'c'), turn('model', 'd')])
  const r = narrowContext(p, { keepTurns: 1 })
  assert.equal(r.startedWithUser, true)
  assert.equal(p.request.contents[0].role, 'user', '往前多取，落在 user 轮上')
  assert.equal(p.request.contents[0].parts[0].text, 'c')
}

export function testToolResultsAreTruncatedButKeepTheirShape() {
  const big = 'X'.repeat(5000)
  const p = body([turn('user', 'go'), { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: big } } }] }])
  const r = narrowContext(p, { keepTurns: 9, toolResultChars: 600 })
  assert.equal(r.truncated, 1)
  const fr = p.request.contents[1].parts[0].functionResponse
  assert.equal(fr.name, 'read_file', '工具名必须留住（丢了模型就不知道这是谁的回包）')
  assert.equal(fr.response.truncated, true)
  assert.ok(String(fr.response.head).length <= 600)
  // 不能截成空对象：那会让模型以为工具"没返回东西"，于是重试同一个工具
  assert.ok(Object.keys(fr.response).length > 0)
}

export function testSmallBodiesAreLeftAlone() {
  const p = body([turn('user', 'a'), turn('model', 'b')])
  const before = JSON.stringify(p)
  const r = narrowContext(p, { keepTurns: 2, toolResultChars: 600 })
  assert.equal(r.dropped, 0)
  assert.equal(r.truncated, 0)
  assert.equal(JSON.stringify(p), before, '本来就不用收窄时不得改动请求体')
}

export function testSystemInstructionIsNeverTouched() {
  // 收窄只管 contents：system 位是装甲/指令的地盘，动它等于拆自己的台
  const p = body([turn('user', 'a'), turn('model', 'b'), turn('user', 'c')], 'SYSTEM-ARMOR')
  narrowContext(p, { keepTurns: 1 })
  assert.equal(p.request.systemInstruction.parts[0].text, 'SYSTEM-ARMOR')
}

export function testStringToolPayloadIsHandled() {
  const p = body([{ role: 'user', parts: [{ functionResponse: { name: 't', response: 'Y'.repeat(900) } }] }])
  const r = narrowContext(p, { keepTurns: 5, toolResultChars: 100 })
  assert.equal(r.truncated, 1)
  assert.ok(String(p.request.contents[0].parts[0].functionResponse.response.head).length <= 100)
}

export function testMissingContentsIsSafe() {
  const r = narrowContext({ request: {} })
  assert.equal(r.dropped, 0)
  assert.equal(r.kept, 0)
}

export function testDefaultKeepTurnsIsTwo() {
  const p = body([turn('user', 'a'), turn('model', 'b'), turn('user', 'c'), turn('model', 'd'), turn('user', 'e')])
  narrowContext(p)
  assert.equal(p.request.contents.length, 3, '默认截到"最后 2 轮 + 补一轮 user"')
  assert.equal(p.request.contents[0].role, 'user', '默认行为也必须守住 user 开头这条硬约束')
  assert.ok(p.request.contents.length < 5, '默认就要真的丢掉历史')
}

// ——— 中性替代文案（用户直接看到的那句话）———

export function testFallbackTextExplainsWhatHappenedAndWhatToDo() {
  assert.match(BLOCK_FALLBACK_TEXT, /上游的内容过滤器/, '要说清是什么拦的')
  assert.match(BLOCK_FALLBACK_TEXT, /不是本机故障/, '要明确排除本机故障（这是用户最可能的误解）')
  assert.match(BLOCK_FALLBACK_TEXT, /已自动重试多档并收窄了上下文/, '要说清系统已经做过什么')
  assert.match(BLOCK_FALLBACK_TEXT, /开一个新会话/, '要给出最有效的一步')
  // 旧文案的毛病：读起来像来路不明的第三方在推卸责任
  assert.ok(!BLOCK_FALLBACK_TEXT.includes('本地上游网关'), '不得再出现"本地上游网关"这种来路不明的说法')
}

export function testFallbackTextItselfCarriesNoTriggerWords() {
  // 替代文案会作为 model 轮进入会话历史 —— 它自己带触发词就等于给下一发埋雷
  assert.deepEqual(scanHotWords(BLOCK_FALLBACK_TEXT), [], '中性替代不得含任何已知触发词')
}

// ——— v1.8.1：实测「收窄形同没做」的两个缺陷 ———
//
// 现场日志：`PASS-NARROW attempt=4 保留 233 轮（丢 220 轮）` ——
// 一次 agent 回合里工具回包全挂 role=user，"往前找到 user 轮"能走 230 条，
// 于是最后一档送出去的还是那个巨无霸请求体，照样被拦。

export function testHardCapBoundsKeptContentsEvenWhenUserTurnsAreSparse() {
  // 453 条、role=user 只在最前面出现一次 —— 旧实现会保留 232 条
  const contents = [turn('user', 'origin')]
  for (let i = 0; i < 452; i++) contents.push({ role: 'model', parts: [{ text: 'step ' + i }] })
  const p = body(contents)
  const r = narrowContext(p, { keepTurns: 2, maxContents: 40 })
  assert.ok(p.request.contents.length <= 40, '硬上限必须生效（实际 ' + p.request.contents.length + '）')
  assert.ok(r.dropped >= contents.length - 40 - 8, '真的丢掉了大头（丢 ' + r.dropped + '）')
  assert.equal(r.aborted, false)
}

export function testAbortsInsteadOfEmittingAnIllegalShape() {
  // 整段没有任何 role=user 的条目 → 无论怎么切都无法以 user 开头。
  // 此时收窄会送出一个上游必然 400 的形状 —— 宁可放弃收窄（保持原样再被拦一次）。
  const contents = []
  for (let i = 0; i < 60; i++) contents.push({ role: 'model', parts: [{ text: 'm' + i }] })
  const p = body(contents)
  const before = JSON.stringify(p)
  const r = narrowContext(p, { keepTurns: 2, maxContents: 10 })
  assert.equal(r.aborted, true, '必须放弃收窄')
  assert.equal(r.dropped, 0)
  assert.equal(JSON.stringify(p), before, '放弃时不得改动 contents（工具回包截断仍可生效）')
  assert.equal(r.startedWithUser, false, '要如实报告切不出合法形状')
}

export function testKeepTurnsCountsUserTurnsNotEntries() {
  // 「最后 2 轮」的语义是最后 2 个 user 轮，不是最后 2 条 —— 条 ≠ 轮
  const p = body([
    turn('user', 'old-1'), turn('model', 'a'),
    turn('user', 'old-2'), turn('model', 'b'), turn('model', 'b2'), turn('model', 'b3'),
    turn('user', 'newest'),
  ])
  const r = narrowContext(p, { keepTurns: 2, maxContents: 99 })
  assert.equal(r.dropped, 2, '停在倒数第二个 user 轮上')
  assert.equal(p.request.contents[0].parts[0].text, 'old-2')
  assert.equal(p.request.contents[p.request.contents.length - 1].parts[0].text, 'newest')
}

export function testRealisticAgentTurnGetsBoundedTail() {
  // 一次真实 agent 回合：user 提问 → 大量 model 思考/工具调用 + user 工具回包
  const contents = [turn('user', 'task')]
  for (let i = 0; i < 120; i++) {
    contents.push({ role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'f' + i } } }] })
    contents.push({ role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: 'C'.repeat(2000) } } }] })
  }
  const p = body(contents)
  const r = narrowContext(p, { keepTurns: 2, maxContents: 40, toolResultChars: 600 })
  assert.ok(p.request.contents.length <= 40, '尾部必须有界（实际 ' + p.request.contents.length + '）')
  assert.equal(p.request.contents[0].role, 'user', '仍以 user 开头')
  assert.ok(r.truncated > 0, '工具回包要被截断')
  assert.ok(r.dropped > 200, '大头真的被丢掉（丢 ' + r.dropped + '）')
}