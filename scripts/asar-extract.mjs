// asar-extract —— 把 app.asar 解包成目录（P8' 内嵌 UI 的前置）
//
// 为什么需要：Electron 的两道 fuse 实测都是关的
//   EnableEmbeddedAsarIntegrityValidation = 0（exe 内无该 fuse 字符串；fuse 串 1011000011 第 5 位 0）
//   OnlyLoadAppFromAsar = 0
// 于是把 app.asar 改成 app 目录后 Electron 会直接加载目录里的源码，
// 我们就能自由改 renderer 注入点（等长补丁做不到这件事：asar 是偏移表归档，
// 一旦某个文件长度改变，后面所有文件 offset 全错）。
//
// 用法：
//   node scripts/asar-extract.mjs --out=build/app          # 解包到指定目录
//   node scripts/asar-extract.mjs --list                    # 只列文件
//   node scripts/asar-extract.mjs --cat=dist/hubWindows.js  # 打印某个文件
import { openSync, readSync, closeSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { log } from '../src/log.mjs'

export function readAsarHeader(asarPath) {
  const fd = openSync(asarPath, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const jsonLen = Number(head.readUInt32LE(12))
  const jb = Buffer.alloc(jsonLen)
  readSync(fd, jb, 0, jsonLen, 16)
  const header = JSON.parse(jb.toString('utf8'))
  // 数据段起点：header pickle 之后按 4 字节对齐（不对齐会整体错 1..3 字节，
  // 表现为每个文件的开头多出几个乱码字符 —— 这个坑实测踩过一次）
  const dataStart = Math.ceil((16 + jsonLen) / 4) * 4
  return { fd, header, dataStart, close: () => closeSync(fd) }
}

export function listAsar(asarPath) {
  const { fd, header, close } = readAsarHeader(asarPath)
  const out = []
  ;(function walk(node, pre) {
    for (const [name, v] of Object.entries(node.files || {})) {
      const p = pre + '/' + name
      if (v.files) walk(v, p)
      else out.push({ path: p, size: v.size, offset: Number(v.offset), unpacked: Boolean(v.unpacked) })
    }
  })(header, '')
  close()
  return out
}

export function readAsarFile(asarPath, filePath) {
  const clean = '/' + String(filePath).replace(/^\/+/, '')
  const { fd, header, dataStart, close } = readAsarHeader(asarPath)
  try {
    const parts = clean.split('/').filter(Boolean)
    let node = header
    for (const p of parts) {
      node = node.files && node.files[p]
      if (!node) throw new Error('asar 内没有 ' + clean)
    }
    // 直接按 offset 读整段（数据段已按 4 字节对齐，没有逐文件长度前缀）
    const buf = Buffer.alloc(node.size)
    readSync(fd, buf, 0, node.size, dataStart + Number(node.offset))
    return buf
  } finally { close() }
}

const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`))
  if (!hit) return d
  const i = hit.indexOf('=')
  return i < 0 ? true : hit.slice(i + 1)
}

const invoked = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/asar-extract.mjs')
if (invoked) {
  const cfg = loadConfig()
  if (arg('list')) {
    const files = listAsar(cfg.asarPath)
    console.log(files.map((f) => String(f.size).padStart(9) + '  ' + f.path).join('\n'))
    console.log('total ' + files.length + ' files')
    process.exit(0)
  }
  if (typeof arg('cat') === 'string') {
    process.stdout.write(readAsarFile(cfg.asarPath, arg('cat')).toString('utf8'))
    process.exit(0)
  }
  const outDir = resolve(cfg.projectRoot, String(arg('out') || 'build/app'))
  mkdirSync(outDir, { recursive: true })
  const files = listAsar(cfg.asarPath)
  let n = 0
  for (const f of files) {
    const dest = join(outDir, f.path)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, readAsarFile(cfg.asarPath, f.path))
    n++
  }
  log.ok(`extracted ${n} files -> ${outDir}`)
}
