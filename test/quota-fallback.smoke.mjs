// 冒烟：上游 429 时，passThrough 车道应回 200 + 真实 SSE 形状的额度说明（而非透传 429），
// 且 60s 熔断窗口内的后续请求不再打上游。
import http from 'node:http'
import assert from 'node:assert'
import { handleSmartPassthrough, inQuotaCooldown, QUOTA_FALLBACK_TEXT } from '../src/layers/gemini-retry.mjs'

let upstreamHits = 0
const upstream = http.createServer((req, res) => {
  upstreamHits++
  res.writeHead(429, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }))
})
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
const port = upstream.address().port

const cfg = { divert: { upstream: `http://127.0.0.1:${port}`, maxAttempts: 3 } }
const body = Buffer.from(JSON.stringify({ request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } }))

function clientRequest() {
  return new Promise((resolve, reject) => {
    const req = { url: '/v1internal:streamGenerateContent?alt=sse' }
    const chunks = []
    const res = {
      headersSent: false, destroyed: false, writableEnded: false,
      writeHead(code, headers) { this.code = code; this.headers = headers; this.headersSent = true },
      write(c) { chunks.push(c) },
      end(c) { if (c) chunks.push(c); this.writableEnded = true; resolve({ code: this.code, out: chunks.join('') }) },
    }
    handleSmartPassthrough({ req, res, body, headers: {}, cfg, armorText: '', log: () => {} }).catch(reject)
  })
}

const r1 = await clientRequest()
assert.strictEqual(r1.code, 200, '首响应应为 200（不是透传 429）')
assert.ok(r1.out.includes('data: {'), '应输出 SSE 帧')
assert.ok(r1.out.includes('finishReason'), 'SSE 应带 finishReason（真实形状）')
assert.ok(r1.out.includes('额度'), '文案应含额度说明')
assert.ok(!/data: \{"error"/.test(r1.out), '不应回传上游错误 JSON 帧（会被客户端当 protobuf 解析）')
assert.strictEqual(upstreamHits, 1, '上游应被打了 1 次')
assert.ok(inQuotaCooldown(), '应进入熔断窗口')

const r2 = await clientRequest()
assert.strictEqual(r2.code, 200, '熔断窗口内的请求也应回 200')
assert.strictEqual(upstreamHits, 1, '熔断窗口内上游不应再被打')

console.log('PASS: 429 -> 200 SSE 额度说明 + 熔断生效')
upstream.close()
process.exit(0)
