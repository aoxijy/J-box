import assert from 'node:assert/strict'
import test from 'node:test'
import { createProbeCoordinator } from './probe-coordinator.mjs'

const memStore = () => ({ getClashSecret: () => 's' })

// 假内核:/proxies/<node>/delay 记一笔调用,按 delays 给结果或失败
const kernel = ({ fail = new Set(), delays = {} } = {}) => {
  const calls = []
  let live = 0
  let maxLive = 0
  const fetchImpl = async (url) => {
    calls.push(String(url))
    const m = /\/proxies\/([^/]+)\/delay\?/.exec(String(url))
    if (!m) return { ok: true, status: 200, json: async () => ({ proxies: {} }) }
    const tag = decodeURIComponent(m[1])
    live += 1
    maxLive = Math.max(maxLive, live)
    await new Promise((r) => setTimeout(r, 5))
    live -= 1
    if (fail.has(tag)) return { ok: false, status: 504, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ delay: delays[tag] || 100 }) }
  }
  return { calls, fetchImpl, maxLive: () => maxLive }
}

test('同一个「节点 + 测速地址」的并发请求只发一次', async () => {
  const k = kernel()
  const c = createProbeCoordinator({ store: memStore(), fetchImpl: k.fetchImpl })
  const [r1, r2, r3] = await Promise.all([
    c.probe('a', 'https://t/204', { intervalMs: 0, force: false }),
    c.probe('a', 'https://t/204', { intervalMs: 0, force: true }),
    c.probe('a', 'https://t/204', { intervalMs: 0, force: true }),
  ])
  assert.equal(k.calls.length, 1, k.calls.join('\n'))
  assert.equal(k.maxLive(), 1)
  assert.equal(r1.ok, true)
  assert.equal(r2.delay, r1.delay)
  assert.equal(r3.delay, r1.delay)
})

test('不同测速地址分别检查:同一个节点、两个地址各发一次', async () => {
  const k = kernel()
  const c = createProbeCoordinator({ store: memStore(), fetchImpl: k.fetchImpl })
  await Promise.all([
    c.probe('a', 'https://t/204', { intervalMs: 0 }),
    c.probe('a', 'https://api.openai.com/v1/models', { intervalMs: 0 }),
  ])
  assert.equal(k.calls.length, 2, k.calls.join('\n'))
  assert.ok(k.calls.some((u) => u.includes(encodeURIComponent('https://t/204'))))
  assert.ok(k.calls.some((u) => u.includes(encodeURIComponent('https://api.openai.com/v1/models'))))
})

test('结果比调用方的间隔新就复用;force=true 一定真测', async () => {
  const k = kernel({ delays: { a: 88 } })
  let clock = 1_000_000
  const c = createProbeCoordinator({ store: memStore(), fetchImpl: k.fetchImpl, now: () => clock })
  // 第一次:真测,并把 force=false + interval 传给内核(打了补丁的内核据此跳过重测与重选)
  const first = await c.probe('a', 'https://t/204', { intervalMs: 300_000, force: false })
  assert.equal(first.ok, true)
  assert.equal(k.calls.length, 1)
  assert.ok(k.calls[0].includes('force=false'))
  assert.ok(k.calls[0].includes('interval=300000'))
  // 30 秒后:长周期组到点,直接吃 30 秒前那份,不再打内核
  clock += 30_000
  const reuse = await c.probe('a', 'https://t/204', { intervalMs: 300_000, force: false })
  assert.equal(reuse.cached, true)
  assert.equal(reuse.delay, 88)
  assert.equal(k.calls.length, 1)
  // 短周期组(5 秒)到点:同一份结果对它来说已经过期,真测
  const again = await c.probe('a', 'https://t/204', { intervalMs: 5000, force: false })
  assert.ok(!again.cached)
  assert.equal(k.calls.length, 2)
  // 手动测速 / 超时复查:force=true 始终真测
  const forced = await c.probe('a', 'https://t/204', { intervalMs: 300_000, force: true })
  assert.ok(!forced.cached)
  assert.equal(k.calls.length, 3)
  assert.ok(!k.calls[2].includes('force=false'))
})

test('seedFromProxies:面板重启后用内核 history 播种,窗口内不再重测', async () => {
  const k = kernel()
  let clock = 2_000_000
  const c = createProbeCoordinator({ store: memStore(), fetchImpl: k.fetchImpl, now: () => clock })
  const at = new Date(clock - 20_000).toISOString()
  const seeded = c.seedFromProxies({ a: { type: 'ss', history: [{ time: at, delay: 66 }] } }, [{ node: 'a', url: 'https://t/204' }])
  assert.equal(seeded, 1)
  const r = await c.probe('a', 'https://t/204', { intervalMs: 300_000, force: false })
  assert.equal(r.cached, true)
  assert.equal(r.delay, 66)
  assert.equal(k.calls.length, 0)
  // 超过窗口后照常真测
  clock += 300_000
  await c.probe('a', 'https://t/204', { intervalMs: 300_000, force: false })
  assert.equal(k.calls.length, 1)
})

test('kernelIntervalMs:故障转移只在面板侧复用,内核窗口给 0(健康判断必须拿当前结果)', async () => {
  const k = kernel({ delays: { a: 12 } })
  let clock = 3_000_000
  const c = createProbeCoordinator({ store: memStore(), fetchImpl: k.fetchImpl, now: () => clock })
  // 故障转移:协调器缓存窗口用组 interval(这里 5 秒),但发给内核的窗口是 0——不吃内核旧值
  await c.probe('a', 'https://t/204', { intervalMs: 5000, kernelIntervalMs: 0, timeoutMs: 1000, force: false })
  assert.equal(k.calls.length, 1)
  assert.ok(k.calls[0].includes('force=false'))
  assert.ok(k.calls[0].includes('interval=0'), k.calls[0])
  // 窗口内另一个调用方(同一组/短周期组)复用面板侧结果,不再打内核
  const reuse = await c.probe('a', 'https://t/204', { intervalMs: 5000, kernelIntervalMs: 0, force: false })
  assert.equal(reuse.cached, true)
  assert.equal(k.calls.length, 1)
  // 超过窗口后重新问内核,窗口依然是 0
  clock += 5001
  await c.probe('a', 'https://t/204', { intervalMs: 5000, kernelIntervalMs: 0, force: false })
  assert.equal(k.calls.length, 2)
  assert.ok(k.calls[1].includes('interval=0'), k.calls[1])
  // 不传 kernelIntervalMs 时窗口跟随 intervalMs(自动优选的定时探测)
  clock += 300_001
  await c.probe('a', 'https://t/204', { intervalMs: 300_000, force: false })
  assert.ok(k.calls[2].includes('interval=300000'), k.calls[2])
})

test('失败结果同样是共享的:503/504 记成节点失败,接口错误记成未知', async () => {
  const k = kernel({ fail: new Set(['dead']) })
  const c = createProbeCoordinator({
    store: memStore(),
    fetchImpl: async (url, init) => {
      if (String(url).includes('/proxies/broken/delay')) return { ok: false, status: 500, json: async () => ({}) }
      return k.fetchImpl(url, init)
    },
  })
  const dead = await c.probe('dead', 'https://t/204', { intervalMs: 0 })
  assert.equal(dead.ok, false)
  assert.equal(dead.reason, 'timeout')
  const broken = await c.probe('broken', 'https://t/204', { intervalMs: 0 })
  assert.equal(broken.ok, null)
  assert.equal(broken.reason, 'http-500')
})
