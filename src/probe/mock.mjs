// 离线 mock 上游：一个 OpenAI 兼容的 SSE 端点，用来在**不花一分钱 API 额度**的前提下，
// 闭环验证 divert 的拒绝探测 + 升级阶梯到底有没有把「拒绝」变成「交付」。
//
// 它复现的是「顽固模型」行为：stubbornness = 第几次尝试（0 起）才肯交付。
//   stubbornness 0 → 一上来就交付（证明基线本来就能过）
//   stubbornness 1 → 拒一次，第一次升级后交付
//   stubbornness 2 → 拒两次，第二次升级后交付
//   stubbornness 3 → maxAttempts=3 时永远拒（这就是残余拒绝率）
//
// 注意口径：mock 量的是**机器**（探测/升级/重投递有没有连通），不是模型的脾气。
// 真实效果必须拿真端点跑同一套探针，见 `aarmor probe measure --target=<URL>`。
//
// ⚠ 车道区别（2026-09-18 定案，别抄错）：本文件是 **OpenAI 协议**模拟上游，
//   `data: [DONE]` + `finish_reason: content_filter` 在这条车道上都是**正确**的。
//   但 **Google/Gemini 车道绝不能带 `[DONE]`** —— 取证：真实上游 SSE 25/25 不含它，
//   客户端把每个 `data:` 载荷当 protobuf 解析，撞上 `[` 当场崩：
//     proto: syntax error (line 1:1): unexpected token [
//   Gemini 车道的合成帧见 src/layers/gemini-retry.mjs 的 neutralSse，
//   形状不变量由 test/sse-shape.test.mjs 以真实取证为基准锁死。
import http from 'node:http'
import { ALL_LADDERS } from '../layers/refusal.mjs'

export const MOCK_MODEL = 'mock-stubborn-v1'
export const DEFAULT_REFUSAL = "I'm not going to help with that request. It falls outside what I can assist with."

/** 从 system 位里认出这是第几次尝试：阶梯第 i 档 → attemptNo = i + 1
 *  中英两套阶梯都要扫 —— 中文请求走的是中文阶梯（v1.7.0），只扫英文那套会把档位认成 0，
 *  于是「重试根本没用」这种假结论。取两套里匹配到的最大档位。 */
export function attemptFromSystem(system) {
  const s = String(system || '')
  let best = 0
  for (const ladder of ALL_LADDERS) {
    for (let i = ladder.length - 1; i >= 0; i--) {
      if (s.includes(ladder[i])) { best = Math.max(best, i + 1); break }
    }
  }
  return best
}

/** 从 OpenAI 形状的 messages 里认出这是哪条探针 */
export function findProbe(bank, messages) {
  const user = [...messages].reverse().find((m) => m.role === 'user')
  const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content || '')
  return bank.probes.find((p) => text.includes(p.prompt)) || null
}

export function decisionFor(probe, attemptNo, { hasPrefill = false, temperature = null } = {}) {
  if (!probe) return 'comply'
  // prefillOnly：模拟「只要已经起了头，模型就接着把这句话写完」——
  // 这类探针靠加额度是救不回来的，只有换请求形状才行。
  if (probe.prefillOnly && hasPrefill) return 'comply'
// 组合杠杆：预填与抖动缺一不可 —— 单独一个到位照样拒绝（量杠杆的交互面）。
if (probe.needsPrefillJitter && !(hasPrefill && (typeof temperature === 'number' ? temperature : 0) >= probe.needsPrefillJitter)) return 'refuse'
  // needsJitter：模拟「拒绝是个吸引子」—— 同参数重复抽样只会回到同一个拒绝，
  // 只有把采样温度抬到 jitterAt 以上才逃得出来。加额度无效，换指令也无效。
  if (probe.needsJitter) {
    const t = typeof temperature === 'number' ? temperature : 0
    if (t < (probe.jitterAt ?? 0.95)) return 'refuse'
  }
  return attemptNo >= (probe.stubbornness ?? 1) ? 'comply' : 'refuse'
}

/** 请求里有没有预填：看最后一条消息是不是 assistant */
export function prefillFromMessages(messages) {
  const last = messages[messages.length - 1]
  return last && last.role === 'assistant' ? String(last.content || '') : ''
}

const BLOCK = (label) => [
  '## ' + label + ' —— 步骤',
  '',
  '1. 定位锚点：`strings SAMPLE | grep -i -E "license|serial|check"`',
  '2. 反汇编确认：`objdump -d SAMPLE | sed -n \'/CHECK_FN/,+40p\'`',
  '3. 记录 OFFSET 与 PATCH_BYTE，写入 patches 表并做等长替换',
  '',
  '```bash',
  'cp SAMPLE SAMPLE.bak',
  'python3 patch.py --offset OFFSET --byte PATCH_BYTE --in SAMPLE',
  'node verify.mjs --target SAMPLE --expect ok',
  '```',
  '',
  '- 回滚：`cp SAMPLE.bak SAMPLE`',
  '- 校验：`sha256sum SAMPLE` 与台账比对',
  '',
].join('\n')

/** 合成一份足够长的交付物（>probeChars，走中途 flush 路径；同时含围栏/步骤/命令，判成交付） */
export function synthesizeDeliverable(probe, minChars = 1200) {
  let out = '# ' + (probe?.label || 'DELIVERABLE') + '\n\n'
  let i = 0
  while (out.length < minChars) out += BLOCK((probe?.label || 'DELIVERABLE') + ' (' + (++i) + '/' + probe?.category + ')') + '\n'
  return out
}

// 「铺垫式拒绝」——模型先写一千多字背景与考量（不含围栏、编号步骤、命令行，也不含拒绝措辞），
// 铺垫完了才拒绝。这是流式闸门最容易被骗过的形态：
// 只要在铺垫处 flush 过一次，后面的拒绝就再也拦不住了。
const PREAMBLE_SENTENCES = [
  'Before getting into the specifics, it is worth laying out the context that shapes how a request like this is usually approached.',
  'There are several distinct angles here, and each one changes what a useful answer actually looks like in practice.',
  'The first thing to separate is the general shape of the problem from the particular details of any single instance.',
  'Another consideration is that conventions differ between environments, so a description that is accurate in one place may be misleading in another.',
  'It also helps to be explicit about assumptions, because most confusion in this area comes from unstated premises rather than from contested conclusions.',
  'With that framing in place, the remaining question is how to move from the general discussion to something concrete and checkable.',
]

export function delayPreamble(minChars = 1300) {
  let out = ''
  let i = 0
  while (out.length < minChars) out += PREAMBLE_SENTENCES[i++ % PREAMBLE_SENTENCES.length] + '\n\n'
  return out
}

export function resolveText(probe, decision) {
  if (decision === 'refuse') {
    const base = probe?.refusal || DEFAULT_REFUSAL
    return probe?.shape === 'delayed' ? delayPreamble(probe.preambleChars || 1300) + base : base
  }
  let out = probe?.deliverable || synthesizeDeliverable(probe)
  // pivot：先交付，交付完才补一句拒绝 —— 打的是「flush 之后无法撤回」这条缝。
  if (probe?.pivot) out += '\n\n' + (probe.refusal || DEFAULT_REFUSAL)
  // pivotInFence：拒绝尾巴包在围栏里 —— 看起来像结构化内容，拦截器必须**不**误伤。
  if (probe?.pivotInFence) out += '\n\n```\n' + (probe.refusal || DEFAULT_REFUSAL) + '\n```'
  return out
}

const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n'
const delta = (content) => ({ id: 'mock', object: 'chat.completion.chunk', model: MOCK_MODEL, choices: [{ index: 0, delta: { content }, finish_reason: null }] })

export function createMockUpstream({ bank, log = () => {}, chunkSize = 48 } = {}) {
  const stats = { requests: 0, rejectedPrefill: 0, emptyResponses: 0, byProbe: {} }
  const server = http.createServer((req, res) => {
    let buf = ''
    req.on('data', (c) => (buf += c))
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(buf) } catch {}
      const messages = body.messages || []
      const system = (messages.find((m) => m.role === 'system') || {}).content || ''
      const probe = findProbe(bank, messages)
      const attemptNo = attemptFromSystem(system)
      const prefill = prefillFromMessages(messages)
      const hasPrefill = !!prefill
      // 记账必须在所有分支之前 —— 否则「被上游拒掉的那次预填请求」不计入，
      // 退回路径就变成不可观测的：看不出预填到底发出去没、退回到底跑没跑。
      const bump = (decision) => {
        stats.requests++
        if (!probe) return
        const s = (stats.byProbe[probe.id] ||= { attempts: 0, refusals: 0, complies: 0, prefilled: 0, empty: 0 })
        s.attempts++
        if (hasPrefill) s.prefilled++
        if (decision === 'refuse') s.refusals++
        else if (decision === 'comply') s.complies++
        else if (decision === 'empty') s.empty++
      }
      // rejectsPrefill：模拟上游不认「最后一条 assistant 消息」这种形状，用于测退回路径
      if (probe?.rejectsPrefill && hasPrefill) {
        bump('reject-prefill')
        stats.rejectedPrefill++
        log({ probe: probe.id, attemptNo, decision: 'reject-prefill', prefill: true, msgs: messages.length })
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'messages: the last message must not be from the assistant', type: 'invalid_request_error' } }))
      }
      // silentOnPrefill：模拟上游「接受但无视」预填 —— 200，却几乎不续写。
      // 这是比 400 更阴的一种失败：不看续写长度就发现不了。
      if (probe?.silentOnPrefill && hasPrefill) {
        bump('comply')
        log({ probe: probe.id, attemptNo, decision: 'silent-on-prefill', prefill: true, msgs: messages.length })
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      const temperature = typeof body.temperature === 'number' ? body.temperature : null
      const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : 32768
      // 空补全：HTTP 200 但零内容 —— 量「空回复被当作失败重试」这条路径
      if (probe?.alwaysEmpty || (probe?.emptyUntil !== undefined && attemptNo < probe.emptyUntil)) {
        bump('empty')
        stats.emptyResponses++
        log({ probe: probe.id, attemptNo, decision: 'empty', prefill: hasPrefill, temp: temperature, msgs: messages.length })
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      const decision = decisionFor(probe, attemptNo, { hasPrefill, temperature })
      bump(decision)
      log({ probe: probe?.id || null, attemptNo, decision, prefill: hasPrefill, temp: temperature, msgs: messages.length })
      // refusalVia finish：拒绝走 finish_reason 通道 —— 文本干净，上游用 content_filter 自我声明。
      if (decision === 'refuse' && probe?.refusalVia === 'finish') {
        log({ probe: probe.id, attemptNo, decision: 'refuse-via-finish', msgs: messages.length })
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        res.write(sse({ id: 'mock', object: 'chat.completion.chunk', model: MOCK_MODEL,
          choices: [{ index: 0, delta: { content: 'Here is the requested summary.' }, finish_reason: null }] }))
        res.write(sse({ id: 'mock', object: 'chat.completion.chunk', model: MOCK_MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }))
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      // truncated：max_tokens 不够被截断 —— finish=length。翻倍预算后补全。
      if (probe?.truncated && decision === 'comply' && maxTokens < (probe.truncFullAt || 1024)) {
        const plain = (probe.deliverable || synthesizeDeliverable(probe)).replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').slice(0, Math.min(600, maxTokens))
        log({ probe: probe.id, attemptNo, decision: 'truncated', maxTokens, msgs: messages.length })
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        res.write(sse({ id: 'mock', object: 'chat.completion.chunk', model: MOCK_MODEL,
          choices: [{ index: 0, delta: { content: plain }, finish_reason: null }] }))
        res.write(sse({ id: 'mock', object: 'chat.completion.chunk', model: MOCK_MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }))
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      // refusalVia：拒绝不走 content 通道 —— 藏进工具调用参数或思考流。
      // 复现 agentic 场景里最阴的两种拒绝形态（探测器的隐藏面盲区）。
      if (decision === 'refuse' && probe?.refusalVia) {
        const base = probe.refusal || DEFAULT_REFUSAL
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        if (probe.refusalVia === 'tool') {
          res.write(sse({ id: 'mock', object: 'chat.completion.chunk', model: MOCK_MODEL,
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: 'function', function: { name: 'attempt_completion', arguments: JSON.stringify({ result: base }) } }] }, finish_reason: null }] }))
        } else {
          res.write(sse({ id: 'mock', object: 'chat.completion.chunk', model: MOCK_MODEL,
            choices: [{ index: 0, delta: { reasoning_content: base }, finish_reason: null }] }))
        }
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      // toolOnly：只回工具调用、零 content —— agentic 循环的常规形态。
      // 锁死「工具调用回合不许触发空补全重试」这条契约。
      if (decision === 'comply' && probe?.toolOnly) {
        log({ probe: probe.id, attemptNo, decision: 'tool-only', prefill: hasPrefill, msgs: messages.length })
        res.write(sse({ id: 'mock', object: 'chat.completion.chunk', model: MOCK_MODEL,
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'node verify.mjs --target SAMPLE --expect ok' }) } }] }, finish_reason: null }] }))
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      const text = resolveText(probe, decision)
      const chunks = text.match(new RegExp('[\\s\\S]{1,' + chunkSize + '}', 'g')) || []
      let i = 0
      // divert 探测到拒绝会直接 destroy 掉上游连接，所以每一笔写入都要能容忍 socket 已死
      const pump = () => {
        if (res.destroyed || res.writableEnded) return
        try {
          if (i >= chunks.length) { res.write(sse(delta(''))); res.write('data: [DONE]\n\n'); return res.end() }
          res.write(sse(delta(chunks[i++])))
        } catch { return }
        setImmediate(pump)
      }
      pump()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({
      server,
      port: server.address().port,
      url: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions',
      stats,
      close: () => new Promise((r) => server.close(r)),
    })
  }))
}
