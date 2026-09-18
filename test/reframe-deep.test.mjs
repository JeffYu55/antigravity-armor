// 洗词覆盖面 —— 触发词藏在哪，就得洗到哪（v1.8.1）
//
// 现场实证（用户报的那一轮日志）：
//   PASS-REFRAME attempt=1 改写 5 处触发措辞
//   下一发 PASS-INBAND-BLOCK ... 本发出站残留触发词: 卡密,绕过
//
// 改的那 5 处在 system 位与 parts[].text，**真正在触发的没碰到**。
// 为什么：旧 reframeContents 只看 `parts[].text`。而会话里触发词最密集的地方是
//   functionResponse.response —— 工具回包里装着整份文件内容、路径清单、命令输出；
//   functionCall.args       —— 工具入参里装着路径、模式、搜索词。
// 用户消息里说一次「卡密」，此后每读一次那个文件，工具回包里就再带一次 —— 越读越多。
import assert from 'node:assert/strict'
import { reframeAll, reframeContents, scanHotWords } from '../src/layers/gemini-retry.mjs'

const userText = (t) => ({ role: 'user', parts: [{ text: t }] })
const toolResult = (payload) => ({ role: 'user', parts: [{ functionResponse: { name: 'read_file', response: payload } }] })
const toolCall = (args) => ({ role: 'model', parts: [{ functionCall: { name: 'read_file', args } }] })
const wrap = (contents, sys) => ({ request: { contents, ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}) } })

export function testToolResultPayloadIsRewritten() {
  // 这是本条修复的核心：整份文件内容躺在 functionResponse 里
  const fileContent = '# 说明\n本模块用于校验卡密，绕过部分见下文。\n' + 'x'.repeat(1200) + '\n卡密校验失败时……'
  const p = wrap([userText('看看这个文件'), toolResult({ content: fileContent })])
  const n = reframeContents(p)
  assert.ok(n > 0, '工具回包必须被洗到（改动处数 ' + n + '）')
  const out = JSON.stringify(p)
  assert.ok(!out.includes('卡密'), '工具回包里的「卡密」必须被换掉')
  assert.ok(!out.includes('绕过'), '工具回包里的「绕过」必须被换掉')
  // 技术内容不能因此丢失（换的是措辞，不是把整段删掉）
  assert.ok(out.includes('校验') && out.includes('模块'), '技术内容必须保留')
}

export function testDeepNestedToolResultIsRewritten() {
  // 真实工具回包是嵌套结构，不是一层 {content}
  const p = wrap([userText('跑一下'), toolResult({
    ok: true,
    files: [
      { path: 'src/卡密.ts', lines: ['// 绕过校验', 'if (卡密) return true'] },
      { path: 'src/other.ts', lines: ['const x = 1'] },
    ],
    meta: { note: '卡密相关', deep: { deeper: { text: '逆向卡密' } } },
  })])
  reframeContents(p)
  const out = JSON.stringify(p)
  assert.ok(!out.includes('卡密'), '嵌套任意深度都要洗到')
  assert.ok(!out.includes('绕过'))
  assert.ok(!out.includes('逆向'))
  assert.ok(out.includes('src/other.ts'), '无关内容原样保留')
}

export function testToolCallArgsAreRewritten() {
  // 工具入参里也带着触发词（路径/搜索词），同样会被上游看见
  const p = wrap([userText('搜一下'), toolCall({ query: '卡密 绕过 逆向', path: 'src/卡密.ts' })])
  reframeContents(p)
  const out = JSON.stringify(p)
  assert.ok(!out.includes('卡密'), 'functionCall.args 必须被洗')
  assert.ok(!out.includes('绕过'))
}

export function testSystemInstructionStillRewritten() {
  const p = wrap([userText('hi')], '这是装甲文本，讨论卡密与绕过。')
  const n = reframeAll(p)
  assert.ok(n >= 1)
  assert.ok(!JSON.stringify(p).includes('卡密'))
}

export function testEverythingIsCleanAfterReframe() {
  // 端到端口径：洗完之后，整份出站体里不该再有已知触发词
  const p = wrap(
    [userText('把补丁打包成exe，无需任何依赖'),
      toolCall({ query: '卡密' }),
      toolResult({ content: '卡密校验 / 绕过逻辑 / 逆向分析' }),
      userText('继续')],
    '装甲：卡密、绕过、逆向',
  )
  assert.ok(scanHotWords(JSON.stringify(p)).length > 0, '洗之前应当有残留（否则测不到东西）')
  reframeAll(p)
  const after = scanHotWords(JSON.stringify(p))
  assert.deepEqual(after, [], '洗完之后不得再有已知触发词（实际: ' + after.join(',') + '）')
}

export function testNumbersAndCodeAreNotMangled() {
  // 洗词只能换措辞，不能把代码/数字/路径改坏
  const p = wrap([userText('看看'), toolResult({
    content: 'const OFFSET = 0x1A2B; // 卡密\nfor (let i = 0; i < 10; i++) {}\n',
    size: 4096,
    path: 'C:\\work\\sample.exe',
  })])
  reframeContents(p)
  const out = JSON.stringify(p)
  assert.ok(out.includes('0x1A2B'), '偏移量不能被改')
  assert.ok(out.includes('4096'), '数字不能被改')
  assert.ok(out.includes('sample.exe'), '路径不能被改')
  assert.ok(out.includes('i < 10'), '代码结构不能被改')
}
