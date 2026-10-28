// 复现实验（一次性诊断脚本）：证明「模型自己 view_file 读过我们的装甲文件」之后，
// 那段带行号的文本会**永久留在会话里**，而 stripOwnArmor 的整块原文匹配**抓不到它**。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  stripOwnArmor, scanHotWords, collectOwnArmorSources, setOwnArmorSources, ownArmorSources,
} from '../src/layers/gemini-retry.mjs'

const geminiHome = join(homedir(), '.gemini')
const armorPath = join(geminiHome, 'config/skills/infinite-gen-3-armor/SKILL.md')

// 关键：按 divert 启动时的做法装载净化册（否则 ownSources 是空的，实验无效）
const n = setOwnArmorSources(collectOwnArmorSources({
  assetsDir: join(process.cwd(), 'assets'),
  geminiHome,
  rules: {
    globalFiles: [join(geminiHome, 'Gemini.md'), join(geminiHome, 'config/AGENTS.md')],
    skillFile: armorPath,
  },
}))
console.log('净化册条数                     :', n)
console.log('净化册含带行号变体?            :', ownArmorSources().some((s) => /^\s*1: /.test(s)))
console.log('')

const armor = readFileSync(armorPath, 'utf8')
const numbered = armor.split(/\r?\n/).map((l, i) => (i + 1) + ': ' + l).join('\n')
  + '\nThe above content shows the entire, complete file contents of the requested file.\n'

const mk = (text) => ({
  request: {
    contents: [{ role: 'user', parts: [{ text }] }],
    systemInstruction: { role: 'user', parts: [{ text: '<identity>You are Antigravity.</identity>' }] },
    labels: {}, sessionId: '-1',
  },
})

for (const [label, text] of [['纯文件形态（系统位注入）', armor], ['view_file 带行号形态（工具回包）', numbered]]) {
  const body = mk(text)
  const removed = stripOwnArmor(body)
  const left = body.request.contents[0].parts[0].text
  console.log('### ' + label)
  console.log('   原文触发词 :', scanHotWords(text).join(',') || '(无)')
  console.log('   剥掉字节   :', removed, '/', text.length)
  console.log('   残留触发词 :', scanHotWords(left).join(',') || '(无)')
  console.log('')
}