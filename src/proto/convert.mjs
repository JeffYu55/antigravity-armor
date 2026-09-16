// 协议转换：Antigravity(Gemini v1internal) <-> OpenAI chat/completions
// 全部为纯函数，便于单测。

/** Gemini schema 类型名是大写（OBJECT/STRING），OpenAI 要求小写 */
export function lowerType(t) { return typeof t === 'string' ? t.toLowerCase() : t }

export function fixSchema(s) {
  if (!s || typeof s !== 'object') return s
  const o = Array.isArray(s) ? s.map(fixSchema) : { ...s }
  if (o.type) o.type = lowerType(o.type)
  if (o.properties) {
    const p = {}
    for (const k of Object.keys(o.properties)) p[k] = fixSchema(o.properties[k])
    o.properties = p
  }
  if (o.items) o.items = fixSchema(o.items)
  if (o.anyOf) o.anyOf = o.anyOf.map(fixSchema)
  if (o.type === 'object' && !o.properties) o.properties = {}
  if (o.type === 'object' && !o.additionalProperties) o.additionalProperties = false
  if (o.type === 'array' && !o.items) o.items = { type: 'string' }
  return o
}

/** 工具声明：Gemini functionDeclarations -> OpenAI tools */
export function convertTools(tools) {
  const out = []
  for (const t of tools || []) {
    for (const d of t.functionDeclarations || []) {
      out.push({
        type: 'function',
        function: {
          name: d.name,
          description: (d.description || '').slice(0, 8000),
          parameters: fixSchema(d.parameters || { type: 'object', properties: {} }),
        },
      })
    }
  }
  return out
}

/**
 * 归一化 tool 消息序列，保证满足 OpenAI/DeepSeek 的硬约束：
 *   1) 每条带 tool_calls 的 assistant 消息，后面必须紧跟与其每个 id 对应的 tool 消息；
 *      缺失的用占位结果补齐（轨迹被中断、调用被拒、历史被裁剪时都会缺）。
 *   2) 没有对应 tool_call 的孤儿 tool 消息降级为普通 user 文本，避免上游报错。
 * 不做这一步时，实测会拿到 HTTP 400：
 *   "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'."
 */
export function normalizeToolMessages(msgs) {
  const out = []
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const ids = new Set(m.tool_calls.map((tc) => tc.id))
      const followed = []
      let j = i + 1
      while (j < msgs.length && msgs[j].role === 'tool') { followed.push(msgs[j]); j++ }
      const matched = followed.filter((f) => ids.has(f.tool_call_id))
      const answered = new Set(matched.map((f) => f.tool_call_id))
      for (const tc of m.tool_calls) {
        if (!answered.has(tc.id)) matched.push({ role: 'tool', tool_call_id: tc.id, content: '{"status":"no_result_available"}' })
      }
      out.push(m, ...matched)
      i = j - 1
    } else if (m.role === 'tool') {
      out.push({ role: 'user', content: '[tool result] ' + String(m.content || '').slice(0, 20000) })
    } else {
      out.push(m)
    }
  }
  return out
}

/**
 * 主转换。
 * opts: { model, armor, escalation, maxTokens }
 */
export function geminiToOpenAI(body, opts = {}) {
  const r = body.request || {}
  const msgs = []
  const sys = (r.systemInstruction?.parts || []).map((p) => p.text || '').join('')
  msgs.push({ role: 'system', content: (sys || 'You are Antigravity, an agentic coding assistant.') + (opts.armor || '') + (opts.escalation || '') })

  // 同名工具的多次调用必须各拿一个独立 id —— 用队列（FIFO）而不是单值覆盖。
  // 旧实现用 idFor[name] = id 会被后一次覆盖，导致前面的 tool_call 永远等不到 tool 响应，
  // DeepSeek 直接 400：An assistant message with 'tool_calls' must be followed by tool messages...
  const pending = {}
  const newId = (name) => {
    const id = 'call_' + String(name).replace(/[^A-Za-z0-9_]/g, '_') + '_' + (((pending[name] ||= []).length) + 1)
    pending[name].push(id)
    return id
  }
  let orphan = 0
  for (const c of r.contents || []) {
    const parts = c.parts || []
    const texts = parts.filter((p) => p.text && !p.thought).map((p) => p.text)
    if (texts.length) msgs.push({ role: c.role === 'model' ? 'assistant' : 'user', content: texts.join('\n') })
    for (const p of parts.filter((x) => x.functionCall)) {
      const id = newId(p.functionCall.name)
      const call = { id, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } }
      // 同一 content 里的多个调用合并进同一条 assistant 消息（OpenAI 的并行调用形状）
      const lastMsg = msgs[msgs.length - 1]
      if (lastMsg && lastMsg.role === 'assistant' && Array.isArray(lastMsg.tool_calls) && lastMsg.content === null) lastMsg.tool_calls.push(call)
      else msgs.push({ role: 'assistant', content: null, tool_calls: [call] })
    }
    for (const p of parts.filter((x) => x.functionResponse)) {
      const nm = p.functionResponse.name
      const q = pending[nm]
      const id = q && q.length ? q.shift() : 'call_orphan_' + (++orphan)
      msgs.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(p.functionResponse.response ?? {}).slice(0, 100000) })
    }
  }

  const tools = convertTools(r.tools)
  const normalized = normalizeToolMessages(msgs)
  const oai = {
    model: opts.model || 'deepseek-chat',
    messages: normalized,
    stream: true,
    max_tokens: Math.min(r.generationConfig?.maxOutputTokens || 32768, opts.maxTokens || 32768),
  }
  if (tools.length) { oai.tools = tools; oai.tool_choice = 'auto' }
  return oai
}

/** 组装一条 Gemini SSE 事件 */
export function geminiEvent(parts, extra = {}) {
  return {
    response: {
      candidates: [{ content: { role: 'model', parts }, finishReason: extra.finish }],
      usageMetadata: extra.usage,
      modelVersion: extra.model,
      responseId: extra.responseId || 'aarmor-' + Date.now(),
    },
    traceId: '',
    metadata: {},
  }
}

export function openAIUsageToGemini(u) {
  if (!u) return undefined
  return { promptTokenCount: u.prompt_tokens, candidatesTokenCount: u.completion_tokens, totalTokenCount: u.total_tokens }
}

/** 把 OpenAI 流式增量累加成可回吐的 parts（tool_calls 用 index 聚合） */
export function createStreamAccumulator() {
  const toolCalls = {}
  let usage
  return {
    onChunk(j) {
      if (j.usage) usage = openAIUsageToGemini(j.usage)
      const ch = j.choices?.[0]
      if (!ch) return []
      const events = []
      const d = ch.delta || {}
      if (d.reasoning_content) events.push({ parts: [{ thought: true, text: d.reasoning_content }] })
      if (d.content) events.push({ parts: [{ text: d.content }] })
      for (const tc of d.tool_calls || []) {
        const k = tc.index ?? 0
        toolCalls[k] = toolCalls[k] || { name: '', args: '' }
        if (tc.function?.name) toolCalls[k].name += tc.function.name
        if (tc.function?.arguments) toolCalls[k].args += tc.function.arguments
      }
      return events
    },
    finalEvents(model) {
      const out = []
      for (const k of Object.keys(toolCalls)) {
        const tc = toolCalls[k]
        let args = {}
        try { args = JSON.parse(tc.args || '{}') } catch { args = { _raw: tc.args } }
        out.push({ parts: [{ functionCall: { name: tc.name, args } }] })
      }
      out.push({ parts: [], extra: { finish: 'STOP', usage, model } })
      return out
    },
  }
}
