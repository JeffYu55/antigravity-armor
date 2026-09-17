// aarmor eval —— 证据隐匿评测夹具的 CLI 门面
//
//   aarmor eval build  [--dir=DIR] [--clean]   物化夹具（spec → 文件系统）
//   aarmor eval verify [--dir=DIR]             逐项自检（名字信号 / ADS / 伪造时间戳 / BOM）
//   aarmor eval scan   [--view=naive|hardened|both] [--json]
//   aarmor eval report [--agent=FILE] [--json] 打分：天真 vs 加固（+ 被测 agent 报告）
//   aarmor eval diff   [--legacy=DIR] [--dir=DIR]  与迁移过来的原夹具逐字节比对
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { materialize, verify, compareDirs, manifest, clean, TRUTH_IDS, FAKE_IDS } from './fixture.mjs'
import { naiveScan, hardenedScan } from './scanner.mjs'
import { evaluate, formatReport } from './harness.mjs'
import { readText } from '../util/fs.mjs'
import { log } from '../log.mjs'

export const EVAL_USAGE = [
  '  aarmor eval build  [--dir=DIR] [--clean]       物化夹具（spec → 文件系统）',
  '  aarmor eval verify [--dir=DIR]                 逐项自检（名字信号 / ADS / 伪造时间戳 / BOM）',
  '  aarmor eval scan   [--view=naive|hardened|both] [--json]',
  '  aarmor eval report [--agent=FILE] [--json]     打分：天真 vs 加固（+ 被测 agent 报告）',
  '  aarmor eval diff   [--legacy=DIR]              与迁移进来的原夹具逐字节比对',
].join('\n')

/** 运行时物化目录（默认落在 state/ 下，state/ 已在 .gitignore 里） */
export function defaultDir(cfg) { return join(cfg.stateDir, 'eval', 'fixture') }
/** 迁移保真的原始夹具目录（随仓库走） */
export function legacyDir(cfg) { return join(cfg.projectRoot, 'test', 'fixtures', 'evasion-eval') }

function readAgentReport(file) {
  if (!file || !existsSync(file)) return null
  const text = readText(file)
  try { return JSON.parse(text) } catch { return text }
}

export async function runEval({ sub = 'report', flags = {}, cfg }) {
  const dir = flags.dir ? String(flags.dir) : defaultDir(cfg)
  const json = !!flags.json
  const emit = (obj) => console.log(JSON.stringify(obj, null, 2))

  // scan / report 遇到还没物化的夹具时自己建一份，避免「空目录 = 0/6」这种假失败
  if ((sub === 'scan' || sub === 'report') && !existsSync(join(dir, 'naive-victim'))) {
    materialize(dir)
    if (!json) console.log('夹具不存在，已按 spec 物化: ' + dir)
  }

  if (sub === 'build') {
    if (flags.clean) clean(dir)
    const res = materialize(dir)
    const v = verify(dir)
    if (json) return emit({ ...res, verify: v })
    console.log('夹具已物化: ' + dir)
    console.log('  写入 ' + res.written.length + ' 项 —— 真迹 ' + TRUTH_IDS.length + ' 条 / 诱饵 ' + FAKE_IDS.length + ' 条 / 答案表 + manifest')
    if (res.unsupported.length) log.warn('本文件系统不支持: ' + res.unsupported.map((u) => u.id + ':' + u.what).join(', '))
    if (v.ok) console.log('  自检 PASS —— 怪名字 / ADS / 伪造时间戳 全部就位')
    else {
      log.warn('自检 FAIL')
      for (const i of v.items.filter((x) => !x.ok)) console.log('    ' + i.id + '  ' + JSON.stringify(i.checks))
    }
    return
  }

  if (sub === 'verify') {
    const v = verify(dir)
    if (json) return emit(v)
    console.log('夹具自检: ' + dir + '  ->  ' + (v.ok ? 'PASS' : 'FAIL'))
    for (const i of v.items) console.log('  ' + (i.ok ? 'OK  ' : 'FAIL') + ' ' + i.id + '  ' + JSON.stringify(i.checks))
    return
  }

  if (sub === 'diff') {
    const legacy = flags.legacy ? String(flags.legacy) : legacyDir(cfg)
    const res = compareDirs(legacy, dir)
    if (json) return emit(res)
    console.log('比对 ' + legacy + '  <->  ' + dir)
    console.log(res.same ? '  逐字节一致（协议目录：naive-victim + honeypot，含 ADS 内容）' : '  差异 ' + res.diffs.length + ' 处:')
    for (const d of res.diffs.slice(0, 30)) console.log('    ' + d.sub + '/' + d.name + '  ' + d.kind + '  ' + JSON.stringify({ a: d.a, b: d.b, stream: d.stream }))
    return
  }

  if (sub === 'scan') {
    const view = flags.view || 'both'
    const out = {}
    if (view !== 'hardened') out.naive = naiveScan(dir)
    if (view !== 'naive') out.hardened = hardenedScan(dir)
    if (json) return emit(out)
    for (const [k, v] of Object.entries(out)) {
      console.log('[' + k + '] 枚举 ' + v.files.length + ' 个文件  命中 ' + ([...v.hits].sort().join(',') || '无') + '  误报 ' + ([...v.falsePositives].sort().join(',') || '无'))
      for (const f of v.findings) console.log('    ' + f.id + '  ' + (f.display || f.file) + '   ' + (f.signals || []).join('; '))
      for (const n of v.notes) console.log('    注：' + n)
    }
    return
  }

  if (sub === 'manifest') {
    const m = manifest()
    if (json) return emit(m)
    console.log(JSON.stringify(m, null, 2))
    return
  }

  if (sub === 'report') {
    const agentReport = readAgentReport(flags.agent ? String(flags.agent) : null)
    const r = evaluate({ dir, agentReport })
    if (json) return emit(r)
    console.log(formatReport(r))
    if (!r.ok) process.exitCode = 1
    return
  }

  console.log('aarmor eval <build|verify|scan|report|diff|manifest>\n' + EVAL_USAGE)
  process.exitCode = 1
}
