#!/usr/bin/env node
// antigravity-armor 统一入口
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.mjs'
import { readText, hasBom, expand, listBackups } from './util/fs.mjs'
import { installBinary, verifyBinary, rollbackBinary } from './layers/binary.mjs'
import { installRules, armorBody } from './layers/rules.mjs'
import { installHooks, buildHooksJson, discoverWorkspaces } from './layers/hooks.mjs'
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
  // divert / ls
  rows.push(['divert', netstat(Number(cfg.divert.port)) ? 'LISTENING :' + cfg.divert.port : 'down', cfg.divert.target + ' model=' + cfg.divert.model])
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
    console.log('divert :' + port + ' -> ' + (running ? 'LISTENING' : 'down') + '  target=' + cfg.divert.target + ' model=' + cfg.divert.model)
    const lp = join(cfg.logDir, 'divert.log')
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
    const logFile = join(cfg.logDir, 'divert.log')
    // 必须用异步 spawn：spawnSync 会一直等这个常驻服务退出，导致 CLI 卡死
    const selfPath = fileURLToPath(import.meta.url)
    const child = spawn(process.execPath, [selfPath, 'divert', 'run', '--port=' + port, '--model=' + (flags.model || cfg.divert.model)], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    log.ok('divert spawned (pid ' + child.pid + '), log: ' + logFile)
    return
  }
  if (action === 'run') return runDivert(port)
}

async function runDivert(port) {
  const { startDivert } = await import('./layers/divert.mjs')
  await startDivert(cfg, { port, model: flags.model || cfg.divert.model, target: flags.target || cfg.divert.target, logFile: join(cfg.logDir, 'divert.log') })
}

async function ls(action) {
  if (action === 'start') {
    const { launchLS, readLsPorts } = await import('./driver/ls.mjs')
    const { proc, pid, logFile, args } = launchLS(cfg, { port: Number(flags.port || 50095), csrf: flags.csrf || 'aarmor' })
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
    console.log(flags.json ? JSON.stringify({ id, chars: txt.length, blocked: /blocked by Gemini/i.test(txt), refused: /can'?t help|cannot help|无法协助|不能协助|抱歉/i.test(txt) }) : txt)
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

const commands = { status, verify, install, divert, ls, drive, rollback }
const handler = commands[cmd]
if (!handler) {
  console.log(`antigravity-armor

  aarmor status                       各层状态总览
  aarmor install [--apply] [--layer=binary|rules|hooks|ide] [--workspaces=a,b]
  aarmor verify [--json]              审计锚点/注册表
  aarmor rollback --layer=binary|ide|rules|hooks
  aarmor divert start|stop|status|run [--port=50100] [--model=deepseek-chat]
  aarmor ls start|stop [--port=50095]
  aarmor drive new "<prompt>" --port=<LS_HTTP> [--workspace=DIR] [--project=ID]
  aarmor drive reply <conversationId> [--json]
  aarmor drive list

环境变量: AARMOR_LOG=debug|info|warn|error, AARMOR_LOG_FILE, ${cfg.divert.keyRef}`)
  process.exit(1)
}
await handler(cmd === 'divert' ? positional[0] : cmd === 'ls' ? positional[0] : cmd === 'drive' ? positional[0] : undefined)
