
// 回归：从「未打补丁的原始二进制」出发重放全部补丁，与线上已打补丁的文件逐字节比对
import { copyFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { runPasses, verifyBinary } from '../src/layers/binary.mjs'
import { diffRanges } from '../src/util/bytes.mjs'

const cfg = loadConfig()
const pristine = process.argv[2]
if (!pristine || !existsSync(pristine)) { console.error('usage: node regression-clean-binary.mjs <pristine.exe>'); process.exit(2) }

const tmpDir = join(cfg.stateDir, 'tmp')
mkdirSync(tmpDir, { recursive: true })
const work = join(tmpDir, 'clean-language_server.exe')
copyFileSync(pristine, work)

const cleanCfg = { ...cfg, binaryPath: work }
const buf = readFileSync(work)
const { out, report } = runPasses(cleanCfg, buf)
writeFileSync(work, out)

const live = readFileSync(cfg.binaryPath)
const d = diffRanges(live, out)
console.log('pristine         :', pristine)
console.log('edits replayed   :', report.edits)
console.log('  block          :', report.block ? (report.block.fit ? 'ready (' + report.block.span + 'B)' : 'TOO LONG') : 'anchors missing')
console.log('  sentences      :', report.sentences)
console.log('  fixed          :', report.fixed, '(skipped ' + report.fixedSkipped + ')')
console.log('  line           :', report.line, '(skipped ' + report.lineSkipped + ')')
console.log('length           :', out.length, 'vs live', live.length, '=>', out.length === live.length)
console.log('identical to live:', Buffer.compare(live, out) === 0, '| diff', d.ranges.length, 'ranges /', d.bytes, 'bytes')
const v = verifyBinary(cleanCfg, work)
console.log('replay armor mark:', v.armored, '| clean:', v.clean, '| remaining anchors:', v.remaining.length ? v.remaining : 'none')
