#!/usr/bin/env node
// 单测运行器（零依赖）：只跑一个用例，并带挂死看门狗。
//
// 为什么需要它：整套 test/run.mjs 每个用例有 25s 超时，一个「请求静默挂死」的回归
// 会被报成 HUNG —— 和「这个用例本来就慢」长得一模一样，定位成本极高。
// 单跑一条 + 短超时 + 直接打印失败原因，是这类问题唯一省时间的查法。
//
//   node scripts/run-one.mjs probe.test.mjs testDivertConsumesRequestBody
//   node scripts/run-one.mjs refusal.test.mjs testConditionalClauseIsNotARefusal --timeout=5000
//   node scripts/run-one.mjs probe.test.mjs --list
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flags = {}
const pos = []
for (const a of args) {
  if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v === undefined ? true : v }
  else pos.push(a)
}
const [file, name] = pos
if (!file) {
  console.log('用法: node scripts/run-one.mjs <testFile> [testName] [--timeout=MS] [--list]')
  console.log('例:   node scripts/run-one.mjs probe.test.mjs testDivertConsumesRequestBody')
  process.exit(1)
}
const target = join(here, '..', 'test', file.endsWith('.mjs') ? file : file + '.test.mjs')
const mod = await import(pathToFileURL(target).href)
const cases = Object.entries(mod).filter(([k]) => k.startsWith('test'))
if (flags.list || !name) {
  for (const [k] of cases) console.log('  ' + k)
  process.exit(0)
}
const fn = mod[name]
if (typeof fn !== 'function') {
  console.log('没有这个用例: ' + name)
  console.log('候选: ' + cases.map(([k]) => k).join(', '))
  process.exit(1)
}
const timeout = Number(flags.timeout || 15000)
const t0 = Date.now()
const timer = setTimeout(() => {
  console.log('HUNG >> ' + name + ' (>' + timeout + 'ms) —— 多半是某个 await 永远不返回（请求没被消费 / 服务没起）')
  process.exit(3)
}, timeout)
if (timer.unref) timer.unref()
try {
  await fn()
  console.log('OK   ' + name + '  (' + (Date.now() - t0) + 'ms)')
} catch (e) {
  console.log('FAIL ' + name + '\n     ' + (e && e.message))
  process.exitCode = 1
}
clearTimeout(timer)
process.exit()
