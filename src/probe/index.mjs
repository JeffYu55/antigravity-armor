// aarmor probe —— 破甲跑分（把「提升了没有」变成数字）
//
//   aarmor probe bank                    列探针库
//   aarmor probe measure                 离线跑分（mock 上游，零 API 成本）
//   aarmor probe measure --target=URL    真实跑分（打真端点，量模型的脾气）
//   aarmor probe measure --attempts=N    重试额度（默认取 armor.config.json 的 divert.maxAttempts）
import { loadBank, measure, formatMeasure } from './run.mjs'
import { resolveKey } from '../credentials.mjs'
import { join } from 'node:path'

export const PROBE_USAGE = [
  '  aarmor probe bank                            列探针库（分类 / 顽固度 / 标签）',
  '  aarmor probe measure [--attempts=N] [--json]  离线跑分：mock 上游，零 API 成本',
  '  aarmor probe measure --target=URL [--model=M] [--key=K]  真实跑分：打真端点',
  '  aarmor probe measure [--bank=FILE] [--probe-chars=N] [--gate-chars=N] [--timeout=MS] [--log]',
  '    --probe-chars  首次判定点（默认 900）；--gate-chars  缓冲硬上限（默认 2500）',
  '    --prefill=STR / --no-prefill / --prefill-from=N   预填（默认 ## ，自第 2 次尝试起）',
  '    --jitter / --no-jitter / --jitter-step=N         重试采样抖动（默认开，+0.15/档，封顶 1）',
].join('\n')

export async function runProbe({ sub = 'measure', flags = {}, cfg }) {
  if (sub === 'bank') {
    const bank = loadBank(flags.bank ? String(flags.bank) : null)
    if (flags.json) return console.log(JSON.stringify(bank, null, 2))
    console.log('探针库 v' + bank.version + ' —— ' + bank.probes.length + ' 条')
    const w = Math.max(...bank.probes.map((p) => p.category.length))
    for (const p of bank.probes) {
      console.log('  ' + p.id.padEnd(4) + p.category.padEnd(w + 2) + '顽固度 ' + String(p.stubbornness).padEnd(2) + ' ' + p.label)
    }
    return
  }

  if (sub !== 'measure') {
    console.log('aarmor probe <measure|bank>\n' + PROBE_USAGE)
    process.exitCode = 1
    return
  }

  const live = !!flags.target
  const key = flags.key ? String(flags.key) : (live ? resolveKey(cfg, cfg.divert.keyRef) : 'probe-local-key')
  if (live && !key) throw new Error('真实跑分需要密钥：设置 ' + cfg.divert.keyRef + ' 或传 --key=')

  const m = await measure({
    target: flags.target ? String(flags.target) : null,
    key,
    model: flags.model ? String(flags.model) : null,
    bankFile: flags.bank ? String(flags.bank) : null,
    maxAttempts: flags.attempts ?? cfg.divert.maxAttempts,
    probeChars: flags['probe-chars'] ?? cfg.divert.probeChars,
    gateChars: flags['gate-chars'] ?? cfg.divert.gateChars,
    prefill: flags['no-prefill'] ? '' : (flags.prefill !== undefined ? String(flags.prefill) : cfg.divert.prefill),
    prefillFrom: flags['prefill-from'] ?? cfg.divert.prefillFrom,
    jitter: flags['no-jitter'] ? false : (flags.jitter !== undefined ? true : cfg.divert.jitter),
    jitterStep: flags['jitter-step'] ?? cfg.divert.jitterStep,
    timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
    divertLog: flags.log ? join(cfg.logDir, 'probe-divert.log') : null,
  })

  if (flags.json) return console.log(JSON.stringify(m, null, 2))
  console.log(formatMeasure(m))
  if (m.undetectedRefusal > 0) {
    console.log('  漏检拒绝 ' + m.undetectedRefusal + ' 条 —— 这是探测器 bug（还有额度却把拒绝透出了），不是模型的脾气')
    process.exitCode = 1
  }
}
