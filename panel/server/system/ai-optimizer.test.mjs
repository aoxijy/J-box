import assert from 'node:assert/strict'
import test from 'node:test'
import { createAiOptimizer } from './ai-optimizer-manager.mjs'
import { scoreNode, selectBestNode, summarizeNodeHistory } from './ai-optimizer.mjs'

const now = Date.parse('2026-09-27T00:00:00Z')
const history = (delays) => delays.map((delay, i) => ({ time: new Date(now - (delays.length - i) * 60_000).toISOString(), delay }))

test('aggregates latest ten samples, treats zero as failure, and excludes stale data', () => {
  const summary = summarizeNodeHistory(history([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0]), { now })
  assert.equal(summary.samples, 10)
  assert.ok(Math.abs(summary.failureRate - 0.1) < 1e-9)
  assert.equal(summary.medianMs, 6)
  assert.equal(summarizeNodeHistory([{ time: '2020-01-01T00:00:00Z', delay: 20 }], { now }).samples, 0)
})

test('uses stability and timeouts rather than only the latest ping', () => {
  const histories = {
    fastFlaky: history([15, 0, 0, 18, 0, 17, 0, 16, 0, 15]),
    stable: history([45, 43, 46, 44, 45, 44, 43, 46, 45, 44]),
  }
  assert.equal(selectBestNode(['fastFlaky', 'stable'], histories, { reliabilityWeight: 100, latencyWeight: 100 }).selected, 'stable')
})

test('ignores unmeasured/fully failing candidates and sensitivity prevents tiny switches', () => {
  const histories = {
    current: history([40, 41]), faster: history([39, 40]),
  }
  assert.equal(selectBestNode(['current', 'faster', 'unknown'], histories, { sensitivityMs: 10 }, { current: 'current' }).selected, 'current')
  assert.equal(selectBestNode(['failed'], { failed: history([0, 0]) }, {}).selected, '')
  assert.ok(Number.isFinite(scoreNode(summarizeNodeHistory(history([45]), { now }), {})))
})

test('runs AI separately inside each group and shares one probe for overlapping node/URL members', async () => {
  const timestamp = new Date(Date.now()).toISOString()
  const records = Object.fromEntries([['A', 60], ['B', 40], ['C', 20]].map(([tag, delay]) => [tag, Array(5).fill({ time: timestamp, delay })]))
  const selections = new Map([['Asia', 'A'], ['ChatGPT', 'B']])
  const probes = []
  const writes = []
  const store = {
    getProfile: () => ({ aiOptimizer: { enabled: true, minSamples: 5, maxSampleAgeHours: 168 } }),
    getClashSecret: () => '',
  }
  const meta = { generatedAt: 'test-version', aiGroups: [
    { tag: 'Asia', url: 'https://probe.test/ping', intervalMs: 60_000, members: ['A', 'B'] },
    { tag: 'ChatGPT', url: 'https://probe.test/ping', intervalMs: 60_000, members: ['B', 'C'] },
  ] }
  const optimizer = createAiOptimizer({
    store, ctx: { readFile: async () => JSON.stringify(meta) }, paths: { etc: '/etc/jbox' },
    history: { record: () => {}, flush: () => {}, get: () => records },
    coordinator: { probe: async (node, url) => { probes.push(`${node}|${url}`); return { at: Date.now(), delay: records[node][0].delay, ok: true } } },
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith('/proxies')) return { ok: true, json: async () => ({ proxies: Object.fromEntries([...selections].map(([tag, now]) => [tag, { now, all: meta.aiGroups.find((g) => g.tag === tag).members }])) }) }
      const tag = decodeURIComponent(new URL(url).pathname.split('/').at(-1))
      if (init.method === 'PUT') { const { name } = JSON.parse(init.body); selections.set(tag, name); writes.push([tag, name]); return { ok: true, status: 204, json: async () => ({}) } }
      return { ok: true, json: async () => ({ now: selections.get(tag) }) }
    },
    log: () => {},
  })
  const result = await optimizer.tick()
  assert.equal(probes.length, 3)
  assert.deepEqual(new Set(probes), new Set(['A|https://probe.test/ping', 'B|https://probe.test/ping', 'C|https://probe.test/ping']))
  assert.deepEqual(writes, [['Asia', 'B'], ['ChatGPT', 'C']])
  assert.equal(result.shared, 1)
})
