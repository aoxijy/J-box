import assert from 'node:assert/strict'
import test from 'node:test'
import YAML from 'yaml'
import { applySubscriptionShareNames } from './subscription-share-names.mjs'
import { parseSubscription } from './subscription.mjs'
import { resolveNodes } from '../api/subscriptions.mjs'

const link = (name, host = 'proxy.example') => `anytls://test-password@${host}:443/?insecure=0&sni=tls.example&custom=keep%2Fme#${encodeURIComponent(name)}`
const names = (text) => parseSubscription(text).nodes.map((node) => node.tag)

test('shares use the same automatic names, manual overrides and current prefix as subscription imports', async () => {
  const content = [link('香港A'), link('日本A'), link('香港B'), link('香港C')].join('\n')
  const sub = { id: 'one', name: '机场', renameOptions: {
    enabled: true, usePrefix: true, prefix: '过期前缀',
    template: '{region}-{feature}-{seq}', seqPad: 3, overrides: { '香港B': '家里 $&' },
  } }
  const imported = await resolveNodes({ content, name: sub.name }, undefined, sub.renameOptions)
  const expected = new Map(imported.renamed.map((node) => [node.originalTag, node.tag]))
  const output = applySubscriptionShareNames(content, sub)
  assert.deepEqual(names(output), parseSubscription(content).nodes.map((node) => expected.get(node.originalTag)))
  assert.deepEqual(names(output), ['机场 | 香港-001', '机场 | 日本-001', '机场 | 家里 $&', '机场 | 香港-002'])
  assert.deepEqual(output.split('\n').map((line) => line.split('#')[0]), content.split('\n').map((line) => line.split('#')[0]))
})

test('unconfigured or disabled renaming preserves originals; manual names and prefix still apply', () => {
  const content = [link('🇭🇰香港01'), link('原名 & 中文')].join('\n')
  for (const renameOptions of [undefined, null, { enabled: false }]) {
    assert.equal(applySubscriptionShareNames(content, { name: '机场', renameOptions }), content)
  }
  const output = applySubscriptionShareNames(content, { name: '自建', renameOptions: {
    enabled: false, usePrefix: true, overrides: { '🇭🇰香港01': '家宽' },
  } })
  assert.deepEqual(names(output), ['自建 | 家宽', '自建 | 原名 & 中文'])
})

test('existing nodes use their final panel names and never take names from another subscription', () => {
  const content = [link('香港A'), link('香港A', 'other.example')].join('\n')
  const parsed = parseSubscription(content).nodes
  const saved = [
    { ...parsed[0], subscriptionId: 'another', tag: '不能使用这个名字' },
    { ...parsed[1], subscriptionId: 'one', tag: '香港-01-2' },
    { ...parsed[0], subscriptionId: 'one', tag: '面板中的名字' },
  ]
  assert.deepEqual(names(applySubscriptionShareNames(content, { id: 'one', renameOptions: { enabled: true } }, saved)),
    ['面板中的名字', '香港-01-2'])
})

test('other shared entries follow rename rules without shifting the imported node sequence', () => {
  const content = [link('香港A'), link('香港B'), link('香港C'), link('香港D')].join('\n')
  const output = applySubscriptionShareNames(content, { renameOptions: {
    enabled: true, excludeKeywords: ['香港A'], disabled: ['香港B'],
  } })
  assert.deepEqual(names(output), ['香港-03', '香港-04', '香港-01', '香港-02'])
})

test('VMess updates the base64 JSON ps while preserving connection and extension fields', () => {
  const config = { v: '2', ps: '香港A', add: 'vmess.example', port: '443', id: 'test-uuid', aid: '0', net: 'ws', tls: 'tls', host: 'tls.example', path: '/ws', custom: { preserved: true } }
  const content = `vmess://${Buffer.from(JSON.stringify(config)).toString('base64')}`
  const output = applySubscriptionShareNames(content, { renameOptions: { enabled: true } })
  assert.deepEqual(JSON.parse(Buffer.from(output.slice(8), 'base64').toString()), { ...config, ps: '香港-01' })
})

test('Clash names and group, dialer and rule references change together without changing credentials', () => {
  const proxy = { name: '香港A', type: 'ss', server: 'ss.example', port: 8388, cipher: 'aes-256-gcm', password: 'test-password', 'dialer-proxy': '香港A', 'custom-options': { keep: true } }
  const doc = { proxies: [proxy], 'proxy-groups': [{ name: '手动', type: 'select', proxies: ['香港A', 'DIRECT'] }],
    rules: ['DOMAIN,example.com,香港A', 'IP-CIDR,10.0.0.0/8,香港A,no-resolve', 'MATCH,手动'] }
  const output = YAML.parse(applySubscriptionShareNames(YAML.stringify(doc), { name: '机场', renameOptions: { enabled: true, usePrefix: true } }))
  assert.deepEqual(output.proxies, [{ ...proxy, name: '机场 | 香港-01', 'dialer-proxy': '机场 | 香港-01' }])
  assert.deepEqual(output['proxy-groups'][0].proxies, ['机场 | 香港-01', 'DIRECT'])
  assert.deepEqual(output.rules, ['DOMAIN,example.com,机场 | 香港-01', 'IP-CIDR,10.0.0.0/8,机场 | 香港-01,no-resolve', 'MATCH,手动'])
})

test('sing-box node tags, selector defaults, detours and routing references stay consistent', () => {
  const proxy = { type: 'anytls', tag: '香港A', server: 'anytls.example', server_port: 443, password: 'test-password', tls: { enabled: true, server_name: 'tls.example' }, custom: { keep: true } }
  const doc = { outbounds: [proxy, { type: 'selector', tag: '手动', outbounds: ['香港A'], default: '香港A' },
    { type: 'direct', tag: 'DIRECT', detour: '香港A' }], route: { rules: [{ domain: ['example.com'], outbound: '香港A' }] } }
  const output = JSON.parse(applySubscriptionShareNames(JSON.stringify(doc), { renameOptions: { enabled: true } }))
  assert.deepEqual(output.outbounds[0], { ...proxy, tag: '香港-01' })
  assert.deepEqual(output.outbounds[1], { type: 'selector', tag: '手动', outbounds: ['香港-01'], default: '香港-01' })
  assert.equal(output.outbounds[2].detour, '香港-01')
  assert.equal(output.route.rules[0].outbound, '香港-01')
})
