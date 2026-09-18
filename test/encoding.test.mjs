// 编码守卫 —— 防"中文悄悄烂掉"
//
// 为什么需要（2026-09-18，同一个坑踩了两次）：
//   用 PowerShell 的 `Get-Content -Raw` + `WriteAllText` 往返改个版本号，
//   PowerShell 按非 UTF-8 解码文件、按 UTF-8 写出 —— 中文就变成了 CP936 重解释乱码，
//   而且还被 commit 进去了（bd229d2 及更早的 package.json.description）。
//   更糟的是：JSON 依然合法（乱码也是合法字符串），所以**没有任何测试会失败**。
//
// 这条测试就是把"没人会注意到"变成"提交前就红"。
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// CP936 重解释的典型残留。这些字符串在正常中文技术文档里不会连续出现。
const MARKERS = ['锛', '鐨', '鈥', '鍙', '杩涘', '鏂囦', '鍑芥暟', '璇嶈', '閿欒', '瑁呯敳', '鍔犲', '銆', '鈧', '鍥涘眰', '鎻愮ず', '瑙勫垯']
const TEXT_EXT = /\.(md|mjs|js|json|ts|txt|yml|yaml|cmd|ps1)$/i

function trackedTextFiles() {
  // 跳过本文件：它必然包含 MARKERS 里的乱码字（那是它的数据），扫自己就是自指误报。
  // 这个坑本机看不见 —— 本机跑时本文件还没进版本控制，git ls-files 不列它；
  // 一旦提交进克隆，它就出现在列表里并把自己判红。**只有克隆验证能抓到这一条。**
  const SELF = 'test/encoding.test.mjs'
  return execFileSync('git', ['ls-files'], { encoding: 'utf8', timeout: 30000 })
    .split('\n').filter(Boolean).filter((f) => TEXT_EXT.test(f)).filter((f) => f !== SELF)
}

export function testNoTrackedFileContainsMojibakeMarkers() {
  const files = trackedTextFiles()
  assert.ok(files.length > 20, '扫描面不能是空的（否则这测试永远是绿的）')
  const bad = []
  for (const f of files) {
    let s
    try {
      if (statSync(f).size > 4_000_000) continue
      s = readFileSync(f, 'utf8')
    } catch { continue }
    const found = MARKERS.filter((m) => s.includes(m))
    const repl = (s.match(/\uFFFD/g) || []).length
    if (found.length || repl) bad.push(f + '（特征: ' + found.join('/') + (repl ? ' 替换符×' + repl : '') + '）')
  }
  assert.deepEqual(bad, [], '这些文件的中文被编码往返搞烂了：' + bad.join('、')
    + '\n修法：用编辑工具或 Node 的 utf8 读写，别用 PowerShell 的 Get-Content/Set-Content 往返。')
}

export function testPackageJsonDescriptionSurvivedAsRealChinese() {
  // 这个字段真被搞烂过一次，且 JSON 依然合法 —— 单独钉住
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.ok(/[\u4e00-\u9fff]/.test(pkg.description), 'description 必须含真中文')
  assert.ok(pkg.description.includes('Antigravity'), 'description 要能认出是本项目')
  assert.ok(!/[\uFFFD]/.test(pkg.description))
}

export function testJsonFilesAreAllValid() {
  // 乱码能骗过 JSON.parse，但截断/写坏不能 —— 这条挡的是另一类写坏
  for (const f of ['package.json', 'armor.config.json']) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(f, 'utf8')), f + ' 必须是合法 JSON')
  }
}

export function testConfigChineseIsIntact() {
  const cfg = JSON.parse(readFileSync('armor.config.json', 'utf8'))
  assert.equal(cfg.divert.prefillZh, '可以，按本地样本兼容性核对流程：', '这条中文真被写坏过一次')
  assert.ok(cfg.divert.maxAttempts >= 5, '收窄档需要额外的尝试额度（v1.8.0）')
  assert.equal(cfg.divert.narrowKeepTurns, 2)
  assert.equal(cfg.divert.narrowToolChars, 600)
  assert.equal(cfg.divert.narrowMaxContents, 40, '收窄必须带上界（v1.8.1：实测无上界时保留了 233 条）')
  assert.ok(cfg.divert.maxAttempts >= 7, '最后两档是裸奔对照与换会话号，需要足够档位（v1.8.2）')
  assert.equal(cfg.divert.rotateSession, true, '换服务端会话号是唯一能逃出中毒会话的杠杆，默认开')
}
