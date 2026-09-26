import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeAiOptimizerSettings } from './ai-optimizer-settings.mjs'

test('AI optimizer applies defaults and clamps invalid numeric values', () => {
  const settings = normalizeAiOptimizerSettings({ policyPriority: 200, sensitivityMs: -5, minSamples: 0, intervalSeconds: 9999 })
  assert.equal(settings.enabled, false)
  assert.equal(settings.policyPriority, 100)
  assert.equal(settings.sensitivityMs, 0)
  assert.equal(settings.minSamples, 1)
  assert.equal(settings.intervalSeconds, 3600)
  assert.equal(settings.latencyWeight, 70)
  assert.equal(settings.asnPriority, false)
})

test('AI optimizer accepts valid options without trusting truthy strings', () => {
  const settings = normalizeAiOptimizerSettings({ enabled: true, asnPriority: true, sensitivityMs: 250, collectTrainingData: true, minSamples: 8 })
  assert.equal(settings.enabled, true)
  assert.equal(settings.asnPriority, true)
  assert.equal(settings.sensitivityMs, 250)
  assert.equal(settings.collectTrainingData, true)
  assert.equal(settings.minSamples, 8)
  assert.equal(normalizeAiOptimizerSettings({ enabled: 'true' }).enabled, false)
})
