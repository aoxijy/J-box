import assert from 'node:assert/strict'
import test from 'node:test'
import { selectBestNode } from './ai-optimizer.mjs'

const now = Date.now()
const good = Array.from({ length: 6 }, (_, i) => ({ time: new Date(now - (6 - i) * 60_000).toISOString(), delay: 40 }))
const bad = Array.from({ length: 6 }, (_, i) => ({ time: new Date(now - (6 - i) * 60_000).toISOString(), delay: 45 }))

test('uses real LightGBM predictions when supplied, without letting it bypass history eligibility', () => {
  const decision = selectBestNode(['rule-best', 'model-best', 'unknown'], { 'rule-best': good, 'model-best': bad }, { minSamples: 5 }, {
    now, modelScores: { 'rule-best': 80, 'model-best': 30, unknown: 1 },
  })
  assert.equal(decision.selected, 'model-best')
  assert.equal(decision.candidates[0].scoring, 'lightgbm')
  assert.equal(decision.candidates.some((item) => item.name === 'unknown'), false)
})

test('LightGBM 不能绕过规则排除全超时节点', () => {
  const failed = good.map((sample) => ({ ...sample, delay: 0 }))
  const decision = selectBestNode(['healthy', 'offline'], { healthy: good, offline: failed }, { minSamples: 5 }, {
    now, modelScores: { healthy: 50, offline: 1 },
  })
  assert.equal(decision.selected, 'healthy')
  assert.equal(decision.candidates.some((item) => item.name === 'offline'), false)
})

test('falls back to the established rule score for candidates missing model predictions', () => {
  const decision = selectBestNode(['known', 'other'], { known: good, other: bad }, {}, { now, modelScores: { known: Number.NaN } })
  assert.equal(decision.selected, 'known')
  assert.ok(decision.candidates.every((item) => item.scoring === 'rules'))
})
