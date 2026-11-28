// 宿主定位：把「Antigravity 装在哪儿」从写死的 Windows 路径变成跨平台探测。
//
// 为什么必须做（2026-11 现场）：armor 原先假设
//   antigravityRoot = C:\Users\Administrator\AppData\Local\Programs\antigravity
//   binary.relative = resources/bin/language_server.exe
// 于是换到 macOS / 换一台机器，`ensure` 第一步就「找不到 language_server.exe」，
// 而 status 仍然显示「层都在」—— 静默失效，最贵的那种。
//
// 另一个同等重要的事实：**宿主版本不是我们自己挑的**。用户升级 Antigravity，
// 版本号就变，补丁表按版本目录存放必然滞后。所以这里只负责「认出这是哪一版、在哪」，
// 至于补丁能不能打，交给 anchors/refit 用命中率判定（见 layers/refit.mjs）。
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

/** 各平台可能的宿主根目录（按优先级）。root 指「含 resources/ 的那一层」。 */
export function hostRootCandidates(platform = process.platform, env = process.env, home = homedir()) {
  const out = []
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    out.push(join(local, 'Programs', 'antigravity'))
    out.push(join(local, 'Programs', 'Antigravity'))
    if (env.PROGRAMFILES) out.push(join(env.PROGRAMFILES, 'Antigravity'))
    if (env['PROGRAMFILES(X86)']) out.push(join(env['PROGRAMFILES(X86)'], 'Antigravity'))
  } else if (platform === 'darwin') {
    out.push('/Applications/Antigravity.app/Contents')
    out.push(join(home, 'Applications/Antigravity.app/Contents'))
    out.push('/Applications/Antigravity IDE.app/Contents')
    out.push(join(home, 'Applications/Antigravity IDE.app/Contents'))
  } else {
    out.push('/opt/Antigravity')
    out.push('/usr/share/antigravity')
    out.push('/usr/lib/antigravity')
    out.push(join(home, '.local/share/antigravity'))
  }
  return out
}

/** 判定一个目录像不像宿主根：必须有 resources/app.asar 或 resources/bin。 */
export function looksLikeHostRoot(dir) {
  if (!dir || !existsSync(dir)) return false
  return existsSync(join(dir, 'resources', 'app.asar')) || existsSync(join(dir, 'resources', 'bin'))
}

/** 解析配置里的 root：
 *  - 'auto' / 空 → 按平台候选逐个试
 *  - 具体路径 → 原样（存在即用，不存在也不报错，留给上层出可读诊断）
 *  - 环境变量 AARMOR_HOST_ROOT 永远优先（CI/测试注入用） */
export function resolveHostRoot(configured, { platform = process.platform, env = process.env, home = homedir() } = {}) {
  const explicit = env.AARMOR_HOST_ROOT || configured
  if (explicit && explicit !== 'auto') return explicit
  for (const c of hostRootCandidates(platform, env, home)) {
    if (looksLikeHostRoot(c)) return c
  }
  return (explicit === 'auto' || !explicit) ? (hostRootCandidates(platform, env, home)[0] || '') : explicit
}

/** 候选二进制名：不同平台/架构叫法不同；.exe 只在 Windows 上优先。 */
export function binaryNameCandidates(platform = process.platform, arch = process.arch) {
  const names = []
  if (platform === 'win32') names.push('language_server.exe', 'language_server')
  else {
    if (platform === 'darwin' && arch === 'arm64') names.push('language_server_macos_arm64', 'language_server_macos_aarch64')
    if (platform === 'darwin') names.push('language_server_macos_x64', 'language_server_macos_x86_64')
    if (platform === 'linux') names.push('language_server_linux_amd64', 'language_server_linux_x64', 'language_server_linux_arm64')
    names.push('language_server')
  }
  return names
}

/**
 * 定位 language_server：先按名字候选，再扫 resources/bin 下所有 language_server*。
 * 扫目录是「适配所有版本」的关键一步：2.35.x 起名字带平台后缀的包越来越多，
 * 靠配置里写死一个文件名，升级后就必然找不到。
 */
export function findLanguageServer(root, { platform = process.platform, arch = process.arch } = {}) {
  if (!root) return null
  const binDir = join(root, 'resources', 'bin')
  for (const name of binaryNameCandidates(platform, arch)) {
    const p = join(binDir, name)
    if (existsSync(p)) return p
  }
  if (existsSync(binDir)) {
    let best = null
    for (const f of readdirSync(binDir)) {
      if (!/^language_server/i.test(f)) continue
      if (/\.(dll|so|dylib|pdb|json|txt)$/i.test(f)) continue
      const p = join(binDir, f)
      try {
        const st = statSync(p)
        if (!st.isFile() || st.size < 1_000_000) continue
        if (!best || st.size > best.size) best = { path: p, size: st.size }
      } catch { /* 权限问题跳过 */ }
    }
    if (best) return best.path
  }
  return null
}

/** 宿主版本：asar 内 package.json → resources/version → macOS Info.plist → 'unknown'。
 *  全部失败也不阻断：'unknown' 会走 auto-refit 现场派生补丁表。 */
export function detectHostVersion(root) {
  if (!root) return 'unknown'
  try {
    const asar = join(root, 'resources', 'app.asar')
    if (existsSync(asar)) {
      const maxRead = Math.min(statSync(asar).size, 2 * 1024 * 1024)
      const buf = Buffer.allocUnsafe(maxRead)
      const fd = openSync(asar, 'r')
      let n = 0
      try { n = readSync(fd, buf, 0, maxRead, 0) } finally { closeSync(fd) }
      const text = buf.subarray(0, n).toString('latin1')
      const at = text.search(/"name"\s*:\s*"antigravity"/i)
      if (at >= 0) {
        const m = text.slice(at, at + 400).match(/"version"\s*:\s*"(\d+\.\d+\.\d+)"/)
        if (m) return m[1]
      }
      const m2 = text.match(/"name"\s*:\s*"antigravity"[\s\S]{0,200}?"version"\s*:\s*"(\d+\.\d+\.\d+)"/)
      if (m2) return m2[1]
    }
  } catch { /* 版本识别失败不阻断启动 */ }
  try {
    const v = join(root, 'resources', 'version')
    if (existsSync(v)) {
      const s = readFileSync(v, 'utf8').trim()
      if (/^\d+\.\d+\.\d+$/.test(s)) return s
    }
  } catch { /* 忽略 */ }
  try {
    // macOS：Contents/Info.plist（XML）里的 CFBundleShortVersionString
    const plist = join(root, 'Info.plist')
    if (existsSync(plist)) {
      const s = readFileSync(plist, 'utf8')
      const m = s.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)
      if (m && /^\d+\.\d+\.\d+/.test(m[1].trim())) return m[1].trim().split('-')[0]
    }
  } catch { /* 忽略 */ }
  return 'unknown'
}

/**
 * macOS 签名状态：真机实测（2026-11-27，Antigravity 2.35.1 / arm64）——
 * 等长改字节后原签名立刻失效，直接执行会 dyld abort（134）。
 * 正确顺序是 `codesign --remove-signature` + `codesign --force --sign -`（ad-hoc）。
 * 这里只做**探测**，动刀在 layers/sign.mjs。
 */
export function signatureState(binaryPath, { platform = process.platform } = {}) {
  if (!binaryPath || !existsSync(binaryPath)) return { platform, signed: null, reason: 'missing' }
  if (platform !== 'darwin') return { platform, signed: null, reason: 'not-applicable' }
  try {
    const out = execFileSync('codesign', ['-dv', '--verbose=2', binaryPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 })
    return { platform, signed: /Signature=/.test(out), reason: 'query-ok', detail: out.split('\n').slice(0, 4).join(' | ') }
  } catch (e) {
    const txt = String((e && (e.stderr || e.stdout)) || '')
    const signed = /Signature=/.test(txt)
    return { platform, signed, reason: signed ? 'query-ok' : 'invalid-or-unsigned', detail: txt.split('\n').slice(0, 3).join(' | ') }
  }
}

/** 二进制是否已经被本工程改过（标记串） */
export function hasMarker(buf, marker) {
  try { return buf.includes(Buffer.from(marker, 'utf8')) } catch { return false }
}

export function hostSummary(cfg) {
  return {
    platform: process.platform,
    arch: process.arch,
    root: cfg.antigravityRoot,
    binary: cfg.binaryPath || null,
    version: cfg.hostVersion,
    asar: cfg.asarPath || null,
    hostName: cfg.antigravityRoot ? basename(cfg.antigravityRoot) : null,
  }
}
