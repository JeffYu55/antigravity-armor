import assert from 'node:assert/strict'
import { equalLength, collectEdits, applyEdits, diffRanges, countOccurrences, lineBounds } from '../src/util/bytes.mjs'

export function testEqualLengthPads() {
  const r = equalLength('abcdefgh', 'xyz')
  assert.equal(r.length, 8)
  assert.equal(r.toString('utf8'), 'xyz     ')
}

export function testEqualLengthRejectsOverflow() {
  assert.equal(equalLength('abc', 'abcd'), null)
}

export function testCollectEditsSubstringAllOccurrences() {
  const buf = Buffer.from('foo bar foo baz foo')
  const { edits } = collectEdits(buf, [{ probe: 'foo', repl: 'bar' }], { mode: 'substring' })
  assert.equal(edits.length, 3)                       // 所有出现位置都要覆盖
  const out = applyEdits(buf, edits)
  assert.equal(out.length, buf.length)                // 等长
  assert.equal(countOccurrences(out, 'foo'), 0)
  assert.equal(countOccurrences(out, 'bar'), 4)       // 原有 1 个 bar + 3 个替换
}

export function testCollectEditsRejectsOverflowInsteadOfCorrupting() {
  const buf = Buffer.from('foo bar foo')
  const { edits, skipped } = collectEdits(buf, [{ probe: 'foo', repl: 'TOOLONG' }], { mode: 'substring' })
  assert.equal(edits.length, 0)                       // 放不下就整条跳过，绝不截断写入
  assert.equal(skipped, 2)
}

export function testLineModeExpandsToLineBounds() {
  const buf = Buffer.from('aaa\nTARGETLINE\nbbb\n')
  const { edits } = collectEdits(buf, [{ probe: 'TARGETLINE', repl: 'REPLACED' }], { mode: 'line', maxLineUnwrapped: 100 })
  assert.equal(edits.length, 1)
  const [a, b] = [edits[0].from, edits[0].to]
  assert.equal(buf.subarray(a, b).toString('utf8'), 'TARGETLINE')
  assert.equal(applyEdits(buf, edits).toString('utf8'), 'aaa\nREPLACED  \nbbb\n')
}

export function testLineModeFallsBackWhenLineTooLong() {
  const long = 'x'.repeat(50) + 'NEEDLE' + 'y'.repeat(50)
  const buf = Buffer.from(long)
  const { edits } = collectEdits(buf, [{ probe: 'NEEDLE', repl: 'OK' }], { mode: 'line', maxLineUnwrapped: 20 })
  assert.equal(edits.length, 1)
  assert.equal(edits[0].to - edits[0].from, 6)
}

export function testDiffRanges() {
  const a = Buffer.from('abcdefgh')
  const b = Buffer.from('abXXefgh')
  const d = diffRanges(a, b)
  assert.equal(d.sameLength, true)
  assert.equal(d.bytes, 2)
  assert.deepEqual(d.ranges, [[2, 4]])
}

export function testDiffRangesLengthChange() {
  assert.equal(diffRanges(Buffer.from('ab'), Buffer.from('abc')).sameLength, false)
}
