// host-probe —— 宿主二进制字符串勘察器（P2 第 1 件）
//
// 为什么需要它：锚点表按版本漂移，凭记忆找锚点必然出错。这个脚本把
// language_server.exe 里的可见 ASCII 串（含换行，因为提示词是多行块）按
// 出现顺序列出来，成为后续所有补丁锚点的**唯一事实来源**。
//
// 用法：
//   node scripts/host-probe.mjs --stats
//   node scripts/host-probe.mjs --grep="PolicyGuardian|vet_mango" --max=8
//   node scripts/host-probe.mjs --dump            # 落 state/probe/host-strings.ndjson
//   node scripts/host-probe.mjs --grep="hook" --around=200
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { log } from '../src/log.mjs'

const MIN_RUN = 120          // 短于这个长度的串不进库（噪声太大）
const MAX_RUN_TEXT = 20000   // 单串截断上限，防超长资源段把内存打爆

/** 扫描可见 ASCII 串（可含 \t \n \r），返回 [{offset, len, text}] */
export function scanRuns(buf, { min = MIN_RUN } = {}) {
  const out = []
  let start = -1
  const isPrintable = (b) => (b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (isPrintable(b)) {
      if (start < 0) start = i
      continue
    }
    if (start >= 0) {
      const len = i - start
      if (len >= min) out.push({ offset: start, len, text: buf.toString('latin1', start, Math.min(i, start + MAX_RUN_TEXT)) })
      start = -1
    }
  }
  if (start >= 0 && buf.length - start >= min) {
    out.push({ offset: start, len: buf.length - start, text: buf.toString('latin1', start, Math.min(buf.length, start + MAX_RUN_TEXT)) })
  }
  return out
}

function arg(name, dflt = null) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return dflt
  const eq = hit.indexOf('=')
  return eq < 0 ? true : hit.slice(eq + 1)
}

function main() {
  const cfg = loadConfig()
  const buf = readFileSync(cfg.binaryPath)
  const runs = scanRuns(buf)
  const total = runs.reduce((a, r) => a + r.len, 0)

  if (arg('dump')) {
    const file = `${cfg.stateDir}/probe/host-strings.ndjson`
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, runs.map((r) => JSON.stringify(r)).join('\n') + '\n')
    log.ok(`dump ${runs.length} runs -> ${file}`)
  }

  const stats = {
    binary: cfg.binaryPath,
    bytes: buf.length,
    runs: runs.length,
    printableBytes: total,
    minRun: MIN_RUN,
    longest: runs.reduce((m, r) => (r.len > m.len ? r : m), { len: 0, offset: 0, text: '' }).len,
  }

  const grep = arg('grep')
  if (typeof grep === 'string') {
    const re = new RegExp(grep, 'i')
    const max = Number(arg('max', 10))
    const around = Number(arg('around', 0))
    const hits = runs.filter((r) => re.test(r.text))
    log.info(`grep /${grep}/i -> ${hits.length} runs`)
    for (const r of hits.slice(0, max)) {
      const body = around > 0
        ? r.text.slice(Math.max(0, r.text.search(re) - around), r.text.search(re) + around).replace(/[\r\n]+/g, ' ⏎ ')
        : r.text.slice(0, 240).replace(/[\r\n]+/g, ' ⏎ ')
      console.log(`@${r.offset} len=${r.len}\n  ${body}\n`)
    }
  } else {
    console.log(JSON.stringify(stats, null, 2))
  }
  return stats
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/host-probe.mjs')
if (invokedDirectly) main()
