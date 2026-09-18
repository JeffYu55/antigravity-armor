// LS 进程探测 —— 契约测试
//
// 锁死一条：status 说 LS 的状态必须以**真实进程**为准。
// 只读 state/ls.pid 会把 IDE 自己拉起的 LS 误报成 down（实测：IDE 明明在跑，
// status 却显示 down —— 与「divert 全绿但代理已死」同类误导）。
import assert from 'node:assert/strict'
import { parseFlag, summarizeLs, probeLanguageServers } from '../src/diag/ls.mjs'

const REAL = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\antigravity\\resources\\bin\\language_server.exe '
  + '--app_data_dir "C:\\Users\\Administrator\\.gemini\\antigravity" '
  + '--cloud_code_endpoint "http://127.0.0.1:50100/appppppppppppppppp" --csrf_token 6eaacc88-1111'

export function testParseFlagHandlesQuotedAndBareValues() {
  assert.equal(parseFlag(REAL, '--app_data_dir'), 'C:\\Users\\Administrator\\.gemini\\antigravity')
  assert.equal(parseFlag(REAL, '--cloud_code_endpoint'), 'http://127.0.0.1:50100/appppppppppppppppp')
  assert.equal(parseFlag(REAL, '--csrf_token'), '6eaacc88-1111')
  assert.equal(parseFlag(REAL, '--not_there'), null)
  // `--flag=value` 形式也要吃
  assert.equal(parseFlag('x --port=18606 y', '--port'), '18606')
}

export function testPaddedEndpointCountsAsViaDivert() {
  const r = summarizeLs([REAL], 50100)
  assert.equal(r.count, 1)
  assert.equal(r.viaDivert, 1)
  assert.match(r.summary, /running ×1/)
  assert.match(r.summary, /1 个指向 divert/)
}

export function testUnpaddedEndpointIsFlaggedLoudly() {
  // L4 补丁被 IDE 更新覆盖后，LS 会回到官方 host —— 这时必须喊出来，而不是显示"正常"
  const official = REAL.replace('http://127.0.0.1:50100/appppppppppppppppp', 'https://daily-cloudcode-pa.googleapis.com')
  const r = summarizeLs([official], 50100)
  assert.equal(r.count, 1)
  assert.equal(r.viaDivert, 0)
  assert.match(r.summary, /未指向 divert/)
}

export function testNoProcessIsReportedAsDownNotAsHealthy() {
  const r = summarizeLs([], 50100)
  assert.equal(r.count, 0)
  assert.equal(r.viaDivert, 0)
  assert.match(r.summary, /down/)
  // 多实例：IDE 常常会拉起不止一个 LS
  const two = summarizeLs([REAL, REAL.replace('antigravity"', 'antigravity-ide"')], 50100)
  assert.equal(two.count, 2)
  assert.equal(two.viaDivert, 2)
}

export function testProbeNeverThrowsAndNeverPretendsToBeHealthy() {
  // 探测失败要返回"未探到"，不能伪造成 down 也不算健康 —— 返回结构必须稳定
  const r = probeLanguageServers(50100)
  assert.equal(typeof r.count, 'number')
  assert.equal(typeof r.viaDivert, 'number')
  assert.ok(Array.isArray(r.entries))
  assert.equal(typeof r.summary, 'string')
  assert.ok(r.summary.length > 0)
  assert.ok(r.viaDivert <= r.count, '指向 divert 的个数不可能超过总数')
}