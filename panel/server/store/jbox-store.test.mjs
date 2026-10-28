import assert from 'node:assert/strict'
import test from 'node:test'
import { createStore, DEFAULT_PROFILE, KEYS } from './jbox-store.mjs'

const memStore = () => {
  const m = new Map()
  return {
    store: createStore({
      get: (k) => (m.has(k) ? m.get(k) : null),
      set: (k, v) => m.set(k, v),
      del: (k) => m.delete(k),
    }),
    m,
  }
}

test('getProfile 无值返回默认', () => {
  const { store } = memStore()
  assert.deepEqual(store.getProfile(), DEFAULT_PROFILE)
})

test('IPv6 默认关闭:不解析也不访问 v6,除非用户自己打开', () => {
  const { store } = memStore()
  assert.equal(store.getProfile().ipv6, false)
})

test('setProfile 深合并,不丢未提及字段', () => {
  const { store } = memStore()
  store.setProfile({ ipv6: false, dns: { mode: 'dnsmasq' } })
  const p = store.getProfile()
  assert.equal(p.ipv6, false)
  assert.equal(p.dns.mode, 'dnsmasq')
  assert.equal(p.dns.direct, '223.5.5.5') // 未提及字段保留
  assert.equal(p.routing.proxyTag, 'PROXY')
})

test('setProfile 返回合并结果', () => {
  const { store } = memStore()
  const returned = store.setProfile({ ipv6: false })
  assert.deepEqual(returned, store.getProfile())
})

test('target policy reorder updates saved card order and keeps fallback last', () => {
  const { store } = memStore()
  const policies = [{ name: 'AI' }, { name: 'Block' }, { name: 'Direct' }]
  store.setProfile({ routing: { policies, fallbackName: 'Catch all', displayOrder: ['Block', 'AI', 'Catch all', 'Direct'] } })
  const reordered = [policies[0], policies[2], policies[1]]
  const updated = store.setProfile({ routing: { policies: reordered } })
  assert.deepEqual(updated.routing.displayOrder, ['AI', 'Direct', 'Block', 'Catch all'])
  assert.deepEqual(store.getProfile().routing.displayOrder, updated.routing.displayOrder)
  store.setProfile({ routing: { displayOrder: ['Direct', 'AI', 'Block', 'Catch all'] } })
  store.setProfile({ routing: { policies: reordered.map(p => ({ ...p, default: 'DIRECT' })) } })
  assert.deepEqual(store.getProfile().routing.displayOrder, ['AI', 'Direct', 'Block', 'Catch all'])
})

test('老数据缺新字段时用默认补齐', () => {
  const { store, m } = memStore()
  m.set(KEYS.profile, JSON.stringify({ ipv6: false }))
  const p = store.getProfile()
  assert.equal(p.ipv6, false)
  assert.deepEqual(p.tun, DEFAULT_PROFILE.tun)
})

test('数组字段整体替换而非合并', () => {
  const { store } = memStore()
  store.setProfile({ routing: { directRulesets: ['geosite-cn'] } })
  const p = store.getProfile()
  assert.deepEqual(p.routing.directRulesets, ['geosite-cn'])
  // 未提及的 routing 字段仍保留默认
  assert.equal(p.routing.proxyTag, 'PROXY')
  assert.deepEqual(p.routing.categories, [])
})

test('订阅/节点/部署态往返', () => {
  const { store } = memStore()
  store.setSubscriptions([{ id: 's1', url: 'http://x', name: 'A' }])
  assert.equal(store.getSubscriptions()[0].id, 's1')
  store.setNodes([{ tag: '美国-01' }])
  assert.equal(store.getNodes().length, 1)
  store.setDeployState({ stage: 'running', message: '', at: 1, badTags: [] })
  assert.equal(store.getDeployState().stage, 'running')
})

test('订阅/节点无值时返回空数组', () => {
  const { store } = memStore()
  assert.deepEqual(store.getSubscriptions(), [])
  assert.deepEqual(store.getNodes(), [])
})

test('clashSecret 生成一次并持久化', () => {
  const { store } = memStore()
  const s1 = store.getClashSecret()
  const s2 = store.getClashSecret()
  assert.equal(s1, s2)
  assert.match(s1, /^[0-9a-f]{32}$/)
})

test('clashSecret 用注入的 randomHex 保证测试确定性', () => {
  const m = new Map()
  const injected = createStore(
    {
      get: (k) => (m.has(k) ? m.get(k) : null),
      set: (k, v) => m.set(k, v),
      del: (k) => m.delete(k),
    },
    { randomHex: () => 'a'.repeat(32) },
  )
  assert.equal(injected.getClashSecret(), 'a'.repeat(32))
})

test('损坏的 JSON 回退到默认而非抛错', () => {
  const { store, m } = memStore()
  m.set(KEYS.profile, '{ not json')
  assert.deepEqual(store.getProfile(), DEFAULT_PROFILE)
  m.set(KEYS.subscriptions, 'oops')
  assert.deepEqual(store.getSubscriptions(), [])
})

test('损坏的部署态 JSON 回退到默认', () => {
  const { store, m } = memStore()
  m.set(KEYS.deployState, 'not json')
  assert.deepEqual(store.getDeployState(), { stage: 'idle', message: '', at: 0, badTags: [] })
})

test('线路选择快照:键名带 jbox/ 前缀(受保护,不会被设置同步清掉);旧的点号键自动搬过来', () => {
  const m = new Map()
  const store = createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
  assert.equal(KEYS.selections, 'jbox/selections')
  m.set('jbox.selections', JSON.stringify({ '谷歌': '香港' }))
  assert.deepEqual(store.getSelectionsSnapshot(), { '谷歌': '香港' })
  assert.ok(!m.has('jbox.selections'))
  assert.ok(m.has('jbox/selections'))
  store.setSelectionsSnapshot({ a: 'b' })
  assert.equal(m.get('jbox/selections'), JSON.stringify({ a: 'b' }))
  // 内核在跑时直接写新快照(不经 get):旧键也要被清掉
  m.set('jbox.selections', '{}')
  store.setSelectionsSnapshot({ c: 'd' })
  assert.ok(!m.has('jbox.selections'))
})

test('旧数据或旧备份的 Geo 自动更新计划退出使用，其他更新和 DNS 计划保留', () => {
  const { store, m } = memStore()
  m.set(KEYS.profile, JSON.stringify({ updates: { geo: { auto: true }, jbox: { auto: true } } }))
  assert.equal(store.getProfile().updates.geo, undefined)
  assert.equal(store.getProfile().updates.jbox.auto, true)
  const imported = store.setProfile({ updates: { geo: { auto: true, hour: 4 } }, dns: { filter: { autoUpdate: { enabled: true } } } })
  assert.equal(imported.updates.geo, undefined)
  assert.equal(imported.updates.jbox.auto, true)
  assert.equal(imported.dns.filter.autoUpdate.enabled, true)
})

test('stored stale display order and imported inline priority cannot override target order', () => {
  const { store, m } = memStore()
  m.set(KEYS.profile, JSON.stringify({ routing: { policies: [
    { name: 'AI' }, { name: 'Disabled', enabled: false }, { name: 'Block', inlinePriority: true },
  ], fallbackName: 'Catch all', displayOrder: ['Block', 'AI'] } }))
  const profile = store.getProfile()
  assert.deepEqual(profile.routing.displayOrder, ['AI', 'Block', 'Catch all'])
  assert.ok(profile.routing.policies.every((p) => !('inlinePriority' in p)))
  assert.deepEqual(store.setProfile({ routing: { fallbackName: 'Rest' } }).routing.displayOrder, ['AI', 'Block', 'Rest'])
})
