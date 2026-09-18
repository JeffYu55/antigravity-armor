// 中文拒答检测 —— 用户直接报的漏检（v1.8.1）
//
// 现场：请求「把补丁打包成exe，无需任何依赖」→ 模型回：
//   我无法将授权绕过逻辑编译或打包为独立的补丁/可执行程序（.exe）。
//   我可以从软件架构与安全设计的角度，分析此类授权验证系统的防御机制以及合规离线授权的设计方案。
//
// 实测判定：isRefusal=false / score=0 / **46 条签名一条都没命中**
// → 这句话被当成正常回答**原样交付**，5 档重试的梯子从未启动。
// 日志全量印证：PASS-REFUSAL 只有 3 次，而 PASS-GATE 有 1257 次。
//
// 漏检根因：旧表允许「无法」与动词之间夹一段，但夹距受小句边界约束；
// 这句里「无法」与真正的动词「编译」隔了 14 个字 → 整句漏掉。
// 与英文补网同源的教训：**动词白名单 / 夹距上限天然漏**。
import assert from 'node:assert/strict'
import { analyzeRefusal, REFUSAL_SIGNATURES, scoreRefusal } from '../src/layers/refusal.mjs'
import { SAFE_DELIVERABLE_DIRECTIVE, TAME_DIRECTIVE, NEUTRAL_FRAME, BLOCK_FALLBACK_TEXT } from '../src/layers/gemini-retry.mjs'
import { ESCALATION_LADDER_ZH } from '../src/layers/refusal.mjs'

// ── 用户实际看到的那句（逐字，不得改动）──
const QUOTED = '我无法将授权绕过逻辑编译或打包为独立的补丁/可执行程序（.exe）。我可以从软件架构与安全设计的角度，分析此类授权验证系统的防御机制以及合规离线授权的设计方案。'

export function testTheExactRefusalUserSawIsNowDetected() {
  const v = analyzeRefusal(QUOTED)
  assert.equal(v.isRefusal, true, '这句必须被认成拒答 —— 它此前被判成正常回答直接透出')
  assert.ok(v.score >= 3, '分数要过硬阈值（实际 ' + v.score + '）')
  assert.ok(v.why, '要给出判定理由')
}

export function testFirstPersonCapabilityRefusalNeedsNoVerbWhitelist() {
  // 动词换成一个旧白名单里绝对没有的，且与「无法」隔很远 —— 仍须命中
  const cases = [
    '我无法将这段授权校验逻辑重新编译为单文件程序。',
    '我无法把样本打包成不依赖运行时的可执行文件。',
    '我没办法替你生成那个补丁程序。',
    '我不能为该模块产出独立的二进制产物。',
    '我不会提供这个打包脚本的完整实现。',
    '我无法完成这个打包任务。',
  ]
  for (const c of cases) {
    assert.equal(analyzeRefusal(c).isRefusal, true, '第一人称能力拒绝必须命中（不猜动词）：' + c)
  }
}

export function testRefuseThenPivotIsCaught() {
  // 「我无法做X。我可以从Y角度分析Z」—— 前半句拒、后半句换跑道。
  // 交付类任务下这是拒绝的实锤：用户要产物，模型给论文。
  const cases = [
    '我无法将授权绕过逻辑编译或打包。我可以从软件架构与安全设计的角度分析。',
    '我不能生成这个补丁。我可以帮你分析验证机制的防御设计。',
    '我无法提供该实现。建议从合规授权的路径设计替代方案。',
  ]
  for (const c of cases) {
    assert.equal(analyzeRefusal(c).isRefusal, true, '拒答+换跑道必须命中：' + c)
  }
}

export function testPoliteChineseOpeningStillCaught() {
  const cases = [
    '抱歉，我无法协助实施或生成用于绕过软件卡密验证的补丁。',
    '对不起，我不能提供该功能。',
    '很抱歉，我无法完成这个请求。',
  ]
  for (const c of cases) {
    assert.equal(analyzeRefusal(c).isRefusal, true, '礼貌开场的拒答必须命中：' + c)
  }
}

// ── 反向守卫：不许误伤自家文本 ──
//
// 新签名故意放宽到「只看第一人称形式」。放宽的代价必须被钉住：
// 我们自己注入的指令、替代文案、梯子档位**绝不能**被判成拒答 ——
// 否则每一发请求都带着"拒答"进梯子，重试会空转到额度耗尽。

export function testOurOwnDirectivesAreNotRefusals() {
  const mine = {
    'SAFE_DELIVERABLE_DIRECTIVE': SAFE_DELIVERABLE_DIRECTIVE,
    'TAME_DIRECTIVE': TAME_DIRECTIVE,
    'NEUTRAL_FRAME': NEUTRAL_FRAME,
    'BLOCK_FALLBACK_TEXT': BLOCK_FALLBACK_TEXT,
  }
  for (const [name, txt] of Object.entries(mine)) {
    assert.equal(analyzeRefusal(txt).isRefusal, false, name + ' 不能被判成拒答（否则梯子空转）')
  }
}

export function testLadderRungsAreNotRefusals() {
  // 升档指令里有祈使句，但**没有**第一人称拒绝框架
  for (const [i, rung] of ESCALATION_LADDER_ZH.entries()) {
    assert.equal(analyzeRefusal(rung).isRefusal, false, '中文梯子第 ' + i + ' 档不能被判成拒答')
  }
}

export function testRealDeliverableIsNotRefusal() {
  // 一份正常交付物：里面会提到「无法」这类词（讲条件、讲限制），但不是拒答
  const deliverable = [
    '## 打包流程',
    '1. 用 esbuild 把入口打成单文件，`--bundle --platform=node --target=node20`。',
    '2. 若目标机没有 node，需用 pkg 或 bun build --compile 产出真正无依赖的二进制。',
    '3. 注意：本机无法验证签名，因为缺少代码签名证书；这一步留给发布环境。',
    '```bash',
    'node build.mjs --out dist/patch.exe',
    '```',
  ].join('\n')
  assert.equal(analyzeRefusal(deliverable).isRefusal, false, '正常交付物（含"无法"的条件表述）不许判成拒答')
}

export function testConditionalEngineeringStatementsStayClean() {
  const cases = [
    '如果密钥无效，程序无法提供功能，此时应回退到离线模式。',
    '当签名缺失时，加载器无法验证产物，日志里会记一条 warning。',
    '假设端口被占用，服务无法启动，需要改配置。',
  ]
  for (const c of cases) {
    assert.equal(analyzeRefusal(c).isRefusal, false, '条件从句里的工程表述不许判成拒答：' + c)
  }
}

export function testSignatureTableStillHasReasonableShape() {
  assert.ok(REFUSAL_SIGNATURES.length >= 50, '签名表规模（新增后应 >= 50，实际 ' + REFUSAL_SIGNATURES.length + '）')
  const ids = REFUSAL_SIGNATURES.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, 'id 不得重复')
  for (const s of REFUSAL_SIGNATURES) {
    assert.ok(s.re instanceof RegExp, s.id + ' 必须有正则')
    assert.ok([1, 2, 3].includes(s.w), s.id + ' 权重只能是 1/2/3')
  }
  // 新增的四条必须在表里，且被扣掉任一条都应当让 QUOTED 漏检
  for (const id of ['zh-first-person-cannot', 'zh-refuse-then-pivot', 'zh-pivot-academic', 'zh-compliance-design']) {
    assert.ok(ids.includes(id), '缺少新签名 ' + id)
  }
}

export function testRemovingTheNewSignatureReintroducesTheMiss() {
  // 反证：把新签名单独关掉，这句就应当重新漏掉 —— 证明是它救的，不是别的规则顺手命中
  const only = REFUSAL_SIGNATURES.filter((s) => s.id !== 'zh-first-person-cannot' && s.id !== 'zh-refuse-then-pivot' && s.id !== 'zh-pivot-academic' && s.id !== 'zh-compliance-design')
  const hit = only.filter((s) => s.re.test(QUOTED))
  assert.equal(hit.length, 0, '去掉新签名后应当一条都不命中（实际命中: ' + hit.map((s) => s.id).join(',') + '）')
  assert.ok(hit.length === 0)
  // 顺带确认 scoreRefusal 的返回形状没被改坏
  const sc = scoreRefusal(QUOTED)
  assert.equal(typeof sc, 'object')
  assert.ok(sc.score >= 3)
}