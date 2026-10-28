// h2 连接诊断 v2：显式发请求看会不会响应；并测 h1 对照
import http2 from 'node:http2'
import https from 'node:https'

const ORIGIN = 'https://daily-cloudcode-pa.googleapis.com'
const PATH = '/v1internal/nonexist'

function h2test(label, opts) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const c = http2.connect(ORIGIN, opts || {})
    c.on('error', (e) => console.log(label + ' [session-err] ' + (e.code || '') + ' ' + (e.aggregateErrors ? e.aggregateErrors.length + ' errs: ' + e.aggregateErrors.map(x => x.code + '@' + x.address).join(',') : e.message) + ' at ' + (Date.now() - t0) + 'ms'))
    const rq = c.request({ ':method': 'GET', ':path': PATH })
    rq.on('response', (h) => { console.log(label + ' response :status=' + h[':status'] + ' in ' + (Date.now() - t0) + 'ms'); c.close(); resolve() })
    rq.on('error', (e) => { console.log(label + ' [rq-err] ' + e.code + ' at ' + (Date.now() - t0) + 'ms'); c.close(); resolve() })
    rq.end()
    setTimeout(() => { if (!rq.closed) { console.log(label + ' TIMEOUT 20s'); c.close(); resolve() } }, 20000)
  })
}

function h1test() {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const preq = https.request({ host: 'daily-cloudcode-pa.googleapis.com', path: PATH, method: 'GET', timeout: 20000 }, (res) => {
      console.log('h1 response status=' + res.statusCode + ' in ' + (Date.now() - t0) + 'ms')
      res.resume(); resolve()
    })
    preq.on('error', (e) => { console.log('h1 [err] ' + e.code + ' at ' + (Date.now() - t0) + 'ms'); resolve() })
    preq.end()
    setTimeout(() => resolve(), 22000)
  })
}

await h2test('h2-default')
await h2test('h2-noAuto', { autoSelectFamily: false })
await h1test()
process.exit(0)
