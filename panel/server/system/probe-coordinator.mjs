// 节点探测协调器:自动优选(urltest)与故障转移共用同一份探测结果。
//
// 为什么需要它(现场:用户把检测间隔设成 300 秒,组却每 30 秒就换节点):
//   · 内核的 /proxies/<节点>/delay 每被调用一次,就会对**所有包含该节点的 URLTest 组**
//     重跑一次择优(experimental/clashapi/proxies.go 的 PerformUpdateCheck)。多个组共享
//     同一个节点时(实测 179 个节点被 7 个组引用),同一个节点几秒内被反复探测,顺带把每个
//     组都重选一遍——用户设的间隔形同虚设,而且重选看的是旧延迟,常跳到已经不通的节点上。
//   · 面板重启、定时任务、故障转移各测各的,同一个节点同样会在几秒内被检查多次。
//
// 这里的做法:按「节点 + 测速地址」把结果存成一份。
//   · 同一个键的并发请求只发一次(不同测速地址互不影响)——见 probe() 的 in-flight 合并。
//   · 每个调用方给出自己的检测间隔 intervalMs;已有结果比它新就直接复用,不再发请求。
//     于是共享节点的实际探测周期 = 用到它的所有组里最短的那个 interval;长周期组到点时
//     直接吃短周期组刚测出来的结果。见 probe() 的 cached 分支。
//   · force=true(面板手动测速、故障转移超时后的立即复查)始终真测。
//   · seedFromProxies():面板刚启动时用内核 history 里已有的时间给缓存播种,避免"面板重启
//     导致同一个节点在几秒内被重新检查一遍"。
//   · 定时探测在请求里带 force=false(见 scripts/singbox-tcp-dns-hotfix/urltest-force.patch):
//     内核那边 history 还新鲜就直接把已有结果还回来,不重测也不重选;没打这个补丁的内核
//     会忽略参数,行为退回今天的样子,面板侧的复用依然生效。
import { CLASH_API_BASE } from '../api/penetration.mjs'

const withTimeout = async (fetchImpl, url, init, timeoutMs) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

const errText = (err) => (err instanceof Error ? err.message : String(err))

// 结果形状和 failover-manager 以前自己实现的探针一致:
//   ok: true  = 内核测通了(history 已写)
//       false = 节点确实失败(503/504)
//       null  = 探测基础设施的问题(请求超时 / 非 503 的 HTTP 错误),不算节点失败
export const createProbeCoordinator = ({
  store, fetchImpl = globalThis.fetch, now = () => Date.now(),
}) => {
  // key -> { at, ok, delay, reason }
  const entries = new Map()
  // key -> Promise(在途请求,同键合并)
  const inflight = new Map()
  let hits = 0
  let misses = 0

  const keyOf = (node, url) => `${node}\u0000${url}`
  const headers = () => {
    const secret = store && store.getClashSecret ? store.getClashSecret() : ''
    return secret ? { Authorization: `Bearer ${secret}` } : {}
  }

  // 内核已经有的结果(history 的时间 / 延迟)拿来播种:面板重启后第一个 tick 不会立刻
  // 把每个节点重测一遍,而是把内核记录的时刻当成"刚测过"。interests 是 [{node,url}]
  const seedFromProxies = (proxies, interests) => {
    let seeded = 0
    for (const it of interests || []) {
      if (!it || !it.node || !it.url) continue
      const key = keyOf(it.node, it.url)
      if (entries.has(key)) continue
      const p = proxies && proxies[it.node]
      const hist = p && Array.isArray(p.history) ? p.history : null
      if (!hist || !hist.length) continue
      const last = hist[hist.length - 1]
      const at = Date.parse(last && last.time)
      if (!Number.isFinite(at) || !Number.isFinite(Number(last.delay))) continue
      entries.set(key, { at, ok: Number(last.delay) > 0, delay: Number(last.delay), reason: 'seed' })
      seeded += 1
    }
    return seeded
  }

  const fetchResult = async (node, url, { timeoutMs, force, intervalMs }) => {
    const at0 = now()
    const query = `url=${encodeURIComponent(url)}&timeout=${timeoutMs}`
      + (force ? '' : `&force=false&interval=${Math.max(0, Math.round(intervalMs || 0))}`)
    try {
      const res = await withTimeout(
        fetchImpl,
        `${CLASH_API_BASE}/proxies/${encodeURIComponent(node)}/delay?${query}`,
        { headers: headers() },
        timeoutMs + 5000,
      )
      if (!res) return { ok: null, delay: 0, at: at0, reason: 'no-response' }
      if (res.ok) {
        let body = null
        try { body = await res.json() } catch { /* 空体也算通过 */ }
        const delay = body && Number.isFinite(Number(body.delay)) ? Number(body.delay) : 0
        return delay > 0 ? { ok: true, delay, at: at0 } : { ok: false, delay: 0, at: at0, reason: 'zero-delay' }
      }
      if (res.status === 503 || res.status === 504) {
        return { ok: false, delay: 0, at: at0, reason: res.status === 504 ? 'timeout' : 'failed' }
      }
      return { ok: null, delay: 0, at: at0, reason: `http-${res.status}` }
    } catch (err) {
      return { ok: null, delay: 0, at: at0, reason: err && err.name === 'AbortError' ? 'probe-timeout' : errText(err) }
    }
  }

  // 探测一个节点。force=true 一定真测(手动测速 / 超时复查);否则比 intervalMs 新就复用。
  // kernelIntervalMs:发给内核的 force=false 去重窗口(默认与 intervalMs 相同)。
  //   自动优选用默认值——内核 history 还新鲜时直接复用,不重测也不重选(这就是 300 秒间隔
  //   真正生效的关键);故障转移传 0,因为它的健康判断必须拿到**当前**结果,不能吃旧值。
  const probe = async (node, url, { intervalMs = 0, kernelIntervalMs = null, timeoutMs = 5000, force = false } = {}) => {
    if (!node || !url) return { ok: null, delay: 0, at: now(), reason: 'bad-args' }
    const key = keyOf(node, url)
    // 并发合并:同一个键在途时,后来的请求(包括 force)都等这一份结果。
    // 不同测速地址的 key 不同,互不影响。
    const running = inflight.get(key)
    if (running) return running
    if (!force && intervalMs > 0) {
      const hit = entries.get(key)
      if (hit && now() - hit.at < intervalMs) {
        hits += 1
        return { ...hit, cached: true }
      }
    }
    misses += 1
    const kernelInterval = kernelIntervalMs === null ? intervalMs : kernelIntervalMs
    const p = fetchResult(node, url, { timeoutMs, force, intervalMs: kernelInterval })
      .then((result) => {
        entries.set(key, result)
        return result
      })
      .finally(() => { inflight.delete(key) })
    inflight.set(key, p)
    return p
  }

  // 只标"刚测过",不产生结果(例如外部已经知道内核测过了)
  const noteProbed = (node, url, at, result = {}) => {
    if (!node || !url) return
    entries.set(keyOf(node, url), { at, ok: result.ok ?? null, delay: result.delay ?? 0, reason: result.reason || 'noted' })
  }

  const stats = () => ({ size: entries.size, inflight: inflight.size, hits, misses })

  // 手动测速(面板"测速"按钮、订阅页一键测速)不走这里:那条路有自己的强制语义,
  // 见 api/node-latency.mjs 与 api/penetration.mjs 的控制器转发。
  return { probe, seedFromProxies, noteProbed, stats, _entries: entries }
}
