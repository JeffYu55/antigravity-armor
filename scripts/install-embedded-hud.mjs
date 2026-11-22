// install-embedded-hud —— 把 HUD 做成 Antigravity 内嵌 UI（P8'）
//
// 三步：
//   1. 解包 app.asar -> resources/app（fuse 实测允许目录加载）；
//   2. 把 assets/armor-hud-inject.js 放进 app/dist/，并写 sidecar（base/tokenFile）；
//   3. 在 app/dist/main.js 末尾挂一行 require（幂等，带标记）。
//
// 与悬浮窗的关系：悬浮窗（dist/hud/ArmorHud.exe）保留为 legacy `aarmor hud floating`；
// 默认 `aarmor hud embed|open` 走内嵌这条。
//
// 用法：
//   node scripts/install-embedded-hud.mjs            # 预览
//   node scripts/install-embedded-hud.mjs --apply    # 落盘
//   node scripts/install-embedded-hud.mjs --restore --apply   # 摘掉注入并还原 asar
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadConfig } from '../src/config.mjs'
import { ensureToken } from '../src/hud/control.mjs'
import { appDirOf, asarBakOf } from './unpack-asar.mjs'
import { log } from '../src/log.mjs'

const MARK = '/* armor-hud-inject v1 */'
const REQUIRE_LINE = `${MARK}\ntry { require('./armor-hud-inject').install(); } catch (e) { console.error('[armor-hud] install failed', e && e.message); }\n`

const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`))
  if (!hit) return d
  const i = hit.indexOf('=')
  return i < 0 ? true : hit.slice(i + 1)
}

function stripRequire(mainJs) {
  const i = mainJs.indexOf(MARK)
  if (i < 0) return mainJs
  return mainJs.slice(0, i)
}

function main() {
  const cfg = loadConfig()
  const appDir = appDirOf(cfg)
  const mainJsPath = join(appDir, 'dist', 'main.js')
  const injectorDest = join(appDir, 'dist', 'armor-hud-inject.js')
  const sidecar = join(appDir, 'dist', 'armor-hud.json')
  const running = (() => {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Process | Where-Object { $_.ProcessName -like 'Antigravity*' } | Measure-Object).Count"], { encoding: 'utf8', timeout: 20000 })
      return Number(out.trim()) > 0
    } catch { return false }
  })()

  if (arg('restore')) {
    console.log('restore: 摘掉注入并还原 app.asar')
    if (running) { console.log('⚠ Antigravity 正在运行，先退出再回滚'); process.exit(1) }
    if (!arg('apply')) { console.log('DRY RUN：加 --apply 真做'); return }
    try { execFileSync(process.execPath, [join(cfg.projectRoot, 'scripts', 'unpack-asar.mjs'), '--restore', '--apply'], { stdio: 'inherit' }) } catch (e) { log.error('还原失败：' + e.message); process.exit(1) }
    return
  }

  if (!existsSync(appDir)) {
    console.log('app 目录不存在 → 先解包')
    if (!arg('apply')) { console.log('DRY RUN：加 --apply 会解包并注入'); return }
    execFileSync(process.execPath, [join(cfg.projectRoot, 'scripts', 'unpack-asar.mjs'), '--apply'], { stdio: 'inherit' })
  }
  if (!existsSync(mainJsPath)) { log.error('找不到 ' + mainJsPath); process.exit(1) }

  const token = ensureToken(cfg)
  const mainJs = readFileSync(mainJsPath, 'utf8')
  const patched = mainJs.includes(MARK)

  console.log('app dir      ' + appDir)
  console.log('main.js      ' + mainJsPath + '  bytes=' + mainJs.length + '  alreadyPatched=' + patched)
  console.log('injector     ' + injectorDest)
  console.log('token        ' + token.slice(0, 8) + '…')
  console.log('asar bak     ' + asarBakOf(cfg) + '  exists=' + existsSync(asarBakOf(cfg)))
  if (!arg('apply')) { console.log('\nDRY RUN：加 --apply 落盘'); return }
  if (running) { log.warn('Antigravity 正在运行：注入会写盘，但要重启应用才生效') }

  copyFileSync(join(cfg.projectRoot, 'assets', 'armor-hud-inject.js'), injectorDest)
  mkdirSync(join(appDir, 'dist'), { recursive: true })
  writeFileSync(sidecar, JSON.stringify({ base: 'http://127.0.0.1:' + (cfg.hud.port || 50101), tokenFile: join(cfg.hudDir, 'token.txt'), projectRoot: cfg.projectRoot, at: new Date().toISOString() }, null, 2))
  if (!patched) writeFileSync(mainJsPath, stripRequire(mainJs) + '\n' + REQUIRE_LINE)
  log.ok('embedded hud installed: ' + injectorDest + '（重启 Antigravity 生效）')
}

const invoked = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/install-embedded-hud.mjs')
if (invoked) main()
