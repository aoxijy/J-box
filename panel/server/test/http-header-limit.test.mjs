// 请求头上限:Node 默认 16KB,HPE_HEADER_OVERFLOW 会把带大 Cookie / 长代理头的请求
// 直接挡在 HTTP 解析层(面板挂在路由器上很容易撞到)。index.mjs 已放宽到 64KB。
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'j-box-header-test-'))
process.env.ZASHBOARD_DB_PATH = path.join(tempDir, 'zashboard.sqlite')

const { server, shutdownServer } = await import(new URL(`./../index.mjs?header=${Date.now()}`, import.meta.url).href)

after(async () => {
  await shutdownServer().catch(() => {})
  await fs.rm(tempDir, { recursive: true, force: true })
})

test('HTTP 服务把请求头上限从默认 16KB 放宽到 64KB', () => {
  assert.equal(server.maxHeaderSize, 64 * 1024)
})

test('超过 16KB 的请求头不会被解析层拒掉', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const cookie = `jbox_probe=${'x'.repeat(20 * 1024)}`
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { cookie } })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).ok, true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
