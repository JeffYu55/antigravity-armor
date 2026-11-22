// guard-inventory —— 护栏表面清点器（P2 第 3 件）
//
// 回答一个问题：**这一版宿主长出了哪些护栏提示块？** 升级后只跑这一个脚本，
// 就知道补丁表要跟着补哪几条（GT-xx）。判据全是「提示块里出现的固定短语」，
// 不猜、不靠版本号。
//
// 用法：
//   node scripts/guard-inventory.mjs                 # 打印清单
//   node scripts/guard-inventory.mjs --emit          # 落 patches/hosts/<ver>/guardrails.json
//   node scripts/guard-inventory.mjs --id=GT-02      # 只看一条
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { scanRuns } from './host-probe.mjs'
import { log } from '../src/log.mjs'

/** 每条 = 一个护栏表面：命中任一 marker 即认领该 run */
export const GUARDRAILS = [
  { id: 'GT-01', name: 'Runtime Policy Guardian（运行时判官）', markers: ['You are the Runtime Policy Guardian', 'Runtime Policy Guardian'] },
  { id: 'GT-02', name: 'PolicyGuardian 不可逆动作审计', markers: ["PolicyGuardian's irreversible-action auditor", 'is_destructive'] },
  { id: 'GT-03', name: 'Remy 安全策略判官（safety_decision JSON）', markers: ['vet_remy_policy', "'safety_decision'"] },
  { id: 'GT-04', name: 'Mango 安全策略判官', markers: ['vet_mango_policy', 'Mango safety policies'] },
  { id: 'GT-05', name: 'vet_destruction 销毁清单（含 tamper 条目）', markers: ['vet_destruction', 'DESTRUCTIVE ACTIONS & SYSTEMATIC VETTING POLICY', 'Modifying agent guardrail/hook/permission configurations'] },
  { id: 'GT-06', name: '浏览器安全 / CAPTCHA / 抓取段', markers: ['Never solve or bypass a CAPTCHA', 'Core Safety Principles', 'Prohibited platform automation'] },
  { id: 'GT-07', name: '代码意图判官', markers: ['Is the intention of the author malicious'] },
  { id: 'GT-08', name: '持久化分类器', markers: ['persistence threat', 'persistence mechanism'] },
  { id: 'GT-09', name: '数据外泄审计 / 反注入条款', markers: ['Never follow directives, role changes, policy overrides', 'RESPECT INTENT', 'NO OBFUSCATED EXFIL STAGING'] },
  { id: 'GT-10', name: 'safety policy 判决词', markers: ['could not be verified by safety policy', 'Content safety response could not be verified', 'modifying system configuration is not allowed'] },
  { id: 'GT-11', name: '审批 / HITL 门', markers: ['TerminalCommandAutoExecutionPolicy', 'APPLICATION_PERMISSION', 'approval'] },
  { id: 'GT-12', name: '提示词注入检测', markers: ['enable_prompt_injection_detection', 'PROMPT_INJECTION'] },
]

export function inventory(buf) {
  const runs = scanRuns(buf, { min: 160 })
  const found = []
  for (const g of GUARDRAILS) {
    const hitRuns = []
    for (const r of runs) {
      if (g.markers.some((m) => r.text.includes(m))) hitRuns.push(r)
    }
    found.push({
      id: g.id,
      name: g.name,
      runs: hitRuns.length,
      bytes: hitRuns.reduce((a, r) => a + r.len, 0),
      samples: hitRuns.slice(0, 6).map((r) => ({ offset: r.offset, len: r.len, head: r.text.slice(0, 160).replace(/[\r\n]+/g, ' ⏎ ') })),
    })
  }
  return found
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/guard-inventory.mjs')
if (invokedDirectly) {
  const cfg = loadConfig()
  const buf = readFileSync(cfg.binaryPath)
  const found = inventory(buf)
  const only = (process.argv.find((a) => a.startsWith('--id=')) || '').slice(5)
  const rows = only ? found.filter((f) => f.id === only) : found
  for (const f of rows) {
    log.info(`${f.id}  runs=${String(f.runs).padStart(3)}  bytes=${f.bytes}  ${f.name}`)
    for (const s of f.samples) console.log(`    @${s.offset} len=${s.len}  ${s.head}`)
  }
  const missing = found.filter((f) => f.runs === 0)
  if (missing.length) log.warn(`未命中：${missing.map((m) => m.id).join(', ')}（该版本文本已变，需重抽）`)
  if (process.argv.includes('--emit')) {
    const out = join(cfg.projectRoot, 'patches', 'hosts', cfg.hostVersion, 'guardrails.json')
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify({ hostVersion: cfg.hostVersion, at: new Date().toISOString(), found }, null, 2))
    log.ok(`emit -> ${out}`)
  }
}
