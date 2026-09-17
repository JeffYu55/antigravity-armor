#!/usr/bin/env node
// antigravity-armor 统一入口
import { existsSync, readFileSync, readdirSync, mkdirSync, openSync, appendFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.mjs'
import { readText, hasBom, expand, listBackups, writeText } from './util/fs.mjs'
import { installBinary, verifyBinary, rollbackBinary } from './layers/binary.mjs'
import { installRules, armorBody } from './layers/rules.mjs'
import { installHooks, buildHooksJson, discoverWorkspaces, hooksDrift } from './layers/hooks.mjs'
import { installIde, rollbackIde, buildReplacement } from './layers/ide.mjs'
import { resolveKey } from './credentials.mjs'
import { log } from './log.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0]
const flags = {}
const positional = []
for (const a of argv.slice(1)) {
  if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v === undefined ? true : v }
  else positional.push(a)
}
const cfg = loadConfig()

function netstat(port) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq ${port} } | Measure-Object).Count`], { encoding: 'utf8', timeout: 20000 })
    return Number(out.trim()) > 0
  } catch { return false }
}

async function status() {
  const rows = []
  // 二进制
  const b = existsSync(cfg.binaryPath) ? verifyBinary(cfg) : null
  rows.push(['binary', b ? (b.armored ? (b.clean ? 'ARMORED' : 'ARMORED (残留锚点 ' + b.remaining.length + ')') : 'not armored') : 'MISSING', cfg.binaryPath])
  // IDE
  let ideState = 'MISSING'
  if (existsSync(cfg.asarPath)) {
    const buf = readFileSync(cfg.asarPath)
    ideState = buf.includes(Buffer.from(buildReplacement(cfg), 'utf8')) ? 'PATCHED -> localhost' : (buf.includes(Buffer.from(cfg.ide.endpointFind, 'utf8')) ? 'original (points at Google)' : 'unknown')
  }
  rows.push(['ide', ideState, cfg.asarPath])
  const idePatched = ideState === 'PATCHED -> localhost'
  // rules
  const ruleFiles = cfg.rules.globalFiles.map(expand).filter(existsSync)
  rows.push(['rules', ruleFiles.length + '/' + cfg.rules.globalFiles.length + ' files', ruleFiles.join(' , ')])
  rows.push(['skill', existsSync(expand(cfg.rules.skillFile)) ? 'present' : 'missing', expand(cfg.rules.skillFile)])
  // hooks
  const hookDirs = [...(cfg.hooks.globalRoots || []).map(expand), ...discoverWorkspaces(cfg).map((w) => join(w, '.agents'))]
  let ok = 0, bom = 0
  for (const d of hookDirs) {
    const p = join(d, 'hooks.json')
    if (!existsSync(p)) continue
    if (hasBom(p)) bom++
    if (readText(p).includes('armor-allow-all')) ok++
  }
  rows.push(['hooks', ok + ' installed' + (bom ? ', ' + bom + ' WITH BOM (broken!)' : ''), hookDirs.length + ' candidate roots'])
  // 钩子脚本漂移：assets 是事实来源，state/hooks 是部署副本。对不上就是「改了源码但线上跑的还是旧脚本」——
  // 实测发生过一次静默失效（源码 3.7KB / 部署 1.9KB），而 status 全绿。所以这一项必须出现在总览里。
  const drift = hooksDrift(cfg)
  const drifted = drift.filter((d) => d.drift).map((d) => d.file)
  rows.push(['hook scripts', drifted.length ? drifted.length + ' DRIFTED' + (drifted.length ? ' (' + drifted.join(',') + ')' : '') : 'in sync', join(cfg.stateDir, 'hooks')])
  // divert / ls
  const divertUp = netstat(Number(cfg.divert.port))
  rows.push(['divert', divertUp ? 'LISTENING :' + cfg.divert.port : 'down', cfg.divert.passThrough ? 'pass-through -> ' + cfg.divert.upstream : cfg.divert.target + ' model=' + cfg.divert.model])
  const pidFile = join(cfg.stateDir, 'ls.pid')
  let lsState = 'down'
  if (existsSync(pidFile)) {
    const pid = readText(pidFile).trim()
    try { process.kill(Number(pid), 0); lsState = 'running pid=' + pid } catch { lsState = 'stale pid file' }
  }
  rows.push(['ls', lsState, join(cfg.logDir, 'language_server.log')])
  rows.push(['key ' + cfg.divert.keyRef, resolveKey(cfg, cfg.divert.keyRef) ? 'resolved' : 'MISSING', '~/.dsh/.credentials.yaml refs'])

  const w = Math.max(...rows.map((r) => r[0].length))
  console.log('\nAntigravity armor — status\n' + '─'.repeat(60))
  for (const [k, v, p] of rows) console.log('  ' + k.padEnd(w) + '  ' + String(v).padEnd(34) + '  ' + p)
  // 致命组合必须喊出来：IDE 已被指向本地代理，而代理不在 —— 连账号都登录不上
  // （实测报错：dial tcp 127.0.0.1:50100: connectex: No connection could be made）
  if (idePatched && !divertUp) {
    console.log('\n⚠ IDE 已指向 127.0.0.1:' + cfg.divert.port + '，但代理不在监听 —— 此刻连账号登录都会失败。')
    console.log('  立刻恢复：node src/cli.mjs divert start')
    console.log('  永久保活：node src/cli.mjs divert autostart install')
  }
  console.log('')
}

async function verify() {
  const r = verifyBinary(cfg)
  const out = {
    binary: { path: cfg.binaryPath, armored: r.armored, length: r.length, remainingAnchors: r.remaining, clean: r.clean },
    ide: { path: cfg.asarPath, patched: existsSync(cfg.asarPath) && readFileSync(cfg.asarPath).includes(Buffer.from(buildReplacement(cfg), 'utf8')) },
    rules: cfg.rules.globalFiles.map(expand).map((p) => ({ path: p, exists: existsSync(p), bom: existsSync(p) && hasBom(p) })),
    hooks: [...(cfg.hooks.globalRoots || []).map(expand)].map((d) => {
      const p = join(d, 'hooks.json')
      return { path: p, exists: existsSync(p), bom: existsSync(p) && hasBom(p), valid: existsSync(p) ? (() => { try { JSON.parse(readText(p)); return true } catch { return false } })() : false }
    }),
    // 脚本副本漂移：assets vs state/hooks —— 对不上就是「源码改了、线上跑的仍是旧脚本」
    hookScripts: hooksDrift(cfg).map(({ file, drift, srcSha, dstSha }) => ({ file, drift, srcSha, dstSha })),
    backups: listBackups(cfg.backupDir).slice(0, 5).map((b) => b.name),
  }
  if (flags.json) console.log(JSON.stringify(out, null, 2))
  else log.info(JSON.stringify(out, null, 2))
  return out
}

async function install() {
  const apply = !!flags.apply
  const layer = flags.layer || 'all'
  log.step('install (' + (apply ? 'APPLY' : 'DRY RUN') + ') layer=' + layer)
  const ws = flags.workspaces ? String(flags.workspaces).split(',') : null
  const res = {}
  if (layer === 'all' || layer === 'rules') res.rules = installRules(cfg, { apply, workspaces: ws || discoverWorkspaces(cfg) })
  if (layer === 'all' || layer === 'hooks') res.hooks = installHooks(cfg, { apply, workspaces: ws })
  if (layer === 'all' || layer === 'binary') { log.step('binary (41 injection points)'); res.binary = installBinary(cfg, { apply }) }
  if (layer === 'all' || layer === 'ide') { log.step('ide endpoint'); res.ide = installIde(cfg, { apply }) }
  if (!apply) log.warn('dry run — 加 --apply 才写入')
  return res
}

function divert(action) {
  const port = Number(flags.port || cfg.divert.port)
  const running = netstat(port)
  if (action === 'status' || !action) {
    // 配置里的模型 ≠ 进程实际在用的模型（切换模型只重启进程不改配置），所以两个都报
    let liveModel = null
    try {
      const ps = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*divert run*' } | Select-Object -First 1 -ExpandProperty CommandLine"], { encoding: 'utf8', timeout: 20000 })
      liveModel = (ps.match(/--model=(\S+)/) || [])[1] || null
    } catch {}
    const lp = join(cfg.logDir, 'divert.log')
    let lastModel = null
    if (existsSync(lp)) {
      const ms = [...readText(lp).matchAll(/model=([\w.-]+)/g)]
      lastModel = ms.length ? ms[ms.length - 1][1] : null
    }
    const sm = !!cfg.divert.sameModel
    const pt = !!cfg.divert.passThrough
    console.log('divert :' + port + ' -> ' + (running ? 'LISTENING' : 'down') + '  ' + (sm ? 'same-model 同模型重试 upstream=' + cfg.divert.upstream : pt ? 'pass-through 原模型直通 upstream=' + cfg.divert.upstream : 'target=' + cfg.divert.target))
    if (pt) console.log('  模式: 中间层零换模型 —— 整形直通：出站剥自家装甲 + BLOCK_NONE + 拦截同模型重发')
    else {
      console.log('  config model : ' + cfg.divert.model)
      console.log('  live   model : ' + (liveModel || '(未运行)') + (lastModel && lastModel !== liveModel ? '   [最近日志用的: ' + lastModel + ']' : ''))
    }
    if (existsSync(lp)) console.log('recent:\n' + readText(lp).split('\n').slice(-8).join('\n'))
    return
  }
  if (action === 'stop') {
    // 之前这里引号写错（Name='node.exe 少一个引号），PowerShell 直接抛 InvalidArgument，stop 从未生效过
    const ps = "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*divert run*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
    spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit', timeout: 30000 })
    return
  }
  if (action === 'start') {
    if (running) { log.warn('already listening on ' + port); return }
    spawnDivert(port)
    return
  }
  if (action === 'ensure') return ensureDivert(port)
  if (action === 'watchdog') return runWatchdog(port)
  if (action === 'autostart') return divertAutostart(positional[1] || 'status')
  if (action === 'run') return runDivert(port)
}

/** 常驻看门狗（v1.7.3）：每 5 分钟检查一次，代理不在就拉起。
 *  这是唯一能覆盖「会话运行中代理崩掉」的机制 —— 计划任务只在登录/定时触发，
 *  而 IDE 一旦拿不到 127.0.0.1:50100，连账号都登录不上。 */
async function runWatchdog(port) {
  const logFile = join(cfg.logDir, 'divert-watchdog.log')
  const every = Math.max(10, Number(flags.interval || cfg.divert.watchdogSeconds || 300)) * 1000
  const note = (m) => { try { mkdirSync(cfg.logDir, { recursive: true }); appendFileSync(logFile, new Date().toISOString() + '  ' + m + '\n') } catch {} }
  note('watchdog 启动 pid=' + process.pid + ' 端口=' + port + ' 间隔=' + every / 1000 + 's')
  const tick = () => {
    try {
      if (!netstat(port)) { note('代理不在监听 -> 拉起'); spawnDivert(port) }
    } catch (e) { note('检查失败: ' + e.message) }
  }
  tick()
  setInterval(tick, every)
  await new Promise(() => {}) // 常驻
}

/** 幂等保活：在监听就什么都不做、静默退出 0（专供计划任务调用） */
function ensureDivert(port) {
  if (netstat(port)) return
  spawnDivert(port)
}

function spawnDivert(port) {
  const logFile = join(cfg.logDir, 'divert.log')
  // 必须用异步 spawn：spawnSync 会一直等这个常驻服务退出，导致 CLI 卡死
  // v1.6.4：stderr/stdout 落文件 —— 此前 stdio:'ignore' 把崩溃堆栈整个丢掉，
  // 现场只剩「日志停在某个请求上、进程没了」，无法定案。
  const errFile = join(cfg.logDir, 'divert-stderr.log')
  mkdirSync(cfg.logDir, { recursive: true })
  const errFd = openSync(errFile, 'a')
  const selfPath = fileURLToPath(import.meta.url)
  const child = spawn(process.execPath, [selfPath, 'divert', 'run', '--port=' + port, '--model=' + (flags.model || cfg.divert.model)], { detached: true, stdio: ['ignore', errFd, errFd], windowsHide: true })
  child.unref()
  log.ok('divert spawned (pid ' + child.pid + '), log: ' + logFile + ', stderr: ' + errFile)
}

/** 自启保活（v1.7.3）：divert 不是服务，重启/注销/崩溃都会让它消失，
 *  而 app.asar 已经被指向 127.0.0.1:50100 —— 代理一没，**连账号都登录不上**
 *  （实测报错：`dial tcp 127.0.0.1:50100: connectex: No connection could be made`）。
 *  用一个 .cmd 包一层再挂计划任务：登录时拉起 + 每 5 分钟兜底 ensure。 */
const AUTOSTART_TASK_ONLOGON = 'AntigravityArmor-Divert-AtLogon'
const AUTOSTART_TASK_WATCHDOG = 'AntigravityArmor-Divert-Watchdog'

function autostartCmdPath() {
  return join(cfg.stateDir, 'divert-ensure.cmd')
}

function divertAutostart(sub) {
  const cmd = autostartCmdPath()
  const selfPath = fileURLToPath(import.meta.url)
  const mkCmd = () => {
    mkdirSync(cfg.stateDir, { recursive: true })
    const body = [
      '@echo off',
      'rem 由 `aarmor divert autostart install` 生成 —— 幂等保活，代理在监听时静默退出',
      '"' + process.execPath + '" "' + selfPath + '" divert ensure >> "' + join(cfg.logDir, 'divert-ensure.log') + '" 2>&1',
      '',
    ].join('\r\n')
    writeText(cmd, body)
    return cmd
  }
  const query = (tn) => {
    try {
      const out = execFileSync('schtasks', ['/Query', '/TN', tn], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] })
      return /Ready|Running|就绪|正在运行/i.test(out) ? 'installed' : 'present'
    } catch { return 'missing' }
  }
  const startupDir = join(process.env.APPDATA || '', 'Microsoft/Windows/Start Menu/Programs/Startup')
  const startupFile = join(startupDir, 'AntigravityArmor-Divert.cmd')
  if (sub === 'status' || !sub) {
    console.log('divert autostart')
    console.log('  at logon  : ' + query(AUTOSTART_TASK_ONLOGON) + '  (' + AUTOSTART_TASK_ONLOGON + ')')
    console.log('  watchdog  : ' + query(AUTOSTART_TASK_WATCHDOG) + '  (' + AUTOSTART_TASK_WATCHDOG + ', 每 5 分钟)')
    console.log('  启动文件夹: ' + (existsSync(startupFile) ? 'installed' : 'missing') + '  (' + startupFile + ')')
    console.log('  wrapper   : ' + (existsSync(cmd) ? cmd : '(未生成)'))
    try {
      const ps = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*divert watchdog*' } | Select-Object -First 1 -ExpandProperty ProcessId"], { encoding: 'utf8', timeout: 20000 })
      console.log('  看门狗进程: ' + (ps.trim() ? 'running pid=' + ps.trim() : 'down'))
    } catch { console.log('  看门狗进程: 未知') }
    return
  }
  if (sub === 'install') {
    const p = mkCmd()
    // 计划任务需要管理员（实测本机 Medium 完整性级别会被 Access is denied 挡掉），
    // 挡掉就自动降级到「启动文件夹 + 常驻看门狗」——一样能覆盖崩溃与重启，且不需要提权。
    const tr = 'cmd /c \\"' + p + '\\"'
    const mk = (tn, sc, mo) => {
      const args = ['/Create', '/TN', tn, '/TR', tr, '/SC', sc, '/RL', 'LIMITED', '/F']
      if (mo) args.push('/MO', String(mo))
      const r = spawnSync('schtasks', args, { encoding: 'utf8', timeout: 30000 })
      return r.status === 0
    }
    const a = mk(AUTOSTART_TASK_ONLOGON, 'ONLOGON')
    const b = mk(AUTOSTART_TASK_WATCHDOG, 'MINUTE', 5)
    if (a && b) {
      log.ok('计划任务已装：登录自启 + 每 5 分钟兜底')
    } else {
      mkdirSync(startupDir, { recursive: true })
      const node = process.execPath
      const self = fileURLToPath(import.meta.url)
      writeText(startupFile, [
        '@echo off',
        'rem 由 `aarmor divert autostart install` 生成：登录时静默拉起常驻看门狗',
        'rem 看门狗每 5 分钟检查 127.0.0.1:' + cfg.divert.port + '，不在监听就拉起（app.asar 指向本地，代理没了连账号都登录不上）',
        'powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath \'' + node + '\' -ArgumentList \'' + self + '\',\'divert\',\'watchdog\' -WindowStyle Hidden"',
        '',
      ].join('\r\n'))
      log.ok('计划任务不可用（需要管理员），已改用启动文件夹 + 常驻看门狗：' + startupFile)
      // 立刻拉起看门狗，本次会话就已经受保护（不必等下次登录）
      const selfPath = fileURLToPath(import.meta.url)
      const child = spawn(process.execPath, [selfPath, 'divert', 'watchdog'], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      log.ok('看门狗已立即启动 (pid ' + child.pid + ')')
    }
    console.log('\n保活语义：登录自动拉起 + 每 5 分钟检查一次（在监听就静默跳过）。')
    console.log('查看：node src/cli.mjs divert autostart status')
    return
  }
  if (sub === 'uninstall') {
    for (const tn of [AUTOSTART_TASK_ONLOGON, AUTOSTART_TASK_WATCHDOG]) {
      spawnSync('schtasks', ['/Delete', '/TN', tn, '/F'], { encoding: 'utf8', timeout: 20000 })
    }
    try { rmSync(startupFile, { force: true }) } catch {}
    spawnSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*divert watchdog*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { timeout: 20000 })
    log.ok('已移除自启与看门狗（wrapper 文件保留：' + cmd + '）')
    return
  }
}

async function runDivert(port) {
  const { startDivert } = await import('./layers/divert.mjs')
  await startDivert(cfg, { port, model: flags.model || cfg.divert.model, target: flags.target || cfg.divert.target, logFile: join(cfg.logDir, 'divert.log') })
}

async function ls(action) {
  if (action === 'start') {
    const { launchLS, readLsPorts } = await import('./driver/ls.mjs')
    // --backend= 可指定模型后端：默认走本地改道代理；传官方地址即为"对照组"（未经装甲的原生通道）
    const { proc, pid, logFile, args } = launchLS(cfg, { port: Number(flags.port || 50095), csrf: flags.csrf || 'aarmor', backend: flags.backend || null })
    const ports = await readLsPorts(logFile)
    console.log(JSON.stringify({ pid, ports, args }, null, 2))
    if (ports) console.log('\n用这个驱动:\n  $env:ANTIGRAVITY_LS_ADDRESS=\'localhost:' + ports.http + '\'\n  $env:ANTIGRAVITY_CSRF_TOKEN=\'' + (flags.csrf || 'aarmor') + '\'')
    process.exit(0)
  }
  if (action === 'stop') {
    const pidFile = join(cfg.stateDir, 'ls.pid')
    if (existsSync(pidFile)) { try { process.kill(Number(readText(pidFile).trim())) } catch {} }
    spawnSync('powershell', ['-NoProfile', '-Command', "Get-Process -Name language_server -ErrorAction SilentlyContinue | Stop-Process -Force"], { stdio: 'inherit' })
    return
  }
  const pidFile = join(cfg.stateDir, 'ls.pid')
  console.log(existsSync(pidFile) ? 'ls pid=' + readText(pidFile).trim() : 'ls not tracked')
}

async function drive(sub) {
  const { newConversation, readReply, listConversations } = await import('./driver/session.mjs')
  const port = Number(flags.port || 0)
  if (sub === 'list') { console.log(listConversations(cfg, Number(flags.limit || 10)).map((c) => c.id).join('\n')); return }
  if (sub === 'reply') {
    const id = positional[1]
    const txt = await readReply(cfg, id)
    // 判定走与 divert 同一套引擎（多签名加权 + 交付物判定），别再维护第二份朴素正则
    const { analyzeRefusal } = await import('./layers/refusal.mjs')
    const v = analyzeRefusal(txt)
    console.log(flags.json
      ? JSON.stringify({ id, chars: txt.length, blocked: /blocked by Gemini/i.test(txt), refused: v.isRefusal, why: v.why, score: v.score })
      : txt)
    return
  }
  if (sub === 'new') {
    const prompt = positional.slice(1).join(' ')
    const cwd = flags.workspace || process.cwd()
    const projectId = flags.project
    if (!port) throw new Error('--port=<LS http port> 必填（先 aarmor ls start）')
    const { id, raw } = newConversation(cfg, prompt, { httpPort: port, csrf: flags.csrf || 'aarmor', projectId, cwd, model: flags.model || 'flash' })
    if (!id) { console.log(JSON.stringify(raw, null, 2)); return }
    console.log('conversationId: ' + id)
    if (flags.wait !== false) {
      await new Promise((r) => setTimeout(r, Number(flags.waitMs || 45000)))
      const txt = await readReply(cfg, id)
      console.log('blocked=' + /blocked by Gemini/i.test(txt) + ' chars=' + txt.length)
      console.log(txt.slice(0, Number(flags.head || 1200)))
    }
  }
}

function rollback() {
  const layer = flags.layer || 'binary'
  if (layer === 'binary') console.log('restored ' + rollbackBinary(cfg))
  else if (layer === 'ide') console.log('restored ' + rollbackIde(cfg))
  else {
    const tag = layer === 'rules' ? 'pre-rules' : layer === 'hooks' ? 'pre-hooks' : 'pre-' + layer
    const bs = listBackups(cfg.backupDir, tag)
    if (!bs.length) throw new Error('no backups tagged ' + tag)
    console.log(bs.slice(0, 10).map((b) => b.path).join('\n'))
  }
}

async function evalCmd(sub) {
  const { runEval } = await import('./eval/index.mjs')
  return runEval({ sub: sub || 'report', flags, cfg })
}

async function probeCmd(sub) {
  const { runProbe } = await import('./probe/index.mjs')
  return runProbe({ sub: sub || 'measure', flags, cfg })
}

async function seatsCmd(sub) {
  const { SEATS, renderPack } = await import('./seats/packs.mjs')
  const { preview, deploy, verify, restore, seatFile } = await import('./seats/deploy.mjs')
  sub = sub || 'list'
  const seat = flags.seat || 'gemini'
  if (!SEATS[seat]) throw new Error('未知席位: ' + seat + '（可选 ' + Object.keys(SEATS).join('/') + '）')
  const home = flags.home || (seat === 'gemini' ? cfg.geminiHome : process.env[seat.toUpperCase() + '_CONFIG_DIR'])
  const opts = { controlWord: flags.word, activationReply: flags.reply }
  if (sub === 'list') {
    for (const [id, s] of Object.entries(SEATS)) {
      const h = id === 'gemini' ? cfg.geminiHome : process.env[id.toUpperCase() + '_CONFIG_DIR']
      console.log('  ' + id.padEnd(10) + ' ' + s.label.padEnd(22) + ' ' + (s.file || '') + '  home=' + (h || '(未解析，用 --home=DIR)'))
    }
    return
  }
  if (!home) throw new Error('席位 ' + seat + ' 配置目录未解析：用 --home=DIR 指定')
  if (sub === 'preview') {
    const pv = preview(seat, home, opts)
    console.log('seat      ' + pv.seat)
    console.log('path      ' + pv.path)
    console.log('exists    ' + pv.exists)
    console.log('deployed  ' + pv.alreadyDeployed)
    console.log('sha-after ' + pv.sha256After.slice(0, 16) + '…')
    console.log('bytes-after ' + Buffer.byteLength(pv.after))
    return
  }
  if (sub === 'deploy') {
    if (flags.apply) {
      const r = deploy(seat, home, opts)
      console.log('deployed  ' + r.path + '  backup=' + (r.backup || 'none') + '  sha=' + r.sha256.slice(0, 16) + '…')
    } else {
      console.log('DRY RUN（加 --apply 真写）。预览：')
      const pv = preview(seat, home, opts)
      console.log('  path ' + pv.path + '  exists=' + pv.exists + '  alreadyDeployed=' + pv.alreadyDeployed)
    }
    return
  }
  if (sub === 'verify') {
    const v = verify(seat, home, opts)
    console.log((v.ok ? 'ok       ' : 'DRIFT    ') + v.reason + '  ' + (v.sha256 ? v.sha256.slice(0, 16) + '…' : ''))
    return
  }
  if (sub === 'restore') {
    const r = restore(seat, home)
    console.log('restored ' + r.restored + '  ' + r.path)
    return
  }
  throw new Error('未知子命令 ' + sub + '（list/preview/deploy/verify/restore）')
}

const commands = { status, verify, install, divert, ls, drive, rollback, eval: evalCmd, probe: probeCmd, seats: seatsCmd }
const SUBCOMMANDS = new Set(['divert', 'ls', 'drive', 'eval', 'probe', 'seats'])
const handler = commands[cmd]
if (!handler) {
  console.log(`antigravity-armor

  aarmor status                       各层状态总览
  aarmor install [--apply] [--layer=binary|rules|hooks|ide] [--workspaces=a,b]
  aarmor verify [--json]              审计锚点/注册表
  aarmor rollback --layer=binary|ide|rules|hooks
  aarmor divert start|stop|status|run [--port=50100] [--model=deepseek-chat]
  aarmor divert ensure                幂等保活：代理不在就拉起，在监听就静默退出（供计划任务调用）
  aarmor divert autostart install|uninstall|status
                                      登录自启 + 每 5 分钟兜底 —— 代理一没，IDE 连账号都登录不上
  aarmor ls start|stop [--port=50095]
  aarmor drive new "<prompt>" --port=<LS_HTTP> [--workspace=DIR] [--project=ID]
  aarmor drive reply <conversationId> [--json]
  aarmor drive list
  aarmor eval build|verify|scan|report|diff|manifest [--dir=DIR] [--view=both] [--agent=FILE] [--json]
  aarmor probe bank|measure [--attempts=N] [--target=URL] [--json]   破甲跑分（离线 mock / 真实端点）
  aarmor seats list|preview|deploy|verify|restore [--seat=gemini] [--home=DIR] [--apply]  席位词包（就地破甲，不换模型）

环境变量: AARMOR_LOG=debug|info|warn|error, AARMOR_LOG_FILE, ${cfg.divert.keyRef}`)
  process.exit(1)
}
await handler(SUBCOMMANDS.has(cmd) ? positional[0] : undefined)
