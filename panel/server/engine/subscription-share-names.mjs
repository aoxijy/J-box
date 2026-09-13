import YAML from 'yaml'
import { decodeBase64 } from './codec.mjs'
import { parseShareLink } from './sharelink.mjs'
import { parseClashProxies } from './clash.mjs'
import { parseSingboxOutbounds } from './singbox-in.mjs'
import { detectSubscriptionFormat } from './subscription.mjs'
import { excludeNodes, renameNodes, subscriptionRenameOptions } from './rename.mjs'

const nodeKey = (node) => JSON.stringify([node.originalTag, node.type, node.server, node.server_port])

// 只改名称，保留原始协议字段（包括 J-Box 尚未识别的客户端扩展）。
const renameLink = (line, name) => {
  if (line.startsWith('vmess://')) {
    const config = JSON.parse(decodeBase64(line.slice('vmess://'.length)))
    config.ps = name
    return `vmess://${Buffer.from(JSON.stringify(config)).toString('base64')}`
  }
  return `${line.split('#', 1)[0]}#${encodeURIComponent(name)}`
}

const renameSingboxReferences = (value, names) => {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (['outbound', 'detour', 'default'].includes(key) && typeof item === 'string') {
      value[key] = names.get(item) ?? item
    } else if (key === 'outbounds' && Array.isArray(item)) {
      value[key] = item.map((entry) => typeof entry === 'string' ? (names.get(entry) ?? entry) : entry)
      for (const entry of value[key]) renameSingboxReferences(entry, names)
    } else {
      renameSingboxReferences(item, names)
    }
  }
}

const renameClashReferences = (doc, names) => {
  for (const group of doc['proxy-groups'] || []) {
    if (Array.isArray(group.proxies)) group.proxies = group.proxies.map((name) => names.get(name) ?? name)
  }
  for (const proxy of doc.proxies) {
    if (proxy && names.has(proxy['dialer-proxy'])) proxy['dialer-proxy'] = names.get(proxy['dialer-proxy'])
  }
  const renameRule = (rule) => {
    if (typeof rule !== 'string') return rule
    const fields = rule.split(',')
    const index = fields.length - (fields.at(-1) === 'no-resolve' ? 2 : 1)
    if (index > 0 && names.has(fields[index])) fields[index] = names.get(fields[index])
    return fields.join(',')
  }
  if (Array.isArray(doc.rules)) doc.rules = doc.rules.map(renameRule)
  for (const [name, rules] of Object.entries(doc['sub-rules'] || {})) {
    if (Array.isArray(rules)) doc['sub-rules'][name] = rules.map(renameRule)
  }
}

export const applySubscriptionShareNames = (content, subscription, storedNodes = []) => {
  const entries = []
  let render
  const references = new Map()
  const add = (node, setName) => {
    if (node) entries.push({ node: { ...node, shareIndex: entries.length }, setName })
  }
  const format = detectSubscriptionFormat(content)
  if (format === 'sharelink') {
    const lines = content.split(/\r?\n/)
    lines.forEach((raw, index) => {
      const line = raw.trim()
      add(parseShareLink(line), (name) => { lines[index] = renameLink(line, name) })
    })
    render = () => lines.join('\n')
  } else if (format === 'clash') {
    const doc = YAML.parse(content)
    for (const proxy of doc.proxies || []) {
      const node = parseClashProxies(YAML.stringify({ proxies: [proxy] })).nodes[0]
      add(node, (name) => { proxy.name = name })
    }
    render = () => { renameClashReferences(doc, references); return YAML.stringify(doc) }
  } else if (format === 'singbox') {
    const doc = JSON.parse(content)
    for (const key of ['outbounds', 'endpoints']) {
      for (const outbound of doc[key] || []) {
        const node = parseSingboxOutbounds(JSON.stringify({ [key]: [outbound] })).nodes[0]
        add(node, (name) => { outbound.tag = name })
      }
    }
    render = () => { renameSingboxReferences(doc, references); return JSON.stringify(doc, null, 2) }
  } else return content

  // 先给已导入的节点编号，原文中其余节点随后分配名称，避免影响面板中已生效的
  // 编号。分享包含的所有节点均遵循重命名规则，不改变此前分享的节点集合。
  const { effective } = subscriptionRenameOptions(subscription.renameOptions ?? { enabled: false }, subscription.name)
  const { kept } = excludeNodes(entries.map((entry) => entry.node), effective)
  const keptIndices = new Set(kept.map((node) => node.shareIndex))
  const remaining = entries.filter(({ node }) => !keptIndices.has(node.shareIndex)).map(({ node }) => node)
  const generated = new Map(renameNodes([...kept, ...remaining], effective).map((node) => [node.shareIndex, node.tag]))
  const saved = new Map()
  for (const node of storedNodes) {
    if (node.subscriptionId !== subscription.id) continue
    const key = nodeKey(node)
    if (!saved.has(key)) saved.set(key, [])
    saved.get(key).push(node.tag)
  }
  let changed = false
  for (const { node, setName } of entries) {
    // 已导入节点沿用面板里的最终名称，包含跨订阅同名去重后的后缀。
    const name = saved.get(nodeKey(node))?.shift() ?? generated.get(node.shareIndex) ?? node.originalTag
    if (name === node.originalTag) continue
    setName(name)
    if (!references.has(node.originalTag)) references.set(node.originalTag, name)
    changed = true
  }
  return changed ? render() : content
}

// Clash/Mihomo 客户端要求订阅根节点包含 proxies。把通用分享链接转换成最小的
// Clash 节点对象；这里只转换连接参数，不丢弃名称、服务器和认证信息。
export const toClashProxy = (node) => {
  const fields = node.fields || {}
  const type = node.type === 'shadowsocks' ? 'ss' : node.type === 'socks' ? 'socks5' : node.type
  const proxy = { name: node.tag, type, server: node.server, port: node.server_port }
  const copy = ['password', 'uuid', 'flow', 'username', 'obfs']
  for (const key of copy) if (fields[key] !== undefined) proxy[key] = fields[key]
  if (node.type === 'shadowsocks' && fields.method) proxy.cipher = fields.method
  if (node.type === 'vmess') {
    proxy.cipher = fields.security || 'auto'
    proxy.alterId = Number.parseInt(fields.alter_id ?? 0, 10) || 0
  }
  if (node.type === 'wireguard') {
    if (fields.private_key) proxy['private-key'] = fields.private_key
    if (fields.peer_public_key) proxy['public-key'] = fields.peer_public_key
    const address = Array.isArray(fields.local_address) ? fields.local_address[0] : fields.local_address
    if (address) proxy.ip = String(address).replace(/\/\d+$/, '')
  }
  if (fields.plugin) {
    proxy.plugin = fields.plugin === 'obfs-local' ? 'obfs' : fields.plugin
    const opts = Object.fromEntries(String(fields.plugin_opts || '').split(';').map((item) => item.split('=').map((v) => v.trim())).filter(([key]) => key))
    if (Object.keys(opts).length) proxy['plugin-opts'] = opts
  }
  if (fields.tls) {
    proxy.tls = fields.tls.enabled !== false
    if (fields.tls.server_name) proxy.servername = fields.tls.server_name
    if (fields.tls.insecure) proxy['skip-cert-verify'] = true
    if (fields.tls.utls?.fingerprint) proxy['client-fingerprint'] = fields.tls.utls.fingerprint
    if (fields.tls.reality?.public_key) proxy['reality-opts'] = { 'public-key': fields.tls.reality.public_key, ...(fields.tls.reality.short_id ? { 'short-id': fields.tls.reality.short_id } : {}) }
  }
  const transport = fields.transport
  if (transport) {
    proxy.network = transport.type === 'http' ? 'h2' : transport.type
    if (transport.type === 'ws') proxy['ws-opts'] = { ...(transport.path ? { path: transport.path } : {}), ...(transport.headers ? { headers: transport.headers } : {}) }
    if (transport.type === 'grpc' && transport.service_name) proxy['grpc-opts'] = { 'grpc-service-name': transport.service_name }
    if (transport.type === 'http') proxy['http-opts'] = { ...(transport.path ? { path: [transport.path] } : {}), ...(transport.headers?.Host ? { headers: { Host: [transport.headers.Host] } } : {}) }
  }
  if (fields.obfs?.type) { proxy.obfs = fields.obfs.type; if (fields.obfs.password) proxy['obfs-password'] = fields.obfs.password }
  return proxy
}
