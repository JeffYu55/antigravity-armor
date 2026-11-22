// pure-repack-test —— 只验证 asar 重打包格式是否被 Electron 接受（不注入任何东西）
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { listAsar, readAsarFile } from './asar-extract.mjs'
import { packAsar } from './repack-asar.mjs'

const cfg = loadConfig()
const src = join(cfg.antigravityRoot, 'resources', 'app.asar')
const out = join(cfg.antigravityRoot, 'resources', 'app.asar.pure')

const files = listAsar(src)
const map = {}
for (const f of files) {
  if (f.unpacked) continue
  map[f.path] = readAsarFile(src, f.path)
}
const { buf, files: n } = packAsar(map)
writeFileSync(out, buf)
const orig = readFileSync(src)
console.log('original  bytes=' + orig.length + '  files=' + files.length + ' (unpacked ' + files.filter((f) => f.unpacked).length + ')')
console.log('repacked  bytes=' + buf.length + '  files=' + n)
console.log('header@0..16 orig=' + orig.subarray(0, 16).toString('hex'))
console.log('header@0..16 ours=' + buf.subarray(0, 16).toString('hex'))
console.log('written   ' + out)
