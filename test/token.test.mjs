// 令牌真伪鉴定 —— 契约测试
//
// 现场（2026-09-18 11:37）：LS 送来真实的 ya29. 令牌（len=260），上游回 401。
// 必须能一次分清：令牌过期 / 令牌被撤销 / 令牌有效但请求被拒。
// 硬约束：这些用例同时锁死「令牌永不进入任何返回值」。
import assert from 'node:assert/strict'
import { probeToken, tokenInfoLine } from '../src/diag/tokeninfo.mjs'
import { describeToken, tokenLine } from '../src/diag/token.mjs'

const SECRET = 'ya29.SUPERSECRETVALUE_should_never_appear_anywhere_0123456789'

export async function testNonBearerIsNotProbed() {
  const r = await probeToken('')
  assert.equal(r.probed, false)
  assert.equal(r.reason, 'no-bearer')
  const r2 = await probeToken('Basic abc')
  assert.equal(r2.probed, false)
}

export async function testProbeNeverLeaksTheToken() {
  // 不联网也要成立：无论成功失败，返回结构里都不能出现令牌片段
  const r = await probeToken('Bearer ' + SECRET, { timeoutMs: 1 })
  const dump = JSON.stringify(r)
  assert.ok(!dump.includes('SUPERSECRET'), '探测结果不得包含令牌：' + dump)
  assert.ok(!dump.includes('ya29.'), '探测结果不得包含令牌前缀：' + dump)
  const line = tokenInfoLine(r)
  assert.ok(!line.includes('SUPERSECRET'), '日志行不得包含令牌：' + line)
}

export async function testTokenInfoLineDistinguishesRevokedFromValid() {
  assert.match(tokenInfoLine({ probed: true, active: false, error: 'invalid_token' }), /无效\/已撤销/)
  assert.match(tokenInfoLine({ probed: true, active: false, error: 'invalid_token' }), /重新登录/)
  const ok = tokenInfoLine({ probed: true, active: true, expiresIn: 3300, scope: 'openid https://www.googleapis.com/auth/cloud-platform' })
  assert.match(ok, /令牌有效/)
  assert.match(ok, /还剩 55 分钟/)
  assert.match(ok, /账号\/项目状态/)   // 令牌没问题时要指向别处，不能继续怪令牌
  assert.match(tokenInfoLine({ probed: false, reason: 'timeout' }), /未能鉴定/)
}

export async function testDescribeTokenReadsJwtExpiryWithoutLeaking() {
  const now = Math.floor(Date.now() / 1000)
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.' + Buffer.from(JSON.stringify({ exp: now - 600, iat: now - 4200 })).toString('base64url') + '.SIGNATURESECRET'
  const d = describeToken('Bearer ' + jwt, now)
  assert.equal(d.fmt, 'jwt')
  assert.equal(d.expired, true)
  assert.equal(d.expInSec, -600)
  const line = tokenLine(d)
  assert.match(line, /令牌已过期 10 分钟/)
  assert.ok(!line.includes('SIGNATURESECRET'), '日志行不得含令牌签名段：' + line)
  // 有效的 JWT
  const good = 'eyJhbGciOiJSUzI1NiJ9.' + Buffer.from(JSON.stringify({ exp: now + 600 })).toString('base64url') + '.x'
  assert.match(tokenLine(describeToken('Bearer ' + good, now)), /令牌有效，还剩 10 分钟/)
  // 无头
  assert.match(tokenLine(describeToken('', now)), /无 Authorization 头/)
}

export async function testDescribeTokenHandlesRealGoogleShape() {
  // 实测形态：ya29. 开头的不透明令牌，长度约 260 —— 本地判不了有效期，但必须认得出来
  const real = 'ya29.a0AfH6SMB' + 'x'.repeat(246)
  const d = describeToken('Bearer ' + real)
  assert.equal(d.present, true)
  assert.equal(d.fmt, 'opaque')
  assert.equal(d.exp, null)
  assert.equal(d.expired, null, '不透明令牌不能假装知道过期与否')
  assert.equal(d.len, real.length)
  assert.match(tokenLine(d), /opaque 令牌，无法本地判有效期/)
}