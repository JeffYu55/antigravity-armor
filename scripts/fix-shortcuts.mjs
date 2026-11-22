// fix-shortcuts —— 给 Antigravity 的启动快捷方式统一加上 --remote-debugging-port
//
// 为什么必须这么做：CDP 注入要求进程带 --remote-debugging-port 启动。
// 用户重启时从开始菜单/任务栏/桌面点，快捷方式里没有这个参数 → 端口不监听 → 齿轮挂不上去。
// 把所有入口的 .lnk 改一遍，就再也不需要记得「用哪个图标启动」。
//
// 备份：state/backup/lnk/<原名>.lnk.armor-bak（原样保存，回滚直接覆盖回去）
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadConfig } from '../src/config.mjs'
import { log } from '../src/log.mjs'

const PORT = 9222
const cfg = loadConfig()
const bakDir = join(cfg.stateDir, 'backup', 'lnk')
mkdirSync(bakDir, { recursive: true })

const home = process.env.USERPROFILE
const candidates = [
  join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
  join(home, 'Desktop'),
  'C:\\Users\\Public\\Desktop',
  join(process.env.APPDATA || '', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
]

function findLnks(dir, depth = 2) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory() && depth > 0) out.push(...findLnks(p, depth - 1))
    else if (name.toLowerCase().endsWith('.lnk')) out.push(p)
  }
  return out
}

/** 按「目标路径是 Antigravity.exe」筛选，而不是按文件名（任务栏固定项常被重命名） */
function lnkTarget(lnk) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}').TargetPath`], { encoding: 'utf8', timeout: 15000 })
    return out.trim()
  } catch { return '' }
}

const all = candidates.flatMap((d) => findLnks(d))
const targets = all.filter((p) => /antigravity\.exe$/i.test(lnkTarget(p)) || /antigravity/i.test(basename(p)))
if (!targets.length) { log.warn('没找到 Antigravity 快捷方式'); process.exit(0) }

const ps = []
for (const lnk of targets) {
  const bak = join(bakDir, basename(lnk) + '.armor-bak')
  if (!existsSync(bak)) copyFileSync(lnk, bak)
  ps.push(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}'); if ($s.Arguments -notlike '*remote-debugging-port*') { $s.Arguments = ($s.Arguments + ' --remote-debugging-port=${PORT}').Trim(); $s.Save(); 'patched: ${lnk}' } else { 'already: ${lnk}' }`)
}
const script = ps.join('; ')
const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 60000 })
console.log(out.trim())
log.ok(`checked ${targets.length} shortcuts；备份在 ${bakDir}`)
