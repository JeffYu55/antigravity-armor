// 配置装载：把 armor.config.json 解析成绝对路径 + 运行时值
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expand } from './util/fs.mjs'

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function loadConfig(overrides = {}) {
  const raw = JSON.parse(readFileSync(join(PROJECT_ROOT, 'armor.config.json'), 'utf8'))
  const cfg = { ...raw, ...overrides }
  const root = expand(cfg.paths.antigravityRoot)
  const stateDir = expand(cfg.paths.stateDir || join(PROJECT_ROOT, 'state'))

  return {
    raw: cfg,
    projectRoot: PROJECT_ROOT,
    stateDir,
    backupDir: join(stateDir, 'backup'),
    logDir: join(stateDir, 'logs'),
    captureDir: join(stateDir, 'capture'),
    antigravityRoot: root,
    binaryPath: join(root, cfg.binary.relative),
    asarPath: join(root, cfg.ide.relative),
    geminiHome: expand(cfg.paths.geminiHome),
    dshHome: expand(cfg.paths.dshHome),
    patchesFile: join(PROJECT_ROOT, 'patches', 'binary-patches.json'),
    assetsDir: join(PROJECT_ROOT, 'assets'),
    binary: cfg.binary,
    ide: cfg.ide,
    divert: cfg.divert,
    hooks: cfg.hooks,
    rules: cfg.rules,
  }
}

export function patchTable(cfg) {
  return JSON.parse(readFileSync(cfg.patchesFile, 'utf8'))
}

export function exists(p) { return existsSync(p) }
