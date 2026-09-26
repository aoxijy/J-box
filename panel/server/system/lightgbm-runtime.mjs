import { createHash } from 'node:crypto'

const percentile = (values, p) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
}
const deviation = (values) => {
  if (!values.length) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return Math.sqrt(values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / values.length)
}

export const FEATURE_COUNT = 9
export const LIGHTGBM_VERSION = '4.7.0'
export const LIGHTGBM_MODEL_FORMAT = 'v4'

export function featureVector(samples, { now = Date.now(), maxAgeMs = 7 * 86_400_000 } = {}) {
  const valid = (Array.isArray(samples) ? samples : []).filter((s) => s && Number.isFinite(Date.parse(s.time)) && Number.isFinite(s.delay) && s.delay >= 0 && now - Date.parse(s.time) <= maxAgeMs).slice(-10)
  const successful = valid.map((s) => s.delay).filter((d) => d > 0)
  const firstAt = valid.length ? Date.parse(valid[0].time) : 0
  const lastAt = valid.length ? Date.parse(valid.at(-1).time) : 0
  return [valid.length, successful.length, valid.length ? 1 - successful.length / valid.length : 1, percentile(successful, 0.5), percentile(successful, 0.9), successful.length ? successful.reduce((a, b) => a + b, 0) / successful.length : 0, deviation(successful), successful.at(-1) || 0, Math.max(0, lastAt - firstAt) / 1000]
}

// Every row predicts the next observed probe result using only preceding results for that node.
// Identity strings and probe URLs never enter the model feature matrix.
export function makeTrainingRows(histories, { maxAgeMs = 7 * 86_400_000, now = Date.now(), minSamplesPerNode = 6 } = {}) {
  const rows = []
  for (const samples of Object.values(histories || {})) {
    const ordered = (Array.isArray(samples) ? samples : []).filter((s) => s && Number.isFinite(Date.parse(s.time)) && Number.isFinite(s.delay) && s.delay >= 0 && now - Date.parse(s.time) <= maxAgeMs).sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).slice(-10)
    if (ordered.length < minSamplesPerNode) continue
    for (let i = 4; i < ordered.length - 1; i++) rows.push({ features: featureVector(ordered.slice(0, i + 1), { now: Date.parse(ordered[i].time), maxAgeMs }), label: ordered[i + 1].delay })
  }
  return rows
}

const ensureRuntime = (ctx, paths) => {
  if (!ctx?.exec || !ctx?.writeFile || !ctx?.readFile || !ctx?.mkdirp || !paths?.lightgbm || !paths?.dataDir) throw new Error('官方 LightGBM 运行时或数据目录未配置')
}
const safeKey = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)
const csv = (rows, { label = false, failurePenaltyMs = 3000 } = {}) => [
  `${label ? 'label\t' : ''}${Array.from({ length: FEATURE_COUNT }, (_, i) => `f${i}`).join('\t')}`,
  ...rows.map((row) => `${label ? `${Number(row.label) > 0 ? Number(row.label) : failurePenaltyMs}\t` : ''}${row.features.map((n) => Number.isFinite(n) ? Number(n).toFixed(6) : '0').join('\t')}`),
].join('\n') + '\n'
const exec = async (ctx, binary, args, timeoutMs) => {
  const result = await ctx.exec(binary, args, { timeoutMs })
  if (result.code !== 0) throw new Error(`LightGBM ${args[0]} 失败: ${(result.stderr || result.stdout || `exit ${result.code}`).slice(-1000)}`)
  return result
}

export async function trainOnlineModel(histories, { ctx, paths, minRows = 32, maxAgeMs = 7 * 86_400_000, now = Date.now(), numIterations = 32 } = {}) {
  ensureRuntime(ctx, paths)
  const rows = makeTrainingRows(histories, { maxAgeMs, now })
  if (rows.length < minRows) return { ok: false, reason: 'insufficient-observed-transitions', samples: rows.length, required: minRows }
  const dir = `${paths.dataDir}/ai-optimizer`
  await ctx.mkdirp(dir)
  const key = safeKey(`${process.pid}:${now}`)
  const dataPath = `${dir}/train-${key}.tsv`
  const modelPath = `${dir}/model-${key}.txt`
  const failurePenaltyMs = Math.max(3000, Math.max(0, ...rows.map((row) => Number(row.label) || 0)) * 3)
  await ctx.writeFile(dataPath, csv(rows, { label: true, failurePenaltyMs }))
  try {
    await exec(ctx, paths.lightgbm, [
      'task=train', 'objective=regression', `data=${dataPath}`, 'header=true', 'label_column=0',
      `num_iterations=${Math.max(8, Math.min(128, Math.trunc(numIterations) || 32))}`,
      'learning_rate=0.05', 'num_leaves=7', 'max_depth=3', 'min_data_in_leaf=3', 'min_data_in_bin=1',
      'feature_fraction=1.0', 'bagging_fraction=1.0', 'verbosity=-1', 'num_threads=1', 'metric=l2',
      `model_output=${modelPath}`,
    ], 120_000)
    const model = await ctx.readFile(modelPath)
    if (!model.includes(`version=${LIGHTGBM_MODEL_FORMAT}\n`) || !model.includes(`max_feature_idx=${FEATURE_COUNT - 1}\n`) || model.length < 128) throw new Error('LightGBM 输出模型格式/特征数校验失败')
    const sanity = await predictWithLightGbm({ modelPath, rows: [rows.at(-1).features], ctx, paths })
    if (sanity.length !== 1 || !Number.isFinite(sanity[0])) throw new Error('LightGBM 新模型试预测失败')
    return { ok: true, model, modelPath, samples: rows.length, trainedAt: new Date(now).toISOString() }
  } finally {
    await ctx.remove?.(dataPath)
    await ctx.remove?.(modelPath)
    if (!ctx.remove) await ctx.exec('rm', ['-f', dataPath, modelPath]).catch(() => {})
  }
}

export async function predictWithLightGbm({ modelPath, rows, ctx, paths }) {
  ensureRuntime(ctx, paths)
  if (!Array.isArray(rows) || !rows.length) return []
  if (rows.some((row) => !Array.isArray(row) || row.length !== FEATURE_COUNT || !row.every(Number.isFinite))) throw new Error('LightGBM 推理特征无效')
  const dir = `${paths.dataDir}/ai-optimizer`
  await ctx.mkdirp(dir)
  const key = safeKey(`${process.pid}:${Date.now()}:${rows.length}:${modelPath}`)
  const inputPath = `${dir}/predict-${key}.tsv`
  const outputPath = `${dir}/result-${key}.txt`
  await ctx.writeFile(inputPath, csv(rows.map((features) => ({ features }))))
  try {
    await exec(ctx, paths.lightgbm, ['task=predict', `data=${inputPath}`, 'header=true', `input_model=${modelPath}`, `output_result=${outputPath}`, 'num_threads=1', 'verbosity=-1'], 30_000)
    const output = await ctx.readFile(outputPath)
    const scores = output.trim().split(/\s+/).map(Number)
    if (scores.length !== rows.length || !scores.every(Number.isFinite)) throw new Error('LightGBM 推理结果数量或数值无效')
    return scores
  } finally {
    await ctx.remove?.(inputPath)
    await ctx.remove?.(outputPath)
  }
}
