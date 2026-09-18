// 令牌体检（v1.7.6）—— 不解密、不打印令牌本身，只报「形态 + 有效期」
//
// 为什么需要：401 有两种完全不同的成因，日志里长得一模一样：
//   A) 令牌**过期**而 IDE 没刷新成功   -> 重新登录
//   B) 令牌是**新鲜**的却被上游拒      -> 账号/项目状态问题，重登录也未必解决
// 只报形态与 exp 就能当场分辨，不必反复猜。
//
// 安全：只读取 JWT 的 payload 段（base64url 解码即可，无需密钥、无需验签），
//      整条令牌永不落日志；非 JWT 的 opaque 令牌（Google 的 ya29.…）只报前缀与长度。

/** 解析 Authorization 头，给出可安全落日志的形态摘要 */
export function describeToken(header, nowSec = Math.floor(Date.now() / 1000)) {
  const raw = String(header || '').trim()
  if (!raw) return { present: false, scheme: null, len: 0, head: '', fmt: 'none', exp: null, iat: null, expired: null, expInSec: null }
  const m = raw.match(/^(\S+)\s+(.+)$/)
  const scheme = m ? m[1] : '(raw)'
  const val = (m ? m[2] : raw).trim()
  const out = {
    present: true, scheme, len: val.length, head: val.slice(0, 5),
    fmt: 'opaque', exp: null, iat: null, expired: null, expInSec: null,
  }
  const parts = val.split('.')
  if (parts.length === 3) {
    out.fmt = 'jwt'
    try {
      const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
      if (typeof p.exp === 'number') {
        out.exp = p.exp
        out.expInSec = p.exp - nowSec
        out.expired = out.expInSec <= 0
      }
      if (typeof p.iat === 'number') out.iat = p.iat
    } catch { out.fmt = 'jwt-unparsable' }
  }
  return out
}

/** 一行日志（永不含令牌本身） */
export function tokenLine(t) {
  if (!t || !t.present) return 'AUTH-INFO 无 Authorization 头 —— 客户端没带令牌（需要登录）'
  const shape = t.scheme + ' len=' + t.len + ' ' + (t.fmt === 'jwt' ? 'jwt' : t.fmt === 'opaque' ? 'opaque(' + t.head + '…)' : t.fmt)
  if (t.fmt === 'jwt' && t.expInSec !== null) {
    const mins = Math.round(Math.abs(t.expInSec) / 60)
    return 'AUTH-INFO ' + shape + (t.expired
      ? ' 【令牌已过期 ' + mins + ' 分钟 —— IDE 没刷新成功：重新登录】'
      : ' 【令牌有效，还剩 ' + mins + ' 分钟】')
  }
  return 'AUTH-INFO ' + shape + '（opaque 令牌，无法本地判有效期）'
}