// 语言服务器直连出站体检 —— 契约测试
//
// 样本**逐字抄自** 2026-09-20 16:3x 的实机日志（~/.gemini 那台机器的
// %APPDATA%\Antigravity\logs\language_server.log），不是凭记忆写的形状 ——
// 这条纪律 v1.7.2 已经用一次 P0 交过学费（extractSseText 按裸形状读，闸门从来没读到过字）。
//
// 现场一句话：Clash 关掉 TUN/系统代理后本机到 Google 直连不通；
// divert（Node，读 HTTPS_PROXY）照旧活着，语言服务器（Go，不读注册表系统代理）拿不到令牌，
// GUI 于是弹 "There was a network issue connecting to the server, please try again."
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scanLsOutage, assessLsRoute, parseLsStamp, tcpProbe, probeLsDirect,
  newestLsLog, userEnvProxy, LS_DIRECT_HOSTS, LS_OUTAGE_PATTERNS,
} from '../src/diag/lsnet.mjs'

const T0 = new Date(2026, 8, 20, 16, 35, 0).getTime() // 用户报错那一刻（16:35）

const REAL = [
  'ERROR: logging before google.Init: I0920 14:41:12.815062       1 server.go:1487] Starting language server process with pid 23328',
  'ERROR: logging before google.Init: I0920 14:41:13.422012       1 auth_provider.go:1350] [AuthProvider] UpdateEndpointURL skipping update for custom configCloudCodeURL: "http://127.0.0.1:50100/appppppppppppppppp"',
  'ERROR: logging before google.Init: E0920 16:31:48.254766     106 server.go:764] Failed to get OAuth token: failed to compute token: Post "https://oauth2.googleapis.com/token": dial tcp 173.194.202.95:443: connectex: A connection attempt failed because the connected party did not properly respond after a period of time, or established connection failed because connected host has failed to respond.',
  'ERROR: logging before google.Init: E0920 16:33:14.836496     106 client.go:68] Post "https://play.googleapis.com/log": dial tcp 172.217.119.4:443: i/o timeout',
  'ERROR: logging before google.Init: W0920 16:33:11.862762   80742 cache.go:56] Cache(userInfo): Singleflight refresh failed: Post "http://127.0.0.1:50100/appppppppppppppppp/v1internal:fetchUserInfo": Post "https://oauth2.googleapis.com/token": dial tcp 173.194.202.95:443: connectex: A connection attempt failed because the connected party did not properly respond after a period of time, or established connection failed because connected host has failed to respond.',
  'ERROR: logging before google.Init: E0920 16:32:37.691034   80460 errorreport.go:223] request would have ended on a model turn (trajectory e64b23a4-9204-4732-9138-60837f7fa637, generator metadata 2636)',
].join('\n')

export function testRealOutageIsDetectedActive() {
  // 这条就是用户报的那个错：日志尾部是拿不到令牌，且是新鲜的
  const r = scanLsOutage(REAL, { now: T0 })
  assert.equal(r.active, true, '16:31 的故障在 16:35 看必须是「正在发生」')
  assert.equal(r.kind, 'oauth', '外层症状是拿不到 OAuth 令牌')
  assert.ok(r.count >= 2, '至少两条（oauth2 与 play）')
  assert.match(r.verdict, /语言服务器出站故障/)
  assert.match(r.hits.map((h) => h.line).join('\n'), /e64b23a4|oauth2\.googleapis\.com/)
}

export function testPlainDialFailureIsClassifiedAsDirect() {
  const one = 'ERROR: logging before google.Init: E0920 16:33:14.836496     106 client.go:68] Post "https://play.googleapis.com/log": dial tcp 172.217.119.4:443: i/o timeout'
  const r = scanLsOutage(one, { now: T0 })
  assert.equal(r.active, true)
  assert.equal(r.kind, 'direct-dial')
}

export function testStaleOutageDoesNotStayActive() {
  // 昨天自愈过的故障不该一直挂在告警里（与 upstream.mjs「只看最后一次成功之后」同一纪律）
  const r = scanLsOutage(REAL, { now: T0 + 3 * 3600 * 1000 })
  assert.equal(r.active, false)
  assert.ok(r.count >= 2, '取证仍要留着（count/verdict），只是不报警')
}

export function testDivertDownIsItsOwnClass() {
  const one = 'ERROR: logging before google.Init: E0920 17:02:00.1     1 server.go:764] Post "http://127.0.0.1:50100/appppppppppppppppp/v1internal:loadCodeAssist": dial tcp 127.0.0.1:50100: connectex: No connection could be made because the target machine actively refused it.'
  const r = scanLsOutage(one, { now: T0 + 30 * 60 * 1000 })
  assert.equal(r.kind, 'divert-down', 'divert 不在要和「墙」分开报，修法完全不同')
  assert.match(r.hits[0].why, /divert/)
}

export function testBadEnvProxyIsItsOwnClass() {
  const one = 'ERROR: logging before google.Init: E0920 16:40:00.1   1 client.go:68] Post "https://oauth2.googleapis.com/token": proxyconnect tcp: dial tcp 127.0.0.1:7897: connectex: No connection could be made'
  const r = scanLsOutage(one, { now: T0 + 5 * 60 * 1000 })
  assert.equal(r.kind, 'proxy')
}

export function testCleanLogIsQuiet() {
  const r = scanLsOutage(REAL.split('\n').slice(0, 2).join('\n'), { now: T0 })
  assert.equal(r.active, false)
  assert.equal(r.count, 0)
}

export function testStampIsParsedWithoutYear() {
  const d = parseLsStamp('ERROR: logging before google.Init: E0920 16:31:48.254766     106 server.go:764] x', T0)
  assert.ok(d)
  assert.equal(d.getMonth(), 8)
  assert.equal(d.getDate(), 20)
  assert.equal(d.getHours(), 16)
  assert.equal(d.getMinutes(), 31)
  assert.equal(d.getSeconds(), 48)
  assert.equal(parseLsStamp('no timestamp here', T0), null)
}

export function testYearRolloverGoesBackwards() {
  // 12 月看 1 月的日志：不能算成「未来」
  const now = new Date(2026, 0, 2, 10, 0, 0).getTime()
  const d = parseLsStamp('E1231 23:00:00.1 1 x.go:1] y', now)
  assert.equal(d.getFullYear(), 2025)
}

export function testBlockedDirectWithoutEnvProxyIsFatal() {
  const a = assessLsRoute({ directOk: false, envProxy: { present: false, https: null, http: null, port: null } })
  assert.equal(a.ok, false)
  const all = a.hints.join('\n')
  assert.match(all, /TUN/, '必须给 TUN（对 LS 透明且不用重启 Antigravity）')
  assert.match(all, /用户级环境变量|HTTPS_PROXY/, '必须给环境变量那条持久修法')
  assert.match(all, /无效/, '必须点明「只开系统代理对 Go 的 LS 无效」，否则用户会在这条上白耗')
}

export function testEnvProxyCoversBlockedDirect() {
  const a = assessLsRoute({ directOk: false, envProxy: { present: true, https: 'http://127.0.0.1:7897', http: 'http://127.0.0.1:7897', port: 7897 } })
  assert.equal(a.ok, true, '有环境变量代理时 LS 是通的 —— 不能诬告')
  assert.match(a.hints.join('\n'), /环境变量代理/)
}

export function testEnvProxyThatItselfFailsIsReported() {
  const a = assessLsRoute({ directOk: false, viaProxyOk: false, envProxy: { present: true, https: 'http://127.0.0.1:7897' } })
  assert.equal(a.ok, false)
  assert.match(a.hints.join('\n'), /代理本身连不上/)
}

export function testDirectOkNeedsNoProxy() {
  const a = assessLsRoute({ directOk: true, envProxy: { present: false } })
  assert.equal(a.ok, true)
}

export function testPatternTableCoversEveryRealString() {
  // 表里少一条 = 这个判据在真机上形同虚设（v1.7.0 的漏检就是这么来的）
  const kinds = LS_OUTAGE_PATTERNS.map((p) => p.kind)
  for (const k of ['divert-down', 'proxy', 'oauth', 'direct-dial']) assert.ok(kinds.includes(k), '缺 ' + k)
  assert.ok(LS_DIRECT_HOSTS.some((h) => h.host === 'oauth2.googleapis.com'), 'OAuth 口子必须在直连清单里')
}

export function testTcpProbeClosedPortResolvesFalse() {
  return tcpProbe('127.0.0.1', 1, { timeoutMs: 1500 }).then((r) => {
    assert.equal(r.ok, false)
    assert.ok(typeof r.ms === 'number')
  })
}

export async function testProbeLsDirectReturnsFullShapeEvenWhenBlocked() {
  const r = await probeLsDirect({ timeoutMs: 1200, hosts: [{ host: '127.0.0.1', port: 1, what: 'closed' }] })
  assert.equal(r.ok, false)
  assert.equal(r.rows.length, 1)
  assert.ok('ms' in r.rows[0])
}

export function testNewestLsLogSkipsEmptyFiles() {
  // IDE 每次重启都会新建一个 0 字节的 language_server.log —— 空文件不能盖过有内容的那份
  const dir = mkdtempSync(join(tmpdir(), 'aarmor-lsnet-'))
  const oldf = join(dir, 'language_server.log')
  const newf = join(dir, 'ls-main.log')
  writeFileSync(oldf, REAL)
  writeFileSync(newf, '')
  const now = Date.now() / 1000
  utimesSync(newf, now, now)
  utimesSync(oldf, now - 600, now - 600)
  // 只喂这两个文件，验证「跳过空文件」这条规则本身
  const got = newestLsLog({ logDir: dir }, { candidates: [oldf, newf] })
  assert.ok(got)
  assert.equal(got.path, oldf, '空文件必须被跳过')
}

export function testUserEnvProxyShape() {
  const p = userEnvProxy()
  for (const k of ['https', 'http', 'no', 'port', 'present']) assert.ok(k in p, '缺字段 ' + k)
  assert.equal(typeof p.present, 'boolean')
}
