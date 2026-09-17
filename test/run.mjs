// 极简测试运行器：零依赖，递归跑 test/*.test.mjs
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs') && !f.startsWith('tmp-')).sort()
// 逐用例超时：曾经出现「单个用例挂住 -> 整个套件无输出」的情况，定位成本极高。
const TIMEOUT = Number(process.env.AARMOR_TEST_TIMEOUT || 25000)
const withTimeout = (fn, ms) => Promise.race([
  Promise.resolve().then(fn),
  new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('HUNG > ' + ms + 'ms')), ms); if (t.unref) t.unref() }),
])
let pass = 0, fail = 0
const t0 = Date.now()
for (const f of files) {
  const mod = await import(pathToFileURL(join(here, f)).href)
  const cases = Object.entries(mod).filter(([k]) => k.startsWith('test'))
  for (const [name, fn] of cases) {
    try { await withTimeout(fn, TIMEOUT); pass++; console.log('  ✓ ' + f + ' :: ' + name) }
    catch (e) { fail++; console.log('  ✗ ' + f + ' :: ' + name + '\n      ' + e.message) }
  }
}
console.log('  (耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's)')
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
