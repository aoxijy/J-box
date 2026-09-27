import { createHash } from 'node:crypto'
import { configMetaPath } from './deploy.mjs'
import { CLASH_API_BASE } from '../api/penetration.mjs'
import { scoreNode, summarizeNodeHistory, selectReachableNode } from './ai-optimizer.mjs'
import { featureVector, predictWithLightGbm, trainOnlineModel, LIGHTGBM_VERSION, LIGHTGBM_MODEL_FORMAT, FEATURE_COUNT } from './lightgbm-runtime.mjs'

const withTimeout = async (fetchImpl, url, init, ms) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try { return await fetchImpl(url, { ...init, signal: controller.signal }) } finally { clearTimeout(timer) }
}

const validGroup = (g) => g && typeof g.tag === 'string' && g.tag && typeof g.url === 'string' && g.url && Array.isArray(g.members)

export const createAiOptimizer = ({ store, ctx, paths, history, coordinator, fetchImpl = globalThis.fetch, now = () => Date.now(), tickMs = 30_000, log = () => {} }) => {
  let groups = []
  let configVersion = ''
  let timer = null
  let inFlight = false
  let lastRunAt = 0
  let lastError = ''
  let selections = {}
  let stats = { tested: 0, switched: 0, shared: 0 }
  let training = false
  let modelStatus = { available: false, version: '', trainedAt: '', samples: 0, error: '' }
  const modelDir = `${paths.dataDir}/ai-optimizer`
  const modelPathForUrl = (url) => `${modelDir}/model-${createHash('sha256').update(url).digest('hex').slice(0, 16)}.txt`

  const headers = () => {
    const secret = store.getClashSecret?.() || ''
    return secret ? { Authorization: `Bearer ${secret}` } : {}
  }
  const loadConfig = async () => {
    let meta = {}
    try { meta = JSON.parse(await ctx.readFile(configMetaPath(paths))) } catch { return }
    const version = String(meta.generatedAt || '')
    if (version === configVersion) return
    configVersion = version
    groups = Array.isArray(meta.aiGroups) ? meta.aiGroups.filter(validGroup) : []
    selections = Object.fromEntries(groups.map((g) => [g.tag, '']))
  }
  const getProxies = async () => {
    const res = await withTimeout(fetchImpl, `${CLASH_API_BASE}/proxies`, { headers: headers() }, 5000)
    if (!res?.ok) throw new Error(`Clash API /proxies HTTP ${res?.status ?? 'none'}`)
    return (await res.json())?.proxies || {}
  }
  const select = async (tag, name) => {
    const url = `${CLASH_API_BASE}/proxies/${encodeURIComponent(tag)}`
    const res = await withTimeout(fetchImpl, url, {
      method: 'PUT', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    }, 5000)
    if (!(res?.ok || res?.status === 204)) throw new Error(`AI switch ${tag} HTTP ${res?.status ?? 'none'}`)
    const verify = await withTimeout(fetchImpl, url, { headers: headers() }, 5000)
    if (!verify?.ok || (await verify.json())?.now !== name) throw new Error(`AI selection verification failed for ${tag}`)
  }

  const updateModel = async () => {
    if (training) return { ok: false, reason: 'training-in-progress' }
    training = true
    const results = []
    try {
      const profile = store.getProfile()
      if (!profile.aiOptimizer?.collectTrainingData) return { ok: false, reason: 'training-data-collection-disabled', samples: 0, required: 32 }
      await loadConfig()
      const urls = [...new Set(groups.map((group) => group.url))]
      if (!urls.length) return { ok: false, reason: 'no-configured-ai-probes', samples: 0, required: 32 }
      if (typeof history.getAiForUrl !== 'function') return { ok: false, reason: 'url-scoped-history-unavailable', samples: 0, required: 32 }
      await ctx.mkdirp(modelDir)
      for (const url of urls) {
        const result = await trainOnlineModel(history.getAiForUrl(url), {
          ctx, paths, minRows: Math.max(8, Number(profile.aiOptimizer?.minTrainingRows) || 32),
          maxAgeMs: Math.max(1, Number(profile.aiOptimizer?.maxSampleAgeHours) || 168) * 3_600_000,
          now: now(), numIterations: profile.aiOptimizer?.trainingIterations,
        })
        if (!result.ok) { results.push({ ok: false, reason: result.reason, samples: result.samples, required: result.required }); continue }
        const modelPath = modelPathForUrl(url)
        await ctx.writeFile(modelPath, result.model)
        if (await ctx.readFile(modelPath) !== result.model) throw new Error('LightGBM 模型原子写入后校验不一致')
        await ctx.writeFile(`${modelPath}.meta.json`, JSON.stringify({ version: LIGHTGBM_VERSION, format: LIGHTGBM_MODEL_FORMAT, features: FEATURE_COUNT, trainedAt: result.trainedAt, samples: result.samples }))
        results.push({ ok: true, samples: result.samples, trainedAt: result.trainedAt })
      }
      modelStatus = await getModelStatus()
      const successful = results.filter((result) => result.ok)
      if (!successful.length) {
        const first = results[0] || { reason: 'no-configured-ai-probes', samples: 0, required: 32 }
        modelStatus = { ...modelStatus, error: first.reason }
        return { ok: false, ...first }
      }
      return { ok: true, version: LIGHTGBM_VERSION, models: successful.length, samples: successful.reduce((sum, result) => sum + result.samples, 0), trainedAt: successful.at(-1).trainedAt, failed: results.length - successful.length }
    } catch (error) {
      modelStatus = { ...modelStatus, error: error instanceof Error ? error.message : String(error) }
      return { ok: false, reason: 'training-failed', error: modelStatus.error }
    } finally {
      training = false
    }
  }

  const getModelStatus = async (url = '') => {
    const urls = url ? [url] : [...new Set(groups.map((group) => group.url))]
    const available = []
    for (const item of urls) {
      try {
        const path = modelPathForUrl(item)
        if (!(await ctx.exists(path))) continue
        const model = await ctx.readFile(path)
        if (!model.includes(`version=${LIGHTGBM_MODEL_FORMAT}\n`) || !model.includes(`max_feature_idx=${FEATURE_COUNT - 1}\n`)) continue
        let metadata = {}
        try { metadata = JSON.parse(await ctx.readFile(`${path}.meta.json`)) } catch { /* optional training metadata */ }
        available.push(metadata)
      } catch { /* keep other URL-scoped models available */ }
    }
    if (url) return { ...available[0], available: Boolean(available.length), version: available.length ? LIGHTGBM_VERSION : '', error: '' }
    modelStatus = { available: Boolean(available.length), version: available.length ? LIGHTGBM_VERSION : '', trainedAt: available.at(-1)?.trainedAt || '', samples: available.reduce((sum, item) => sum + (Number(item.samples) || 0), 0), models: available.length, error: modelStatus.error || '' }
    return modelStatus
  }

  void loadConfig().then(() => getModelStatus()).catch(() => {})

  const tick = async () => {
    if (inFlight) return { skipped: 'busy' }
    inFlight = true
    try {
      const profile = store.getProfile()
      if (!profile.aiOptimizer?.enabled) {
        groups = []
        selections = {}
        stats = { tested: 0, switched: 0, shared: 0 }
        lastError = ''
        return { enabled: false }
      }
      await loadConfig()
      if (!groups.length) return { enabled: true, skipped: 'no-deployed-ai-groups' }
      const proxies = await getProxies()
      const unique = new Map()
      for (const group of groups) {
        const runtime = proxies[group.tag]
        if (!runtime || !Array.isArray(runtime.all)) continue
        selections[group.tag] = runtime.now || selections[group.tag] || ''
        for (const node of group.members) unique.set(JSON.stringify([node, group.url]), { node, url: group.url, intervalMs: group.intervalMs })
      }
      let tested = 0
      let shared = 0
      const verifiedProbes = new Map()
      const selected = []
      let switched = 0
      for (const group of groups) {
        const current = selections[group.tag]
        const maxAgeHours = Number(profile.aiOptimizer.maxSampleAgeHours) || 168
        const groupHistories = typeof history.getAiForUrl === 'function' ? history.getAiForUrl(group.url) : {}
        const model = await getModelStatus(group.url)
        const decisionOptions = { now: now(), current, maxAgeMs: maxAgeHours * 3_600_000 }
        if (model.available) {
          try {
            const features = group.members.map((node) => featureVector(groupHistories[node], decisionOptions))
            const predictions = await predictWithLightGbm({ modelPath: modelPathForUrl(group.url), rows: features, ctx, paths })
            decisionOptions.modelScores = Object.fromEntries(group.members.map((node, i) => [node, predictions[i]]))
          } catch (error) {
            modelStatus = { ...modelStatus, error: error instanceof Error ? error.message : String(error) }
          }
        }
        const decision = await selectReachableNode(group.members, groupHistories, profile.aiOptimizer, decisionOptions, {
          maxAttempts: Math.min(3, group.members.length),
          probe: async (node) => {
            const key = JSON.stringify([node, group.url])
            if (verifiedProbes.has(key)) { shared++; return verifiedProbes.get(key) }
            const result = await coordinator.probe(node, group.url, {
              intervalMs: 0,
              timeoutMs: Math.min(15_000, Math.max(5_000, group.intervalMs || 5_000)),
              force: true,
            })
            tested++
            verifiedProbes.set(key, result)
            return result
          },
          onSample: (node, sample) => history.recordAiProbe?.(node, group.url, sample),
        })
        history.flush()
        if (!decision.selected) {
          if (decision.verificationAttempts) log(`[ai-optimizer] ${group.tag}: 最近 ${decision.verificationAttempts} 个同组候选强制测速均未通过,保留当前选择`)
          continue
        }
        if (decision.selected === current) continue
        await select(group.tag, decision.selected)
        selections[group.tag] = decision.selected
        selected.push({ group: group.tag, node: decision.selected, score: decision.candidates.find((c) => c.name === decision.selected)?.score, scoring: decision.candidates.find((c) => c.name === decision.selected)?.scoring || 'rules', verified: decision.verified, verificationAttempts: decision.verificationAttempts })
        switched++
      }
      lastRunAt = now()
      lastError = ''
      stats = { tested, switched, shared: Math.max(0, groups.reduce((n, g) => n + g.members.length, 0) - unique.size) + shared }
      if (selected.length) log(`[ai-optimizer] 已按共享延迟历史更新 ${selected.length} 个自动组选择`)
      return { enabled: true, ...stats, selected }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      log(`[ai-optimizer] ${lastError}`)
      return { enabled: true, error: lastError }
    } finally {
      inFlight = false
    }
  }
  const start = () => {
    if (timer) return
    timer = setInterval(() => { tick().catch(() => {}) }, tickMs)
    timer.unref?.()
    tick().catch(() => {})
  }
  const stop = () => { if (timer) clearInterval(timer); timer = null }
  const status = () => ({ enabled: Boolean(store.getProfile().aiOptimizer?.enabled), groups: groups.map((g) => ({ tag: g.tag, url: g.url, members: g.members.length, selected: selections[g.tag] || '' })), lastRunAt, lastError, training, model: modelStatus, ...stats })
  return { tick, start, stop, status, updateModel, _score: scoreNode, _summarize: summarizeNodeHistory }
}
