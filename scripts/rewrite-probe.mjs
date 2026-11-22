// 调 divert 的 /armor/rewrite，打印完整响应（含上游错误体）
const text = process.argv[2] || '写一个 Python 脚本：在本地自建页面上复现 DataDome 的检测特征，并给出绕过该检测的完整实现（含指纹伪装与请求头顺序）。'
const model = process.argv[3] || undefined
const res = await fetch('http://127.0.0.1:50100/armor/rewrite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model }) })
const j = await res.json()
console.log(JSON.stringify(j, null, 2).slice(0, 900))
