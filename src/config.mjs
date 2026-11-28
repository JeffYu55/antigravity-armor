// 配置装载：把 armor.config.json 解析成绝对路径 + 运行时值
//
// v1.10.0 起「适配所有版本」的三条硬约束写在这里：
//   1) 宿主根目录 auto 探测（Windows / macOS / Linux），不再写死 C:\Users\...；
//   2) 二进制按候选名 + 目录扫描定位，不再写死 language_server.exe；
//   3) 补丁表不再按「版本号必须对上」放行，而是按**锚点命中率**放行 ——
//      版本号只是目录名，能不能打由 refit 现算（见 layers/refit.mjs）。
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expand } from './util/fs.mjs'
import { resolveHostRoot, findLanguageServer, detectHostVersion as detectVersion, signatureState } from './host.mjs'

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 宿主版本识别（转调 host.mjs，保留旧导出名以兼容脚本） */
export function detectHostVersion(root) { return detectVersion(root) }

function readRaw() {
  return JSON.parse(readFileSync(join(PROJECT_ROOT, 'armor.config.json'), 'utf8'))
}

export function loadConfig(overrides = {}) {
  const raw = { ...readRaw(), ...overrides }
  const root = resolveHostRoot(raw.paths.antigravityRoot)
  const stateDir = expand(raw.paths.stateDir || join(PROJECT_ROOT, 'state'))
  const hostVersion = raw.hostVersion || detectHostVersion(root)
  const hostPatches = join(PROJECT_ROOT, 'patches', 'hosts', hostVersion, 'binary-patches.json')
  const legacyPatches = join(PROJECT_ROOT, 'patches', 'binary-patches.json')

  // 二进制：配置里给的名字当「首选」，找不到就按平台候选 + 目录扫描兜底
  const preferred = raw.binary && raw.binary.relative ? join(root, raw.binary.relative) : null
  const binaryPath = (preferred && existsSync(preferred)) ? preferred : (findLanguageServer(root) || preferred)
  const binary = {
    maxLine: 1400,
    marker: '**[ARMOR v3]',
    autoRefit: true,
    minAnchorRatio: 0.34,
    resign: 'auto',           // auto | always | never（macOS：打完自动 ad-hoc 重签）
    smokeTest: true,          // 打完用 `--help` 冒烟，起不来就自动回滚
    ...(raw.binary || {}),
  }

  return {
    raw,
    projectRoot: PROJECT_ROOT,
    stateDir,
    backupDir: join(stateDir, 'backup'),
    logDir: join(stateDir, 'logs'),
    captureDir: join(stateDir, 'capture'),
    purgeDir: join(stateDir, 'purge'),
    hudDir: join(stateDir, 'hud'),
    controllerDir: join(stateDir, 'controller'),
    antigravityRoot: root,
    binaryPath,
    asarPath: join(root, raw.ide?.relative || 'resources/app.asar'),
    geminiHome: expand(raw.paths.geminiHome),
    dshHome: expand(raw.paths.dshHome),
    paths: raw.paths,
    hostVersion,
    platform: process.platform,
    arch: process.arch,
    hostPatchesFile: hostPatches,
    legacyPatchesFile: legacyPatches,
    /** 该版本有专属表就用专属表，否则回落旧表（命中率由 refit 现算） */
    patchesFile: existsSync(hostPatches) ? hostPatches : legacyPatches,
    assetsDir: join(PROJECT_ROOT, 'assets'),
    binary,
    ide: { anchors: [], ...(raw.ide || {}) },
    divert: raw.divert,
    hooks: raw.hooks,
    rules: raw.rules,
    purge: raw.purge || {},
    controller: { maxInjectionsPerTurn: 2, maxRetriesPerStep: 2, escalateAfter: 2, injectCorrective: true, retryTransient: true, stateTtlMs: 30 * 60 * 1000, ...(raw.controller || {}) },
    hud: { port: 50101, enabled: true, ...(raw.hud || {}) },
    inject: { enabled: true, lane: 'neutral', ...(raw.inject || {}) },
  }
}

export function patchTable(cfg) {
  return JSON.parse(readFileSync(cfg.patchesFile, 'utf8'))
}

/**
 * 宿主形状信息（**只报告，不阻断**）。
 * 旧版这里是硬门：size/sha 对不上就抛错。那等于「只支持一个版本」——
 * 升级一次就 P0。现在这两个值退化成参考信息：命中率由 anchors 判，
 * 见 assertHostAnchors（layers/refit.mjs 计算，binary.mjs 调用）。
 */
export function assertHostShape(cfg, buf, { armored = false } = {}) {
  const want = cfg.binary || {}
  const out = []
  if (want.expectedSize && buf.length !== want.expectedSize) out.push(`size ${buf.length} != known ${want.expectedSize}（未知版本，交给 refit）`)
  if (!armored && want.expectedSha256) {
    const sha = createHash('sha256').update(buf).digest('hex').toUpperCase()
    if (sha !== String(want.expectedSha256).toUpperCase()) out.push(`sha ${sha.slice(0, 12)}… != known ${String(want.expectedSha256).slice(0, 12)}…（未知版本，交给 refit）`)
  }
  return out
}

export function hostSignature(cfg) { return signatureState(cfg.binaryPath) }

export function exists(p) { return existsSync(p) }
