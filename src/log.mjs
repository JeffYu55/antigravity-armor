// 统一日志：带层级前缀，可静音
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const envLevel = LEVELS[process.env.AARMOR_LOG || 'info'] ?? 20
const sink = process.env.AARMOR_LOG_FILE ? (await import('node:fs')).createWriteStream(process.env.AARMOR_LOG_FILE, { flags: 'a' }) : null

function emit(level, tag, args) {
  if (LEVELS[level] < envLevel) return
  const line = new Date().toISOString().slice(11, 19) + ' ' + tag + ' ' + args.map(String).join(' ')
  if (level === 'error') console.error(line)
  else console.log(line)
  if (sink) sink.write(line + '\n')
}
export const log = {
  debug: (...a) => emit('debug', 'debug', a),
  info: (...a) => emit('info', ' info', a),
  ok: (...a) => emit('info', '   ok', a),
  warn: (...a) => emit('warn', ' warn', a),
  error: (...a) => emit('error', 'error', a),
  step: (t) => emit('info', '  ==', [t]),
}
