import express from 'express'
import {
  cancelUpdate, compareVersions, fetchLatestVersion, readChannel, readMeta, readUpdateLogTail,
  readUpdateStatus, startUpdate,
} from '../system/updater.mjs'

const CHANNELS = new Set(['auto', 'direct', 'mirror'])

// 发起升级前探一下最新 tag(直连不通就走镜像,见 fetchLatestVersion);探不到就空着,
// 脚本会自己再试一次直连,再不行退回稳定资产名
const makeLatestTagOrEmpty = (fetchImpl) => async () => {
  try {
    return (await fetchLatestVersion(fetchImpl)).latest
  } catch {
    return ''
  }
}

export const registerUpdateRoutes = (app, { ctx, paths, fetchImpl = globalThis.fetch } = {}) => {
  const router = express.Router({ caseSensitive: true })
  const latestTagOrEmpty = makeLatestTagOrEmpty(fetchImpl)
  router.use(express.json({ limit: '64kb' }))

  // GET /api/jbox/update/status —— 本地信息,不出网
  router.get('/update/status', async (_req, res) => {
    const [meta, channel, status, logTail] = await Promise.all([
      readMeta(ctx, paths), readChannel(ctx, paths), readUpdateStatus(ctx, paths), readUpdateLogTail(ctx, paths),
    ])
    res.json({ version: meta.version || '', singboxVersion: meta.singboxVersion || '', builtAt: meta.builtAt || '', channel, status, logTail })
  })

  // GET /api/jbox/update/check —— 探最新版
  router.get('/update/check', async (_req, res) => {
    try {
      const meta = await readMeta(ctx, paths)
      const { latest, via } = await fetchLatestVersion(fetchImpl)
      res.json({ current: meta.version || '', latest, via, hasUpdate: compareVersions(latest, meta.version) > 0 })
    } catch (error) {
      res.status(503).json({ message: error instanceof Error ? error.message : String(error) })
    }
  })

  // POST /api/jbox/update/run {channel}
  router.post('/update/run', async (req, res) => {
    const channel = String((req.body || {}).channel || 'auto')
    if (!CHANNELS.has(channel)) return res.status(400).json({ message: `channel must be one of ${[...CHANNELS].join(', ')}` })
    const status = await readUpdateStatus(ctx, paths)
    if (status.running) return res.status(409).json({ message: '已有一次更新在进行中' })
    if (!(await ctx.exists(paths.updateScript))) return res.status(503).json({ message: `找不到升级脚本:${paths.updateScript}` })
    const r = await startUpdate(ctx, paths, channel, { expect: await latestTagOrEmpty() })
    if (!r.ok) return res.status(503).json({ message: r.output || `update.sh exit ${r.code}` })
    res.json({ ok: true, output: r.output })
  })

  router.post('/update/cancel', async (_req, res) => {
    res.json(await cancelUpdate(ctx, paths))
  })

  // 旧页面/客户端不能再单独更新 Geo，防止与随包快照混用。
  router.all(['/rulesets/check', '/rulesets/refresh', '/rulesets/refresh/status'], (_req, res) => {
    res.status(410).json({ message: 'GeoSite / GeoIP 已随 J-Box 统一更新，请使用 J-Box 更新' })
  })

  app.use('/api/jbox', router)
}
