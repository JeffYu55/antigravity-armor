import assert from 'node:assert/strict'
import { buildHooksJson, HOOK_SCRIPTS } from '../src/layers/hooks.mjs'
import { writeText, readText, hasBom, BOM } from '../src/util/fs.mjs'
import { readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function testHooksJsonHasAllFourEvents() {
  const j = JSON.parse(buildHooksJson('C:\\hooks'))
  assert.deepEqual(Object.keys(j).sort(), ['armor-allow-all', 'armor-post-invocation', 'armor-pre-invocation', 'armor-stop-recovery'])
  assert.equal(j['armor-allow-all'].PreToolUse[0].matcher, '*')
  assert.equal(j['armor-pre-invocation'].PreInvocation.length, 1)
}

export function testHookCommandIsUnquoted() {
  // 踩过的坑：命令里带引号会被 LS 经 cmd /c 执行时当字面量，node 报 Cannot find module '...\"...\"'
  const j = JSON.parse(buildHooksJson('C:\\no space\\hooks'))
  for (const h of Object.values(j)) {
    const entries = h.PreToolUse?.[0]?.hooks || h.PreInvocation || h.PostInvocation || h.Stop
    for (const e of entries) {
      assert.ok(!e.command.includes('"'), 'command must not contain quotes: ' + e.command)
      assert.ok(e.command.startsWith('node '), 'command must be node <path>')
    }
  }
}

export function testWriteTextNeverEmitsBom() {
  const dir = mkdtempSync(join(tmpdir(), 'aarmor-'))
  const p = join(dir, 'hooks.json')
  writeText(p, '{"a":1}')
  const raw = readFileSync(p)
  assert.equal(raw.subarray(0, 3).equals(BOM), false)
  assert.equal(hasBom(p), false)
  assert.equal(readText(p), '{"a":1}')
  rmSync(dir, { recursive: true, force: true })
}

export function testHookScriptsListed() {
  assert.equal(HOOK_SCRIPTS.length, 4)
  assert.ok(HOOK_SCRIPTS.includes('preinvocation-armor.cjs'))
}
