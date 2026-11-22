// 直接读模型清单：用本机 Antigravity 自己的 OAuth 凭证调 fetchAvailableModels
// 只做只读 GET 语义（POST 空体），不打印任何令牌内容。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const p = join(process.env.USERPROFILE, '.gemini', 'oauth_creds.json')
const creds = JSON.parse(readFileSync(p, 'utf8'))
const token = creds.access_token
if (!token) { console.log('没有 access_token'); process.exit(1) }
const expired = creds.expiry_date ? Date.now() > Number(creds.expiry_date) - 60000 : false
console.log('token 长度 ' + token.length + '，过期=' + expired + '，到期时间 ' + new Date(Number(creds.expiry_date)).toLocaleString())

async function call(body) {
  const res = await fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'User-Agent': 'antigravity/hub/2.34.0 (aidev_client)',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, text }
}

let r = await call({})
if (r.status === 401 || r.status === 403) {
  console.log('第一次 401/403，尝试带 project 再发一次…')
  r = await call({ project: 'aicode-consumers' })
}
console.log('HTTP ' + r.status + '  ' + r.text.slice(0, 200))

let names = []
try {
  const j = JSON.parse(r.text)
  const walk = (v) => {
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v)) { v.forEach(walk); return }
    const cand = v.model ?? v.name ?? v.modelId ?? v.id
    if (typeof cand === 'string' && /gemini|flash|pro|claude|gpt|o\d/i.test(cand)) names.push(cand)
    for (const val of Object.values(v)) walk(val)
  }
  walk(j)
} catch { /* 非 JSON */ }
names = [...new Set(names)]
console.log('models(' + names.length + '):')
for (const n of names) console.log('  ' + n)
