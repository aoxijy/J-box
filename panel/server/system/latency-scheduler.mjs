// 自动组的硬性定时测速。
//
// sing-box 的 URLTest 组是"懒惰"的:interval 只在这个组有流量经过时才起作用——启动时测一遍,
// 之后只有连接真正经过它才启动定时器,超过 idle_timeout 没流量又停掉。闲置的组永远停在启动
// 那一次结果上,用户设的检测间隔在没流量时不成立。这里由面板服务端按 interval 严格
// 定时:每 tick 看一眼每个 urltest 组最近一轮是什么时候(自己记的,或者成员里最新的一条——
// 内核启动自测、有流量时内核自己测都算),到点把该测的成员逐个测一遍。
//
// 为什么按成员调 /proxies/<tag>/delay,而不是一次调 /group/<tag>/delay:
// 内核(1.14 / experimental/clashapi/api_meta_group.go)的组测速接口走 URLTestGroup.URLTest,
// 也就是 force=true——整组所有成员都要测,而且拿请求里的 timeout 当**整批**的上下文;单个成员
// 的探测上限是内核常量。面板要按成员错峰(共用节点每个 interval 只测一次,代价 = 节点数,不是
// 组数 × 节点数),传的 timeout 是单节点超时(5s),于是组测速刚跑完十几个节点就被取消:剩下
// 没测到的成员在 URLTest 里被当成失败 DeleteURLTestHistory 删掉 history。下一次 Select 读不到
// 当前节点的历史,就退化成"列表里第一个还有历史的成员",节点开始乱跳,而且被删掉的成员下一个
// tick 又算"到点",组测速每 30 秒重发一次。实测 119 个成员的组,一次组测速调用后只剩 5~11 个
// 成员还有 history,组每 20~40 秒换一次节点,用户设的 300 秒检测间隔形同虚设。
// 单节点接口只动这一个节点的 history,不碰别人;内核随后照常对包含它的自动组重选。
// (组接口仍留给面板上"测速当前选中节点"这类一次性的手动操作。)
// 测完再读一次 /proxies:有新结果的记进延迟历史;这轮该测(结果比 interval 老或本来就没有)
// 却仍没有结果的成员就是超时,记 0。
import { CLASH_API_BASE } from '../api/penetration.mjs'
import { processUptime } from './service.mjs'
import { parseDuration } from '../engine/duration.mjs'
import { isInternalTag } from '../engine/user-groups.mjs'
import { kernelTestUrl } from '../engine/test-url.mjs'

export { parseDuration }

const DEFAULT_INTERVAL_MS = 300_000
const latestTime = (proxy) => {
  const history = proxy && Array.isArray(proxy.history) ? proxy.history : []
  const last = history[history.length - 1]
  const t = last ? Date.parse(last.time) : NaN
  return Number.isFinite(t) ? t : 0
}

const withTimeout = async (fetchImpl, url, init, timeoutMs) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// 有界并发跑一批任务,结果按下标一一对应(和内核自己的批测并发对齐)
const mapLimit = async (items, limit, fn) => {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export const createLatencyScheduler = ({
  store, ctx, paths, history, fetchImpl = globalThis.fetch, now = () => Date.now(),
  tickMs = 30_000, testTimeoutMs = 5000, log = () => {},
}) => {
  // 每个成员上一次被我们发起的测试覆盖到的时刻。有结果的成员按内核记录的时间判"到点",
  // 没结果的(超时的、从没测通的)内核那边没有时间,就按这个表判——否则它们每个 tick 都算到点,
  // 每 30 秒被测一次,一个死节点一次 5 秒,白白占着并发。
  const lastTested = new Map()
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
  const readGroups = async () => {
    const cfg = JSON.parse(await ctx.readFile(paths.configPath))
    // 故障转移的内部子组不在这里调度:它们的检测由 system/failover-manager.mjs 按父组的间隔统一做,两个调度器
    // 不重复发起同一批检查
    return (cfg.outbounds || [])
      .filter((o) => o && o.type === 'urltest' && o.tag && !isInternalTag(o.tag))
      // 保留组配置的检测地址；随包内核的 Clash API 和原生定时探测均支持 HTTP / HTTPS。
      .map((o) => ({ tag: o.tag, url: kernelTestUrl(o.url || ''), intervalMs: parseDuration(o.interval) || DEFAULT_INTERVAL_MS, members: Array.isArray(o.outbounds) ? o.outbounds : [] }))
  }

  // 只读一次 /proxies 把看到的变化记下来,不发起测速(面板手动测完后调用,结果马上进历史)
  const sync = async () => {
    let proxies
    try { proxies = await fetchProxies() } catch { return false }
    return history.recordFromProxies(proxies, { kernelStartedAt: await kernelStart(), at: now() })
  }

  // 单节点测速。true = 内核测通了(history 已写);false = 节点确实失败(503/504);null = 面板
  // 这边请求本身失败 / 超时,结果未知——不能当成节点超时记 0,也不算测过(下个 tick 还会再来)。
  const NODE_CONCURRENCY = 10
  const testNode = async (tag, url) => {
    try {
      const res = await withTimeout(fetchImpl, `${CLASH_API_BASE}/proxies/${encodeURIComponent(tag)}/delay?url=${encodeURIComponent(url)}&timeout=${testTimeoutMs}`, { headers: headers() }, testTimeoutMs + 5000)
      if (!res) return null
      if (res.ok) return true
      if (res.status === 503 || res.status === 504) return false
      return null
    } catch { return null }
  }

  let inFlight = false
  const tick = async () => {
    // 上一轮还没跑完(大组一轮要一两分钟)就不叠着跑
    if (inFlight) return { skipped: 'busy' }
    inFlight = true
    try {
      return await runTick()
    } finally {
      inFlight = false
    }
  }

  const runTick = async () => {
    let proxies
    try { proxies = await fetchProxies() } catch { return { skipped: 'kernel' } }
    const kernelStartedAt = await kernelStart()
    history.recordFromProxies(proxies, { kernelStartedAt, at: now() })
    let groups
    try { groups = await readGroups() } catch { return { skipped: 'config' } }

    const tested = []
    const timeouts = []
    for (const g of groups) {
      if (!g.url || !g.members.length) continue
      // 到点按成员算,不按组算:一个组里各成员上次测的时刻不一样(共用的成员可能刚被别的组测过,
      // 一轮里靠后的成员比靠前的晚一分钟),谁到了 interval 谁就该测。每个组都按此刻最新的
      // /proxies 判,前一个组刚测过的共用成员这里就不算到点。
      const at = now()
      const due = g.members.filter((m) => {
        const t = latestTime(proxies[m])
        // 内核测完后节点 history 可能还没在下一次 /proxies 里反映出来。面板自己的记录必须和
        // 内核时间取较新者,否则同一轮后面的共享组会读到旧 history,把同一个节点再测一次。
        const since = Math.max(t, lastTested.get(m) || 0)
        return !since || at - since >= g.intervalMs
      })
      if (!due.length) continue
      const results = await mapLimit(due, NODE_CONCURRENCY, (m) => testNode(m, g.url))
      tested.push(g.tag)
      if (results.some((r) => r === null)) log(`[latency] 定时测速 ${g.tag}:部分成员的测速请求未完成`)
      // 测完马上读一次:新结果立刻进历史,后面的组也按新数据判要不要测
      try { proxies = await fetchProxies() } catch { break }
      history.recordFromProxies(proxies, { kernelStartedAt, at: now() })
      // 这轮该测却仍没有结果的成员就是超时。自己请求没完成的那个成员不判:结果未知,不是节点超时
      const time = new Date(at).toISOString()
      const samples = []
      for (let i = 0; i < due.length; i++) {
        if (results[i] === null) continue
        const m = due[i]
        lastTested.set(m, at)
        const p = proxies[m]
        if (!p || typeof p !== 'object') continue
        if (Array.isArray(p.all) && p.all.length) continue
        if (!latestTime(p)) samples.push({ name: m, time, delay: 0 })
      }
      history.recordSamples(samples)
      timeouts.push(...samples.map((x) => x.name))
      log(`[latency] 定时测速 ${g.tag}:测 ${due.length} 个`)
    }
    return { tested, timeouts }
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
