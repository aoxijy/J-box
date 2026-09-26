import assert from 'node:assert/strict'
import test from 'node:test'
import { planLatencyTests } from './latency-test-plan.mjs'

test('同一测速地址的策略组共测并去重，CHATGPT节点只进入专用地址测试', () => {
  const plan = planLatencyTests([
    { name: 'CHATGPT自动', url: 'https://api.openai.com/v1/models', members: ['US-01', 'ASIA-01'] },
    { name: '美国-自动', url: 'http://global.test/204', members: ['US-01', 'US-02'] },
    { name: '亚洲-自动', url: 'http://global.test/204', members: ['ASIA-01', 'JP-01'] },
    { name: '其他-自动', url: 'http://global.test/204', members: ['OTHER-01', 'JP-01'] },
  ])

  assert.deepEqual(plan, [
    { url: 'https://api.openai.com/v1/models', groups: ['CHATGPT自动'], nodes: ['US-01', 'ASIA-01'] },
    { url: 'http://global.test/204', groups: ['美国-自动', '亚洲-自动', '其他-自动'], nodes: ['US-02', 'JP-01', 'OTHER-01'] },
  ])
})

test('不同测速地址各自成批，同一批内节点只测试一次', () => {
  assert.deepEqual(planLatencyTests([
    { name: 'CHATGPT自动', url: 'https://ai.test/', members: ['A'] },
    { name: '组B', url: 'https://b.test/', members: ['A', 'B'] },
    { name: '组C', url: 'https://b.test/', members: ['B', 'C'] },
  ]), [
    { url: 'https://ai.test/', groups: ['CHATGPT自动'], nodes: ['A'] },
    { url: 'https://b.test/', groups: ['组B', '组C'], nodes: ['B', 'C'] },
  ])
})
