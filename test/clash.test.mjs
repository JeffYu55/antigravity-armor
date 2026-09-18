// Clash 路由实况 —— 契约测试
//
// 现场（2026-09-18 用户提问）：「clash 的节点是德国的，为什么走到了日本」
// mihomo 亲口答案：PROXY[Selector].now = AUTO，AUTO[URLTest].now = onlinespace-hy2。
// 即 **主组挂在自动测速组上时，界面上手选的节点不生效**。这些用例把这条锁死。
import assert from 'node:assert/strict'
import { assessRouting, dechunk, extractRegion, httpOverPipe, readClash } from '../src/diag/clash.mjs'

// 实测现场的策略组快照
const LIVE_GROUPS = [
  { name: 'AUTO', type: 'URLTest', now: 'onlinespace-hy2', all: ['onlinespace-hy2', 'onlinespace-reality'] },
  { name: 'GLOBAL', type: 'Selector', now: 'DIRECT', all: ['DIRECT', 'REJECT', 'AUTO', 'PROXY'] },
  { name: 'PROXY', type: 'Selector', now: 'AUTO', all: ['AUTO', 'onlinespace-hy2', 'onlinespace-reality', 'DIRECT'] },
]
const LIVE_CONNS = [{ host: 'accounts.google.com', chains: ['onlinespace-hy2', 'AUTO', 'PROXY'], rule: 'MATCH' }]

export function testAutoGroupSwallowsManualSelection() {
  const r = assessRouting({ groups: LIVE_GROUPS, connections: LIVE_CONNS, exitCountry: 'DE' })
  assert.equal(r.autoGroup, 'AUTO', '必须认出主组挂在自动测速组上')
  assert.equal(r.autoNode, 'onlinespace-hy2')
  const all = r.warns.join('\n')
  assert.match(all, /手选的节点\*\*不生效\*\*/)
  assert.match(all, /选\*\*具体节点\*\*/, '要给出可执行修法')
}

export function testManualSelectionIsSilentWhenGroupIsNotAuto() {
  // 主组直接选了具体节点 —— 这时候手选是真生效的，不能瞎报
  const groups = [
    { name: 'AUTO', type: 'URLTest', now: 'jp-01', all: ['jp-01', 'de-01'] },
    { name: 'PROXY', type: 'Selector', now: 'de-01', all: ['AUTO', 'jp-01', 'de-01'] },
  ]
  const r = assessRouting({ groups, connections: [{ host: 'x.googleapis.com', chains: ['de-01', 'PROXY'] }], exitCountry: 'DE' })
  assert.equal(r.autoGroup, null)
  assert.equal(r.warns.length, 0, '手选生效时不该有告警：' + r.warns.join(' / '))
  assert.equal(r.nodeName, 'de-01')
}

export function testNodeLabelVersusRealExitCountry() {
  // 中转/专线：节点名写德国，实测落地日本 —— 这正是用户看到的现象
  const groups = [{ name: 'PROXY', type: 'Selector', now: '🇩🇪德国01-专线', all: ['🇩🇪德国01-专线'] }]
  const r = assessRouting({ groups, connections: [{ host: 'daily-cloudcode-pa.googleapis.com', chains: ['🇩🇪德国01-专线', 'PROXY'] }], exitCountry: 'JP' })
  assert.equal(r.claimed, 'DE')
  assert.match(r.warns.join('\n'), /标称 DE，但\*\*实测出口国家是 JP\*\*/)
}

export function testLabelMatchesExitIsSilent() {
  const groups = [{ name: 'PROXY', type: 'Selector', now: '🇯🇵日本东京06-高速专线', all: [] }]
  const r = assessRouting({ groups, connections: [{ host: 'y.googleapis.com', chains: ['🇯🇵日本东京06-高速专线', 'PROXY'] }], exitCountry: 'JP' })
  assert.equal(r.claimed, 'JP')
  assert.equal(r.warns.length, 0)
}

export function testExtractRegionReadsFlagsAndWords() {
  assert.equal(extractRegion('🇯🇵日本东京06-0.1倍 | 高速专线推荐'), 'JP')
  assert.equal(extractRegion('🇸🇬新加坡01 | 电信联通推荐'), 'SG')
  assert.equal(extractRegion('🇺🇸美国01-0.1倍'), 'US')
  assert.equal(extractRegion('Hysteria2-东京'), 'JP')
  assert.equal(extractRegion('onlinespace-hy2'), null, '认不出地区时必须返回 null，不能瞎猜')
  assert.equal(extractRegion('onlinespace-reality'), null, '认不出地区时必须返回 null，不能瞎猜')
  assert.equal(extractRegion(''), null)
}

export function testCountryCodeMustBeAnIsolatedToken() {
  // 实测踩过的误报：`onlinespace-hy2` 里的 "nl" 被判成荷兰，而实际出口是德国。
  // 这类误报比不报更坏 —— 它会让人去改一个根本没问题的设置。
  assert.equal(extractRegion('onlinespace-hy2'), null)
  assert.equal(extractRegion('onlinespace-reality'), null)
  assert.equal(extractRegion('JPEGPROXY'), null, '两位码粘在别的词里不能当地区')
  assert.equal(extractRegion('mydeployment'), null, '两位码粘在别的词里不能当地区')
  assert.equal(extractRegion('xyz12'), null, '不认识的两位码不能当地区')
  // 整词就是地名时要认得出来（这不是误报，是有效信号）
  assert.equal(extractRegion('netherlandsBackup'), 'NL')
  assert.equal(extractRegion('JP01'), 'JP')
  assert.equal(extractRegion('sg-02'), 'SG')
  assert.equal(extractRegion('US 01 | 高速'), 'US')
  assert.equal(extractRegion('de_03'), 'DE')
  assert.equal(extractRegion('uk-01'), 'GB', 'UK 要归一到 GB')
}

export function testNoGoogleTrafficIsReportedNotGuessed() {
  // 没有 googleapis 连接时不能编造链路
  const r = assessRouting({ groups: LIVE_GROUPS, connections: [{ host: 'pr.map.qq.com', chains: ['onlinespace-hy2', 'AUTO', 'PROXY'] }], exitCountry: 'DE' })
  assert.equal(r.chain, null)
  assert.equal(r.nodeName, 'onlinespace-hy2', '没有目标连接时可以退回自动组的当前选中')
}

export function testDechunkHandlesRealMihomoShape() {
  const body = '{"proxies":{"AUTO":{"type":"URLTest"}}}'
  const hex = body.length.toString(16)
  const raw = Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' + hex + '\r\n' + body + '\r\n0\r\n\r\n')
  assert.equal(dechunk(raw), body)
  // 非分块（外控端口走 HTTP 时）也要能读
  const plain = Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello')
  assert.equal(dechunk(plain), 'hello')
}

export async function testReadClashNeverThrows() {
  const r = await readClash({ pipes: ['\\\\.\\pipe\\definitely-not-a-pipe-aarmor'], ports: [], timeoutMs: 800 })
  assert.equal(r.ok, false)
  assert.ok(Array.isArray(r.groups) && Array.isArray(r.connections))
  assert.match(r.reason, /读不到/)
}

export async function testPipeReaderReturnsNullOnMissingPipe() {
  assert.equal(await httpOverPipe('\\\\.\\pipe\\definitely-not-a-pipe-aarmor', '/proxies', { timeoutMs: 600 }), null)
}

export async function testReadClashLiveIfAvailable() {
  // 本机有 Clash 时必须能读到策略组（无则跳过，不算失败）
  const r = await readClash({ timeoutMs: 2500 })
  if (!r.ok) return
  assert.ok(r.groups.length > 0, '读到了接口却没解析出策略组')
  assert.ok(r.groups.every((g) => typeof g.name === 'string'), '策略组结构不对')
}