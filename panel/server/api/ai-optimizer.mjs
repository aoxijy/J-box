import express from 'express'

export const registerAiOptimizerRoutes = (app, { optimizer } = {}) => {
  const router = express.Router()
  router.get('/ai-optimizer/status', (_req, res) => res.json(optimizer.status()))
  router.post('/ai-optimizer/run', async (_req, res) => {
    const result = await optimizer.tick()
    res.status(result.error ? 503 : 200).json(result)
  })
  router.post('/ai-optimizer/model/update', async (_req, res) => {
    const result = await optimizer.updateModel()
    res.status(result.ok || result.reason === 'insufficient-observed-transitions' ? 200 : 503).json(result)
  })
  router.post('/ai-optimizer/training/reset', async (_req, res) => {
    const result = await optimizer.resetTrainingData()
    res.status(result.ok ? 200 : result.reason === 'optimizer-busy' ? 409 : 500).json(result)
  })
  app.use('/api/jbox', router)
}
