// unpack-asar —— 把 app.asar 换成可编辑的 resources/app 目录（P8' 内嵌 UI 的前置）
//
// 依据（本机实测）：
//   * Electron fuse `EnableEmbeddedAsarIntegrityValidation` = 0 —— 无 asar 完整性校验；
//   * `OnlyLoadAppFromAsar` = 0 —— 允许从目录加载。
// 于是「改名 + 解包」就能拿到可自由编辑的宿主源码，且随时可回滚。
//
// 用法：
//   node scripts/unpack-asar.mjs            # 预览
//   node scripts/unpack-asar.mjs --apply    # 解包 + 把 app.asar 改名备份
//   node scripts/unpack-asar.mjs --restore --apply   # 回滚：删目录、恢复 app.asar
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { listAsar, readAsarFile } from './asar-extract.mjs'
import { log } from '../src/log.mjs'

const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`))
  if (!hit) return d
  const i = hit.indexOf('=')
  return i < 0 ? true : hit.slice(i + 1)
}

export function appDirOf(cfg) {
  return join(cfg.antigravityRoot, 'resources', 'app')
}
export function asarBakOf(cfg) {
  return join(cfg.antigravityRoot, 'resources', 'app.asar.armor-bak')
}
/** 当前可用的 asar 源：原位优先，否则用备份 */
export function asarSourceOf(cfg) {
  if (existsSync(cfg.asarPath)) return cfg.asarPath
  const bak = asarBakOf(cfg)
  return existsSync(bak) ? bak : null
}

function copyUnpackedDir(cfg, outDir, files) {
  const unpackedRoot = join(cfg.antigravityRoot, 'resources', 'app.asar.unpacked')
  let n = 0
  for (const f of files.filter((x) => x.unpacked)) {
    const src = join(unpackedRoot, f.path)
    const dst = join(outDir, f.path)
    if (!existsSync(src)) continue
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    n++
  }
  return n
}

function main() {
  const cfg = loadConfig()
  const outDir = appDirOf(cfg)

  if (arg('restore')) {
    if (!existsSync(outDir) && existsSync(cfg.asarPath)) { log.info('已是原始形态，无需恢复'); return }
    if (!arg('apply')) { console.log('DRY RUN：将删除 ' + outDir + ' 并恢复 app.asar（加 --apply 真做）'); return }
    if (existsSync(outDir)) { rmSync(outDir, { recursive: true, force: true }); log.ok('removed ' + outDir) }
    const bak = asarBakOf(cfg)
    if (existsSync(bak) && !existsSync(cfg.asarPath)) { renameSync(bak, cfg.asarPath); log.ok('restored ' + cfg.asarPath) }
    return
  }

  const srcAsar = asarSourceOf(cfg)
  if (!srcAsar) { log.error('既没有 app.asar 也没有 app.asar.armor-bak'); process.exit(2) }
  if (existsSync(outDir) && !arg('force')) { log.warn(outDir + ' 已存在（加 --force 重新解包）'); return }

  const files = listAsar(srcAsar)
  const total = files.reduce((a, f) => a + f.size, 0)
  log.info('asar ' + srcAsar)
  log.info(`  files ${files.length}  bytes ${total}  unpackedEntries ${files.filter((f) => f.unpacked).length}`)
  log.info('  -> ' + outDir)
  if (!arg('apply')) { console.log('DRY RUN：加 --apply 真解包'); return }

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  for (const f of files.filter((x) => !x.unpacked)) {
    const dest = join(outDir, f.path)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, readAsarFile(srcAsar, f.path))
  }
  const copied = copyUnpackedDir(cfg, outDir, files)
  writeFileSync(join(outDir, '.armor-unpacked.json'), JSON.stringify({
    at: new Date().toISOString(), source: srcAsar, hostVersion: cfg.hostVersion, files: files.length, unpackedCopied: copied,
    note: 'armor 解包模式；回滚用 node scripts/unpack-asar.mjs --restore --apply',
  }, null, 2))

  const bak = asarBakOf(cfg)
  if (existsSync(cfg.asarPath)) {
    if (!existsSync(bak)) renameSync(cfg.asarPath, bak)
    else rmSync(cfg.asarPath, { force: true })
  }
  log.ok(`unpacked ${files.length} files; app.asar -> ${bak}`)
}

const invoked = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/unpack-asar.mjs')
if (invoked) main()
