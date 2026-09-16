// 语言服务器守护：复刻 IDE 的 spawn 契约（stdio=pipe 且立刻 end stdin，父进程保持存活）
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, openSync, closeSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log.mjs'

export function lsArgs(cfg, { port = 50095, csrf = 'aarmor', backend = null, ideVersion = '2.12.2' } = {}) {
  const endpoint = backend || ('http://127.0.0.1:' + cfg.divert.port + '/a' + 'p'.repeat(Math.max(0, cfg.ide.endpointFind.length - cfg.ide.endpointBase.length - 1)))
  return [
    '--standalone', '--override_ide_name', 'antigravity', '--subclient_type', 'hub',
    '--override_ide_version', ideVersion, '--override_user_agent_name', 'antigravity',
    '--https_server_port', String(port), '--csrf_token', csrf,
    '--app_data_dir', 'antigravity-ide',
    '--api_server_url', 'https://generativelanguage.googleapis.com',
    '--cloud_code_endpoint', endpoint,
    '--disable_telemetry=true',
  ]
}

/**
 * 拉起语言服务器。
 * 关键点（踩过的坑）：
 *  - LS 启动时要从 stdin 读元数据，必须给出「立刻 EOF」的 stdin（NUL），否则 fatal
 *  - 父进程一旦退出，pipe 型 stdout/stderr 关闭会让 LS 一起死；因此 stdio 落文件 + detached + unref
 */
export function launchLS(cfg, opts = {}) {
  const args = lsArgs(cfg, opts)
  mkdirSync(cfg.logDir, { recursive: true })
  const logFile = opts.logFile || join(cfg.logDir, 'language_server.log')
  // 空文件即"立刻 EOF"的 stdin（'NUL' 在 Node 里会被当相对路径解析）
  const eofPath = join(cfg.stateDir, 'stdin.eof')
  if (!existsSync(eofPath)) writeFileSync(eofPath, '')
  const nul = openSync(eofPath, 'r')
  const outFd = openSync(logFile, 'w')   // 每次启动覆盖，避免读到上一次的端口
  const p = spawn(cfg.binaryPath, args, {
    stdio: [nul, outFd, outFd],
    detached: !opts.attach,
    windowsHide: true,
    env: { ...process.env },
  })
  p.unref()
  closeSync(nul)
  closeSync(outFd)
  const pidFile = join(cfg.stateDir, 'ls.pid')
  writeFileSync(pidFile, String(p.pid))
  log.ok('language server pid=' + p.pid + ' log=' + logFile)
  log.info('  args: ' + args.join(' '))
  return { proc: p, pid: p.pid, logFile, args }
}

/** 从日志里解析 LS 实际监听的 HTTP 端口（agentapi 用它） */
export async function readLsPorts(logFile, { tries = 40, delayMs = 500 } = {}) {
  const { readFileSync, existsSync } = await import('node:fs')
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, delayMs))
    if (!existsSync(logFile)) continue
    const t = readFileSync(logFile, 'utf8')
    // 注意 "for HTTPS (gRPC)" 也以 "for HTTP" 开头，HTTP 那条必须锚行尾
    const allHttps = [...t.matchAll(/listening on fixed port at (\d+) for HTTPS \(gRPC\)/g)]
    const allHttp = [...t.matchAll(/listening on fixed port at (\d+) for HTTP\s*$/gm)]
    const https = allHttps.at(-1)
    const http = allHttp.at(-1)
    if (https && http) return { https: Number(https[1]), http: Number(http[1]) }
  }
  return null
}
