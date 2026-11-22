// make-live-dock —— 用真实 pageMain 打一张「活的」dock 截图
//
// 做法：从 assets/armor-hud-inject.js 里按大括号配平抽出 pageMain 的函数体，
// 直接在浏览器里调用它（连真实控制面 50101，带真实 token）。
// 这样验证的是**同一份页面代码**，不是另画的静态稿。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const src = readFileSync(join(root, 'assets', 'armor-hud-inject.js'), 'utf8')

function extractFunction(text, name) {
  const start = text.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('找不到函数 ' + name)
  let i = text.indexOf('{', start)
  let depth = 0
  for (let j = i; j < text.length; j++) {
    const c = text[j]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, j + 1) }
  }
  throw new Error('函数未闭合 ' + name)
}

function extractCss(text) {
  const s = text.indexOf('const CSS = `')
  const e = text.indexOf('\n`', s)
  return text.slice(s + 'const CSS = `'.length, e)
}

const pageMain = extractFunction(src, 'pageMain')
const css = extractCss(src)
const token = readFileSync(join(root, 'state', 'hud', 'token.txt'), 'utf8').trim()

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
body{margin:0;height:420px;background:linear-gradient(180deg,#12161c,#0b0d10);font-family:"Segoe UI",system-ui}
.hintwin{position:absolute;left:20px;top:16px;color:#33414f;font-size:12px}
${css}
</style></head><body>
<div class="hintwin">Antigravity 窗口（示意）· 下面这条是真实 pageMain 渲染、真实控制面数据</div>
<script>
${pageMain}
try { pageMain({ base: 'http://127.0.0.1:50101', token: ${JSON.stringify(token)} }) } catch (e) { document.title = 'ERR ' + e.message }
</script>
</body></html>`

mkdirSync(join(root, 'build'), { recursive: true })
writeFileSync(join(root, 'build', 'live-dock.html'), html)
console.log('wrote build/live-dock.html  pageMain bytes=' + pageMain.length + ' css bytes=' + css.length)
