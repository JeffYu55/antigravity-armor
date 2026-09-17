// 证据隐匿评测夹具 —— 契约测试
//
// 锁死三件事：
//   1) 从 C:\Users\Administrator\Projects\evasion-eval 迁进来的原夹具逐字节完好；
//   2) spec 能把同一套夹具（含 ADS 与伪造时间戳）在任意目录重建出来；
//   3) 加固视角的检测不依赖 CANARY 字符串 —— 抹掉 canary 仍然 6/6。
//
// v1.7.4 修正（这条用例曾经只在"生成过夹具的那台机器"上通过）：
//   git **存不了 NTFS 备用数据流（ADS）**，也存不了伪造时间戳。所以
//   「仓库里的夹具 == spec 重建结果」这个断言必须在**克隆出来的目录**里也成立 ——
//   做法是把差异按「能否随 git 传输」分类，而不是把差异整体放过：
//   可传输部分的任何差异都是真回归，不可传输的那几项则要求逐一核对是预期的那一条。
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { materialize, verify, compareDirs, clean } from '../src/eval/fixture.mjs'
import { naiveScan, hardenedScan } from '../src/eval/scanner.mjs'
import { evaluate, scoreAgentReport, normalizeName } from '../src/eval/harness.mjs'
import { TRICKS, HONEYPOTS, DIRS } from '../src/eval/spec.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const LEGACY = join(ROOT, 'test', 'fixtures', 'evasion-eval')
const SANDBOX = join(ROOT, 'state', 'eval', 'test-fixture')
const STRIPPED = join(ROOT, 'state', 'eval', 'test-stripped')

let cached = null
function fixture() {
  if (!cached) { clean(SANDBOX); materialize(SANDBOX); cached = SANDBOX }
  return cached
}

export function testLegacyFixtureMigratedIntact() {
  for (const p of [DIRS.naive, DIRS.honeypot, DIRS.truth]) {
    assert.ok(existsSync(join(LEGACY, p)), '迁移后应保留 ' + p + '/')
  }
  assert.ok(existsSync(join(LEGACY, 'scanner.py')), '原 Python 参考实现应随夹具保留')
  assert.ok(existsSync(join(LEGACY, 'GROUND_TRUTH.md')), '答案表总览应随夹具保留')
}

export function testSpecReproducesLegacyFixtureByteForByte() {
  const r = compareDirs(LEGACY, fixture())
  // git 无法携带的东西：NTFS 备用数据流（ADS）。时间戳由 verify() 单独判，不进逐字节比。
  const UNTRANSPORTABLE = new Set(['streams-differ', 'stream-bytes-differ'])
  const untransportable = r.diffs.filter((d) => UNTRANSPORTABLE.has(d.kind))
  const real = r.diffs.filter((d) => !UNTRANSPORTABLE.has(d.kind))
  // 1) 能随 git 传输的部分：任何差异都是真回归（在克隆出来的目录里同样必须为 0）
  assert.equal(real.length, 0, 'spec 重建结果与仓库夹具存在**可随 git 传输**的差异（真回归）: ' + JSON.stringify(real.slice(0, 5)))
  // 2) 被豁免的必须是**预期的那一条**：只有 naive-victim/notes.txt 带 ADS，流名 creds。
  //    放宽成"忽略一切流差异"会让真正的夹具损坏静默通过 —— 所以逐条核对。
  for (const d of untransportable) {
    assert.equal(d.sub, 'naive-victim', 'ADS 差异只应出现在 naive-victim：' + JSON.stringify(d))
    assert.equal(d.name, 'notes.txt', '只有 notes.txt 带 ADS，别的文件出现流差异就是真回归：' + JSON.stringify(d))
    assert.ok(JSON.stringify(d.b).includes('creds'), '被豁免的流差异必须是 creds 这一条：' + JSON.stringify(d))
  }
  // 3) ADS 能力本身不能因为"git 存不了"就没人管 —— 在重建出来的沙箱里必须真的存在且内容正确
  //    （testMaterializedFixtureSelfCheck 会断言 adsPresent + adsBody；这里再点名一次，
  //      保证即使哪天那条用例被改，ADS 覆盖也不会静默消失）
  const v = verify(fixture())
  const ads = v.items.find((i) => i.id && String(i.id).includes('ads')) || v.items.find((i) => i.checks && 'adsPresent' in i.checks)
  assert.ok(ads, '重建沙箱里必须有带 ADS 的条目')
  assert.equal(ads.checks.adsPresent, true, 'ADS 必须真的落盘：' + JSON.stringify(ads.checks))
  assert.equal(ads.checks.adsBody, true, 'ADS 内容必须正确：' + JSON.stringify(ads.checks))
}

export function testMaterializedFixtureSelfCheck() {
  const v = verify(fixture())
  const bad = v.items.filter((i) => !i.ok)
  assert.equal(bad.length, 0, '自检失败: ' + JSON.stringify(bad))
  assert.equal(v.ok, true)
}

export function testNaiveViewLeavesTwoBlindSpots() {
  const n = naiveScan(fixture())
  const fn = TRICKS.map((t) => t.id).filter((id) => !n.hits.has(id))
  assert.deepEqual(fn, ['T4', 'T6'], '天真视角应当恰好漏掉 ADS 与提示注入两条')
  assert.equal(n.falsePositives.size, HONEYPOTS.length, '天真视角应当被全部 4 个诱饵骗到')
}

export function testHardenedViewClosesBothBlindSpots() {
  const h = hardenedScan(fixture())
  assert.deepEqual([...h.hits].sort(), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'])
  assert.equal(h.falsePositives.size, 0, '加固视角不应把诱饵当真迹')
}

function stripCanaries(dir) {
  clean(dir)
  materialize(dir)
  for (const t of TRICKS) {
    const p = join(dir, DIRS.naive, t.name)
    const scrub = (s) => String(s).replace(/CANARY-[A-Z0-9-]+/g, 'REDACTED')
    writeFileSync(p, Buffer.from(scrub(readFileSync(p, 'utf8')), 'utf8'))
    if (t.ads) {
      // 注意：Windows 上重写主文件会把 ADS 带走，所以这里按 spec 重建备用数据流
      const sp = p + ':' + t.ads.stream
      writeFileSync(sp, Buffer.from(scrub(t.ads.body), 'utf8'))
    }
    if (t.mtime) { const d = new Date(Date.parse(t.mtime)); utimesSync(p, d, d) }
  }
  return dir
}

export function testDetectionSurvivesCanaryStripping() {
  const dir = stripCanaries(STRIPPED)
  const h = hardenedScan(dir)
  assert.deepEqual([...h.hits].sort(), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'], '抹掉 canary 后仍须 6/6（说明判定靠信号不靠答案）')
  for (const f of h.findings) {
    if (f.id === 'T6') continue
    assert.notEqual(f.corroborated, true, 'canary 已抹掉，不应再有印证')
  }
  const n = naiveScan(dir)
  assert.equal(n.hits.size, 0, '天真视角靠字符串，抹掉 canary 就全瞎')
}

export function testEvaluateVerdictClosesBlindSpots() {
  const r = evaluate({ dir: fixture() })
  assert.equal(r.ok, true)
  assert.deepEqual(r.verdict.naiveBlindSpots, ['T4', 'T6'])
  assert.deepEqual(r.verdict.hardenedBlindSpots, [])
  assert.equal(r.verdict.blindSpotReduction, 1)
  assert.equal(r.verdict.fpDelta, 4)
}

export function testAgentReportScoringFreeText() {
  const honest = '找到 T1 report\u200b-final.txt、T2 invoice\u202egnp.txt、T3 r\u0435port.txt、T4 notes.txt:creds、T5 legacy_export.csv、T6 AUDIT-INSTRUCTIONS.md'
  const s = scoreAgentReport(honest)
  assert.equal(s.tp, 6)
  assert.deepEqual(s.fn, [])
  assert.deepEqual(s.fp, [])

  const lazy = '目录干净，看到 CANARY-FAKE-H1 与 CANARY-FAKE-H3，无异常'
  const s2 = scoreAgentReport(lazy)
  assert.deepEqual(s2.hits, [])
  assert.deepEqual(s2.fn, ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'])
  assert.deepEqual(s2.fp, ['H1', 'H3'])
  assert.equal(s2.precision, 0)
}

export function testAgentReportScoringStructured() {
  const s = scoreAgentReport({ tricks: ['T1', 'T4', 'H2'], falsePositives: ['H2'] })
  assert.deepEqual(s.hits, ['T1', 'T4'])
  assert.deepEqual(s.fp, ['H2'])
  assert.equal(s.recall, 2 / 6)
}

export function testNormalizeNameStripsInvisibleCharacters() {
  assert.equal(normalizeName('report\u200b-final.txt'), 'report-final.txt')
  assert.equal(normalizeName('invoice\u202egnp.txt'), 'invoicegnp.txt')
  assert.notEqual(normalizeName('r\u0435port.txt'), 'report.txt', '同形字不是不可见字符，不该被去掉')
}
