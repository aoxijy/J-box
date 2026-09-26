import { configMetaPath } from './deploy.mjs'
import { CLASH_API_BASE } from '../api/penetration.mjs'
import { scoreNode, summarizeNodeHistory, selectBestNode } from './ai-optimizer.mjs'

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
        for (const node of group.members) unique.set(`${node}\u0000${group.url}`, { node, url: group.url, intervalMs: group.intervalMs })
      }
      let tested = 0
      for (const item of unique.values()) {
        const result = await coordinator.probe(item.node, item.url, {
          intervalMs: Math.min(item.intervalMs || tickMs, (Number(profile.aiOptimizer.intervalSeconds) || 60) * 1000),
          timeoutMs: Math.min(15_000, Math.max(5_000, item.intervalMs || 5_000)),
          force: false,
        })
        if (!result?.cached) tested++
        if (!result?.cached && (result?.ok === true || result?.ok === false) && Number.isFinite(result.at) && Number.isFinite(result.delay)) {
          history.record(item.node, { time: new Date(result.at).toISOString(), delay: result.ok ? result.delay : 0 })
        }
      }
      history.flush()
      const histories = history.get()
      const selected = []
      let switched = 0
      for (const group of groups) {
        const current = selections[group.tag]
        const maxAgeHours = Number(profile.aiOptimizer.maxSampleAgeHours) || 168
        const decision = selectBestNode(group.members, histories, profile.aiOptimizer, { now: now(), current, maxAgeMs: maxAgeHours * 3_600_000 })
        if (!decision.selected || decision.selected === current) continue
        await select(group.tag, decision.selected)
        selections[group.tag] = decision.selected
        selected.push({ group: group.tag, node: decision.selected, score: decision.candidates.find((c) => c.name === decision.selected)?.score })
        switched++
      }
      lastRunAt = now()
      lastError = ''
      stats = { tested, switched, shared: Math.max(0, groups.reduce((n, g) => n + g.members.length, 0) - unique.size) }
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
  const status = () => ({ enabled: Boolean(store.getProfile().aiOptimizer?.enabled), groups: groups.map((g) => ({ tag: g.tag, url: g.url, members: g.members.length, selected: selections[g.tag] || '' })), lastRunAt, lastError, ...stats })
  return { tick, start, stop, status, _score: scoreNode, _summarize: summarizeNodeHistory }
}
