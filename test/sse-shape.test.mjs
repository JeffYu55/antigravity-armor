// SSE 形状不变量 —— **以真实上游取证为基准**
//
// 为什么单独一个文件（2026-09-18 定案）：
//   旧版 neutralSse 结尾写 `data: [DONE]`（OpenAI 约定），Google 客户端不认，
//   把每个 `data:` 载荷当 protobuf 解析 → 撞上 `[` 当场崩：
//     agent executor error: calling model: proto: syntax error (line 1:1): unexpected token [
//   用户看到「先显示中性替代文本，紧接着 Agent terminated due to error」。
//
//   这条 bug 之所以能活很久，是因为**锁死它的测试是照假设写的**：
//     assert.ok(sse.includes('data: [DONE]'), '要有结束帧')
//   所以这里改成**照取证写**：夹具是 state/capture 里原样搬来的真实上游响应
//   （25/25 不含 [DONE]，一律以 `\r\n\r\n` 收尾后 EOF），
//   断言是「合成帧必须与真实帧同形」，而不是「合成帧长成我以为的样子」。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { neutralSse, BLOCK_FALLBACK_TEXT, extractSseText, isBlockMessage } from '../src/layers/gemini-retry.mjs'

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const REAL = ['real-sse-ok-2frame.sse', 'real-sse-inband-block.sse', 'real-sse-with-thoughts.sse']

const read = (f) => readFileSync(join(FX, f), 'utf8')
const framesOf = (t) => t.split('\r\n\r\n').filter((x) => x.startsWith('data: '))

export function testRealCapturesNeverContainDone() {
  // 这条断言本身就是本次 bug 的判据 —— 真实样本一个都不能有 [DONE]
  for (const f of REAL) {
    const t = read(f)
    assert.ok(!t.includes('[DONE]'), f + ' 含 [DONE] —— 那它就不是真实上游样本，夹具已被污染')
    assert.ok(t.endsWith('\r\n\r\n'), f + ' 真实流以 CRLF 帧界收尾')
  }
}

export function testRealFramesUseCrlfFrameBoundary() {
  for (const f of REAL) {
    const t = read(f)
    const frames = framesOf(t)
    assert.ok(frames.length >= 2, f + ' 至少要有内容帧与收尾帧')
    // 如果真实样本用 \n\n，那 framesOf 就切不出来 —— 反向确认分隔符真是 \r\n\r\n
    assert.equal(frames.length, (t.match(/^data: /gm) || []).length, f + ' 每帧都必须能被 CRLF 帧界切开')
  }
}

export function testRealTopLevelKeysAreExactlyTheThree() {
  const seen = new Set()
  for (const f of REAL) for (const fr of framesOf(read(f))) Object.keys(JSON.parse(fr.slice(6))).forEach((k) => seen.add(k))
  assert.deepEqual([...seen].sort(), ['metadata', 'response', 'traceId'], '顶层键集合必须与真实帧完全一致')
}

export function testSynthesizedSseIsSameShapeAsReal() {
  const synth = framesOf(neutralSse(BLOCK_FALLBACK_TEXT))
  const real = framesOf(read('real-sse-ok-2frame.sse'))
  assert.equal(synth.length, real.length, '帧数与真实短回复一致（内容帧 + STOP 收尾帧）')
  for (const [i, fr] of synth.entries()) {
    const s = JSON.parse(fr.slice(6)); const r = JSON.parse(real[i].slice(6))
    assert.deepEqual(Object.keys(s).sort(), Object.keys(r).sort(), '帧 ' + i + ' 顶层键必须与真实帧一致')
    assert.deepEqual(Object.keys(s.response).sort(), Object.keys(r.response).sort(), '帧 ' + i + ' response 键必须一致')
    const sc = s.response.candidates[0]; const rc = r.response.candidates[0]
    assert.deepEqual(Object.keys(sc).sort(), Object.keys(rc).sort(), '帧 ' + i + ' candidate 键必须一致')
    assert.deepEqual(Object.keys(sc.content).sort(), Object.keys(rc.content).sort(), '帧 ' + i + ' content 键必须一致')
  }
}

export function testSynthesizedSseEndsWithEofLikeReal() {
  const s = neutralSse(BLOCK_FALLBACK_TEXT)
  assert.ok(s.endsWith('\r\n\r\n'), '要与真实流一样：最后一个帧界之后直接 EOF')
  assert.ok(!/\[DONE\]/.test(s), '合成流不得含 [DONE]')
}

export function testNeutralSseUsesOnlyRealFrameBoundaries() {
  const s = neutralSse('x')
  // 去掉所有合法的 CRLF 帧界之后，不该再出现裸的 \n\n
  assert.ok(!s.replace(/\r\n\r\n/g, '').includes('\n\n'), '合成流不得混入裸换行帧界（真实帧一律 CRLF）')
  assert.equal((s.match(/^data: /gm) || []).length, 2, '恰好两帧')
}

export function testSynthesizedSseHasStopOnTheTerminatorFrameOnly() {
  const frames = framesOf(neutralSse('x'))
  const flags = frames.map((f) => JSON.parse(f.slice(6)).response.candidates[0].finishReason)
  assert.equal(flags[0], undefined, '内容帧不带 finishReason')
  assert.equal(flags[flags.length - 1], 'STOP', '收尾帧才是 STOP')
}

export function testOurOwnParserStillReadsBoth() {
  // 合成帧与真实帧都要能被自家解包器读出正文 —— 否则闸门又变瞎
  const a = extractSseText(neutralSse(BLOCK_FALLBACK_TEXT))
  assert.equal(a.text, BLOCK_FALLBACK_TEXT)
  const b = extractSseText(read('real-sse-ok-2frame.sse'))
  assert.ok(b.frames >= 2)
  assert.equal(b.finish, 'STOP', '真实流的 STOP 要被读出来')
}

export function testRealInbandBlockSampleIsDetected() {
  // 夹具里那 1011 字节的样本正文就是过滤提示 —— 检测器必须认得（这是回退分支的入口）
  const t = read('real-sse-inband-block.sse')
  assert.ok(isBlockMessage(t), '真实正文级过滤样本必须被 isBlockMessage 命中')
  assert.ok(!isBlockMessage(BLOCK_FALLBACK_TEXT), '中性替代不能反过来命中判定（否则会自激循环）')
}

export function testRealThoughtsSampleCarriesUsageMetadataOnEveryFrame() {
  const frames = framesOf(read('real-sse-with-thoughts.sse'))
  assert.ok(frames.length > 10, '长流样本帧数应当不少')
  for (const fr of frames) {
    assert.ok(JSON.parse(fr.slice(6)).response.usageMetadata, '真实帧每帧都带 usageMetadata（合成帧也要带）')
  }
}

// ——— 车道隔离：两条车道的终止符不同，绝不能互相抄 ———
//
//   OpenAI 协议（kuaipao 车道 / src/probe/mock.mjs）：`data: [DONE]` 是**正确**终止符
//   Gemini 协议（Google 车道 / src/layers/*.mjs） ：**绝无 [DONE]**，靠 STOP 帧 + EOF
//
// 本次事故就是有人把 OpenAI 的终止符抄进了 Gemini 车道。

export function testNoGeminiLaneLayerEverWritesDoneToClient() {
  const layerDir = join(FX, '..', '..', 'src', 'layers')
  const offenders = []
  for (const f of readdirSync(layerDir).filter((x) => x.endsWith('.mjs'))) {
    const src = readFileSync(join(layerDir, f), 'utf8')
    src.split('\n').forEach((line, i) => {
      // 只抓「真的写出去」的行：res.write/res.end 且带 [DONE]
      if (/\[DONE\]/.test(line) && /res\.(write|end)\s*\(/.test(line)) offenders.push(f + ':' + (i + 1))
    })
  }
  assert.deepEqual(offenders, [], 'Gemini 车道的 layers 里不得把 [DONE] 写给客户端：' + offenders.join(', '))
}

export function testOpenAiLaneKeepsItsOwnTerminator() {
  // 反向锁死：不能为了"统一"把 OpenAI 车道的正确终止符也删掉
  const mockSrc = readFileSync(join(FX, '..', '..', 'src', 'probe', 'mock.mjs'), 'utf8')
  assert.ok(mockSrc.includes('data: [DONE]'), 'OpenAI 车道的模拟上游必须保留 [DONE]（那是它的正确终止符）')
  assert.ok(/chat\.completion\.chunk/.test(mockSrc), '确认 mock 确实是 OpenAI 协议（据此才允许 [DONE]）')
}

export function testTheOldBuggyShapeWouldBeCaught() {
  // 反证：把出事前那份合成帧原样摆出来，本文档的不变量必须能把它拦下。
  // 没有这条，"测试能不能抓到 bug"就只是信念，不是证据。
  const old = 'data: ' + JSON.stringify({
    response: {
      candidates: [{ content: { role: 'model', parts: [{ text: BLOCK_FALLBACK_TEXT }] }, finishReason: 'STOP' }],
      modelVersion: 'aarmor-local-fallback',
      responseId: 'aarmor-neutral-1',
    },
    traceId: '',
    metadata: {},
  }) + '\n\ndata: [DONE]\n\n'

  assert.ok(old.includes('[DONE]'), '旧形状确实带 [DONE] —— 这就是客户端崩的入口')
  // 客户端把每个 data: 载荷都当 protobuf 解析：第二个载荷是 [DONE]，JSON.parse 直接抛
  const bad = old.split('\n\n').filter(Boolean)[1]
  assert.equal(bad, 'data: [DONE]')
  assert.throws(() => JSON.parse(bad.slice(6)), SyntaxError, '旧形状的第二个载荷无法被解析 —— 正是那个 proto 语法错误')
  // 而且它连帧界都不对（裸 \n\n 而非 \r\n\r\n）：按真实 CRLF 帧界切，两帧会被粘成一坨，
  // 于是紧接着的 JSON.parse 直接炸 —— 客户端看到的正是这一幕。
  const glued = framesOf(old)
  assert.equal(glued.length, 1, '裸换行的旧形状按真实 CRLF 帧界只能切出一坨（两帧粘连）')
  assert.throws(() => JSON.parse(glued[0].slice(6)), SyntaxError, '粘连后无法解析 —— 与客户端报的语法错误同源')
}
