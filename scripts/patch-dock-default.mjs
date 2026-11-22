// 让 dock 默认展开（首次注入就能看见），幂等
import { readFileSync, writeFileSync } from 'node:fs'
const p = 'assets/armor-hud-inject.js'
let s = readFileSync(p, 'utf8')
const marker = "if (open) dock.classList.add('ad-open')"
if (!s.includes(marker)) {
  s = s.replace('  mount()\n  new MutationObserver', "  " + marker + "\n  mount()\n  new MutationObserver")
  writeFileSync(p, s)
  console.log('patched: dock 默认展开')
} else {
  console.log('already patched')
}
// 同步到 hook 用的 .cjs 副本
writeFileSync('hud/armor-hud-inject.cjs', readFileSync(p))
console.log('synced hud/armor-hud-inject.cjs')
