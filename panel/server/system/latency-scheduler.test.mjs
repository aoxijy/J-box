import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'
import { createLatencyHistory } from './latency-history.mjs'
import { createProbeCoordinator } from './probe-coordinator.mjs'
import {
  createLatencyScheduler, parseDuration, leafNodesOf, collectProbeInterests, dedupeWindows, readUrltestGroups, readProbeGroups,
} from './latency-scheduler.mjs'

const paths = createPaths('/opt/j-box')
const memStore = () => {
  const m = new Map()
  return { getRaw: (k) => (m.has(k) ? m.get(k) : null), setRaw: (k, v) => m.set(k, v), delRaw: (k) => m.delete(k), getClashSecret: () => 's' }
}
const T0 = Date.parse('2026-09-06T18:03:24+08:00')
const iso = (t) => new Date(t).toISOString()

// 短周期组 1 分钟、长周期组 5 分钟,两者共享节点 a;长周期组还引用了嵌套组(嵌套组里是 b)
const config = { outbounds: [
  { type: 'urltest', tag: '短周期', url: 'https://t/204', interval: '1m', outbounds: ['a'] },
  { type: 'urltest', tag: '长周期', url: 'https://t/204', interval: '5m', outbounds: ['a', '嵌套'] },
  { type: 'urltest', tag: '嵌套', url: 'https://t/204', interval: '5m', outbounds: ['b'] },
  { type: 'selector', tag: '手动', outbounds: ['短周期'] },
] }
const proxiesFixture = () => ({
  a: { type: 'ss', history: [{ time: iso(T0 - 10_000), delay: 90 }] },
  b: { type: 'ss', history: [{ time: iso(T0 - 10_000), delay: 120 }] },
  嵌套: { type: 'URLTest', all: ['b'], now: 'b', history: [] },
  短周期: { type: 'URLTest', all: ['a'], now: 'a', history: [] },
  长周期: { type: 'URLTest', all: ['a', '嵌套'], now: 'a', history: [] },
})

const kernel = (proxies = proxiesFixture(), clock = () => T0) => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (String(url).endsWith('/proxies')) return { ok: true, status: 200, json: async () => ({ proxies: JSON.parse(JSON.stringify(proxies)) }) }
    const m = /\/proxies\/([^/]+)\/delay\?/.exec(String(url))
    if (m) {
      const tag = decodeURIComponent(m[1])
      proxies[tag].history = [{ time: iso(clock()), delay: 99 }]
      return { ok: true, status: 200, json: async () => ({ delay: 99 }) }
    }
    throw new Error('unexpected ' + url)
  }
  return { proxies, calls, fetchImpl }
}
const ctxWithKernel = ({ meta, runtimeConfig = config } = {}) => createMockContext({
  files: {
    [paths.configPath]: JSON.stringify(runtimeConfig),
    ...(meta ? { [`${paths.etc}/config.meta.json`]: JSON.stringify(meta) } : {}),
    '/proc/123/stat': '123 (sing-box) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0',
    '/proc/uptime': '1000 0',
  },
  execResults: { 'pidof sing-box': { code: 0, stdout: '123\\n' } },
})

test('parseDuration:sing-box 的时长写法', () => {
  assert.equal(parseDuration('5m'), 300_000)
  assert.equal(parseDuration('90s'), 90_000)
  assert.equal(parseDuration(''), 0)
})

test('readUrltestGroups:只收 urltest 组,带出检测地址与间隔', () => {
  const groups = readUrltestGroups(config)
  assert.deepEqual(groups.map((g) => g.tag), ['短周期', '长周期', '嵌套'])
  assert.equal(groups[0].intervalMs, 60_000)
  assert.equal(groups[1].intervalMs, 300_000)
})

test('readProbeGroups:AI selector 从元数据恢复组内候选与测速 URL,不跨组扩展', () => {
  const aiConfig = { outbounds: [{ type: 'selector', tag: 'AI优选', outbounds: ['a', 'b'] }] }
  const meta = { aiGroups: [{ tag: 'AI优选', url: 'https://ai.example/204', intervalMs: 60_000, members: ['a', 'b', 'outside'] }] }
  const groups = readProbeGroups(aiConfig, meta)
  assert.deepEqual(groups, [{ tag: 'AI优选', url: 'https://ai.example/204', intervalMs: 60_000, members: ['a', 'b'] }])
  assert.equal(readProbeGroups(aiConfig, meta, 15_000)[0].intervalMs, 15_000, 'AI采样周期可由面板策略覆盖')
  const interests = collectProbeInterests(groups, { a: { type: 'ss' }, b: { type: 'ss' }, c: { type: 'ss' } })
  assert.deepEqual(interests.map(({ node, url }) => [node, url]), [['a', 'https://ai.example/204'], ['b', 'https://ai.example/204']])
})

test('readProbeGroups:保留普通 urltest 并避免重复读取同名 AI 组', () => {
  const groups = readProbeGroups(config, { aiGroups: [{ tag: '短周期', url: 'https://other/204', members: ['b'] }] })
  assert.equal(groups.length, 3)
  assert.equal(groups[0].url, 'https://t/204')
})

test('leafNodesOf:成员是组(嵌套 URLTest)时展开成真实叶子节点', () => {
  const proxies = proxiesFixture()
  assert.deepEqual(leafNodesOf('长周期', proxies), ['a', 'b'])
  assert.deepEqual(leafNodesOf('嵌套', proxies), ['b'])
  assert.deepEqual(leafNodesOf('a', proxies), ['a'])
})

test('collectProbeInterests:按「节点 + 测速地址」算兴趣,间隔取所有用到它的组里最短的那个', () => {
  const groups = readUrltestGroups(config)
  const list = collectProbeInterests(groups, proxiesFixture())
  const byNode = Object.fromEntries(list.map((it) => [it.node, it]))
  assert.deepEqual(Object.keys(byNode).sort(), ['a', 'b'])
  // a 同时被 1 分钟和 5 分钟的组用到 → 1 分钟;b 只在 5 分钟的组里 → 5 分钟
  assert.equal(byNode.a.intervalMs, 60_000)
  assert.equal(byNode.b.intervalMs, 300_000)
  assert.deepEqual(byNode.b.groups.sort(), ['嵌套', '长周期'])
})

test('dedupeWindows:节点取最短间隔,组取自己的间隔', () => {
  const groups = readUrltestGroups(config)
  const w = dedupeWindows(groups, proxiesFixture())
  assert.equal(w.get('a'), 60_000)
  assert.equal(w.get('b'), 300_000)
  assert.equal(w.get('短周期'), 60_000)
  assert.equal(w.get('长周期'), 300_000)
})

test('tick:先用内核已有结果播种,间隔内不重测;到点后按最短间隔带 force=false 探测', async () => {
  let clock = T0
  const k = kernel(proxiesFixture(), () => clock)
  const store = memStore()
  const history = createLatencyHistory({ store, now: () => clock })
  const coordinator = createProbeCoordinator({ store, fetchImpl: k.fetchImpl, now: () => clock })
  const s = createLatencyScheduler({ store, ctx: ctxWithKernel(), paths, history, coordinator, fetchImpl: k.fetchImpl, now: () => clock, log: () => {} })
  // 内核 history 是 10 秒前的:两个节点的最短窗口都没到,一个请求都不发
  const r1 = await s.tick()
  assert.deepEqual(r1.tested, [])
  assert.deepEqual(k.calls.filter((u) => u.includes('/delay')), [])
  // 70 秒后:节点 a 的最短间隔(60 秒)到点 → 测一次;b 的 5 分钟没到 → 不测
  clock = T0 + 70_000
  k.proxies.a.history = proxiesFixture().a.history
  const r2 = await s.tick()
  assert.deepEqual(r2.tested, ['a'])
  const probes = k.calls.filter((u) => u.includes('/delay'))
  assert.equal(probes.length, 1, probes.join('\n'))
  assert.ok(probes[0].includes('/proxies/a/delay?'), probes[0])
  assert.ok(probes[0].includes('force=false'), probes[0])
  assert.ok(probes[0].includes('interval=60000'), probes[0])
  // 又过 30 秒(长周期组到点):a 的结果只有 30 秒,长周期组直接复用,不再打内核
  clock = T0 + 100_000
  const r3 = await s.tick()
  assert.deepEqual(r3.tested, [])
  assert.equal(k.calls.filter((u) => u.includes('/delay')).length, 1)
})

test('内核没在跑 → 这个 tick 什么都不做', async () => {
  const store = memStore()
  const history = createLatencyHistory({ store })
  const s = createLatencyScheduler({
    store, ctx: ctxWithKernel(), paths, history,
    coordinator: createProbeCoordinator({ store, fetchImpl: async () => { throw new Error('ECONNREFUSED') } }),
    fetchImpl: async () => { throw new Error('ECONNREFUSED') }, log: () => {},
  })
  assert.deepEqual(await s.tick(), { skipped: 'kernel' })
})

test('start runs an initial scan immediately instead of waiting for the first interval', async () => {
  const k = kernel(proxiesFixture())
  const store = memStore()
  const history = createLatencyHistory({ store, now: () => T0 })
  const scheduler = createLatencyScheduler({ store, ctx: ctxWithKernel(), paths, history, coordinator: createProbeCoordinator({ store, fetchImpl: k.fetchImpl, now: () => T0 }), fetchImpl: k.fetchImpl, now: () => T0, tickMs: 60_000, log: () => {} })
  scheduler.start()
  await new Promise((resolve) => setTimeout(resolve, 10))
  scheduler.stop()
  assert.ok(k.calls.includes('http://127.0.0.1:9095/proxies'))
})

test('AI opt-in collects per-node, per-URL shared probe history', async () => {
  const clock = T0
  const k = kernel(proxiesFixture(), () => clock)
  const store = memStore()
  store.getProfile = () => ({ aiOptimizer: { collectTrainingData: true } })
  const history = createLatencyHistory({ store, now: () => clock })
  const s = createLatencyScheduler({ store, ctx: ctxWithKernel(), paths, history, coordinator: createProbeCoordinator({ store, fetchImpl: k.fetchImpl, now: () => clock }), fetchImpl: k.fetchImpl, now: () => clock, log: () => {} })
  await s.tick()
  assert.deepEqual(history.getAiForUrl('https://t/204').a.map((sample) => sample.delay), [99])
  assert.deepEqual(history.getAiForUrl('https://t/204').b.map((sample) => sample.delay), [99])
  const probeCalls = k.calls.filter((url) => url.includes('/delay?'))
  assert.equal(probeCalls.length, 2, 'must disregard untagged kernel history on the first URL-scoped sample')
  await s.tick()
  assert.equal(k.calls.filter((url) => url.includes('/delay?')).length, 2, 'fresh URL-scoped history is reused')
})

test('AI opt-in also samples selector candidates using config metadata', async () => {
  const clock = T0
  const k = kernel(proxiesFixture(), () => clock)
  const store = memStore()
  store.getProfile = () => ({ aiOptimizer: { collectTrainingData: true } })
  const history = createLatencyHistory({ store, now: () => clock })
  const runtimeConfig = { outbounds: [{ type: 'selector', tag: '自动优选', outbounds: ['a', 'b'] }] }
  const meta = { aiGroups: [{ tag: '自动优选', url: 'https://ai.example/204', intervalMs: 60_000, members: ['a', 'b'] }] }
  const s = createLatencyScheduler({ store, ctx: ctxWithKernel({ runtimeConfig, meta }), paths, history, coordinator: createProbeCoordinator({ store, fetchImpl: k.fetchImpl, now: () => clock }), fetchImpl: k.fetchImpl, now: () => clock, log: () => {} })
  const result = await s.tick()
  assert.deepEqual(result.tested.sort(), ['a', 'b'])
  assert.deepEqual(history.getAiForUrl('https://ai.example/204').a.map((sample) => sample.delay), [99])
  assert.deepEqual(history.getAiForUrl('https://ai.example/204').b.map((sample) => sample.delay), [99])
  assert.equal(k.calls.filter((url) => url.includes('/delay?')).length, 2)
})

test('AI selector sampling honors the configured concurrent probe limit', async () => {
  const clock = T0
  const tags = Array.from({ length: 7 }, (_, i) => `candidate-${i}`)
  const proxies = Object.fromEntries(tags.map(tag => [tag, { type: 'ss', history: [] }]))
  let active = 0
  let peak = 0
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/proxies')) return { ok: true, status: 200, json: async () => ({ proxies }) }
    if (String(url).includes('/delay?')) {
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      active--
      return { ok: true, status: 200, json: async () => ({ delay: 80 }) }
    }
    throw new Error(`unexpected URL: ${url}`)
  }
  const store = memStore()
  store.getProfile = () => ({ aiOptimizer: { collectTrainingData: true, probeConcurrency: 2 } })
  const history = createLatencyHistory({ store, now: () => clock })
  const runtimeConfig = { outbounds: [{ type: 'selector', tag: '自动优选', outbounds: tags }] }
  const meta = { aiGroups: [{ tag: '自动优选', url: 'https://ai.example/204', intervalMs: 60_000, members: tags }] }
  const scheduler = createLatencyScheduler({ store, ctx: ctxWithKernel({ runtimeConfig, meta }), paths, history, coordinator: createProbeCoordinator({ store, fetchImpl, now: () => clock }), fetchImpl, now: () => clock, log: () => {} })
  const result = await scheduler.tick()
  assert.equal(result.tested.length, tags.length)
  assert.ok(peak > 1, `expected concurrent probes, peak=${peak}`)
  assert.ok(peak <= 2, `probe concurrency exceeded configured limit: peak=${peak}`)
})

test('sync:只读 /proxies,不发起任何测速', async () => {
  const clock = T0
  const k = kernel(proxiesFixture(), () => clock)
  const store = memStore()
  const history = createLatencyHistory({ store, now: () => clock })
  const s = createLatencyScheduler({ store, ctx: ctxWithKernel(), paths, history, coordinator: null, fetchImpl: k.fetchImpl, now: () => clock, log: () => {} })
  await s.sync()
  assert.deepEqual(k.calls, ['http://127.0.0.1:9095/proxies'])
})
