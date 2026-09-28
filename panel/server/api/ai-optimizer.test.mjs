import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { registerAiOptimizerRoutes } from './ai-optimizer.mjs'

const start = async (resetTrainingData) => {
  const app = express()
  registerAiOptimizerRoutes(app, { optimizer: {
    status: () => ({ enabled: true }),
    tick: async () => ({ enabled: true }),
    updateModel: async () => ({ ok: true }),
    resetTrainingData,
  } })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}

test('training/reset delegates to AI-only clear and reports the deleted samples/models', async () => {
  let calls = 0
  const app = await start(async () => { calls++; return { ok: true, removedSamples: 17, removedModels: 2 } })
  try {
    const res = await fetch(`${app.url}/api/jbox/ai-optimizer/training/reset`, { method: 'POST' })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, removedSamples: 17, removedModels: 2 })
    assert.equal(calls, 1)
  } finally { await app.close() }
})

test('training/reset reports busy optimizer as HTTP 409 without claiming deletion', async () => {
  const app = await start(async () => ({ ok: false, reason: 'optimizer-busy' }))
  try {
    const res = await fetch(`${app.url}/api/jbox/ai-optimizer/training/reset`, { method: 'POST' })
    assert.equal(res.status, 409)
    assert.deepEqual(await res.json(), { ok: false, reason: 'optimizer-busy' })
  } finally { await app.close() }
})
