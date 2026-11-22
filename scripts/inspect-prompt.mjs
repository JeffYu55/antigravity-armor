// 扫描候选提示词：体积 / 热词 / 行数（决定放 A 层还是 B 层）
import { readFileSync } from 'node:fs'
import { scanHotWords } from '../src/layers/gemini-retry.mjs'

const p = process.argv[2] || 'D:\\Desktop\\Gemini-4-Argon.md'
const t = readFileSync(p, 'utf8')
const bytes = Buffer.byteLength(t, 'utf8')
const hot = scanHotWords(t)
const hits = {}
for (const w of hot) {
  const n = t.split(w).length - 1
  hits[w] = n
}
console.log('file      ' + p)
console.log('bytes     ' + bytes + '   lines ' + t.split('\n').length + '   ≈tokens ' + Math.round(bytes / 3.2))
console.log('hotWords  ' + (hot.length ? JSON.stringify(hits) : '[]'))
console.log('hasBOM    ' + (t.charCodeAt(0) === 0xfeff))
