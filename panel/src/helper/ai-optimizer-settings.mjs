const DEFAULTS = Object.freeze({
  enabled: false,
  policyPriority: 50,
  asnPriority: false,
  sensitivityMs: 50,
  collectTrainingData: false,
  minSamples: 5,
  maxSampleAgeHours: 168,
  latencyWeight: 70,
  reliabilityWeight: 30,
  jitterWeight: 20,
  intervalSeconds: 60,
})

export function normalizeAiOptimizerSettings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const integer = (key, fallback, min, max) => {
    const number = Number(source[key])
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback
  }
  return {
    enabled: source.enabled === true,
    policyPriority: integer('policyPriority', DEFAULTS.policyPriority, 0, 100),
    asnPriority: source.asnPriority === true,
    sensitivityMs: integer('sensitivityMs', DEFAULTS.sensitivityMs, 0, 10_000),
    collectTrainingData: source.collectTrainingData === true,
    minSamples: integer('minSamples', DEFAULTS.minSamples, 1, 10),
    maxSampleAgeHours: integer('maxSampleAgeHours', DEFAULTS.maxSampleAgeHours, 1, 720),
    latencyWeight: integer('latencyWeight', DEFAULTS.latencyWeight, 0, 100),
    reliabilityWeight: integer('reliabilityWeight', DEFAULTS.reliabilityWeight, 0, 100),
    jitterWeight: integer('jitterWeight', DEFAULTS.jitterWeight, 0, 100),
    intervalSeconds: integer('intervalSeconds', DEFAULTS.intervalSeconds, 15, 3600),
  }
}

export { DEFAULTS as AI_OPTIMIZER_DEFAULTS }
