import { randomBytes } from 'node:crypto'
import { BUILTIN_REGIONS } from '../engine/routing-model.mjs'
import { defaultGroups, normalizeGroups } from '../engine/user-groups.mjs'
import { DEFAULT_DIRECT_TEST_URL, DEFAULT_TEST_URL } from '../engine/test-url.mjs'

export const KEYS = {
  profile: 'jbox/profile',
  subscriptions: 'jbox/subscriptions',
  subscriptionShares: 'jbox/subscription-shares',
  nodes: 'jbox/nodes',
  groups: 'jbox/groups',
  deployState: 'jbox/deploy-state',
  clashSecret: 'jbox/clash-secret',
  // 内核里各 selector 当前选的线路的快照(system/scheduler.mjs 每分钟刷新)
  // 必须带 jbox/ 前缀:index.mjs 的 isProtectedStorageKey 只认这个前缀,浏览器每次
  // 同步设置(PUT /api/storage)会把不受保护的键整个清掉——以前用点号,快照每次都被删
  selections: 'jbox/selections',
}

export const DEFAULT_PROFILE = {
  region: 'CN',
  // 默认关掉 IPv6:关掉的含义是 DNS 只解析 A 记录(strategy=ipv4_only)、tun 不给
  // v6 地址、并在防火墙上 REJECT 掉 lan→wan 的 v6——也就是干脆不走 IPv6,免得它绕开
  // 隧道直连出去。要用 v6 的人在「其他」页签里自己打开。
  ipv6: false,
  // IPv6 开着时,走代理的目标怎么处理(engine/dns.mjs 的 ipv6ProxyMode):
  //   node:v6 目标和 v4 一样交给节点(老行为);
  //   ipv4:走代理的域名不给 AAAA(终端自然用 v4),裸 v6 目标要走代理时在内核里明确拒绝——
  //        代理线路不支持 v6 时用它,直连的 v6 照常。
  //   bypass:v6 根本不进内核,按系统路由直接从 WAN 出去(OpenClash / DAE 的默认行为,GitHub #36)。
  ipv6Proxy: 'node',
  // 订阅链接和节点服务器的地址一律直连,不看站点集(engine/direct-hosts.mjs)
  directForNodes: true,
  tun: { autoRedirect: true },
  // 共享网络:本机开的服务器入站(engine/servers.mjs),默认没有
  servers: [],
  // 终端分流:按局域网来源 IP 指定出口(engine/client-routes.mjs),默认没有
  clientRoutes: [],
  // mode:off 不碰 DNS / hijack 防火墙劫持 / dnsmasq 转发(默认;见 engine/dns.mjs 与 system/dns-takeover.mjs)
  dns: { split: true, mode: 'dnsmasq', direct: '223.5.5.5', proxy: '1.1.1.1' },
  // 每日流量这些分析数据在库里留多久(月)。面板「后端设置」里可改,1~36。
  // 按正式路由器实测,按天的记录一天大约 0.75MB,3 个月 ≈ 70MB;小时明细另外只留 7 天
  // (见 system/traffic-collector.mjs)
  traffic: { keepMonths: 3 },
  aiOptimizer: { enabled: false, policyPriority: 50, asnPriority: false, sensitivityMs: 50, collectTrainingData: false, minSamples: 5, maxSampleAgeHours: 168, latencyWeight: 70, reliabilityWeight: 30, jitterWeight: 20, intervalSeconds: 60 },
  // 测速地址。testUrl 给自动择优(url-test)组和面板的延迟测试用;directTestUrl 只给内置
  // 直连出站用——默认那个是 Google 的域名,从国内直连去测量出来的是"直连到 Google 有多远"。
  // 默认 HTTP，用户可自定义 HTTP / HTTPS 地址(见 engine/test-url.mjs)
  testUrl: DEFAULT_TEST_URL,
  directTestUrl: DEFAULT_DIRECT_TEST_URL,
  // 分组可选的「自定义测速地址」:某类分组(典型是 AI 分组)需要一个更贴合的检测地址
  // (如 https://api.openai.com/v1/models,测的是"这个节点到底能不能访问 OpenAI");
  // 分组把测速地址设成哨兵值 custom 时解析到这里(见 engine/test-url.mjs)。
  // 留空 = 引用它的分组回落全局 testUrl。
  customTestUrl: '',
  // 自动更新计划(面板进程内的定时器,见 system/scheduler.mjs):默认都关
  // channel 是自动更新走的通道;checkChannel 是卡片上手动「检查更新 / 立即更新」那个下拉框
  // 上次选的通道,记下来免得每次进页面都要重选
  updates: {
    jbox: { auto: false, hour: 4, channel: 'auto', checkChannel: 'auto' },
  },
  routing: {
    proxyTag: 'PROXY',
    // 地区分流:预置中国大陆/香港澳门/其他地区三条,用户可以增删改、拖拽排序。
    // regionId 指向当前选中的那条(没有时按 regionMode 推断,见 routing-model.mjs)。
    regions: BUILTIN_REGIONS.map((r) => ({ ...r, rules: r.rules.map((rule) => ({ ...rule })) })),
    regionMode: 'CN',
    // 「出站」页签:每条策略的 selector 里能选到哪几类东西
    outboundOptions: { direct: true, reject: true, groups: true },
    // 策略分流。一条策略 = 一组匹配条件 + 内核里一个同名 selector,不记具体节点。
    policies: [],
    adBlock: false,
    adRuleset: 'geosite-category-ads-all',
    // 下面三个是改版前的老字段。deepMerge 没有删键的能力,清空反而会让降级回旧版本
    // 的人丢数据,所以留着不动;读出来时由 engine/routing-model.mjs 翻译成新模型。
    categories: [],
    directRulesets: ['geosite-cn', 'geoip-cn'],
    fallback: 'PROXY',
  },
  rulesetDir: '/opt/j-box/data/rulesets',
}

const DEFAULT_DEPLOY_STATE = { stage: 'idle', message: '', at: 0, badTags: [] }

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

// 深合并:普通对象递归合并,数组与其它类型整体替换(patch 优先)。
const deepMerge = (base, patch) => {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch
  const result = { ...base }
  for (const key of Object.keys(patch)) {
    result[key] = deepMerge(base[key], patch[key])
  }
  return result
}

// 所有 JSON 解析统一走这里:损坏数据回退到 fallback,而不是抛错拖垮整个面板。
const parseJsonOr = (raw, fallback) => {
  if (typeof raw !== 'string') return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

const defaultRandomHex = () => randomBytes(16).toString('hex')

export const createStore = ({ get, set, del }, { randomHex = defaultRandomHex } = {}) => {
  void del // 当前接口未暴露删除操作,保留注入以便未来使用/测试对称性。

  const getProfile = () => {
    const raw = get(KEYS.profile)
    const stored = parseJsonOr(raw, {})
    const profile = deepMerge(DEFAULT_PROFILE, isPlainObject(stored) ? stored : {})
    if (isPlainObject(profile.updates)) delete profile.updates.geo
    return profile
  }

  const setProfile = (patch) => {
    const merged = deepMerge(getProfile(), patch || {})
    if (isPlainObject(merged.updates)) delete merged.updates.geo
    set(KEYS.profile, JSON.stringify(merged))
    return merged
  }

  const getSubscriptions = () => {
    const raw = get(KEYS.subscriptions)
    const stored = parseJsonOr(raw, [])
    return Array.isArray(stored) ? stored : []
  }

  const setSubscriptions = (list) => {
    set(KEYS.subscriptions, JSON.stringify(Array.isArray(list) ? list : []))
  }

  const getSubscriptionShares = () => {
    const raw = get(KEYS.subscriptionShares)
    const stored = parseJsonOr(raw, [])
    return Array.isArray(stored) ? stored : []
  }

  const setSubscriptionShares = (list) => {
    set(KEYS.subscriptionShares, JSON.stringify(Array.isArray(list) ? list : []))
  }

  const getNodes = () => {
    const raw = get(KEYS.nodes)
    const stored = parseJsonOr(raw, [])
    return Array.isArray(stored) ? stored : []
  }

  const setNodes = (list) => {
    set(KEYS.nodes, JSON.stringify(Array.isArray(list) ? list : []))
  }

  const getDeployState = () => {
    const raw = get(KEYS.deployState)
    const stored = parseJsonOr(raw, DEFAULT_DEPLOY_STATE)
    return deepMerge(DEFAULT_DEPLOY_STATE, isPlainObject(stored) ? stored : {})
  }

  const setDeployState = (s) => {
    set(KEYS.deployState, JSON.stringify(s))
  }

  // 内核跑着的时候从 clash API 读到的「每个 selector 现在选的是谁」。内核没在跑时
  // (升级脚本停掉内核后用户点启动、开机自启)拿它生成 DNS 规则,不然所有站点集都
  // 会按配置里的默认项判直连/代理,和内核用 cache_file 恢复出来的实际选择对不上。
  const LEGACY_SELECTIONS_KEY = 'jbox.selections'
  const getSelectionsSnapshot = () => {
    let raw = get(KEYS.selections)
    if (raw === null || raw === undefined) {
      // 旧键名的快照搬到新键下(能搬到就搬,搬不到也无妨:那份多半早被清空了)
      const legacy = get(LEGACY_SELECTIONS_KEY)
      if (legacy !== null && legacy !== undefined) {
        set(KEYS.selections, legacy)
        del(LEGACY_SELECTIONS_KEY)
        raw = legacy
      }
    }
    const stored = parseJsonOr(raw, {})
    return isPlainObject(stored) ? stored : {}
  }
  const setSelectionsSnapshot = (map) => {
    set(KEYS.selections, JSON.stringify(isPlainObject(map) ? map : {}))
    // 内核在跑时每分钟都是直接写新快照、不经过 get,旧键名那份要顺手清掉
    if (get(LEGACY_SELECTIONS_KEY) !== null && get(LEGACY_SELECTIONS_KEY) !== undefined) del(LEGACY_SELECTIONS_KEY)
  }

  const getClashSecret = () => {
    const existing = get(KEYS.clashSecret)
    if (typeof existing === 'string' && existing) return existing
    const generated = randomHex()
    set(KEYS.clashSecret, generated)
    return generated
  }

  const migrateUnchangedReleaseDefaults = (list) => {
    const shippedDefaults = defaultGroups()
    const currentById = new Map(shippedDefaults.map((group) => [group.id, group]))
    const legacyById = new Map()
    const legacyNames = ['CHATGPT自动', '香港-自动', '亚洲-自动', '美国-自动', '其他-自动', '所有-自动']
    const requiredRegionNames = legacyNames.slice(0, 5)

    for (const name of legacyNames) {
      const current = shippedDefaults.find((group) => group.name === name)
      if (!current) return null
      legacyById.set(current.id, {
        ...current,
        mode: name === '所有-自动' ? 'dynamic' : 'static',
        keywords: [],
        members: [],
        interval: '300s',
        tolerance: name === 'CHATGPT自动' ? 300 : 100,
      })
    }

    const matchesLegacyDefault = (group, legacy) => {
      if (!group || Object.keys(group).length !== Object.keys(legacy).length) return false
      return Object.entries(legacy).every(([key, value]) => JSON.stringify(group[key]) === JSON.stringify(value))
    }

    // 只有整套地区组仍与旧版随包默认完全一致时才迁移;少一个、改过任意设置都视为用户配置。
    for (const name of requiredRegionNames) {
      const legacy = [...legacyById.values()].find((group) => group.name === name)
      if (!list.some((group) => group.id === legacy.id && matchesLegacyDefault(group, legacy))) return null
    }

    let changed = false
    const migrated = list.map((group) => {
      const legacy = legacyById.get(group.id)
      const current = currentById.get(group.id)
      if (!legacy || !current || !matchesLegacyDefault(group, legacy)) return group
      changed = true
      return current
    })
    return changed ? normalizeGroups(migrated) : null
  }

  // 用户自定义节点组。第一次读取时落地随包默认组;升级时只迁移未被用户修改过的旧版整套默认,
  // 避免 SQLite 中已持久化的旧静态组让新 release 的动态地区规则永远不生效。
  const getGroups = () => {
    const raw = get(KEYS.groups)
    if (raw) {
      try {
        const list = JSON.parse(raw)
        if (Array.isArray(list)) {
          const migrated = migrateUnchangedReleaseDefaults(list)
          if (migrated) {
            set(KEYS.groups, JSON.stringify(migrated))
            return migrated
          }
          return normalizeGroups(list)
        }
      } catch { /* 落到下面的默认值 */ }
    }
    const seeded = normalizeGroups(defaultGroups())
    set(KEYS.groups, JSON.stringify(seeded))
    return seeded
  }
  const setGroups = (list) => {
    set(KEYS.groups, JSON.stringify(normalizeGroups(Array.isArray(list) ? list : [])))
  }

  return {
    getProfile,
    setProfile,
    getGroups,
    setGroups,
    getSubscriptions,
    setSubscriptions,
    getSubscriptionShares,
    setSubscriptionShares,
    getNodes,
    setNodes,
    getDeployState,
    setDeployState,
    getSelectionsSnapshot,
    setSelectionsSnapshot,
    // 裸键读写:给部署锁这类"进程间协调"用,键必须带 jbox/ 前缀才不会被设置同步清掉
    getRaw: (key) => get(key),
    setRaw: (key, value) => set(key, value),
    delRaw: (key) => del(key),
    getClashSecret,
  }
}
