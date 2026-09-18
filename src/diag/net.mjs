// 出口网络体检（v1.7.7）
//
// 为什么需要（2026-09-18 实测现场）：
//   用户在 Antigravity 里看到
//     「Sorry, this account is ineligible to use Antigravity ... not currently available in your location」
//   直觉怀疑「流量是不是没经过 Clash」。实测三条路径出口 IP **完全一致**（199.247.20.29），
//   说明 Clash 是生效的（TUN + `MATCH,PROXY`）。真正的问题是**出口节点的信誉**：
//   该 IP 属于 AS20473（Vultr 机房），第三方直接以
//     "bad network reputation (AS20473)"
//   拒绝匿名访问 —— Google 同样无法从这个 IP 确认用户位置，于是判「地区不可用」。
//
// 所以体检要回答两个**不同**的问题，不能混为一谈：
//   1) divert 的流量到底有没有走代理？（Node 不读系统代理，这是最容易漏的一环）
//      -> 用同一条隧道显式走一遍代理，比对出口 IP；不一致 = divert 在直连，漏了。
//   2) 出口 IP 本身能不能用？（机房 ASN 信誉 / 国家是否在批准名单）
import http from 'node:http'
import tls from 'node:tls'
import { URL } from 'node:url'

/** 常见的机房/托管 ASN —— 这类 IP 被风控标成「无法确认位置」的概率很高 */
export const FLAGGED_ASNS = {
  AS20473: 'Vultr / Choopa',
  AS14061: 'DigitalOcean',
  AS63949: 'Akamai-Linode',
  AS24940: 'Hetzner',
  AS16276: 'OVH',
  AS16509: 'AWS',
  AS14618: 'AWS',
  AS31898: 'Oracle Cloud',
  AS45102: 'Alibaba Cloud',
  AS132203: 'Tencent Cloud',
  AS25820: 'IT7 / BandwagonHost',
  AS396982: 'Google Cloud',
  AS51167: 'Contabo',
  AS9009: 'M247',
  AS60781: 'LeaseWeb',
}

/** Antigravity 明确不可用的地区（FAQ 是白名单，这里只列最常见的黑名单用于早筛） */
export const KNOWN_UNSUPPORTED = ['China', 'Hong Kong', 'Russia', 'Iran', 'North Korea', 'Syria', 'Cuba', 'Belarus', 'Crimea']

const norm = (s) => String(s || '').replace(/^AS/i, '')

/** 走 HTTP 代理隧道的取回（CONNECT + TLS）—— 用来验证「显式走代理会得到什么 IP」 */
export function httpsViaProxy(proxyUrl, targetUrl, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let p, t
    try { p = new URL(proxyUrl); t = new URL(targetUrl) } catch (e) { return reject(e) }
    const req = http.request({ host: p.hostname, port: Number(p.port || 80), method: 'CONNECT', path: t.hostname + ':443', timeout: timeoutMs })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error('CONNECT ' + res.statusCode)) }
      const s = tls.connect({ socket, servername: t.hostname }, () => {
        s.write('GET ' + t.pathname + t.search + ' HTTP/1.1\r\nHost: ' + t.hostname + '\r\nConnection: close\r\n\r\n')
      })
      let buf = ''
      s.on('data', (d) => { buf += d.toString('utf8') })
      s.on('end', () => {
        const m = buf.match(/\r\n\r\n([\s\S]*)/)
        resolve((m ? m[1] : buf).trim())
      })
      s.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('CONNECT timeout')))
    req.end()
  })
}

/** 直连取回（Node 默认行为 —— divert 用的就是这条） */
export async function directText(url, { timeoutMs = 15000 } = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  return (await r.text()).trim()
}

const IP_ECHO = 'https://api.ipify.org'

/** 纯函数：根据出口信息给出判读（不联网，便于测试） */
export function assessExit({ ip, geo, nodeEgressEqualsProxy, proxyConfigured }) {
  const hints = []
  let ok = true
  if (!ip) return { ok: false, verdict: '取不到出口 IP（网络不通或被墙）', hints: ['先确认基础网络'] }
  const asn = geo && geo.as ? String(geo.as).split(' ')[0] : ''
  const asnKey = 'AS' + norm(asn)
  if (proxyConfigured && nodeEgressEqualsProxy === false) {
    ok = false
    // 这一条最要命：系统代理只给浏览器用，Node 不读它 —— divert 会绕过代理直连出去
    hints.push('⚠ 这台机器的 Node/divert 出口与「显式走代理」的出口**不一致** → divert 在直连，没走代理。')
    hints.push('  修法：给代理加 TUN 模式（全局接管），或让 divert 走代理（HTTPS_PROXY + CONNECT 隧道）。')
  }
  if (asnKey && FLAGGED_ASNS[asnKey]) {
    ok = false
    hints.push('⚠ 出口是**机房 IP**：' + asnKey + '（' + FLAGGED_ASNS[asnKey] + '）—— 风控常判为「无法确认位置」。')
    hints.push('  修法：换一条家宽/中转/专线节点，别用裸机房 IP。')
  } else if (geo && geo.hosting) {
    ok = false
    hints.push('⚠ 出口被标记为 hosting/datacenter（' + (geo.isp || '') + '）—— 同样是机房 IP。')
  }
  const country = geo ? geo.country : ''
  if (country && KNOWN_UNSUPPORTED.includes(country)) {
    ok = false
    hints.push('⚠ 出口国家「' + country + '」在 Antigravity 不可用地区里。')
  }
  if (ok) hints.push('出口看起来可用（非机房/非受限地区）。若仍被拒，问题在账号侧（见 aarmor status 的账号判读）。')
  return {
    ok,
    verdict: ip + (country ? '  ' + country : '') + (asnKey ? '  ' + asnKey + (FLAGGED_ASNS[asnKey] ? ' (' + FLAGGED_ASNS[asnKey] + ')' : '') : ''),
    hints,
  }
}

/** 真体检：直连出口 vs 显式走代理出口 */
export async function netcheck({ proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '', timeoutMs = 15000 } = {}) {
  const out = { direct: null, viaProxy: null, proxyConfigured: !!proxyUrl, errors: [] }
  try { out.direct = await directText(IP_ECHO, { timeoutMs }) } catch (e) { out.errors.push('direct: ' + e.message) }
  if (proxyUrl) {
    try { out.viaProxy = await httpsViaProxy(proxyUrl, IP_ECHO, { timeoutMs }) } catch (e) { out.errors.push('proxy: ' + e.message) }
  }
  let geo = null
  if (out.direct) {
    try {
      const r = await fetch('http://ip-api.com/json/' + out.direct + '?fields=status,country,countryCode,isp,org,as,hosting,proxy', { signal: AbortSignal.timeout(timeoutMs) })
      geo = await r.json()
    } catch (e) { out.errors.push('geo: ' + e.message) }
  }
  const nodeEgressEqualsProxy = (out.direct && out.viaProxy) ? out.direct === out.viaProxy : null
  out.geo = geo
  out.nodeEgressEqualsProxy = nodeEgressEqualsProxy
  out.assessment = assessExit({ ip: out.direct, geo, nodeEgressEqualsProxy, proxyConfigured: out.proxyConfigured })
  return out
}