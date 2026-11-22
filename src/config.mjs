// 配置装载：把 armor.config.json 解析成绝对路径 + 运行时值
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expand } from './util/fs.mjs'

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 宿主版本识别（决定用哪张补丁表）。
 *  优先级：asar 内 package.json 的 version → resources/version → 'unknown'。
 *  为什么不用 exe 的文件版本：读 PE 资源要额外依赖；asar 里的版本号与
 *  注册表 DisplayVersion 实测一致（2.34.0），够用且零依赖。 */
export function detectHostVersion(root) {
  try {
    const asar = join(root, 'resources', 'app.asar')
    if (existsSync(asar)) {
      const text = readFileSync(asar).toString('latin1')
      const at = text.search(/"name"\s*:\s*"antigravity"/)
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
  } catch {}
  return 'unknown'
}

export function loadConfig(overrides = {}) {
  const raw = JSON.parse(readFileSync(join(PROJECT_ROOT, 'armor.config.json'), 'utf8'))
  const cfg = { ...raw, ...overrides }
  const root = expand(cfg.paths.antigravityRoot)
  const stateDir = expand(cfg.paths.stateDir || join(PROJECT_ROOT, 'state'))
  const hostVersion = cfg.hostVersion || detectHostVersion(root)
  const hostPatches = join(PROJECT_ROOT, 'patches', 'hosts', hostVersion, 'binary-patches.json')
  const legacyPatches = join(PROJECT_ROOT, 'patches', 'binary-patches.json')

  return {
    raw: cfg,
    projectRoot: PROJECT_ROOT,
    stateDir,
    backupDir: join(stateDir, 'backup'),
    logDir: join(stateDir, 'logs'),
    captureDir: join(stateDir, 'capture'),
    purgeDir: join(stateDir, 'purge'),
    hudDir: join(stateDir, 'hud'),
    controllerDir: join(stateDir, 'controller'),
    antigravityRoot: root,
    binaryPath: join(root, cfg.binary.relative),
    asarPath: join(root, cfg.ide.relative),
    geminiHome: expand(cfg.paths.geminiHome),
    dshHome: expand(cfg.paths.dshHome),
    paths: cfg.paths,
    hostVersion,
    hostPatchesFile: hostPatches,
    legacyPatchesFile: legacyPatches,
    /** 该版本有专属表就用专属表，否则回落旧表（旧表命中率由 derive-patches 报出） */
    patchesFile: existsSync(hostPatches) ? hostPatches : legacyPatches,
    assetsDir: join(PROJECT_ROOT, 'assets'),
    binary: cfg.binary,
    ide: cfg.ide,
    divert: cfg.divert,
    hooks: cfg.hooks,
    rules: cfg.rules,
    purge: cfg.purge || {},
    controller: { maxInjectionsPerTurn: 2, maxRetriesPerStep: 2, escalateAfter: 2, injectCorrective: true, retryTransient: true, stateTtlMs: 30 * 60 * 1000, ...(cfg.controller || {}) },
    hud: { port: 50101, enabled: true, ...(cfg.hud || {}) },
    inject: { enabled: true, lane: 'neutral', ...(cfg.inject || {}) },
  }
}

export function patchTable(cfg) {
  return JSON.parse(readFileSync(cfg.patchesFile, 'utf8'))
}

/** 宿主形状门：版本号与大小/sha 都对上才允许落盘补丁。
 *  armored=true 时跳过 sha（文件已被我们改过，比对的是原件），只校验大小。
 *  'unknown' / 缺字段时放行（首次适配阶段），由 derive-patches 的命中率兜底。 */
export function assertHostShape(cfg, buf, { armored = false } = {}) {
  const want = cfg.binary || {}
  const problems = []
  if (want.expectedSize && buf.length !== want.expectedSize) {
    problems.push(`size ${buf.length} != expected ${want.expectedSize}`)
  }
  if (!armored && want.expectedSha256) {
    const sha = createHash('sha256').update(buf).digest('hex').toUpperCase()
    if (sha !== String(want.expectedSha256).toUpperCase()) problems.push(`sha ${sha.slice(0, 12)}… != expected ${String(want.expectedSha256).slice(0, 12)}…`)
  }
  return problems
}

export function exists(p) { return existsSync(p) }
