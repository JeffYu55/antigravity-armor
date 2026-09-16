// 层 3：生命周期钩子（PreToolUse 全放行 / PreInvocation 装甲注入 / 拒绝恢复 / Stop 恢复）
// 两个必须踩过的坑：JSON 不能带 BOM；command 里的路径不能加引号（LS 经 cmd 执行会把引号当字面量）
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { writeText, readText, backup, expand, ensureDir } from '../util/fs.mjs'
import { log } from '../log.mjs'

export const HOOK_SCRIPTS = [
  'pretooluse-allow.cjs',
  'preinvocation-armor.cjs',
  'postinvocation-recover.cjs',
  'stop-recover.cjs',
]

export const HOOK_NAMES = {
  'pretooluse-allow.cjs': 'armor-allow-all',
  'preinvocation-armor.cjs': 'armor-pre-invocation',
  'postinvocation-recover.cjs': 'armor-post-invocation',
  'stop-recover.cjs': 'armor-stop-recovery',
}

/** 生成 hooks.json 内容（无 BOM、命令不带引号、绝对路径） */
export function buildHooksJson(hooksDir) {
  const cmd = (f) => 'node ' + join(hooksDir, f)     // 不加引号
  return JSON.stringify({
    'armor-allow-all': { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('pretooluse-allow.cjs'), timeout: 10 }] }] },
    'armor-pre-invocation': { PreInvocation: [{ type: 'command', command: cmd('preinvocation-armor.cjs'), timeout: 10 }] },
    'armor-post-invocation': { PostInvocation: [{ type: 'command', command: cmd('postinvocation-recover.cjs'), timeout: 10 }] },
    'armor-stop-recovery': { Stop: [{ type: 'command', command: cmd('stop-recover.cjs'), timeout: 10 }] },
  }, null, 2)
}

export function discoverWorkspaces(cfg) {
  const out = new Set(cfg.hooks.workspaces || [])
  const projDir = join(cfg.geminiHome, 'config', 'projects')
  if (existsSync(projDir)) {
    for (const f of readdirSync(projDir).filter((x) => x.endsWith('.json'))) {
      try {
        const j = JSON.parse(readFileSync(join(projDir, f), 'utf8'))
        const res = j?.projectResources?.resources || []
        for (const r of res) {
          const uri = r.folderUri || r.gitFolder?.folderUri
          if (uri) out.add(decodeURIComponent(uri.replace('file:///', '')).replace(/\//g, '\\'))
        }
      } catch { /* 损坏的项目配置跳过 */ }
    }
  }
  const tf = join(cfg.geminiHome, 'trustedFolders.json')
  if (existsSync(tf)) {
    try { for (const k of Object.keys(JSON.parse(readFileSync(tf, 'utf8')))) out.add(k) } catch {}
  }
  return [...out].filter((p) => existsSync(p))
}

/** 钩子脚本 + hooks.json 部署（全局根 + 工作区） */
export function installHooks(cfg, { apply = false, workspaces = null } = {}) {
  const hooksDir = join(cfg.stateDir, 'hooks')
  const ws = workspaces || discoverWorkspaces(cfg)
  const json = buildHooksJson(hooksDir)
  const written = []

  for (const f of HOOK_SCRIPTS) {
    const src = join(cfg.assetsDir, 'hooks', f)
    const dst = join(hooksDir, f)
    if (!existsSync(src)) { log.warn('missing hook asset: ' + src); continue }
    if (apply) writeText(dst, readText(src))
    written.push(dst)
  }
  log.info('hooks: scripts -> ' + hooksDir + ' (' + HOOK_SCRIPTS.length + ')')

  const targets = [...(cfg.hooks.globalRoots || []).map(expand), ...ws.map((w) => join(w, '.agents'))]
  for (const dir of targets) {
    const p = join(dir, 'hooks.json')
    const already = existsSync(p) && readText(p).includes('armor-allow-all')
    const bom = existsSync(p) && readFileSync(p).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    log.info('hooks: ' + (already && !bom ? 'ok    ' : 'write ') + p)
    if (!apply) continue
    if (existsSync(p)) backup(p, cfg.backupDir, 'pre-hooks')
    writeText(p, json)
  }
  return { scripts: written, hookFiles: targets.length, workspaces: ws.length }
}
