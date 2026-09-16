// 极简测试运行器：零依赖，递归跑 test/*.test.mjs
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort()
let pass = 0, fail = 0
for (const f of files) {
  const mod = await import(pathToFileURL(join(here, f)).href)
  const cases = Object.entries(mod).filter(([k]) => k.startsWith('test'))
  for (const [name, fn] of cases) {
    try { await fn(); pass++; console.log('  ✓ ' + f + ' :: ' + name) }
    catch (e) { fail++; console.log('  ✗ ' + f + ' :: ' + name + '\n      ' + e.message) }
  }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
