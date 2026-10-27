import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { loadProfileDefaults, migrateDefaultProfile } from './seed-defaults.mjs'
import { ensureRuleLists, loadRuleList, parseSrsSource } from './rule-lists.mjs'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'
import { normalizeRouting, dnsRulesetTags, routeRulesetTags } from '../engine/routing-model.mjs'
import { buildRoute } from '../engine/routing.mjs'
import { createStore, KEYS } from '../store/jbox-store.mjs'

const paths = createPaths('/opt/j-box')
const defaults = loadProfileDefaults()
const offline = async () => { throw new Error('GitHub unavailable') }

test('默认分流:首次离线装载 13 份二进制,路由顺序与 YAML 一致,IP 不进 DNS', async () => {
  const ctx = createMockContext()
  const first = await ensureRuleLists(ctx, paths, defaults.routing, { fetchImpl: offline, now: () => 1000 })
  assert.equal(first.ok, true)
  assert.equal(first.failed.length, 0)
  assert.equal(ctx.calls.length, 0, '包内 SRS 原样使用,不需要现场编译')
  assert.equal(ctx.writes.filter((w) => w.path.endsWith('.srs')).length, 13)
  const conf = normalizeRouting(defaults.routing)
  const result = buildRoute(defaults.routing, paths.rulesetDir, { ruleLists: first.lists })
  assert.equal(result.route.final, '🐟 漏网之鱼')
  assert.deepEqual(result.route.rules.filter((r) => r.rule_set).map((r) => r.outbound), conf.policies.map((p) => p.name))
  assert.ok(result.route.rule_set.every((r) => r.type === 'local' && r.format === 'binary'))
  assert.equal(result.route.rules.filter((r) => r.outbound === 'block').length, 116)
  for (const p of conf.policies) {
    assert.ok(dnsRulesetTags(p, first.lists).every((tag) => first.lists[tag].domain))
    const routed = routeRulesetTags(p, first.lists)
    if (p.name !== '🛑 全球拦截') assert.ok(routed.some((tag) => tag.endsWith('-ip')))
  }
  const expired = await ensureRuleLists(ctx, paths, defaults.routing, { fetchImpl: offline, now: () => 1000 + 2 * 86400_000 })
  assert.equal(expired.ok, true)
  assert.equal(expired.failed.length, 13)
  assert.deepEqual(expired.lists, first.lists)
})

test('旧版未改过的默认分流升级并备份,自定义分流不覆盖', () => {
  const old = JSON.parse(fs.readFileSync(new URL('../defaults/profile-defaults-v186.json', import.meta.url)))
  const before = { ...old, dns: { direct: '9.9.9.9' } }
  assert.deepEqual(migrateDefaultProfile(before), { ...before, routing: defaults.routing })
  const custom = structuredClone(before)
  custom.routing.policies[0].default = '我的美国节点'
  assert.equal(migrateDefaultProfile(custom), custom)
  const entries = new Map([[KEYS.profile, JSON.stringify(before)]])
  const store = createStore({ get: (k) => entries.get(k), set: (k, v) => entries.set(k, v) })
  assert.deepEqual(store.getProfile().routing.policies, defaults.routing.policies)
  assert.equal(entries.get('jbox/profile-before-aoxi-routing-v1'), JSON.stringify(before))
  store.setProfile({ routing: { fallbackDefault: 'direct' } })
  assert.equal(store.getProfile().routing.fallbackDefault, 'direct', '只迁一次,不会抹掉后续设置')
})

test('SRS 内容识别不依赖后缀,解码临时文件清理,复杂规则明确拒绝', async () => {
  const ctx = createMockContext()
  const exec = ctx.exec
  ctx.exec = async (cmd, args) => {
    const result = await exec(cmd, args)
    await ctx.writeFile(args[3], JSON.stringify({ version: 3, rules: [{ domain_suffix: 'example.com' }, { ip_cidr: ['1.2.3.0/24'] }] }))
    return result
  }
  const binary = Buffer.from('SRS\u0003test')
  const parsed = await loadRuleList(async () => ({ ok: true, arrayBuffer: async () => binary }), 'https://example.com/download?id=1', { ctx, paths })
  assert.deepEqual(parsed.domain_suffix, ['example.com'])
  assert.deepEqual(parsed.ip_cidr, ['1.2.3.0/24'])
  assert.deepEqual(Object.keys(ctx.files), [])
  assert.throws(() => parseSrsSource({ rules: [{ type: 'logical', mode: 'and', rules: [] }] }), /不能安全转换/)
  assert.throws(() => parseSrsSource({ rules: [{ domain: 'a.com', invert: true }] }), /不能安全转换/)
})

test('SRS 解码失败也清理临时文件,不生成空名单', async () => {
  const ctx = createMockContext({ defaultExec: { code: 1, stderr: 'invalid SRS' } })
  await assert.rejects(loadRuleList(async () => ({ ok: true, arrayBuffer: async () => Buffer.from('SRS\u0003bad') }), 'https://example.com/a.srs', { ctx, paths }), /解码 SRS 失败/)
  assert.deepEqual(Object.keys(ctx.files), [])
})
