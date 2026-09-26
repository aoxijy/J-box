import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockContext } from './context.mjs'
import { featureVector, makeTrainingRows, trainOnlineModel, predictWithLightGbm } from './lightgbm-runtime.mjs'

const ts = (n) => new Date(Date.now() - (20 - n) * 60_000).toISOString()
const samples = (base) => Array.from({ length: 10 }, (_, i) => ({ time: ts(i), delay: base + i * 2 }))
const model = `tree\nversion=v4\nnum_feature=9\nmax_feature_idx=8\n${'x'.repeat(160)}`
const features = (seed) => Array.from({ length: 9 }, (_, i) => seed + i)

test('training data uses only past observations and keeps timeout labels', () => {
  const rows = makeTrainingRows({ a: [...samples(20).slice(0, 9), { time: ts(9), delay: 0 }] }, { now: Date.now() + 60_000 })
  assert.equal(rows.length, 5)
  assert.equal(rows.at(-1).label, 0)
  assert.equal(rows.at(-1).features.length, 9)
  assert.ok(rows.every((row) => !Object.values(row).some((v) => typeof v === 'string' && v === 'a')))
})

test('native LightGBM training refuses insufficient data and retains standard text model output', async () => {
  const ctx = createMockContext()
  const insufficient = await trainOnlineModel({ a: samples(20) }, { ctx, paths: { lightgbm: '/opt/j-box/bin/lightgbm', dataDir: '/data' }, minRows: 99 })
  assert.equal(insufficient.ok, false)
  assert.equal(ctx.calls.length, 0)

  const context = createMockContext()
  let writtenTrainingData = ''
  context.exec = async (cmd, args) => {
    context.calls.push({ cmd, args })
    if (args.includes('task=predict')) {
      const outputArg = args.find((arg) => arg.startsWith('output_result='))
      context.files[outputArg.slice('output_result='.length)] = '90'
    } else {
      const dataArg = args.find((arg) => arg.startsWith('data='))
      writtenTrainingData = context.files[dataArg.slice(5)]
      const outputArg = args.find((arg) => arg.startsWith('model_output='))
      context.files[outputArg.slice('model_output='.length)] = model
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const trained = await trainOnlineModel({ a: samples(20), b: [...samples(60).slice(0, 9), { time: ts(9), delay: 0 }] }, { ctx: context, paths: { lightgbm: '/opt/j-box/bin/lightgbm', dataDir: '/data' }, minRows: 1, now: Date.now() + 60_000 })
  assert.equal(trained.ok, true)
  assert.equal(trained.samples, 10)
  assert.ok(trained.model.includes('version=v4'))
  assert.ok(context.calls[0].args.includes('task=train'))
  assert.ok(writtenTrainingData.includes('label\t'))
  assert.ok(writtenTrainingData.includes('\n3000\t'), 'timeouts train as penalized latency, not zero/fast')
})

test('native prediction calls official LightGBM CLI and parses one finite score per row', async () => {
  const ctx = createMockContext()
  ctx.exec = async (_cmd, args) => {
    const out = args.find((arg) => arg.startsWith('output_result=')).slice('output_result='.length)
    ctx.files[out] = '42.5\n0\n'
    return { code: 0, stdout: '', stderr: '' }
  }
  const scores = await predictWithLightGbm({ modelPath: '/data/model.txt', rows: [features(1), features(3)], ctx, paths: { lightgbm: '/opt/j-box/bin/lightgbm', dataDir: '/data' } })
  assert.deepEqual(scores, [42.5, 0])
})

test('runtime features remain finite for empty and measured latency history', () => {
  assert.equal(featureVector([]).length, 9)
  assert.ok(featureVector(samples(30)).every(Number.isFinite))
})
