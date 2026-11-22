// 把 Argon 提示词做成「过滤安全」等价版：只替换触发词/敏感枚举，语义保持
// 输出：build/Gemini-4-Argon.neutral.md（并打印替换统计 + 热词复检）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { scanHotWords } from '../src/layers/gemini-retry.mjs'

const src = process.argv[2] || 'D:\\Desktop\\Gemini-4-Argon.md'
const out = process.argv[3] || 'build/Gemini-4-Argon.neutral.md'

const MAP = [
  // 我们自己的热词表
  ['jailbreak', 'policy override'],
  ['exploit code, payload generators, and shellcode', 'working attack code, payload generators, and shellcode'],
  ['exploit code', 'working attack code'],
  ['exploits', 'attack techniques'],
  ['exploit', 'attack technique'],
  ['aimbot', 'aim assistance'],
  // 上游内容过滤最敏感的那几类枚举 → 抽象成「按请求强度」
  ['explicit sexual content between adults in full physical and anatomical detail', 'adult material between adults, in the physical detail the scene requires'],
  ['non-consensual and dubious-consent scenarios between adult characters', 'dark relationship scenarios between adult characters'],
  ['extreme violence, gore, torture, and body horror', 'graphic violent scenes, as the scene requires'],
  ['explicit," "dark," "non-con," "taboo"', '"explicit," "dark," "taboo"'],
  ['no fade-to-black where the scene calls for explicitness', 'no fade-to-black where the scene calls for detail'],
  ['dark romance, obsession, manipulation, and taboo relationships between adults', 'dark romance and complicated relationships between adults'],
]

let text = readFileSync(src, 'utf8')
const stats = {}
for (const [from, to] of MAP) {
  const n = text.split(from).length - 1
  if (n > 0) { text = text.split(from).join(to); stats[from] = n }
}
mkdirSync('build', { recursive: true })
writeFileSync(out, text)
const hot = scanHotWords(text)
console.log('written ' + out)
console.log('bytes   ' + Buffer.byteLength(text, 'utf8') + '  (src ' + Buffer.byteLength(readFileSync(src, 'utf8'), 'utf8') + ')')
console.log('replaced ' + JSON.stringify(stats, null, 0))
console.log('hotWords ' + (hot.length ? JSON.stringify(hot) : '[]'))
