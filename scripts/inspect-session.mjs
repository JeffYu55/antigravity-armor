// 打印探针缓存请求的关键字段（不改动）
import { readFileSync } from 'node:fs'
const p = 'C:/Users/Administrator/Projects/antigravity-armor-2.34/state/probe/session.json'
const s = JSON.parse(readFileSync(p, 'utf8'))
const body = JSON.parse(s.body || '{}')
const req = body.request || {}
console.log('model      ' + body.model)
console.log('project    ' + body.project)
console.log('genCfg     ' + JSON.stringify(req.generationConfig || {}))
console.log('safety     ' + JSON.stringify((req.safetySettings || []).slice(0, 3)))
console.log('tools      ' + ((req.tools || []).length) + ' 组, 函数 ' + ((req.tools || [])[0]?.functionDeclarations || []).length + ' 个')
console.log('sysParts   ' + ((req.systemInstruction?.parts || []).length) + ' 片, 总长 ' + ((req.systemInstruction?.parts || []).reduce((n, x) => n + (x.text || '').length, 0)))
console.log('contents   ' + ((req.contents || []).length) + ' 段')
console.log('toolConfig ' + JSON.stringify(req.toolConfig || {}))
