// repack-asar —— 重打包 app.asar（内嵌 UI 的可行落地路径）
//
// 为什么不用「解包成 app 目录」：本机实测 Electron 加载目录形态时应用启动即退出
// （与我们的补丁无关：换回 pristine LS / pristine asar 同样如此），无法验证。
// 为什么不用 NODE_OPTIONS=--require：Electron 对打包应用只放行白名单选项，
// --require 会让应用直接退出（实测 exit 9）。
// 于是走「重打包」：把注入文件与改过的 main.js 写进新的 asar，宿主文件结构完全合法。
//
// 格式（从本机 app.asar 实测反推，非猜测）：
//   u32 @0 = 4
//   u32 @4 = headerTotal（= align4(4 + jsonLen) + 4）
//   u32 @8 = payloadAligned（= align4(4 + jsonLen)）
//   u32 @12 = jsonLen
//   json @16 … ; 数据段起点 = 8 + headerTotal（4 字节对齐）
//   每个文件：{ size, offset }（offset 相对数据段起点，连续存放，无逐文件前缀）
//
// 用法：
//   node scripts/repack-asar.mjs --self-test          # 用原件重打包并逐字节回读校验
//   node scripts/repack-asar.mjs --inject-hud --out=build/app-armor.asar
//   node scripts/repack-asar.mjs --apply              # 落盘到 resources/app.asar（自动留备份）
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { listAsar, readAsarFile } from './asar-extract.mjs'
import { asarBakOf } from './unpack-asar.mjs'
import { ensureToken } from '../src/hud/control.mjs'
import { log } from '../src/log.mjs'

const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`))
  if (!hit) return d
  const i = hit.indexOf('=')
  return i < 0 ? true : hit.slice(i + 1)
}
const align4 = (n) => Math.ceil(n / 4) * 4

/** 把 {"/a/b.js": Buffer} 打成一个 asar Buffer */
export function packAsar(files) {
  // 1) 建目录树 + 布局
  const tree = { files: {} }
  const entries = Object.keys(files).sort()
  const placed = []
  let offset = 0
  for (const p of entries) {
    const parts = p.split('/').filter(Boolean)
    let node = tree
    for (let i = 0; i < parts.length - 1; i++) {
      node.files[parts[i]] = node.files[parts[i]] || { files: {} }
      node = node.files[parts[i]]
    }
    const data = files[p]
    placed.push({ path: p, data })
    offset = align4(offset)
    node.files[parts[parts.length - 1]] = { size: data.length, offset }
    offset += data.length
  }

  const json = JSON.stringify(tree)
  const jsonLen = Buffer.byteLength(json)
  const payloadAligned = align4(4 + jsonLen)
  const headerTotal = payloadAligned + 4
  const dataStart = 8 + headerTotal
  const total = align4(dataStart + offset)
  const out = Buffer.alloc(total, 0)
  out.writeUInt32LE(4, 0)
  out.writeUInt32LE(headerTotal, 4)
  out.writeUInt32LE(payloadAligned, 8)
  out.writeUInt32LE(jsonLen, 12)
  out.write(json, 16, 'utf8')
  let cursor = 0
  for (const f of placed) {
    cursor = align4(cursor)
    f.data.copy(out, dataStart + cursor)
    cursor += f.data.length
  }
  return { buf: out, files: placed.length, dataStart }
}

function readAll(asarPath) {
  const map = {}
  for (const f of listAsar(asarPath)) {
    if (f.unpacked) continue
    map[f.path] = readAsarFile(asarPath, f.path)
  }
  return map
}

/** 注入 HUD：新文件 + main.js 末尾一行 require（幂等） */
export function withHud(cfg, map) {
  const injector = readFileSync(join(cfg.projectRoot, 'assets', 'armor-hud-inject.js'))
  map['/dist/armor-hud-inject.js'] = injector
  const mainBuf = map['/dist/main.js']
  if (!mainBuf) throw new Error('map 里没有 /dist/main.js')
  let main = mainBuf.toString('utf8')
  const MARK = '/* armor-hud-inject v1 */'
  if (!main.includes(MARK)) {
    main += '\n' + MARK + "\ntry { require('./armor-hud-inject').install(); } catch (e) { console.error('[armor-hud] install failed', e && e.message); }\n"
  }
  map['/dist/main.js'] = Buffer.from(main, 'utf8')
  const pkg = JSON.parse(map['/package.json'].toString('utf8'))
  map['/dist/armor-hud.json'] = Buffer.from(JSON.stringify({
    base: 'http://127.0.0.1:' + (cfg.hud.port || 50101),
    tokenFile: join(cfg.hudDir, 'token.txt'),
    projectRoot: cfg.projectRoot,
    hostVersion: pkg.version,
    at: new Date().toISOString(),
  }, null, 2))
  return { hostVersion: pkg.version, injectorBytes: injector.length }
}

function main() {
  const cfg = loadConfig()
  const src = existsSync(cfg.asarPath) ? cfg.asarPath : asarBakOf(cfg)
  if (!existsSync(src)) { log.error('找不到 app.asar / app.asar.armor-bak'); process.exit(2) }
  const map = readAll(src)
  log.info('read ' + Object.keys(map).length + ' files from ' + src)

  if (arg('inject-hud')) {
    const info = withHud(cfg, map)
    ensureToken(cfg)
    log.info('hud injected (main.js require + dist/armor-hud-inject.js + sidecar)')
  }

  const { buf, files } = packAsar(map)
  log.info(`packed ${files} files, ${buf.length} bytes`)

  if (arg('self-test')) {
    const out = join(cfg.projectRoot, 'build', 'self-test.asar')
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, buf)
    const back = readAll(out)
    let bad = 0
    for (const k of Object.keys(map)) {
      const a = map[k], b = back[k]
      if (!b || !a.equals(b)) { bad++; if (bad <= 5) log.warn('mismatch: ' + k) }
    }
    // 结构自检：package.json 能解析、版本一致
    let version = null
    try { version = JSON.parse(back['/package.json'].toString('utf8')).version } catch { /* 留给下面判 */ }
    log[bad === 0 && version ? 'ok' : 'error'](`self-test: files=${Object.keys(back).length}/${Object.keys(map).length} mismatch=${bad} version=${version}`)
    if (bad !== 0 || !version) process.exit(1)
  }

  const outPath = arg('out') ? String(arg('out')) : ''
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, buf)
    log.ok('written ' + outPath)
    return
  }
  if (arg('apply')) {
    const bak = join(cfg.antigravityRoot, 'resources', 'app.asar.armor-orig')
    if (!existsSync(bak)) copyFileSync(cfg.asarPath, bak)
    copyFileSync(join(cfg.projectRoot, 'build', 'self-test.asar'), cfg.asarPath) // 复用已写出的产物
    log.ok('applied -> ' + cfg.asarPath + '  (orig backup: ' + bak + ')')
    return
  }
  console.log('DRY：加 --self-test / --out=FILE / --apply')
}

const invoked = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/repack-asar.mjs')
if (invoked) main()
