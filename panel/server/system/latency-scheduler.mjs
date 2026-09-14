// 自动组的定时探测调度:按组配置的 interval 探测到点的**真实叶子节点**,结果交给
// system/probe-coordinator.mjs 在自动优选与故障转移之间共享。
//
// 为什么不再自己发 /proxies/:tag/delay 就完事:
//   · 内核每收到一次节点测速,就会对所有包含该节点的 URLTest 组重跑一次择优
//     (PerformUpdateCheck)。所以"探测谁、什么时候探"必须先算清楚,否则共享节点会被
//     反复探测、顺带把每个组都重选一遍,用户设的间隔完全不起作用。
//   · 一个组的成员可能是另一个组(嵌套 URLTest)。检测间隔要落到真实叶子节点上算,
//     否则"外层的组标签"和内层的叶子会被当成两个不同的目标各测一遍。
//
// 这里做三件事:
//   1. 读内核配置里的 urltest 组 → 把成员展开成真实叶子节点(嵌套组递归);
//   2. 每个「节点 + 测速地址」算出**用到它的所有组里最短的 interval**(共享节点的实际
//      探测周期),到点的交给协调器探测;协调器里已经有比它新的结果就直接复用(长周期组
//      到点时吃短周期组刚测出来的那份);
//   3. 探测用 force=false 请求内核(见 singbox-tcp-dns-hotfix/urltest-force.patch):
//      内核 history 还新鲜就把已有结果还回来,不重测也不重选。
//
// 手动测速不走这条路:面板"测速"按钮 / 订阅页一键测速有自己的强制语义(立即真测),
// 结果由 api/latency-history.mjs 的 sync 回流。
import { CLASH_API_BASE } from '../api/penetration.mjs'
import { processUptime } from './service.mjs'
import { parseDuration } from '../engine/duration.mjs'
import { isInternalTag } from '../engine/user-groups.mjs'
import { kernelTestUrl } from '../engine/test-url.mjs'

export { parseDuration }

const DEFAULT_INTERVAL_MS = 300_000

const withTimeout = async (fetchImpl, url, init, timeoutMs) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// 一个成员可能是节点,也可能是另一个组(嵌套 URLTest):按 all 递归展开成真实叶子节点。
// 组里带环(不该出现,生成配置时就挡了)时靠 seen 兜底。
export const leafNodesOf = (tag, proxies, seen = new Set()) => {
  const p = proxies && proxies[tag]
  if (!p || typeof p !== 'object') return []
  if (Array.isArray(p.all) && p.all.length) {
    if (seen.has(tag)) return []
    seen.add(tag)
    const out = []
    for (const m of p.all) out.push(...leafNodesOf(m, proxies, seen))
    return out
  }
  return [tag]
}

// 组定义(内核配置里的 urltest 组):tag / 检测地址 / interval / 成员
export const readUrltestGroups = (config) => (Array.isArray(config && config.outbounds) ? config.outbounds : [])
  .filter((o) => o && o.type === 'urltest' && o.tag && !isInternalTag(o.tag))
  .map((o) => ({
    tag: o.tag,
    url: kernelTestUrl(o.url || ''),
    intervalMs: parseDuration(o.interval) || DEFAULT_INTERVAL_MS,
    members: Array.isArray(o.outbounds) ? o.outbounds : [],
  }))

// 组 → 「节点 + 测速地址」的兴趣表。同一个键被多个组用到时,interval 取最短的那个:
// 这就是"共享节点的实际探测周期 = 用到它的组里最短的 interval"。没有测速地址的组跳过。
export const collectProbeInterests = (groups, proxies) => {
  const interests = new Map()
  for (const g of groups) {
    if (!g.url || !g.members.length) continue
    const leaves = new Set()
    for (const m of g.members) for (const leaf of leafNodesOf(m, proxies)) leaves.add(leaf)
    for (const leaf of leaves) {
      const key = `${leaf}\u0000${g.url}`
      const prev = interests.get(key)
      if (!prev) interests.set(key, { key, node: leaf, url: g.url, intervalMs: g.intervalMs, groups: [g.tag] })
      else {
        prev.intervalMs = Math.min(prev.intervalMs, g.intervalMs)
        if (!prev.groups.includes(g.tag)) prev.groups.push(g.tag)
      }
    }
  }
  return [...interests.values()]
}

// 延迟历史的去重窗口:节点用它所有组里最短的 interval,组用它自己的 interval。
// 见 system/latency-history.mjs —— 同一节点在窗口内不再重复记一笔组记录。
export const dedupeWindows = (groups, proxies) => {
  const windows = new Map()
  for (const g of groups) {
    windows.set(g.tag, Math.max(windows.get(g.tag) || 0, g.intervalMs))
    for (const m of g.members) {
      for (const leaf of leafNodesOf(m, proxies)) {
        const prev = windows.get(leaf)
        windows.set(leaf, prev ? Math.min(prev, g.intervalMs) : g.intervalMs)
      }
    }
  }
  return windows
}

export const createLatencyScheduler = ({
  store, ctx, paths, history, coordinator, fetchImpl = globalThis.fetch, now = () => Date.now(),
  tickMs = 30_000, testTimeoutMs = 5000, log = () => {},
}) => {
  const headers = () => {
    const secret = store.getClashSecret ? store.getClashSecret() : ''
    return secret ? { Authorization: `Bearer ${secret}` } : {}
  }
  const fetchProxies = async () => {
    const res = await withTimeout(fetchImpl, `${CLASH_API_BASE}/proxies`, { headers: headers() }, 5000)
    if (!res || !res.ok) throw new Error(`proxies HTTP ${res ? res.status : 'none'}`)
    const body = await res.json()
    return (body && body.proxies) || {}
  }
  const kernelStart = async () => {
    const uptime = await processUptime(ctx, 'sing-box')
    return typeof uptime === 'number' ? now() - uptime * 1000 : null
  }
  const readGroups = async () => readUrltestGroups(JSON.parse(await ctx.readFile(paths.configPath)))

  // 只读一次 /proxies 把内核已经测出的结果记下来,不发起任何测速
  // (面板手动测完 / 部署完之后调,新结果立刻进历史)
  const sync = async () => {
    let proxies
    try { proxies = await fetchProxies() } catch { return false }
    const kernelStartedAt = await kernelStart()
    return history.recordFromProxies(proxies, { kernelStartedAt, at: now() })
  }

  let seeded = false
  const runTick = async () => {
    let proxies
    try { proxies = await fetchProxies() } catch { return { skipped: 'kernel' } }
    const kernelStartedAt = await kernelStart()
    let groups
    try { groups = await readGroups() } catch { return { skipped: 'config' } }
    const windows = dedupeWindows(groups, proxies)
    const dedupeMsOf = (name) => windows.get(name) || 0
    history.recordFromProxies(proxies, { kernelStartedAt, at: now(), dedupeMsOf })

    const interests = collectProbeInterests(groups, proxies)
    // 面板刚起来(或刚重启完内核):先用内核 history 给协调器播种,不要立刻把每个节点重测一遍
    if (!seeded) {
      const n = coordinator ? coordinator.seedFromProxies(proxies, interests) : 0
      seeded = true
      if (n) log(`[latency] 用内核已有结果播种 ${n} 个节点,按各自间隔到点再测`)
    }
    const probed = []
    if (coordinator) {
      for (const it of interests) {
        const r = await coordinator.probe(it.node, it.url, { intervalMs: it.intervalMs, timeoutMs: testTimeoutMs, force: false })
        if (r && !r.cached) probed.push(it.node)
      }
    }
    // 测完重读一次:新结果立刻进历史(节点按自己最短的窗口去重,组按自己的间隔去重)
    try { proxies = await fetchProxies() } catch { return { tested: probed, timeouts: [] } }
    history.recordFromProxies(proxies, { kernelStartedAt, at: now(), dedupeMsOf })
    return { tested: probed, timeouts: [] }
  }

  let inFlight = false
  const tick = async () => {
    if (inFlight) return { skipped: 'busy' }
    inFlight = true
    try {
      return await runTick()
    } finally {
      inFlight = false
    }
  }

  let timer = null
  const start = () => {
    if (timer) return
    timer = setInterval(() => { tick().catch((err) => log(`[latency] tick 失败:${err instanceof Error ? err.message : err}`)) }, tickMs)
    if (typeof timer.unref === 'function') timer.unref()
  }
  const stop = () => { if (timer) clearInterval(timer); timer = null }
  return { tick, sync, start, stop }
}
