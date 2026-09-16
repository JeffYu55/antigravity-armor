
// 用本机已存储的 git 凭据（GCM）完成：查身份 -> 建仓 -> 推送 -> 校验。全程不打印令牌。
const { spawnSync, execFileSync } = require('child_process')
const https = require('https')

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd, input: opts.input, timeout: opts.timeout || 120000 })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}
function api(path, method, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const req = https.request({
      host: 'api.github.com', path, method,
      headers: {
        'User-Agent': 'antigravity-armor',
        Authorization: 'token ' + token,
        Accept: 'application/vnd.github+json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let s = ''
      res.on('data', (c) => (s += c))
      res.on('end', () => {
        let j = null
        try { j = JSON.parse(s) } catch {}
        resolve({ status: res.statusCode, json: j, raw: s.slice(0, 300) })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

;(async () => {
  const fill = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' })
  const token = ((fill.stdout || '').match(/^password=(.*)$/m) || [])[1]
  if (!token) { console.log('NO CREDENTIAL'); process.exit(1) }

  const me = await api('/user', 'GET', token)
  if (me.status !== 200) { console.log('AUTH FAILED', me.status, me.raw); process.exit(1) }
  const login = me.json.login
  const id = me.json.id
  console.log('authenticated as:', login, '(id ' + id + ')')
  console.log('token scopes    :', '（GCM OAuth 令牌，未展示）')

  // 仓库名与可见性
  const REPO = 'antigravity-armor'
  const existing = await api('/repos/' + login + '/' + REPO, 'GET', token)
  if (existing.status === 200) {
    console.log('repo already exists:', existing.json.html_url)
  } else {
    const created = await api('/user/repos', 'POST', token, {
      name: REPO,
      description: 'Antigravity 破甲工程：二进制提示词补丁 / 规则技能 / 生命周期钩子 / IDE 等长补丁 / 模型后端改道',
      private: true,
      has_issues: true,
      has_wiki: false,
      auto_init: false,
    })
    if (created.status !== 201) { console.log('CREATE FAILED', created.status, created.raw); process.exit(1) }
    console.log('repo created    :', created.json.html_url, '| private:', created.json.private)
  }

  console.log('login=' + login)
  console.log('id=' + id)
})()
