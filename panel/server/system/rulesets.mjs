// Geo 数据属于安装包。启动、详情、DNS 转发统一读取同一份只读快照，不在线补文件。
// 用户名单和 DNS 过滤是本机编译的产物，仍保留各自的数据路径。
import { isRuleListTag } from '../engine/rule-list.mjs'
import { isDnsFilterRulesetTag } from '../engine/dns-filter.mjs'
import { createPaths } from './paths.mjs'

const SAFE_TAG = /^[A-Za-z0-9._!@-]+$/
export const isSafeRulesetTag = tag => typeof tag === 'string' && SAFE_TAG.test(tag) && !tag.includes('..')
export const rulesetKind = tag => isSafeRulesetTag(tag) ? /^(geoip|geosite)-.+/.exec(tag)?.[1] || null : null

export const rulesetPath = (paths, tag) => {
  if (!isSafeRulesetTag(tag)) throw new Error(`不合法的规则集名 ${tag}`)
  return `${rulesetKind(tag) ? paths.geoDir : paths.rulesetDir}/${tag}.srs`
}

export const ensureRulesets = async (ctx, config, { paths = createPaths() } = {}) => {
  for (const entry of config?.route?.rule_set || []) {
    if (!entry || entry.type !== 'local' || !entry.tag || !entry.path) continue
    if (isRuleListTag(entry.tag) || isDnsFilterRulesetTag(entry.tag)) continue
    if (!rulesetKind(entry.tag)) {
      return { ok: false, message: `未知或不合法的规则集名 ${entry.tag}:只认得 geoip-/geosite- 开头的规则集` }
    }
    const path = rulesetPath(paths, entry.tag)
    if (!(await ctx.exists(path))) {
      return { ok: false, message: `安装包缺少规则集 ${entry.tag}，请更新或重新安装 J-Box` }
    }
    // 迁移旧配置的 data/rulesets 路径；旧下载缓存不再遮住随包的新数据。
    entry.path = path
  }
  return { ok: true, downloaded: [] }
}
