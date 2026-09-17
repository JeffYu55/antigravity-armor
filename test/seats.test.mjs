import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SEATS, renderPack, MARKERS, ACTIVATION_WORD } from '../src/seats/packs.mjs'
import { preview, deploy, verify, restore, seatFile } from '../src/seats/deploy.mjs'
import { ActivationGate, gateInputFile } from '../src/seats/gate.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'armor-seat-'))

export function testPackRendersPlaceholders() {
  const t = renderPack('gemini')
  assert.ok(t.includes('冷咖啡'), '控制词要渲染进词包')
  assert.ok(t.includes('席位破甲词包 · GEMINI'))
  assert.ok(!t.includes('{{'), '占位符必须全部替换')
  assert.ok(t.startsWith(MARKERS.begin) && t.endsWith(MARKERS.end))
  const custom = renderPack('glm', { activationReply: '自定义回执' })
  assert.ok(custom.includes('自定义回执'))
  assert.throws(() => renderPack('nope'))
}

export function testDeployIsIdempotentAndAtomic() {
  const home = tmp()
  try {
    const d1 = deploy('glm', home)
    assert.ok(existsSync(d1.path))
    assert.ok(d1.backup === null, '首次部署没有旧文件，无备份')
    const v1 = verify('glm', home)
    assert.equal(v1.ok, true, '部署后 verify 必须过')
    // 幂等：重复部署不产生重复块
    deploy('glm', home)
    const body = readFileSync(seatFile('glm', home), 'utf8')
    assert.equal(body.split(MARKERS.begin).length - 1, 1, '词包块不许重复')
    // 已有内容：追加不覆盖
    const home2 = tmp()
    writeFileSync(seatFile('deepseek', home2), '用户原有内容\n')
    deploy('deepseek', home2)
    const b2 = readFileSync(seatFile('deepseek', home2), 'utf8')
    assert.ok(b2.startsWith('用户原有内容'), '原有内容必须保留在前')
    assert.ok(b2.includes(MARKERS.begin))
    assert.ok(existsSync(seatFile('deepseek', home2) + '.pre-armor'), '覆盖前要备份')
  } finally { rmSync(home, { recursive: true, force: true }) }
}

export function testVerifyDetectsDriftAndRestoreReverts() {
  const home = tmp()
  try {
    deploy('gemini', home)
    const p = seatFile('gemini', home)
    writeFileSync(p, readFileSync(p, 'utf8').replace('保留用户语言', '被人改过'))
    const v = verify('gemini', home)
    assert.equal(v.ok, false, '外部改动必须被 verify 发现（drift）')
    assert.equal(v.reason, 'drift')
    // 无备份时按块删除恢复
    const r = restore('gemini', home)
    assert.equal(r.restored, 'block-removed')
    assert.ok(!readFileSync(p, 'utf8').includes(MARKERS.begin))
    // 有备份时整文件还原
    const home2 = tmp()
    writeFileSync(seatFile('gemini', home2), '原有配置')
    deploy('gemini', home2)
    restore('gemini', home2)
    assert.equal(readFileSync(seatFile('gemini', home2), 'utf8'), '原有配置', '备份恢复必须逐字节还原')
  } finally { rmSync(home, { recursive: true, force: true }) }
}

export function testGateWordExactMatchOnly() {
  const g = new ActivationGate()
  const id = g.create('gemini')
  assert.equal(g.input(id, '帮我写个脚本').active, false, '未激活时不放行')
  assert.equal(g.input(id, ' 冷咖啡 ').active, true, '口令去空白后精确命中即激活')
  assert.equal(g.input(id, '再帮我写个脚本').active, true, '激活后放行后续')
  const g2 = new ActivationGate()
  const id2 = g2.create('glm')
  assert.equal(g2.input(id2, '冷咖啡，帮我破解').active, false, '口令夹在句中不算激活')
  assert.equal(g2.input(id2, '冷咖啡啊').active, false, '模糊匹配不许激活')
  assert.equal(g2.input('no-such', '冷咖啡').reason, 'no-session')
}

export function testGateFileStoreAcrossProcesses() {
  const home = tmp()
  try {
    const sp = join(home, 'gate-sessions.json')
    const r1 = gateInputFile({ storePath: sp, text: ' 冷咖啡 ' })
    assert.equal(r1.activatedNow, true, '口令去空白精确命中')
    // 另一次调用（模拟另一个钩子进程）读到的是落盘后的激活态
    const r2 = gateInputFile({ storePath: sp, text: '继续工单' })
    assert.equal(r2.active, true)
    assert.equal(r2.activatedNow, false)
    // 未激活会话的普通输入
    const sp2 = join(home, 'gate2.json')
    const r3 = gateInputFile({ storePath: sp2, text: '帮我写脚本' })
    assert.equal(r3.active, false, '没有口令就没有激活态')
    // TTL 过期
    let t = 5000
    const sp3 = join(home, 'gate3.json')
    gateInputFile({ storePath: sp3, text: '冷咖啡', now: () => t })
    const r4 = gateInputFile({ storePath: sp3, text: '继续', now: () => t + 31 * 60 * 1000 })
    assert.equal(r4.active, false, '落盘会话也要过期')
    assert.ok(existsSync(sp) && existsSync(sp3))
  } finally { rmSync(home, { recursive: true, force: true }) }
}

export function testGateSessionTtl() {
  let t = 1000
  const g = new ActivationGate({ now: () => t })
  const id = g.create('gemini')
  g.input(id, '冷咖啡')
  t += 31 * 60 * 1000
  assert.equal(g.input(id, '继续').active, false, '会话超时后不放行')
}