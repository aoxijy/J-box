// 自动组的测速结果同步(只读,不再由面板发起测速)。
//
// 历史背景:sing-box 的 URLTest 组是"懒惰"的——interval 只在这个组有流量经过时才起作用,
// 闲置的组永远停在启动那一次结果上。面板以前因此在服务端按成员错峰补测(每个成员每 interval
// 测一次),想让它"严格按间隔测"。
//
// 为什么现在改成只读:内核(1.14,experimental/clashapi/proxies.go 的 getProxyDelay)在每次
// /proxies/:tag/delay 之后,都会对**所有包含这个节点的 URLTest 组**调用 PerformUpdateCheck
// ——也就是立刻重跑一次选择。面板按成员错峰、30 秒一个 tick,一个 119 成员的组每个 tick 都有
// 十几个成员到点,于是:
//   · 组每 30 秒就被重选一次,用户设的 300 秒检测间隔完全不起作用;
//   · 重选看的是各成员 history 里的旧延迟,经常跳到其实已经不通的节点上;真流量(以及走它的
//     DNS)在下一个 tick 之前一直失败;
//   · 组测速接口还是 force=true、拿单节点超时当整批上下文,一次调用测不完就把没轮到的成员
//     DeleteURLTestHistory,进一步喂大上面这个毛病。
// 现在不再由面板发请求:内核自己在组有流量时按 interval(用户设的 300 秒)整组重测并择优,
// 没流量时不动——这正是「检测间隔」本来的语义。面板每个 tick 只把 /proxies 里内核已经测出的
// 结果记进面板的延迟历史(代理页的延迟曲线还是要它)。
//
// 内核刚启动、还没有任何结果的时候也是同样口径:等内核自己测,面板不代劳。
import { CLASH_API_BASE } from '../api/penetration.mjs'
import { processUptime } from './service.mjs'
import { parseDuration } from '../engine/duration.mjs'

export { parseDuration }

const withTimeout = async (fetchImpl, url, init, timeoutMs) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export const createLatencyScheduler = ({
  store, ctx, history, fetchImpl = globalThis.fetch, now = () => Date.now(),
  tickMs = 30_000, log = () => {},
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

  // 只读一次 /proxies 把内核已经测出的结果记下来,不发起任何测速(部署 / 面板手动测完也会调)
  const sync = async () => {
    let proxies
    try { proxies = await fetchProxies() } catch { return false }
    return history.recordFromProxies(proxies, { kernelStartedAt: await kernelStart(), at: now() })
  }

  // 一个 tick:把内核当前的结果同步进面板历史;内核不在就什么都不做。
  // 这里刻意不发 /proxies/:tag/delay —— 见文件头:那会让内核立刻重选,把 300 秒间隔冲掉。
  const tick = async () => {
    let proxies
    try { proxies = await fetchProxies() } catch { return { skipped: 'kernel' } }
    let recorded = false
    try {
      recorded = Boolean(history.recordFromProxies(proxies, { kernelStartedAt: await kernelStart(), at: now() }))
    } catch { /* 记不上不影响下一个 tick */ }
    return { recorded }
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
