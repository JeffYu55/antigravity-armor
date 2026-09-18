// 令牌真伪鉴定（v1.7.6，**默认关闭**，凭 AARMOR_TOKENINFO=1 或 cfg.divert.tokenInfo 开启）
//
// 用途：401 时把「令牌过期 / 令牌被撤销 / 令牌有效但请求被拒」三种情况一次分清。
//   实测现场：LS 送来真实的 ya29. 令牌（len=260），上游回 401 —— 到底是哪一种？
//   Google 自己的 tokeninfo 端点能直接回答（返回 expires_in / scope / error）。
//
// 安全约定：
//   - 令牌只在本进程内存里传给 oauth2.googleapis.com，**永不写日志、永不落盘**；
//   - 只记录返回的判读字段（expires_in / scope 截断 / error），不含令牌本身；
//   - 默认关闭：不开启时这个模块根本不会被调到，代理行为零变化。

/** 探一次 tokeninfo。返回 { probed, active, expiresIn, scope, error } —— 永不含令牌 */
export async function probeToken(authHeader, { timeoutMs = 8000 } = {}) {
  const raw = String(authHeader || '').trim()
  const m = raw.match(/^\s*Bearer\s+(.+)$/i)
  if (!m) return { probed: false, reason: 'no-bearer' }
  const token = m[1].trim()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token), { signal: ctl.signal })
    const text = await r.text()
    let j = {}
    try { j = JSON.parse(text) } catch {}
    if (j.error) return { probed: true, active: false, error: j.error + (j.error_description ? ': ' + String(j.error_description).slice(0, 80) : '') }
    return {
      probed: true,
      active: r.ok,
      expiresIn: j.expires_in != null ? Number(j.expires_in) : null,
      scope: j.scope ? String(j.scope).slice(0, 60) : null,
      error: null,
    }
  } catch (e) {
    return { probed: false, reason: e.name === 'AbortError' ? 'timeout' : String(e.message || e).slice(0, 60) }
  } finally { clearTimeout(timer) }
}

/** 一行判读日志 */
export function tokenInfoLine(res) {
  if (!res || !res.probed) return 'TOKENINFO 未能鉴定（' + ((res && res.reason) || 'unknown') + '）'
  if (!res.active) return 'TOKENINFO 令牌在 Google 侧无效/已撤销（' + (res.error || 'inactive') + '）—— 必须重新登录'
  const mins = res.expiresIn != null ? Math.round(res.expiresIn / 60) : null
  return 'TOKENINFO 令牌有效（' + (mins != null ? '还剩 ' + mins + ' 分钟' : '有效期未知') + '）'
    + '，scope=' + (res.scope || '-')
    + ' —— 令牌本身没问题，要看账号/项目状态'
}