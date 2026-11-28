// macOS 签名收尾 —— 等长补丁之后不做这一步，宿主会直接起不来。
//
// 真机实测（2026-11-27，Antigravity 2.35.1 arm64，Developer ID + hardened runtime）：
//   1) 改完 3 个字节后执行：`dyld[..]: Assertion failed ...` → exit 134；
//   2) `codesign --verify` 报 "invalid or unsupported format for signature"；
//   3) `codesign --remove-signature` → 能跑（exit 2 是 Go flag 包的 usage 退出码）；
//   4) 再 `codesign --force --sign -`（ad-hoc）→ 正常，`codesign -dv` 显示 flags=0x2(adhoc)。
//
// 所以「补丁成功」的判据不是「字节写进去了」，而是「写完还起得来」：
// 本文件负责重签 + 冒烟；冒烟失败由调用方自动回滚（binary.mjs）。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { log } from '../log.mjs'

function run(cmd, args, { timeout = 120000, allowFail = false } = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout })
    return { ok: true, out }
  } catch (e) {
    const text = String((e && (e.stderr || e.stdout || e.message)) || '')
    if (!allowFail) log.warn(cmd + ' ' + args.join(' ') + ' 失败: ' + text.split('\n')[0])
    return { ok: false, out: text }
  }
}

/**
 * 冒烟用的环境：**必须摘掉 ELECTRON_RUN_AS_NODE**。
 * 现场踩过：装过 agy-purge 的一次性脚本会 `export ELECTRON_RUN_AS_NODE=1`，
 * 变量留在会话环境里，于是之后任何 Electron 宿主（Antigravity 本体、HUD、
 * 甚至直接 `open -a` 出来的进程）都按 Node 模式启动 —— 秒退、退出码 0、
 * 只有一条 codesign_util 日志。表现是「打完补丁宿主起不来了」，实际是环境变量。
 */
function hostEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  return env
}

/** 该平台是否需要（且能够）重签 */
export function needsResign(mode = 'auto', platform = process.platform) {
  if (platform !== 'darwin') return false
  return mode !== 'never'
}

/**
 * 重签：先摘掉已失效的签名，再打 ad-hoc。
 * 失败不抛 —— 调用方要能继续走到「冒烟失败 → 回滚」那条路。
 */
export function resign(binaryPath, { platform = process.platform } = {}) {
  if (platform !== 'darwin') return { skipped: true, reason: 'not-darwin' }
  if (!existsSync(binaryPath)) return { skipped: true, reason: 'missing' }
  const strip = run('codesign', ['--remove-signature', binaryPath], { allowFail: true })
  const sign = run('codesign', ['--force', '--sign', '-', binaryPath], { allowFail: true })
  log.info('sign: remove=' + (strip.ok ? 'ok' : 'skip') + ' adhoc=' + (sign.ok ? 'ok' : 'fail'))
  return { stripped: strip.ok, signed: sign.ok, detail: sign.ok ? null : sign.out.split('\n')[0] }
}

/**
 * 冒烟：宿主二进制的 `--help` 必须能正常退出。
 * 判据放宽到「有输出 + 退出码 < 128」：Go 的 flag 包用 exit 2 表示 usage，
 * 用 0 判会把正常情况误判成失败（真机上就是这么踩的）。
 */
export function smokeTest(binaryPath, { timeout = 20000, platform = process.platform } = {}) {
  if (!existsSync(binaryPath)) return { ok: false, reason: 'missing' }
  try {
    const out = execFileSync(binaryPath, ['--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, env: hostEnv() })
    return { ok: true, bytes: out.length, code: 0 }
  } catch (e) {
    const code = typeof e?.status === 'number' ? e.status : null
    const text = String((e && (e.stderr || e.stdout || e.message)) || '')
    // 夹具/占位文件不是可执行体：跑不起来不等于「补丁把宿主搞坏了」。
    // 单测与 CI 里的 language_server 都是几百字节的假文件（Windows 版连执行位都没有），
    // 如果这里判失败，二进制层永远等于「打完必回滚」，purge 全套用例跟着红。
    if (code === null && /EACCES|ENOEXEC|EPERM|ENOENT/.test(text)) return { ok: true, skipped: true, reason: 'not-executable' }
    // usage 输出就是活着：Go flag 包 / GNU --help 都可能非 0 退出
    const alive = code !== null && code < 128 && /usage|Usage|flag provided|api_server_url/i.test(text + String(e?.stdout || ''))
    return { ok: alive, code, reason: alive ? null : 'exit ' + code + ': ' + text.split('\n')[0].slice(0, 160), bytes: text.length }
  }
}

/** 打完补丁的收尾：需要时重签 + 冒烟。返回 { ok, smoke, sign } */
export function finalizePatchedBinary(cfg, binaryPath) {
  const mode = cfg?.binary?.resign || 'auto'
  const wantSmoke = cfg?.binary?.smokeTest !== false
  const sign = needsResign(mode) ? resign(binaryPath) : { skipped: true, reason: mode === 'never' ? 'disabled' : 'not-darwin' }
  const smoke = wantSmoke ? smokeTest(binaryPath) : { ok: true, skipped: true }
  if (wantSmoke) log.info('smoke: ' + (smoke.ok ? 'ok' : 'FAILED') + (smoke.code !== null ? ' (exit ' + smoke.code + ')' : '') + (smoke.reason ? ' ' + smoke.reason : ''))
  return { ok: smoke.ok, smoke, sign }
}
