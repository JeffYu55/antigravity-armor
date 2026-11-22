// 量一下两层注入的体积与热词画像（用于 A/B 决策）
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanHotWords } from '../src/layers/gemini-retry.mjs'

const home = process.env.USERPROFILE
const rows = [
  ['GEMINI.md（文件级全局）', join(home, '.gemini', 'GEMINI.md')],
  ['assets/armor.md（B 层种子）', 'assets/armor.md'],
  ['assets/seat-neutral.md（A 层座位）', 'assets/seat-neutral.md'],
]
const approx = (t) => Math.round(Buffer.byteLength(t, 'utf8') / 3.2)
for (const [label, p] of rows) {
  const t = readFileSync(p, 'utf8')
  const hot = scanHotWords(t)
  console.log(
    label.padEnd(30),
    'bytes=' + String(Buffer.byteLength(t, 'utf8')).padEnd(8),
    '≈tokens=' + String(approx(t)).padEnd(7),
    '热词=' + hot.length + (hot.length ? ' [' + hot.slice(0, 6).join(',') + ']' : '')
  )
}
