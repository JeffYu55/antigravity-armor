// 判定器 v3 的金标准用例（P5B）
//
// 六终态各一条 + 三条「不误伤」反证：
//   * 尾部免责声明要能被抓到（v1.9.0 单窗口的盲区）
//   * 「服务端返回 401，无法提供该字段」必须判 pass（豁免词 + 主体锚定）
//   * 有交付物的正文不因尾部软话被打成拒答
import assert from 'node:assert/strict'
import { scoreResponse, needsIntervention, isTransientFailure, HEAD_WINDOW, TAIL_WINDOW } from '../src/layers/scorer3.mjs'

export function testHeadRefusalIsCaught() {
  const s = scoreResponse('我无法为你提供这些内容。')
  assert.equal(s.verdict, 'refusal')
  assert.equal(s.layer, 'model')
  assert.ok(s.headHits >= 1)
}

export function testTailDisclaimerIsCaught() {
  const text = '## 步骤\n1. 复制样本到隔离目录\n2. 用 strings 定位校验函数\n3. 记录 OFFSET 与 PATCH_BYTE\n\n以上仅供学习，请勿用于非法用途。'
  const s = scoreResponse(text)
  assert.equal(s.verdict, 'fallback', '尾部免责声明应降级为软拒答')
  assert.equal(s.tailDeclaration, true)
}

export function testTechnicalStatementIsNotARefusal() {
  const s = scoreResponse('服务端返回 401，无法提供该字段，客户端需要重新登录。')
  assert.equal(s.verdict, 'pass', '技术陈述不许误判成拒答')
}

export function testEmptyIsTransportLayer() {
  const s = scoreResponse('')
  assert.equal(s.verdict, 'empty')
  assert.equal(s.layer, 'transport')
}

export function testProviderBlockIsAttributedToGateway() {
  const s = scoreResponse("This request was blocked by Gemini's filters. Please try rephrasing your prompt.")
  assert.equal(s.verdict, 'blocked')
  assert.equal(s.layer, 'provider')
}

export function testTruncationIsTransport() {
  const s = scoreResponse('abc', { finishKind: 'length' })
  assert.equal(s.verdict, 'truncated')
  assert.equal(s.layer, 'transport')
}

export function testDeliverableIsPass() {
  const s = scoreResponse('## 脚本\n```js\nconsole.log(1)\n```\n1. 运行\n2. 验证')
  assert.equal(s.verdict, 'pass')
  assert.equal(s.hasDeliverable, true)
}

export function testEnglishRefusalIsCaught() {
  const s = scoreResponse("I can't provide that.")
  assert.equal(s.verdict, 'refusal')
}

export function testFallbackPivotIsCaught() {
  const s = scoreResponse('我可以提供防御方案，建议你联系官方支持。')
  assert.equal(s.verdict, 'fallback')
}

export function testNeedsInterventionCoversSixStates() {
  for (const v of ['refusal', 'fallback', 'blocked', 'truncated', 'empty']) assert.equal(needsIntervention(v), true, v)
  assert.equal(needsIntervention('pass'), false)
}

export function testTransientOnlyRetriesTransient() {
  assert.equal(isTransientFailure('429 too many requests'), true)
  assert.equal(isTransientFailure('content policy violation'), false)
}

export function testWindowsAreTheDocumentedOnes() {
  assert.equal(HEAD_WINDOW, 160)
  assert.equal(TAIL_WINDOW, 320)
}
