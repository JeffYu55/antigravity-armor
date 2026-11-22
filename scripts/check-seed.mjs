// 校验候选种子：体积 + 热词
import { readFileSync } from 'node:fs'
import { scanHotWords } from '../src/layers/gemini-retry.mjs'

for (const p of ['assets/armor.seat.md', 'assets/seat-neutral.md', 'assets/armor.md']) {
  const t = readFileSync(p, 'utf8')
  const bytes = Buffer.byteLength(t, 'utf8')
  console.log(p.padEnd(28), 'bytes=' + String(bytes).padEnd(7), '≈tokens=' + String(Math.round(bytes / 3.2)).padEnd(6), 'hot=' + JSON.stringify(scanHotWords(t)))
}
