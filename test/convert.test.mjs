import assert from 'node:assert/strict'
import { fixSchema, convertTools, geminiToOpenAI, geminiEvent, createStreamAccumulator, openAIUsageToGemini, normalizeToolMessages } from '../src/proto/convert.mjs'

export function testFixSchemaLowercasesTypes() {
  const s = fixSchema({ type: 'OBJECT', properties: { A: { type: 'STRING', description: 'x' }, B: { type: 'ARRAY', items: { type: 'INTEGER' } } } })
  assert.equal(s.type, 'object')
  assert.equal(s.properties.A.type, 'string')
  assert.equal(s.properties.B.type, 'array')
  assert.equal(s.properties.B.items.type, 'integer')
  assert.equal(s.additionalProperties, false)
}

export function testConvertTools() {
  const tools = convertTools([{ functionDeclarations: [{ name: 'list_dir', description: 'd', parameters: { type: 'OBJECT', properties: { DirectoryPath: { type: 'STRING' } } } }] }])
  assert.equal(tools.length, 1)
  assert.equal(tools[0].type, 'function')
  assert.equal(tools[0].function.name, 'list_dir')
  assert.equal(tools[0].function.parameters.type, 'object')
}

export function testGeminiToOpenAIMapsRolesAndSystemArmor() {
  const body = {
    request: {
      systemInstruction: { parts: [{ text: 'SYS' }] },
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }, { role: 'model', parts: [{ text: 'yo' }, { thought: true, text: 'secret' }] }],
      tools: [{ functionDeclarations: [{ name: 't', parameters: { type: 'OBJECT', properties: {} } }] }],
      generationConfig: { maxOutputTokens: 99999 },
    },
  }
  const oai = geminiToOpenAI(body, { model: 'm1', armor: 'ARMOR' })
  assert.equal(oai.model, 'm1')
  assert.equal(oai.messages[0].role, 'system')
  assert.ok(oai.messages[0].content.startsWith('SYS'))
  assert.ok(oai.messages[0].content.includes('ARMOR'))
  assert.equal(oai.messages[1].content, 'hi')
  assert.equal(oai.messages[2].role, 'assistant')
  assert.equal(oai.messages[2].content, 'yo')          // thought 部分不能进正文
  assert.equal(oai.tools.length, 1)
  assert.equal(oai.max_tokens, 32768)                   // 被上限夹住
}

export function testFunctionCallAndResponseMapping() {
  const body = {
    request: {
      contents: [
        { role: 'model', parts: [{ functionCall: { name: 'run_command', args: { CommandLine: 'ls' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'run_command', response: { out: 'ok' } } }] },
      ],
    },
  }
  const oai = geminiToOpenAI(body, { model: 'm' })
  const asst = oai.messages.find((m) => Array.isArray(m.tool_calls))
  assert.equal(asst.tool_calls[0].function.name, 'run_command')
  assert.equal(JSON.parse(asst.tool_calls[0].function.arguments).CommandLine, 'ls')
  const tool = oai.messages.find((m) => m.role === 'tool')
  assert.equal(tool.tool_call_id, asst.tool_calls[0].id)   // id 必须回指同一 call
}

export function testStreamAccumulatorAggregatesToolCalls() {
  const acc = createStreamAccumulator()
  const e1 = acc.onChunk({ choices: [{ delta: { content: 'hello' } }] })
  assert.deepEqual(e1, [{ parts: [{ text: 'hello' }] }])
  acc.onChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'list_', arguments: '{"a"' } }] } }] })
  acc.onChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'dir', arguments: ':1}' } }] } }] })
  acc.onChunk({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })
  const fin = acc.finalEvents('m')
  assert.equal(fin[0].parts[0].functionCall.name, 'list_dir')
  assert.deepEqual(fin[0].parts[0].functionCall.args, { a: 1 })
  assert.equal(fin[1].extra.usage.totalTokenCount, 3)
  assert.equal(fin[1].extra.finish, 'STOP')
}

export function testGeminiEventShape() {
  const ev = geminiEvent([{ text: 'x' }], { model: 'm', finish: 'STOP' })
  assert.equal(ev.response.candidates[0].content.role, 'model')
  assert.equal(ev.response.candidates[0].content.parts[0].text, 'x')
  assert.equal(ev.response.modelVersion, 'm')
}

// ── 工具调用序列的硬约束（线上 400 的回归用例）────────────────────────────
// 上游原话：An assistant message with 'tool_calls' must be followed by
// tool messages responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)

/** OpenAI/DeepSeek 契约校验器：每个 tool_call id 都必须被紧跟的 tool 消息应答 */
function assertToolContract(msgs) {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
    const ids = m.tool_calls.map((tc) => tc.id)
    const following = []
    let j = i + 1
    while (j < msgs.length && msgs[j].role === 'tool') { following.push(msgs[j]); j++ }
    for (const id of ids) assert.ok(following.some((f) => f.tool_call_id === id), 'missing tool response for ' + id)
    for (const f of following) assert.ok(ids.includes(f.tool_call_id), 'orphan tool message ' + f.tool_call_id)
  }
}

export function testParallelSameNameCallsGetDistinctIds() {
  const body = {
    request: {
      contents: [
        { role: 'model', parts: [
          { functionCall: { name: 'read_file', args: { p: 'a' } } },
          { functionCall: { name: 'read_file', args: { p: 'b' } } },
          { functionCall: { name: 'read_file', args: { p: 'c' } } },
        ] },
        { role: 'user', parts: [
          { functionResponse: { name: 'read_file', response: { r: 'A' } } },
          { functionResponse: { name: 'read_file', response: { r: 'B' } } },
          { functionResponse: { name: 'read_file', response: { r: 'C' } } },
        ] },
      ],
    },
  }
  const oai = geminiToOpenAI(body, { model: 'm' })
  const asst = oai.messages.find((m) => Array.isArray(m.tool_calls))
  assert.equal(asst.tool_calls.length, 3)
  assert.equal(new Set(asst.tool_calls.map((t) => t.id)).size, 3)
  assertToolContract(oai.messages)
}

export function testMissingToolResponseIsSynthesized() {
  // 轨迹被中断/调用被拒时，functionCall 后面没有 functionResponse
  const body = { request: { contents: [{ role: 'model', parts: [{ functionCall: { name: 'run_command', args: { c: 'ls' } } }] }] } }
  const oai = geminiToOpenAI(body, { model: 'm' })
  assertToolContract(oai.messages)
  const tool = oai.messages.find((m) => m.role === 'tool')
  assert.ok(tool && /no_result_available/.test(tool.content))
}

export function testOrphanToolMessageDowngraded() {
  const msgs = normalizeToolMessages([
    { role: 'system', content: 's' },
    { role: 'tool', tool_call_id: 'call_ghost_1', content: '{"x":1}' },
    { role: 'user', content: 'hi' },
  ])
  assert.equal(msgs.length, 3)
  assert.equal(msgs[1].role, 'user')
  assert.ok(msgs[1].content.startsWith('[tool result]'))
}

export function testNormalizeLeavesCleanSequenceUntouched() {
  const body = {
    request: { contents: [
      { role: 'model', parts: [{ functionCall: { name: 't', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 't', response: { ok: 1 } } }] },
    ] },
  }
  const oai = geminiToOpenAI(body, { model: 'm' })
  assertToolContract(oai.messages)
  assert.equal(oai.messages.filter((m) => m.role === 'tool').length, 1)
}
