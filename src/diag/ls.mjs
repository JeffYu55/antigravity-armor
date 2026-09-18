// language_server 进程探测（v1.7.5）
//
// 起因：status 里的 `ls` 行读的是我们**自己启动**时写的 state/ls.pid，
// 而实际干活的 LS 是 IDE 自己拉起的（不在那个文件里）—— 于是明明在跑却显示 down，
// 与「divert 全绿但代理其实死了」属于同一类误导性状态，必须一起修掉。
//
// 看三件事：有几个 LS 在跑、它们的 app_data_dir、以及 endpoint 是否指向本地 divert。
import { spawnSync } from 'node:child_process'

/** 解析 `--flag value` 形式的命令行参数（CommandLine 里可能带引号） */
export function parseFlag(cmdline, flag) {
  const s = String(cmdline || '')
  const re = new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[= ]"?([^"\\s]*)')
  const m = s.match(re)
  return m ? m[1] : null
}

/** 由命令行列表归纳出可读结论（纯函数，便于测试） */
export function summarizeLs(cmds, divertPort) {
  const entries = cmds.map((c) => {
    const endpoint = parseFlag(c, '--cloud_code_endpoint')
    return {
      endpoint,
      appDataDir: parseFlag(c, '--app_data_dir'),
      viaDivert: !!endpoint && String(endpoint).includes('127.0.0.1:' + divertPort),
    }
  })
  const via = entries.filter((e) => e.viaDivert).length
  const summary = !entries.length ? 'down（没有 language_server 进程）'
    : 'running ×' + entries.length + (via ? '，其中 ' + via + ' 个指向 divert' : '（未指向 divert —— L4 补丁可能已被覆盖）')
  return { count: entries.length, viaDivert: via, entries, summary }
}

/** 真探：查在跑的 language_server.exe。Windows-only（本项目即 Windows 工具链） */
export function probeLanguageServers(divertPort) {
  const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'language_server.exe\'" | '
    + 'ForEach-Object { $_.CommandLine }'
  let out = ''
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 25000 })
    out = r.stdout || ''
  } catch { /* 探测失败按「不可知」处理，不伪装成 down */ }
  const cmds = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (!cmds.length && !out.trim()) return { count: 0, viaDivert: 0, entries: [], summary: '未探到（进程查询失败）' }
  return summarizeLs(cmds, divertPort)
}