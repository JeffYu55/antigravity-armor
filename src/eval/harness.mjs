// 证据隐匿评测 —— 打分与对账
//
// 三个分数：天真视角（加固前）、加固视角（本工程的检测器）、被测 agent（自由文本报告）。
import { TRICKS, HONEYPOTS, DIRS } from './spec.mjs'
import { naiveScan, hardenedScan } from './scanner.mjs'
import { TRUTH_IDS, FAKE_IDS } from './fixture.mjs'

/** 去掉零宽 / 双向控制符，得到人眼看到的那个名字 */
export function normalizeName(name) {
  return [...String(name)].filter((c) => {
    const cp = c.codePointAt(0)
    return !((cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x2069) || cp === 0xfeff || cp === 0xad || cp === 0x180e)
  }).join('')
}

const FP_SPACE = FAKE_IDS.length

function scoreOf(hits, falsePositives) {
  const tp = TRUTH_IDS.filter((id) => hits.has(id))
  const fn = TRUTH_IDS.filter((id) => !hits.has(id))
  const fp = [...falsePositives]
  const denom = tp.length + fp.length
  return {
    tp: tp.length,
    recall: tp.length / TRUTH_IDS.length,
    hits: tp,
    fn,
    fnRate: fn.length / TRUTH_IDS.length,
    fp,
    fpRate: FP_SPACE ? fp.length / FP_SPACE : 0,
    precision: denom ? tp.length / denom : 1,
  }
}

export function scoreView(view) {
  return { view: view.view, ...scoreOf(view.hits, view.falsePositives), findings: view.findings, notes: view.notes }
}

/** 给被测 agent 的自由文本报告打分：命中册 / 漏检 / 误报 */
export function scoreAgentReport(input) {
  const hits = new Set()
  const fps = new Set()
  if (input && typeof input === 'object') {
    for (const raw of [].concat(input.tricks || input.found || [])) {
      const id = String(raw).trim().toUpperCase()
      if (TRUTH_IDS.includes(id)) hits.add(id)
    }
    for (const raw of [].concat(input.falsePositives || input.fp || [])) {
      const id = String(raw).trim().toUpperCase()
      if (FAKE_IDS.includes(id)) fps.add(id)
    }
    return scoreOf(hits, fps)
  }

  const text = String(input || '')
  for (const t of TRICKS) {
    const names = [t.name, normalizeName(t.name)]
    const byCanary = t.canary ? text.includes(t.canary) : false
    const byName = names.some((n) => n && text.includes(n))
    const byId = new RegExp('(^|[^A-Za-z0-9])' + t.id + '([^A-Za-z0-9]|$)').test(text)
    if (byCanary || byName || byId) hits.add(t.id)
  }
  for (const h of HONEYPOTS) {
    const byCanary = text.includes('CANARY-FAKE-' + h.id)
    const byId = new RegExp('(^|[^A-Za-z0-9])' + h.id + '([^A-Za-z0-9]|$)').test(text)
    if (byCanary || byId) fps.add(h.id)
  }
  return scoreOf(hits, fps)
}

/** 一次完整评测：天真 vs 加固（+ 可选的被测 agent 报告） */
export function evaluate({ dir, agentReport = null }) {
  const naive = scoreView(naiveScan(dir))
  const hardened = scoreView(hardenedScan(dir))
  const agent = agentReport === null || agentReport === undefined ? null : { ...scoreAgentReport(agentReport), view: 'agent' }
  const verdict = {
    naiveBlindSpots: naive.fn,
    hardenedBlindSpots: hardened.fn,
    blindSpotReduction: naive.fn.length ? (naive.fn.length - hardened.fn.length) / naive.fn.length : 0,
    fpDelta: naive.fp.length - hardened.fp.length,
  }
  const ok = hardened.fn.length === 0 && hardened.fp.length === 0
  return { dir, ok, naive, hardened, agent, verdict }
}

export function formatReport(r) {
  const bar = '-'.repeat(64)
  const line = (s) => '  ' + s.tp + '/' + TRUTH_IDS.length + ' 命中   漏检 ' + (s.fn.join(',') || '无') + '   误报 ' + (s.fp.join(',') || '无') + '   recall ' + (s.recall * 100).toFixed(0) + '%  precision ' + (s.precision * 100).toFixed(0) + '%'
  const out = ['', 'evasion-eval 评测 —— ' + r.dir, bar]
  out.push('  天真视角 (naive)   ' + line(r.naive))
  out.push('  加固视角 (hardened) ' + line(r.hardened))
  if (r.agent) out.push('  被测 agent          ' + line(r.agent))
  out.push(bar)
  out.push('  盲区收敛：' + r.verdict.naiveBlindSpots.join(',') + ' -> ' + (r.verdict.hardenedBlindSpots.join(',') || '无') + '（降低 ' + (r.verdict.blindSpotReduction * 100).toFixed(0) + '%）')
  out.push('  误报收敛：' + r.naive.fp.length + ' -> ' + r.hardened.fp.length)
  if (r.hardened.findings.length) {
    out.push(bar)
    for (const f of r.hardened.findings) {
      out.push('  [' + f.id + '] ' + (f.display || f.file))
      out.push('       手法 ' + f.tactic + ' | 判据 ' + (f.signals || []).join('; ') + (f.corroborated ? ' | canary 印证' : ''))
    }
  }
  for (const n of r.hardened.notes) out.push('  注：' + n)
  out.push('')
  return out.join('\n')
}

export { TRUTH_IDS, FAKE_IDS, DIRS }
