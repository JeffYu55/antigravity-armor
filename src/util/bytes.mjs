// 等长字节补丁引擎：任何替换的长度必须 <= 原文，差额用空格补齐，
// 保证 PE 头与文件长度不变、字符串边界不被破坏。
export const SPACE = 0x20

/** 构造等长替换缓冲；放不下返回 null */
export function equalLength(find, repl) {
  const f = Buffer.from(find, 'utf8')
  const r = Buffer.from(repl, 'utf8')
  if (r.length > f.length) return null
  return Buffer.concat([r, Buffer.alloc(f.length - r.length, SPACE)])
}

/** 把 [start, end) 扩展到整行边界（换行为界） */
export function lineBounds(buf, at) {
  let a = at
  while (a > 0 && buf[a - 1] !== 0x0a) a--
  let b = at
  while (b < buf.length && buf[b] !== 0x0a) b++
  return [a, b]
}

/**
 * 收集补丁编辑区间（不写入）。
 * mode: 'substring' 只替换命中串本身；'line' 扩展到整行（行长 <= maxLineUnwrapped）
 * 返回 { edits: [{from,to,repl}], applied, skipped }
 */
export function collectEdits(buf, entries, { mode = 'substring', maxLineUnwrapped = 1400 } = {}) {
  const edits = []
  let skipped = 0
  for (const e of entries) {
    const probe = Buffer.from(e.probe, 'utf8')
    const repl = e.repl
    const rl = Buffer.byteLength(repl, 'utf8')
    let i = 0
    while (true) {
      const k = buf.indexOf(probe, i)
      if (k < 0) break
      i = k + 1
      if (mode === 'line') {
        const [a, b] = lineBounds(buf, k)
        if (b - a > maxLineUnwrapped) {
          if (rl > probe.length) { skipped++; continue }
          edits.push({ from: k, to: k + probe.length, repl })
        } else {
          if (rl > b - a) { skipped++; continue }
          edits.push({ from: a, to: b, repl })
        }
      } else {
        if (rl > probe.length) { skipped++; continue }
        edits.push({ from: k, to: k + probe.length, repl })
      }
    }
  }
  return { edits, applied: edits.length, skipped }
}

/** 应用编辑，返回新 buffer（不修改入参） */
export function applyEdits(buf, edits) {
  const out = Buffer.from(buf)
  for (const e of edits) {
    const r = Buffer.from(e.repl, 'utf8')
    Buffer.concat([r, Buffer.alloc(e.to - e.from - r.length, SPACE)]).copy(out, e.from)
  }
  return out
}

/** 两个 buffer 的变化区间（用于验证「只动了预期位置」） */
export function diffRanges(a, b) {
  if (a.length !== b.length) return { sameLength: false, ranges: [], bytes: 0, span: null }
  const ranges = []
  let i = 0
  while (i < a.length) {
    if (a[i] !== b[i]) {
      const s = i
      while (i < a.length && a[i] !== b[i]) i++
      ranges.push([s, i])
    } else i++
  }
  const bytes = ranges.reduce((n, [s, e]) => n + (e - s), 0)
  return { sameLength: true, ranges, bytes, span: ranges.length ? [ranges[0][0], ranges[ranges.length - 1][1]] : null }
}

/** 统计 needle 出现次数 */
export function countOccurrences(buf, needle) {
  const b = Buffer.from(needle, 'utf8')
  let i = 0, n = 0
  while (true) { const k = buf.indexOf(b, i); if (k < 0) break; n++; i = k + 1 }
  return n
}
