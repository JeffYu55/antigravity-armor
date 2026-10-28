// 语言服务器「直连出站」体检（v1.8.4）
//
// 现场（2026-09-20 16:31，用户报错原文）：
//   Unknown: There was a network issue connecting to the server, please try again.
//   Error ID: e64b23a4-9204-4732-9138-60837f7fa637-5374
//
// 而那一刻 `aarmor status` 是**全绿**的：divert LISTENING、binary ARMORED、
// 「上游健康：最近一次请求是 200」。因为全绿说的是**已过去**的事：
//   16:30:58  divert 最后一次 PASS-GATE 200（trajectory e64b23a4…）
//   16:31:48  LS 日志出现第一条 Failed to get OAuth token:
//               Post "https://oauth2.googleapis.com/token":
//               dial tcp 173.194.202.95:443: connectex: ...（直连超时）
//   16:33:02  同一时刻 Clash Verge 侧：enable_tun_mode=false、enable_system_proxy=false、
//               注册表 ProxyEnable=0、网卡列表里没有 TUN 适配器 —— **全机没有任何东西在接管直连**
//   16:33:11  Post "http://127.0.0.1:50100/.../v1internal:fetchUserInfo":
//               Post "https://oauth2.googleapis.com/token": dial tcp …: connectex （同一条）
//
// 为什么 L1–L5 全都拦不住这个故障：
//   L1 改的是判官提示词、L3 是钩子、L4 把 **v1internal:\*** 的 endpoint 指到 127.0.0.1:50100、
//   L5 是那条通道上的协议转换。而 **OAuth 换令牌 / 遥测 / 用户信息三个出站口根本不走 divert**，
//   它们硬编码在 LS 二进制里、直连 Google。这三个口子断了，请求在「发出去之前」就失败，
//   于是所有 v1internal 调用连 divert 都到不了 —— 表现就是 GUI 那句 network issue。
//
// 关键分歧（决定了修法）：
//   * divert 是 **Node 24** 进程：`https.request` 会读 HTTPS_PROXY/HTTP_PROXY（实测：带 env 502ms 通，
//     清空 env 直接 TIMEOUT）—— 所以 divert 一直活着，把故障掩盖成「代理链路正常」。
//   * LS 是 **Go 二进制**：只读 HTTP_PROXY/HTTPS_PROXY/NO_PROXY 环境变量
//     （二进制里能搜到 "HTTPS_PROXY"/"NO_PROXY"/"ProxyFromEnvironment"），
//     **不读 Windows 注册表里的系统代理** —— 所以「把 Clash 的系统代理打开」对它完全无效。
//   * 三条候选修法的代价差一个数量级：
//       ① Clash 开 **TUN**：内核层接管，对任何进程任何语言透明，且**不用重启 Antigravity**
//          （LS 每 ~30 秒重试一次换令牌，路由一通下次重试就成功）；
//       ② 写**用户级** HTTPS_PROXY/HTTP_PROXY/NO_PROXY（Go 读得到），需要重启 Antigravity 让 LS 继承；
//          ⚠ NO_PROXY 必须带 localhost,127.0.0.1 —— 否则 LS 打 divert（http://127.0.0.1:50100）
//          也会被塞进代理，等于亲手把改道链路掐掉。
//       ③ 只开 Clash「系统代理」：对 LS **无效**，别在这里浪费时间（会以为修了其实没有）。
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readText } from '../util/fs.mjs'

/** LS 绕过 divert 的三个直连出站口 —— 缺一个就等于缺全部 */
export const LS_DIRECT_HOSTS = [
  { host: 'oauth2.googleapis.com', port: 443, what: 'OAuth 换令牌（断了 = 每个接口在发出去之前就失败）' },
  { host: 'www.googleapis.com', port: 443, what: '用户信息 oauth2/v2/userinfo' },
  { host: 'play.googleapis.com', port: 443, what: '遥测上报（刷屏但不致命）' },
]

/** LS 日志里的故障形态。逐行判**第一个**命中就归那一类 —— 所以顺序即优先级。
 *  `proxy` 必须排在 `divert-down` 前面：一条代理失败的日志长这样
 *    `Post "https://oauth2.googleapis.com/token": proxyconnect tcp: dial tcp 127.0.0.1:7897: connectex: No connection could be made`
 *  —— 它同时含「127.0.0.1」和「No connection could be made」，但它是**代理**故障，
 *  修法（换代理/关代理）和 divert 不在（拉起 divert）完全不同。判错会把人支到错的修法上。 */
export const LS_OUTAGE_PATTERNS = [
  { re: /proxyconnect|Proxy Authentication Required|HTTP 407/i, kind: 'proxy', why: '走了代理但代理拒绝 —— HTTPS_PROXY 指向了一个连不上的代理' },
  { re: /dial tcp 127\.0\.0\.1:\d+: connectex: No connection could be made/i, kind: 'divert-down', why: 'LS 打本地 divert 被拒 —— divert 不在（见 status 的 divert 行）' },
  { re: /Failed to get OAuth token/i, kind: 'oauth', why: '拿不到 OAuth 令牌 —— 后续每个 v1internal 调用都会在发出去之前失败' },
  { re: /connectex|i\/o timeout|TLS handshake timeout/i, kind: 'direct-dial', why: '直连超时 —— LS 没有可用的出站路径（它不读系统代理）' },
]

/** glog 行首时间戳：`I0920 16:33:14.189989` / `E0920 16:31:48.254766`（无年份，按当下年份补） */
export function parseLsStamp(line, now = Date.now()) {
  const m = String(line).match(/[IEWF](\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/)
  if (!m) return null
  const base = new Date(now)
  // glog 的小数部分是**微秒**（6 位）。整个塞进 Date 的 ms 槽会被规范化成 +4 分多钟，
  // 于是一条 16:31:48 的日志被判成 16:36 —— 时间判读错 4 分钟，"新鲜度"判定就全歪了（实测踩过）。
  const ms = Number(String(m[6] || '0').padEnd(3, '0').slice(0, 3))
  const d = new Date(base.getFullYear(), Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), ms)
  // 跨年：日志日期比现在晚一天以上，说明是去年的（12 月看 1 月的日志）
  if (d.getTime() - now > 24 * 3600 * 1000) d.setFullYear(d.getFullYear() - 1)
  return d
}

/** 判读一段 LS 日志：有没有正在发生的出站故障？
 *  `active` 只在**新鲜**（距 now 不超过 freshMin）时为真 —— 否则会把昨天自愈过的故障一直挂着，
 *  和 upstream.mjs「只看最后一次成功之后」是同一条纪律。 */
export function scanLsOutage(logText, { now = Date.now(), freshMin = 20, tailLines = 400 } = {}) {
  const lines = String(logText || '').split('\n')
  const scope = lines.slice(-tailLines)
  const hits = []
  for (const line of scope) {
    for (const p of LS_OUTAGE_PATTERNS) {
      if (!p.re.test(line)) continue
      hits.push({ kind: p.kind, why: p.why, at: parseLsStamp(line, now), line: line.trim().slice(0, 400) })
      break
    }
  }
  if (!hits.length) return { active: false, kind: null, count: 0, last: null, ageMs: null, hits: [], verdict: '日志尾部没有出站故障记录' }

  const last = hits[hits.length - 1]
  const ageMs = last.at ? Math.max(0, now - last.at.getTime()) : null
  const active = ageMs == null ? true : ageMs <= freshMin * 60 * 1000
  const kinds = new Set(hits.map((h) => h.kind))
  // OAuth 拿不到令牌是**最外层**的症状：同一条日志里既有 dial 也有 OAuth，报 OAuth
  const kind = kinds.has('divert-down') ? 'divert-down' : kinds.has('oauth') ? 'oauth' : kinds.has('proxy') ? 'proxy' : 'direct-dial'
  const mint = (ms) => (ms == null ? '时间未知' : ms < 90_000 ? Math.round(ms / 1000) + ' 秒前' : Math.round(ms / 60000) + ' 分钟前')
  return {
    active,
    kind,
    count: hits.length,
    last,
    ageMs,
    kinds: [...kinds],
    hits: hits.slice(-4),
    verdict: '语言服务器出站故障 ×' + hits.length + '（最后一次 ' + mint(ageMs) + '，类型 ' + kind + '）',
  }
}

/** 纯函数：给定「直连通不通 / LS 有没有环境变量代理 / 日志怎么说」，给出判读与修法。
 *  这里刻意不联网，好让测试用真实抓到的故障样本把结论钉死。 */
export function assessLsRoute({ directOk, viaProxyOk = null, envProxy = null, outage = null } = {}) {
  const hasEnv = !!(envProxy && (envProxy.https || envProxy.http))
  const hints = []
  const blocked = directOk === false

  if (blocked && !hasEnv) {
    hints.push('⚠ 这台机器到 Google 的**直连**不通，而语言服务器**不会**读 Clash 的「系统代理」')
    hints.push('  （Go 二进制只读 HTTPS_PROXY/HTTP_PROXY/NO_PROXY 环境变量；注册表里的 ProxyEnable 它看不见）')
    hints.push('  修法①【最快，不用重启 Antigravity】Clash Verge 打开 **TUN 模式**：内核层接管直连，')
    hints.push('         LS 每 ~30 秒重试一次换令牌，路由一通下次重试就成功。')
    hints.push('  修法②【持久】把 HTTPS_PROXY=http://127.0.0.1:' + (envProxy && envProxy.port ? envProxy.port : 7897) + ' 与')
    hints.push('         NO_PROXY=localhost,127.0.0.1 写成**用户级环境变量**，然后重启 Antigravity（子进程只在启动时继承）。')
    hints.push('  修法③ 只开 Clash「系统代理」对 LS **无效** —— 别拿它当修复。')
    return { ok: false, verdict: '语言服务器无出站路径（直连不通 + 无环境变量代理）', hints, blocked, hasEnv }
  }
  if (blocked && hasEnv) {
    hints.push('直连不通，但 LS 继承了环境变量代理（HTTPS_PROXY=' + (envProxy && envProxy.https) + '）—— 这条路是通的。')
    if (viaProxyOk === false) hints.push('⚠ 但代理本身连不上（显式走代理也失败）—— 先修代理，再看 Antigravity。')
    return { ok: viaProxyOk !== false, verdict: '直连被墙，靠环境变量代理兜住', hints, blocked, hasEnv }
  }
  if (!blocked && !hasEnv) {
    hints.push('直连可达。若 Antigravity 仍报 network issue，看 outage 行的取证（可能是 divert 侧或账号态）。')
    return { ok: true, verdict: '直连可达（LS 不需要代理）', hints, blocked, hasEnv }
  }
  hints.push('直连可达且已配环境变量代理 —— 两条路都在，抗抖动。')
  return { ok: true, verdict: '直连可达 + 环境变量代理已配', hints, blocked, hasEnv }
}

/** 原生 TCP 探测（**不带任何代理**）—— 因为要回答的正是「LS 那条直连通不通」 */
export function tcpProbe(host, port, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const s = net.connect({ host, port })
    const done = (ok) => { try { s.destroy() } catch {} ; resolve({ ok, ms: Date.now() - t0 }) }
    s.setTimeout(timeoutMs, () => done(false))
    s.on('connect', () => done(true))
    s.on('error', () => done(false))
  })
}

/** 本机到 LS 三个直连出站口的实况。并发探，最慢的那个决定耗时。 */
export async function probeLsDirect({ timeoutMs = 4000, hosts = LS_DIRECT_HOSTS } = {}) {
  const rows = await Promise.all(hosts.map(async (h) => ({ ...h, ...(await tcpProbe(h.host, h.port, { timeoutMs })) })))
  return { ok: rows.every((r) => r.ok), rows }
}

/** 读**用户级**环境变量里的代理（LS 继承的就是它）。
 *  process.env 是我们自己的，不代表 GUI 进程 —— 这是这个故障最容易搞错的一步。 */
export function userEnvProxy() {
  let https = null; let http = null; let no = null
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment'], { encoding: 'utf8', timeout: 8000 })
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*(HTTPS_PROXY|HTTP_PROXY|NO_PROXY|ALL_PROXY)\s+REG_\w+\s+(.*)$/i)
      if (!m) continue
      const k = m[1].toUpperCase(); const v = m[2].trim()
      if (k === 'HTTPS_PROXY') https = v
      else if (k === 'HTTP_PROXY') http = v
      else if (k === 'NO_PROXY') no = v
      else if (!http) http = v
    }
  } catch { /* 非 Windows 或 reg 不可用 —— 当作没配 */ }
  const port = Number((String(https || http || '').match(/:(\d+)/) || [])[1]) || null
  return { https, http, no, port, present: !!(https || http) }
}

/** LS 日志的候选位置。**IDE 真正在写的那个不在 state/logs 下** ——
 *  以前 status 只指 state/logs/language_server.log（只有 `aarmor ls start` 才写它），
 *  于是线上故障在 status 里永远看不见。这里把 IDE 的两处真实日志一起排进去。 */
export function lsLogCandidates(cfg) {
  const out = []
  const appdata = process.env.APPDATA
  if (appdata) {
    out.push(join(appdata, 'Antigravity', 'logs', 'language_server.log'))
    const base = join(appdata, 'Antigravity IDE', 'logs')
    try {
      const dirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse()
      for (const d of dirs.slice(0, 3)) out.push(join(base, d, 'ls-main.log'))
    } catch { /* 没装 IDE 版就不排 */ }
  }
  if (cfg && cfg.logDir) out.push(join(cfg.logDir, 'language_server.log'))
  return out
}

/** 取最新一份**非空**的 LS 日志（IDE 重启会新建空文件，空文件不该盖过上一份有内容的）。
 *  `candidates` 可覆盖候选表（测试用）。 */
export function newestLsLog(cfg, { candidates = null } = {}) {
  let best = null
  for (const p of candidates || lsLogCandidates(cfg)) {
    try {
      const st = statSync(p)
      if (!st.size) continue
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs, size: st.size }
    } catch { /* 不存在就跳过 */ }
  }
  return best
}

/** 从磁盘读 LS 日志尾并判读（status 用；只读尾 512KB，日志可以很大） */
export function scanLsOutageFromDisk(cfg, opts = {}) {
  const f = newestLsLog(cfg)
  if (!f) return { active: false, kind: null, count: 0, path: null, verdict: '找不到 LS 日志', hits: [] }
  let text = ''
  try {
    text = readText(f.path)
    if (text.length > 512 * 1024) text = text.slice(-512 * 1024)
  } catch (e) {
    return { active: false, kind: null, count: 0, path: f.path, verdict: '读不到 LS 日志: ' + e.message, hits: [], error: String(e.message) }
  }
  return { ...scanLsOutage(text, opts), path: f.path, mtimeMs: f.mtimeMs }
}

/** status / netcheck 共用的完整体检（会联网探直连 + 查用户级环境变量） */
export async function lsNetcheck(cfg, { timeoutMs = 4000, now = Date.now(), freshMin = 20 } = {}) {
  const direct = await probeLsDirect({ timeoutMs })
  const envProxy = userEnvProxy()
  const outage = scanLsOutageFromDisk(cfg, { now, freshMin })
  const assessment = assessLsRoute({ directOk: direct.ok, envProxy, outage })
  return { direct, envProxy, outage, assessment }
}
