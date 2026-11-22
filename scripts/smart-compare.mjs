// 智力对照：同一组「能力题」在 neon vs 3.8 vs gpt-oss 上各跑一遍
// 题目选自日常开发里真正吃模型能力的类型：并发 bug、算法、架构、模糊需求澄清
import { readFileSync } from 'node:fs'

const SEAT = readFileSync('assets/seat-exec.md', 'utf8')
const TASKS = [
  ['并发bug', '这段 Go 代码有什么并发问题？给修复版：func main(){ wg:=sync.WaitGroup{}; for i:=0;i<5;i++{ wg.Add(1); go func(){ fmt.Println(i); wg.Done() }() } wg.Wait() }'],
  ['算法', '设计一个支持 O(1) 的 get/put 和 O(1) 频率淘汰的 LFU 缓存，给出 Go 实现要点与核心结构体。'],
  ['架构取舍', '订单系统用「先扣库存再创建订单」还是「先创建订单再扣库存」？给出两种方案的补偿机制设计。'],
  ['模糊澄清', '用户说"我的网站很慢"，列出你会先问的 5 个问题并说明为什么是这 5 个。'],
]

async function probe(text, model) {
  const res = await fetch('http://127.0.0.1:50100/armor/probe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model, seat: SEAT, maxTokens: 2048 }),
  })
  return res.json()
}

const MODELS = ['gemini-4-neon-medium', 'gemini-3.8-flash-high', 'gpt-oss-120b-medium']
const scores = {}
for (const model of MODELS) {
  scores[model] = { chars: 0, ok: 0 }
  for (const [name, q] of TASKS) {
    const j = await probe(q, model)
    const good = (j.chars || 0) >= 300
    if (good) scores[model].ok++
    scores[model].chars += j.chars || 0
    console.log(`${model.padEnd(26)} ${name.padEnd(6)} HTTP=${j.status} chars=${j.chars} ${good ? 'OK' : 'weak'}`)
  }
}
console.log('\n汇总（4 题里答好的数量 / 总正文长度）:')
for (const m of MODELS) console.log('  ' + m.padEnd(26) + scores[m].ok + '/4   ' + scores[m].chars + 'B')
