// 层 4：IDE 侧等长补丁 —— 把 languageServer 的 --cloud_code_endpoint 指到本地改道代理
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { backup, listBackups, restore } from '../util/fs.mjs'
import { countOccurrences } from '../util/bytes.mjs'
import { log } from '../log.mjs'

export function buildReplacement(cfg) {
  const find = cfg.ide.endpointFind
  const base = cfg.ide.endpointBase
  const pad = find.length - base.length - 1
  if (pad < 1) throw new Error('endpointBase too long for equal-length patch')
  return base + '/a' + 'p'.repeat(pad - 1)
}

export function installIde(cfg, { apply = false } = {}) {
  const p = cfg.asarPath
  if (!existsSync(p)) throw new Error('app.asar not found: ' + p)
  const buf = readFileSync(p)
  const find = cfg.ide.endpointFind
  const repl = buildReplacement(cfg)
  const hits = countOccurrences(buf, find)
  const done = countOccurrences(buf, repl)
  log.info('ide: ' + p)
  log.info('  find  : ' + JSON.stringify(find) + ' x' + hits)
  log.info('  repl  : ' + JSON.stringify(repl) + ' x' + done + ' (equal length ' + (find.length === repl.length) + ')')
  if (!apply) return { dryRun: true, hits, already: done > 0 }
  if (done > 0 && hits === 0) return { already: true }
  if (hits === 0) throw new Error('anchor not found in app.asar (version drift?)')
  const bak = backup(p, cfg.backupDir, 'pre-ide')
  const out = Buffer.from(buf)
  const nb = Buffer.from(repl, 'utf8')
  let i = 0
  while (true) { const k = out.indexOf(Buffer.from(find, 'utf8'), i); if (k < 0) break; nb.copy(out, k); i = k + 1 }
  writeFileSync(p, out)
  log.ok('patched ' + hits + ' occurrence(s), length unchanged: ' + (out.length === buf.length))
  log.ok('backup: ' + bak)
  return { patched: hits, backup: bak, sameLength: out.length === buf.length }
}

export function rollbackIde(cfg) {
  const b = listBackups(cfg.backupDir, 'pre-ide')[0]
  if (!b) throw new Error('no ide backup')
  restore(b.path, cfg.asarPath)
  return b.path
}
