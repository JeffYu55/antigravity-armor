// 提示词覆盖位 —— 移植自 dsh-purge 的 prompt-inject.md + override-state.json。
//
// 解决的是「上游一升级就把用户改过的装甲正文冲掉」这件事：
//   assets/armor.md        种子（随项目发布，只读）
//   state/purge/armor-override.md   用户副本（一旦存在就是生效正文）
//   state/purge/override-state.json { customized, hash, seedHash, updatedAt }
// seedHash 记的是「用户开始改的时候种子长什么样」；种子后来变了 → status 报 seedChanged，
// 由用户决定 reset（吃新种子）还是手工合并 —— 不静默覆盖。
import { existsSync, rmSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { readText, writeText } from '../util/fs.mjs'

export const OVERRIDE_FILE = 'armor-override.md'
export const STATE_FILE = 'override-state.json'

const sha = (t) => createHash('sha256').update(String(t), 'utf8').digest('hex')

export function overridePaths(cfg) {
  return {
    seed: join(cfg.assetsDir, 'armor.md'),
    user: join(cfg.purgeDir, OVERRIDE_FILE),
    state: join(cfg.purgeDir, STATE_FILE),
  }
}

export function seedText(cfg) {
  const p = overridePaths(cfg).seed
  return existsSync(p) ? readText(p) : ''
}

export function readOverrideState(cfg) {
  const p = overridePaths(cfg).state
  try {
    const raw = JSON.parse(readText(p))
    return {
      customized: raw.customized === true,
      hash: String(raw.hash || ''),
      seedHash: String(raw.seedHash || ''),
      updatedAt: String(raw.updatedAt || ''),
    }
  } catch {
    return { customized: false, hash: '', seedHash: '', updatedAt: '' }
  }
}

function writeOverrideState(cfg, state) {
  const p = overridePaths(cfg).state
  mkdirSync(dirname(p), { recursive: true })
  writeText(p, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + '\n')
}

/** 生效的装甲正文：用户副本优先（存在即生效，即使 state 丢了也能自愈），否则种子 */
export function effectiveArmorBody(cfg, fallback = '') {
  const { user } = overridePaths(cfg)
  if (existsSync(user)) return readText(user)
  const seed = seedText(cfg)
  return seed || fallback
}

/** 覆盖位状态：user 文件存在但 state 说没改过 → 视为已改（自愈），并报种子是否变过 */
export function armorStatus(cfg) {
  const paths = overridePaths(cfg)
  const state = readOverrideState(cfg)
  const userExists = existsSync(paths.user)
  const seed = seedText(cfg)
  const seedHashNow = seed ? sha(seed) : ''
  const userText = userExists ? readText(paths.user) : ''
  return {
    customized: userExists || state.customized,
    userExists,
    seedPresent: !!seed,
    seedChanged: !!(state.seedHash && seedHashNow && state.seedHash !== seedHashNow),
    hash: userExists ? sha(userText) : state.hash,
    seedHashNow,
    seedHashAtEdit: state.seedHash,
    updatedAt: state.updatedAt,
    paths,
    bytes: userExists ? userText.length : seed.length,
    effective: userExists ? 'user' : 'seed',
  }
}

/** 建立用户副本并标记已改（之后 install/ensure 部署的是副本，不是种子） */
export function armorEdit(cfg) {
  const paths = overridePaths(cfg)
  mkdirSync(dirname(paths.user), { recursive: true })
  const seed = seedText(cfg)
  if (!existsSync(paths.user)) writeText(paths.user, seed)
  const body = readText(paths.user)
  writeOverrideState(cfg, { customized: true, hash: sha(body), seedHash: seed ? sha(seed) : '' })
  return { ...paths, bytes: body.length }
}

/** 丢弃用户副本，回到种子 */
export function armorReset(cfg) {
  const paths = overridePaths(cfg)
  try { rmSync(paths.user, { force: true }) } catch {}
  const seed = seedText(cfg)
  writeOverrideState(cfg, { customized: false, hash: '', seedHash: seed ? sha(seed) : '' })
  return { ...paths, bytes: seed.length }
}
