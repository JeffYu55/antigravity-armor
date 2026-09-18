// Clash / mihomo 路由实况（v1.7.8）
//
// 为什么需要（2026-09-18 用户的直接提问）：
//   「clash 的节点是德国的，为什么走到了日本」
//   实测 mihomo 自己的回答：
//     PROXY  [Selector] now = AUTO              <- 主组挂在 AUTO 上，不是某个具体节点
//     AUTO   [URLTest]  now = onlinespace-hy2   <- AUTO 自动测速挑，谁快走谁
//     accounts.google.com  chain=["onlinespace-hy2","AUTO","PROXY"]
//   也就是说：**当主组是 AUTO(url-test) 时，你在界面上手选的节点根本不生效** ——
//   走哪个国家由自动测速决定（从国内看，日本东京往往延迟最低 → 于是"走到日本"）。
//
// 另一个常见误解是「节点标称地区 = 实际落地地区」：中转/专线节点入口与落地是两台机器。
// 所以这个模块把「节点名里写的地区」与「实测出口国家」摆在一起比对。
import net from 'node:net'

export const DEFAULT_PIPES = ['\\\\.\\pipe\\verge-mihomo', '\\\\.\\pipe\\clash-verge', '\\\\.\\pipe\\clash-meta', '\\\\.\\pipe\\mihomo']

/** 走 named pipe 发一次 HTTP（mihomo 控制接口在 Windows 上就挂在管道上） */
export function httpOverPipe(pipe, path, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(pipe)
    let buf = Buffer.alloc(0)
    const done = (v) => { try { s.destroy() } catch {} ; resolve(v) }
    s.setTimeout(timeoutMs, () => done(null))
    s.on('connect', () => s.write('GET ' + path + ' HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'))
    s.on('data', (d) => { buf = Buffer.concat([buf, d]) })
    s.on('end', () => done(buf))
    s.on('error', () => done(null))
  })
}

/** 解 chunked 响应体（mihomo 默认分块） */
export function dechunk(buf) {
  if (!buf || !buf.length) return ''
  const i = buf.indexOf('\r\n\r\n')
  if (i < 0) return buf.toString('utf8')
  const head = buf.slice(0, i).toString('utf8')
  const body = buf.slice(i + 4)
  if (!/transfer-encoding:\s*chunked/i.test(head)) return body.toString('utf8')
  let out = Buffer.alloc(0); let off = 0
  while (off < body.length) {
    const eol = body.indexOf('\r\n', off)
    if (eol < 0) break
    const size = parseInt(body.slice(off, eol).toString('utf8').trim(), 16)
    if (!size || Number.isNaN(size)) break
    out = Buffer.concat([out, body.slice(eol + 2, eol + 2 + size)])
    off = eol + 2 + size + 2
  }
  return out.toString('utf8')
}

const GROUP_TYPES = ['Selector', 'URLTest', 'Fallback', 'LoadBalance']
const AUTO_TYPES = ['URLTest', 'Fallback', 'LoadBalance']

/** 认可的两位国家码。**必须按独立 token 匹配** —— 否则 `onlinespace` 里的 "nl"
 *  会被当成荷兰（实测踩过：节点名 onlinespace-hy2 被判成 NL，而实际出口是 DE）。
 *  这类误报比不报更坏：它会让人去改一个根本没问题的设置。 */
export const COUNTRY_CODES = new Set(['JP', 'SG', 'HK', 'TW', 'US', 'KR', 'DE', 'GB', 'UK', 'FR', 'NL', 'CA', 'AU', 'TR', 'RU', 'IN', 'MY', 'VN', 'TH', 'PH', 'ID', 'IT', 'ES', 'SE', 'CH', 'FI', 'IE', 'PL', 'CZ', 'AT', 'BE', 'DK', 'NO', 'BR', 'MX', 'AR', 'CL', 'ZA', 'AE', 'SA', 'IL', 'NZ', 'UA', 'RO', 'PT', 'GR', 'HU', 'VN', 'MO', 'KH', 'MM', 'NP', 'PK', 'BD', 'LK', 'MN', 'KZ'])

/** 从节点名里抠出标称地区（旗子 emoji / 独立国家码 token / 常见中英文地名）。
 *  推演不出就返回 null —— **绝不猜**。 */
export function extractRegion(name) {
  const s = String(name || '')
  const flag = (s.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u) || [])[0]
  if (flag) {
    const A = 0x1f1e6
    return String.fromCharCode(flag.codePointAt(0) - A + 65, flag.codePointAt(2) - A + 65)
  }
  // 独立 token 上的国家码：JP / JP01 / us-01 / SG2 ...
  for (const t of s.split(/[^A-Za-z0-9]+/).filter(Boolean)) {
    const m = t.match(/^([A-Za-z]{2})\d*$/)
    if (m) {
      const cc = m[1].toUpperCase()
      if (COUNTRY_CODES.has(cc)) return cc === 'UK' ? 'GB' : cc
    }
  }
  const table = [
    [/(日本|东京|大阪|Japan|Tokyo)/i, 'JP'], [/(新加坡|狮城|Singapore)/i, 'SG'],
    [/(香港|Hong ?Kong)/i, 'HK'], [/(台湾|臺北|Taiwan|Taipei)/i, 'TW'],
    [/(美国|洛杉矶|西雅图|United States|Los Angeles|Seattle)/i, 'US'],
    [/(韩国|首尔|Korea|Seoul)/i, 'KR'],
    [/(德国|法兰克福|German|Frankfurt)/i, 'DE'],
    [/(英国|伦敦|London)/i, 'GB'], [/(法国|巴黎|France|Paris)/i, 'FR'],
    [/(荷兰|阿姆斯特丹|Netherland)/i, 'NL'], [/(加拿大|Canada|Toronto)/i, 'CA'],
    [/(澳大利亚|澳洲|Australia|Sydney)/i, 'AU'], [/(土耳其|Turkey|Istanbul)/i, 'TR'],
    [/(俄罗斯|Russia|Moscow)/i, 'RU'], [/(印度|India|Mumbai)/i, 'IN'],
    [/(马来西亚|Malaysia)/i, 'MY'], [/(越南|Vietnam)/i, 'VN'],
    [/(泰国|Thailand|Bangkok)/i, 'TH'], [/(菲律宾|Philippines|Manila)/i, 'PH'],
    [/(印尼|印度尼西亚|Indonesia|Jakarta)/i, 'ID'], [/(巴西|Brazil|Sao ?Paulo)/i, 'BR'],
    [/(阿根廷|Argentina)/i, 'AR'], [/(阿联酋|迪拜|Emirates|Dubai)/i, 'AE'],
  ]
  for (const [re, cc] of table) if (re.test(s)) return cc
  return null
}

/** 纯函数判读：谁在真正承载流量？手选生效了吗？ */
export function assessRouting({ groups = [], connections = [], exitCountry = null, target = 'googleapis' } = {}) {
  const byName = new Map(groups.map((g) => [g.name, g]))
  const warns = []
  // 1) 主组是不是挂在"自动测速组"上 —— 这是「手选不生效」的唯一原因
  let autoGroup = null
  let chain = null
  const primary = groups.find((g) => g.type === 'Selector' && g.now && byName.get(g.now) && AUTO_TYPES.includes(byName.get(g.now).type))
  if (primary) {
    autoGroup = byName.get(primary.now)
    warns.push('⚠ 主组「' + primary.name + '」挂在**自动测速组**「' + autoGroup.name + '」上 → 你在界面上手选的节点**不生效**，走哪个国家由自动测速决定（实测当前选中 ' + autoGroup.now + '）。')
    warns.push('  修法：点「' + primary.name + '」组，选**具体节点**（不要选 ' + autoGroup.name + '）。')
  }
  // 2) 目标流量的实际链路
  const t = String(target).toLowerCase()
  const conn = connections.find((c) => String(c.host || '').toLowerCase().includes(t))
  if (conn) chain = conn.chains
  const nodeName = (chain && chain[0]) || (autoGroup && autoGroup.now) || null
  const claimed = extractRegion(nodeName)
  if (claimed && exitCountry && claimed !== exitCountry) {
    warns.push('⚠ 节点「' + nodeName + '」标称 ' + claimed + '，但**实测出口国家是 ' + exitCountry + '** —— 中转/专线节点的入口与落地不是同一台机器，别信标签。')
  }
  return { autoGroup: autoGroup ? autoGroup.name : null, autoNode: autoGroup ? autoGroup.now : null, chain, nodeName, claimed, warns }
}

/** 真读：优先 named pipe，其次外控端口 */
export async function readClash({ pipes = DEFAULT_PIPES, ports = [], secret = '', timeoutMs = 4000 } = {}) {
  let via = null; let get = null
  for (const p of pipes) {
    const raw = await httpOverPipe(p, '/proxies', { timeoutMs })
    if (raw && /"proxies"/.test(raw.toString('utf8'))) { via = 'pipe ' + p; get = (path) => httpOverPipe(p, path, { timeoutMs }); break }
  }
  if (!get) {
    for (const port of ports) {
      try {
        const h = secret ? { Authorization: 'Bearer ' + secret } : {}
        const r = await fetch('http://127.0.0.1:' + port + '/proxies', { headers: h, signal: AbortSignal.timeout(timeoutMs) })
        if (r.ok) { via = 'http 127.0.0.1:' + port; get = async (path) => { const x = await fetch('http://127.0.0.1:' + port + path, { headers: h, signal: AbortSignal.timeout(timeoutMs) }); return Buffer.from(await x.text()) }; break }
      } catch {}
    }
  }
  if (!get) return { ok: false, reason: '读不到 Clash 控制接口（named pipe 与外控端口都没响应）', groups: [], connections: [] }
  const parse = (raw) => { try { return JSON.parse(dechunk(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)))) } catch { return null } }
  const pj = parse(await get('/proxies'))
  const groups = []; const nodes = []
  for (const [name, o] of Object.entries((pj && pj.proxies) || {})) {
    const h = o.history && o.history.length ? o.history[o.history.length - 1] : null
    if (GROUP_TYPES.includes(o.type)) groups.push({ name, type: o.type, now: o.now, all: o.all || [] })
    else if (!['Direct', 'Reject', 'Compatible', 'Pass'].includes(o.type)) nodes.push({ name, type: o.type, delay: h ? h.delay : null })
  }
  let connections = []
  try {
    const cj = parse(await get('/connections'))
    connections = ((cj && cj.connections) || []).map((c) => ({ host: c.metadata && (c.metadata.host || c.metadata.destinationIP), chains: c.chains || [], rule: c.rule }))
  } catch {}
  return { ok: true, via, groups, nodes, connections }
}