import assert from 'node:assert/strict'
import test from 'node:test'
import { createAiOptimizer } from './ai-optimizer-manager.mjs'

const makeOptimizer = ({ readFile, exists = async () => false, remove = async () => {}, clearAiHistory = () => 7 } = {}) => {
  let cleared = 0
  const optimizer = createAiOptimizer({
    store: { getProfile: () => ({ aiOptimizer: { enabled: false } }), getClashSecret: () => '' },
    ctx: {
      readFile: readFile || (async () => { throw new Error('ENOENT') }),
      exists,
      remove,
    },
    paths: { etc: '/etc/jbox', dataDir: '/data' },
    history: { clearAiHistory: () => { cleared++; return clearAiHistory() }, getAiForUrl: () => ({}) },
    coordinator: {}, fetchImpl: async () => { throw new Error('not used') },
  })
  return { optimizer, cleared: () => cleared }
}

test('training reset holds a shared lock across config I/O and blocks ticks and retraining', async () => {
  let releaseRead
  const blockedRead = new Promise((resolve) => { releaseRead = resolve })
  const { optimizer, cleared } = makeOptimizer({ readFile: () => blockedRead })
  const resetPromise = optimizer.resetTrainingData()
  await Promise.resolve()
  assert.deepEqual(await optimizer.tick(), { skipped: 'busy' })
  assert.deepEqual(await optimizer.updateModel(), { ok: false, reason: 'optimizer-busy' })
  assert.deepEqual(await optimizer.resetTrainingData(), { ok: false, reason: 'optimizer-busy' })
  releaseRead(JSON.stringify({ generatedAt: 'reset-test', aiGroups: [] }))
  assert.deepEqual(await resetPromise, { ok: true, removedSamples: 7, removedModels: 0 })
  assert.equal(cleared(), 1)
  assert.deepEqual(await optimizer.tick(), { enabled: false })
})

test('model deletion failure leaves AI history untouched and releases reset lock', async () => {
  const url = 'https://probe.test/reset-failure'
  const readFile = async () => JSON.stringify({ generatedAt: 'reset-test', aiGroups: [{ tag: 'AI', url, members: ['A'] }] })
  const { optimizer, cleared } = makeOptimizer({ readFile, exists: async () => true, remove: async () => { throw new Error('read-only filesystem') } })
  const result = await optimizer.resetTrainingData()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'model-reset-failed')
  assert.equal(cleared(), 0)
  assert.deepEqual(await optimizer.tick(), { enabled: false })
})
