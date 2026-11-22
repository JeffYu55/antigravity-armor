// 解析 models.json：列出可用模型标识（GUI 能选的那些）
// 注意：上游可能 gzip/br 压缩，原始 dump 是二进制 —— 先解压再解析
import { readFileSync } from 'node:fs'
import { gunzipSync, brotliDecompressSync } from 'node:zlib'

const buf = readFileSync('state/capture/models.json')
let raw = ''
if (buf[0] === 0x1f && buf[1] === 0x8b) raw = gunzipSync(buf).toString('utf8')
else if (buf.length > 2 && buf[0] === 0xce || buf[0] === 0x1b) { try { raw = brotliDecompressSync(buf).toString('utf8') } catch { raw = buf.toString('utf8') } }
else raw = buf.toString('utf8')
if (!raw.trim().startsWith('{') && !raw.trim().startsWith('[')) {
  // 再兜一次：可能是 SSE 或带前缀
  const i = raw.indexOf('{')
  if (i >= 0) raw = raw.slice(i)
}
const j = JSON.parse(raw)
console.log('顶层键: ' + Object.keys(j).join(', '))

const found = new Map()
const KEYS = ['name', 'model', 'modelId', 'id', 'displayName', 'display_name', 'title', 'value']

function walk(v, path = '') {
  if (!v || typeof v !== 'object') return
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']')); return }
  // 一个对象里如果同时有“像模型标识”的字段，就记下来
  const idKey = KEYS.find((k) => typeof v[k] === 'string' && /gemini|claude|gpt|flash|pro|model/i.test(v[k]))
  if (idKey) {
    const label = v.displayName || v.display_name || v.title || v.description || ''
    found.set(v[idKey], { key: idKey, label: String(label).slice(0, 80), path })
  }
  for (const [k, val] of Object.entries(v)) walk(val, path + '.' + k)
}
walk(j)
console.log('候选模型 ' + found.size + ' 个:')
for (const [id, meta] of found) console.log('  ' + id.padEnd(46) + '  [' + meta.key + ']  ' + meta.label)
