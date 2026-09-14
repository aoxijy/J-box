import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'
import { createLatencyHistory } from './latency-history.mjs'
import { createLatencyScheduler, parseDuration } from './latency-scheduler.mjs'

const paths = createPaths('/opt/j-box')
const memStore = () => {
  const m = new Map()
  return { getRaw: (k) => (m.has(k) ? m.get(k) : null), setRaw: (k, v) => m.set(k, v), delRaw: (k) => m.delete(k), getClashSecret: () => 's' }
}
const T0 = Date.parse('2026-09-06T18:03:24+08:00')
const iso = (t) => new Date(t).toISOString()
const config = { outbounds: [
  { type: 'urltest', tag: '香港-自动', url: 'https://www.gstatic.com/generate_204', interval: '5m', outbounds: ['hk-1', 'hk-2'] },
  { type: 'selector', tag: '国外', outbounds: ['香港-自动'] },
] }

test('parseDuration:sing-box 的时长写法', () => {
  assert.equal(parseDuration('5m'), 300_000)
  assert.equal(parseDuration('1h30m'), 5_400_000)
  assert.equal(parseDuration('90s'), 90_000)
  assert.equal(parseDuration('250ms'), 250)
  assert.equal(parseDuration(''), 0)
  assert.equal(parseDuration('abc'), 0)
})

// 只读的"内核":/proxies 返回当前 history;任何测速接口调用都会被记下来(不该发生)
const kernel = () => {
  const proxies = {
    'hk-1': { type: 'ss', history: [{ time: iso(T0 + 60_000), delay: 93 }] },
    'hk-2': { type: 'ss', history: [] },
    '香港-自动': { type: 'URLTest', all: ['hk-1', 'hk-2'], now: 'hk-1', history: [{ time: iso(T0 + 60_000), delay: 93 }] },
  }
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (String(url).endsWith('/proxies')) return { ok: true, status: 200, json: async () => ({ proxies: JSON.parse(JSON.stringify(proxies)) }) }
    throw new Error('upstream 不该被调用: ' + url)
  }
  return { proxies, calls, fetchImpl }
}
const ctxWithKernel = () => createMockContext({
  files: { [paths.configPath]: JSON.stringify(config), '/proc/123/stat': '123 (sing-box) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0', '/proc/uptime': '1000 0' },
  execResults: { 'pidof sing-box': { code: 0, stdout: '123\n' } },
})

test('tick 只同步内核结果,绝不发起测速:内核任何一次 delay 调用都会让它立刻重选,把 300 秒间隔冲掉', async () => {
  const k = kernel()
  const store = memStore()
  const history = createLatencyHistory({ store, now: () => T0 + 120_000 })
  const s = createLatencyScheduler({ store, ctx: ctxWithKernel(), paths, history, fetchImpl: k.fetchImpl, now: () => T0 + 120_000, log: () => {} })
  const r = await s.tick()
  assert.ok(!r.skipped)
  // 只读了 /proxies
  assert.deepEqual(k.calls, ['http://127.0.0.1:9095/proxies'])
  assert.ok(!k.calls.some((u) => u.includes('/delay')))
  assert.ok(!k.calls.some((u) => u.includes('/group/')))
  // 内核已有结果照常进面板历史
  assert.deepEqual(history.get()['hk-1'].map((x) => x.delay), [93])
})

test('内核没在跑(/proxies 拿不到)→ 这个 tick 什么都不做', async () => {
  const store = memStore()
  const history = createLatencyHistory({ store })
  const s = createLatencyScheduler({ store, ctx: ctxWithKernel(), paths, history, fetchImpl: async () => { throw new Error('ECONNREFUSED') }, log: () => {} })
  assert.deepEqual(await s.tick(), { skipped: 'kernel' })
})

test('sync 只读不测:和 tick 一样只读 /proxies', async () => {
  const k = kernel()
  const store = memStore()
  const history = createLatencyHistory({ store, now: () => T0 + 120_000 })
  const up = createLatencyScheduler({ store, ctx: ctxWithKernel(), paths, history, fetchImpl: k.fetchImpl, now: () => T0 + 120_000, log: () => {} })
  await up.sync()
  assert.deepEqual(history.get()['hk-1'].map((x) => x.delay), [93])
  assert.deepEqual(k.calls, ['http://127.0.0.1:9095/proxies'])
})

test('start/stop:定时器起来了也只读(一个 tick 周期内不会有 delay 请求)', async () => {
  const k = kernel()
  const store = memStore()
  const history = createLatencyHistory({ store, now: () => T0 })
  const s = createLatencyScheduler({ store, ctx: ctxWithKernel(), paths, history, fetchImpl: k.fetchImpl, now: () => T0, tickMs: 5, log: () => {} })
  s.start()
  await new Promise((r) => setTimeout(r, 30))
  s.stop()
  assert.ok(k.calls.length >= 1)
  assert.ok(k.calls.every((u) => u.endsWith('/proxies')), k.calls.join('\n'))
})
