import express from 'express'

export const registerAiOptimizerRoutes = (app, { optimizer } = {}) => {
  const router = express.Router()
  router.get('/ai-optimizer/status', (_req, res) => res.json(optimizer.status()))
  router.post('/ai-optimizer/run', async (_req, res) => {
    const result = await optimizer.tick()
    res.status(result.error ? 503 : 200).json(result)
  })
  app.use('/api/jbox', router)
}
