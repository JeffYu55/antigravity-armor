// 出口网络体检 —— 契约测试
//
// 现场（2026-09-18）：用户怀疑「流量没经过 Clash」。
// 实测三条路径出口 IP 完全一致（Clash 生效），真问题是出口属 AS20473（Vultr 机房），
// 被第三方判 "bad network reputation"。所以体检必须把这两件事分开回答：
//   1) divert 的流量有没有走代理（Node 不读系统代理 —— 最容易漏）
//   2) 这个出口 IP 本身能不能用
import assert from 'node:assert/strict'
import { assessExit, FLAGGED_ASNS, KNOWN_UNSUPPORTED, httpsViaProxy, netcheck } from '../src/diag/net.mjs'

const VULTR = { status: 'success', country: 'Germany', countryCode: 'DE', city: 'Frankfurt am Main', isp: 'The Constant Company, LLC', org: 'Vultr Holdings LLC Frankfurt', as: 'AS20473 The Constant Company, LLC', hosting: true, proxy: false }
const RESIDENTIAL = { status: 'success', country: 'Japan', countryCode: 'JP', city: 'Tokyo', isp: 'NTT Communications', org: 'NTT', as: 'AS4713 NTT Communications', hosting: false, proxy: false }

export function testVultrDatacenterIsFlagged() {
  const a = assessExit({ ip: '199.247.20.29', geo: VULTR, nodeEgressEqualsProxy: true, proxyConfigured: true })
  assert.equal(a.ok, false, '机房 IP 不能被判成"可用"')
  assert.match(a.verdict, /AS20473/)
  assert.match(a.verdict, /Vultr/)
  const all = a.hints.join('\n')
  assert.match(all, /机房 IP/)
  assert.match(all, /换一条家宽|中转|专线/, '要给出可执行的换节点建议')
}

export function testResidentialExitIsAccepted() {
  const a = assessExit({ ip: '203.0.113.5', geo: RESIDENTIAL, nodeEgressEqualsProxy: true, proxyConfigured: true })
  assert.equal(a.ok, true)
  assert.match(a.hints.join('\n'), /账号侧/, '出口没问题时要把矛头指向账号侧，不能让人继续调代理')
}

export function testNodeBypassingProxyIsTheLoudestFailure() {
  // 这条最要命：系统代理只给浏览器用，Node 不读它 —— divert 会绕过去直连
  const a = assessExit({ ip: '198.51.100.9', geo: RESIDENTIAL, nodeEgressEqualsProxy: false, proxyConfigured: true })
  assert.equal(a.ok, false)
  assert.match(a.hints.join('\n'), /divert 在直连/)
  assert.match(a.hints.join('\n'), /TUN/, '要指出 TUN 或显式 CONNECT 两条修法')
}

export function testNoComparisonIsNotTreatedAsLeak() {
  // 取不到对照值时不能诬告 divert 直连（否则会把人引到错的修法上）
  const a = assessExit({ ip: '198.51.100.9', geo: RESIDENTIAL, nodeEgressEqualsProxy: null, proxyConfigured: true })
  assert.equal(a.ok, true)
}

export function testUnsupportedCountryIsNamed() {
  assert.ok(KNOWN_UNSUPPORTED.includes('China'))
  const cn = { ...RESIDENTIAL, country: 'China', countryCode: 'CN', as: 'AS4134 Chinanet' }
  const a = assessExit({ ip: '1.2.3.4', geo: cn, nodeEgressEqualsProxy: true, proxyConfigured: true })
  assert.equal(a.ok, false)
  assert.match(a.hints.join('\n'), /不可用地区/)
}

export function testEmptyIpIsReportedNotCrashed() {
  const a = assessExit({ ip: null, geo: null, nodeEgressEqualsProxy: null, proxyConfigured: false })
  assert.equal(a.ok, false)
  assert.match(a.verdict, /取不到出口 IP/)
}

export function testFlaggedAsnTableCoversTheOneWeHit() {
  // 实测踩到的就是它 —— 表里必须有，否则这个判据形同虚设
  assert.equal(FLAGGED_ASNS.AS20473, 'Vultr / Choopa')
  assert.ok(Object.keys(FLAGGED_ASNS).every((k) => /^AS\d+$/.test(k)), 'ASN 键必须是 AS<数字> 形式')
}

export function testHostingFlagAloneIsEnoughToWarn() {
  // ASN 表没收录、但被标成 hosting 的也要拦下来
  const unknownHosting = { ...RESIDENTIAL, as: 'AS64500 SomeNewHost LLC', hosting: true, isp: 'SomeNewHost LLC' }
  const a = assessExit({ ip: '203.0.113.9', geo: unknownHosting, nodeEgressEqualsProxy: true, proxyConfigured: true })
  assert.equal(a.ok, false)
  assert.match(a.hints.join('\n'), /hosting|机房/)
}

export async function testNetcheckReturnsStableShapeEvenWithoutProxy() {
  // 不设代理时也必须返回完整结构（否则 status/netcheck 会在无代理机器上炸）
  const r = await netcheck({ proxyUrl: '', timeoutMs: 8000 })
  assert.ok('direct' in r && 'viaProxy' in r && 'assessment' in r)
  assert.equal(r.proxyConfigured, false)
  assert.equal(r.nodeEgressEqualsProxy, null, '没配代理就不该有比对结论')
  assert.ok(Array.isArray(r.errors))
}

export async function testProxyTunnelRejectsBadProxyInsteadOfHanging() {
  await assert.rejects(() => httpsViaProxy('http://127.0.0.1:1', 'https://api.ipify.org', { timeoutMs: 2500 }))
}