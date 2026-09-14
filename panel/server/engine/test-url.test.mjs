import assert from 'node:assert/strict'
import test from 'node:test'
import { CUSTOM_TEST_URL_TOKEN, DEFAULT_DIRECT_TEST_URL, DEFAULT_TEST_URL, ensureTestUrlDefaults, kernelTestUrl, resolveGroupTestUrl } from './test-url.mjs'
import { createStore } from '../store/jbox-store.mjs'

const memStore = () => {
  const m = new Map()
  return createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
}

test('kernelTestUrl 保留用户指定的协议、主机、端口、路径和参数，不替换成其他检测地址', () => {
  for (const url of [
    'http://cp.cloudflare.com/generate_204', 'HTTP://example.com:8080/x?q=1',
    'https://cp.cloudflare.com/generate_204', 'http://www.msftconnecttest.com/connecttest.txt',
  ]) assert.equal(kernelTestUrl(` ${url} `), url)
  assert.equal(kernelTestUrl(''), '')
  assert.equal(kernelTestUrl(undefined), '')
  assert.equal(kernelTestUrl('not a url'), 'not a url')
  assert.ok(DEFAULT_TEST_URL.startsWith('http://') && DEFAULT_DIRECT_TEST_URL.startsWith('http://'))
})

test('新档案默认 HTTP；旧版内置 HTTPS 默认迁移为 HTTP，重复启动不再写入', () => {
  const fresh = memStore()
  assert.equal(ensureTestUrlDefaults(fresh), false)
  assert.equal(fresh.getProfile().testUrl, DEFAULT_TEST_URL)
  assert.equal(fresh.getProfile().directTestUrl, DEFAULT_DIRECT_TEST_URL)
  const old = memStore()
  old.setProfile({ testUrl: 'https://www.gstatic.com/generate_204', directTestUrl: 'https://connectivitycheck.platform.hicloud.com/generate_204' })
  assert.equal(ensureTestUrlDefaults(old), true)
  assert.equal(old.getProfile().testUrl, DEFAULT_TEST_URL)
  assert.equal(old.getProfile().directTestUrl, DEFAULT_DIRECT_TEST_URL)
  assert.equal(ensureTestUrlDefaults(old), false)
})

test('保留自定义 HTTP 和 HTTPS 地址；兼容早期直连默认值', () => {
  const custom = memStore()
  custom.setProfile({ testUrl: 'http://cp.cloudflare.com/generate_204', directTestUrl: 'https://example.com/204' })
  assert.equal(ensureTestUrlDefaults(custom), false)
  assert.equal(custom.getProfile().testUrl, 'http://cp.cloudflare.com/generate_204')
  assert.equal(custom.getProfile().directTestUrl, 'https://example.com/204')
  custom.setProfile({ directTestUrl: 'http://www.msftconnecttest.com/connecttest.txt' })
  assert.equal(ensureTestUrlDefaults(custom), true)
  assert.equal(custom.getProfile().directTestUrl, DEFAULT_DIRECT_TEST_URL)
})

test('分组测速地址:custom 哨兵解析到档案里的自定义地址,没填回落到全局', () => {
  const global = 'http://global.example/204'
  const custom = 'https://api.openai.com/v1/models'
  // 空 = 全局
  assert.equal(resolveGroupTestUrl('', { testUrl: global, customTestUrl: custom }), global)
  assert.equal(resolveGroupTestUrl(undefined, { testUrl: global, customTestUrl: custom }), global)
  // custom = 自定义地址(分组测 OpenAI 这类专用地址)
  assert.equal(resolveGroupTestUrl(CUSTOM_TEST_URL_TOKEN, { testUrl: global, customTestUrl: custom }), custom)
  // 自定义地址留空时,引用它的分组回落全局
  assert.equal(resolveGroupTestUrl(CUSTOM_TEST_URL_TOKEN, { testUrl: global, customTestUrl: '' }), global)
  // 具体 URL(预设或手动输入)原样使用,忽略全局
  assert.equal(resolveGroupTestUrl('https://github.com/robots.txt', { testUrl: global, customTestUrl: custom }), 'https://github.com/robots.txt')
  // 全局也没有时兜到内置默认,绝不产生空 url(内核 urltest 的 url 不能为空)
  assert.equal(resolveGroupTestUrl(CUSTOM_TEST_URL_TOKEN, {}), DEFAULT_TEST_URL)
  assert.equal(resolveGroupTestUrl('', {}), DEFAULT_TEST_URL)
})
