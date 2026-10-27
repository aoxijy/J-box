// 新装面板的默认外观与偏好:随包发布一份「面板设置」快照(server/defaults/storage-defaults.json)
// 和一张背景图(server/defaults/background-image.txt,data URL)。面板第一次启动、app_storage
// 里还没有任何 config/* 时把它们写进去,新装用户打开面板就是这套主题、圆角、透明度和背景。
// 已经在用的安装(有 config/*)一律不动。
import fs from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BACKGROUND_IMAGE_KEY = '__background_image__'
const DEFAULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'defaults')

export const loadStorageDefaults = (dir = DEFAULTS_DIR) => {
  let entries = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'storage-defaults.json'), 'utf8'))
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof k === 'string' && k.startsWith('config/') && !k.startsWith('config/access-') && typeof v === 'string') entries[k] = v
      }
    }
  } catch {
    entries = {}
  }
  let background = ''
  try {
    background = fs.readFileSync(path.join(dir, 'background-image.txt'), 'utf8').trim()
    if (!background.startsWith('data:image/')) background = ''
  } catch {
    background = ''
  }
  return { entries, background }
}

// 随包目标分流按 aoxi888.yaml 的首条命中顺序排列,规则集使用 guize 的二进制 SRS。
// 手工拦截在前,未命中走「漏网之鱼」;已有自定义档案不覆盖。
export const PROFILE_KEY = 'jbox/profile'

export const loadProfileDefaults = (dir = DEFAULTS_DIR) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'profile-defaults.json'), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (!parsed.routing || typeof parsed.routing !== 'object' || !Array.isArray(parsed.routing.policies)) return null
    return parsed
  } catch {
    return null
  }
}

export const seedDefaultStorage = ({ countConfigEntries, insert, hasKey = () => false, log = () => {}, dir = DEFAULTS_DIR }) => {
  if (countConfigEntries() > 0) return { seeded: 0, profile: false }
  const { entries, background } = loadStorageDefaults(dir)
  let seeded = 0
  for (const [k, v] of Object.entries(entries)) {
    insert(k, v)
    seeded += 1
  }
  if (background) {
    insert(BACKGROUND_IMAGE_KEY, background)
    seeded += 1
  }
  let profile = false
  const profileDefaults = loadProfileDefaults(dir)
  if (profileDefaults && !hasKey(PROFILE_KEY)) {
    insert(PROFILE_KEY, JSON.stringify(profileDefaults))
    profile = true
  }
  if (seeded || profile) log(`[defaults] 全新安装:写入 ${seeded} 项默认面板设置${background ? '(含背景图)' : ''}${profile ? `,以及默认目标分流(${profileDefaults.routing.policies.length} 个站点集)` : ''}`)
  return { seeded, profile }
}

// 只升级完全未改过的 v0.1.186 默认分流,用户自定义过的档案保持原样。
export const migrateDefaultProfile = (profile) => {
  if (!profile || typeof profile !== 'object') return profile
  const previous = ['profile-defaults-v186.json', 'profile-defaults-aoxi-v1.json'].map(loadProfileDefaultsFromLegacy)
  if (!previous.some((p) => p && isDeepStrictEqual(profile.routing, p.routing))) return profile
  const next = loadProfileDefaults()
  return next ? { ...profile, routing: next.routing } : profile
}
const loadProfileDefaultsFromLegacy = (filename) => {
  try { return JSON.parse(fs.readFileSync(path.join(DEFAULTS_DIR, filename), 'utf8')) }
  catch { return null }
}
