
const { spawnSync } = require('child_process')
const r = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' })
if (r.status !== 0) { console.log('fill failed:', r.status, r.stderr.slice(0, 200)); process.exit(0) }
const out = r.stdout
const user = (out.match(/^username=(.*)$/m) || [])[1] || ''
const pass = (out.match(/^password=(.*)$/m) || [])[1] || ''
console.log('username:', user || '(empty)')
console.log('password present:', !!pass, '| length:', pass.length, '| prefix:', pass.slice(0, 4) + '...')
console.log('looks like PAT:', /^(ghp_|github_pat_|gho_|ghs_)/.test(pass))
