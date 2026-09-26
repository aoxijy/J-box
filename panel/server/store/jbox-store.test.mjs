import assert from 'node:assert/strict'
import test from 'node:test'
import { createStore, DEFAULT_PROFILE, KEYS } from './jbox-store.mjs'
import { defaultGroups } from '../engine/user-groups.mjs'
const oldReleaseDefaultGroups = () => {
  const regional = [
    { id: 'g-1789350557846', name: 'CHATGPT自动', icon: 'brand:githubcopilot', testUrl: 'custom', tolerance: 300 },
    { id: 'g-1789350194599', name: '香港-自动', icon: 'HK', testUrl: '', tolerance: 100 },
    { id: 'g-1789350236691', name: '亚洲-自动', icon: 'globe:earth-asia', testUrl: '', tolerance: 100 },
    { id: 'g-1789350262328', name: '美国-自动', icon: 'US', testUrl: '', tolerance: 100 },
    { id: 'g-1789350283340', name: '其他-自动', icon: 'globe:earth-meridians', testUrl: '', tolerance: 100 },
  ]
  const previousById = new Map(regional.map(({ id, name, icon, testUrl, tolerance }) => [id, {
    id, name, type: 'urltest', mode: 'static', enabled: true, icon, iconScale: 0,
    keywords: [], members: [], testUrl, interval: '300s', tolerance, idleTimeout: '12h',
  }]))
  return [...previousById.values(), {
    id: 'all-auto', name: '所有-自动', type: 'urltest', mode: 'dynamic', enabled: true,
    icon: 'globe:earth-asia', iconScale: 0, keywords: [], members: [], testUrl: '', interval: '300s', tolerance: 100, idleTimeout: '12h',
  }, ...defaultGroups().filter((group) => ['all-manual', 'builtin-direct', 'builtin-block'].includes(group.id))]
}

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

test('升级时迁移未修改的 v0.1.195 默认自动组到动态分组,保留额外用户组并写回', () => {
  const { store, m } = memStore()
  const previous = oldReleaseDefaultGroups()
  previous.push({ id: 'my-custom', name: '我自己的组', type: 'selector', mode: 'static', enabled: true, keywords: [], members: ['node-1'] })
  m.set(KEYS.groups, JSON.stringify(previous))

  const migrated = store.getGroups()
  const expected = new Map([
    ['CHATGPT自动', ['美国', '亚洲', '其他']],
    ['香港-自动', ['香港']],
    ['亚洲-自动', ['亚洲']],
    ['美国-自动', ['美国']],
    ['其他-自动', ['其他']],
  ])
  for (const [name, keywords] of expected) {
    const group = migrated.find((item) => item.name === name)
    assert.equal(group.mode, 'dynamic', name)
    assert.deepEqual(group.keywords, keywords, name)
    assert.equal(group.interval, '600s', name)
    assert.equal(group.tolerance, 500, name)
  }
  assert.equal(migrated.find((item) => item.name === '所有-自动').interval, '600s')
  assert.deepEqual(migrated.find((item) => item.id === 'my-custom').members, ['node-1'])
  assert.deepEqual(JSON.parse(m.get(KEYS.groups)), migrated)
})

test('旧版任一地区默认组被用户修改时不做整套默认迁移', () => {
  const { store, m } = memStore()
  const previous = oldReleaseDefaultGroups()
  const customHongKong = previous.find((group) => group.name === '香港-自动')
  customHongKong.keywords = ['手工关键词']
  m.set(KEYS.groups, JSON.stringify(previous))

  const stored = store.getGroups()
  assert.deepEqual(stored.find((group) => group.name === '香港-自动').keywords, ['手工关键词'])
  assert.equal(stored.find((group) => group.name === 'CHATGPT自动').mode, 'static')
  assert.equal(stored.find((group) => group.name === '亚洲-自动').interval, '300s')
})

test('旧版默认组增加未知字段时视为自定义,不做整套迁移', () => {
  const { store, m } = memStore()
  const previous = oldReleaseDefaultGroups()
  previous.find((group) => group.name === '香港-自动').userNote = 'keep-me'
  m.set(KEYS.groups, JSON.stringify(previous))

  const stored = store.getGroups()
  assert.equal(stored.find((group) => group.name === '香港-自动').mode, 'static')
  assert.equal(stored.find((group) => group.name === 'CHATGPT自动').mode, 'static')
  assert.equal(stored.find((group) => group.name === '亚洲-自动').interval, '300s')
})
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
