// 从 models.bin 里抠真实模型 id（gzip 或裸 protobuf 都能处理）
import { readFileSync } from 'node:fs'
import { gunzipSync, brotliDecompressSync } from 'node:zlib'

const p = 'C:/Users/Administrator/Projects/antigravity-armor-2.34/state/capture/models.bin'
let buf = readFileSync(p)
console.log('raw bytes ' + buf.length + ' head=' + buf.subarray(0, 4).toString('hex'))
if (buf[0] === 0x1f && buf[1] === 0x8b) { buf = gunzipSync(buf); console.log('gunzip -> ' + buf.length) }
else if (buf.length > 8 && buf[0] === 0xce) { try { buf = brotliDecompressSync(buf); console.log('brotli -> ' + buf.length) } catch { /* 忽略 */ } }

const s = buf.toString('latin1')
const ids = new Set()
for (const m of s.matchAll(/[a-z][a-z0-9]*(?:[-_.][a-z0-9]+){1,6}/g)) {
  const v = m[0]
  if (v.length < 6) continue
  if (/^(gemini|claude|gpt|o[0-9]|anthropic|openai)/.test(v)) ids.add(v)
}
console.log('候选 id ' + ids.size + ':')
for (const id of [...ids].sort()) console.log('  ' + id)
