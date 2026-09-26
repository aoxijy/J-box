export interface AiOptimizerSettings {
  enabled: boolean
  policyPriority: number
  asnPriority: boolean
  sensitivityMs: number
  collectTrainingData: boolean
  minSamples: number
  maxSampleAgeHours: number
  latencyWeight: number
  reliabilityWeight: number
  jitterWeight: number
  intervalSeconds: number
}
export const AI_OPTIMIZER_DEFAULTS: Readonly<AiOptimizerSettings>
export function normalizeAiOptimizerSettings(value?: Partial<AiOptimizerSettings> | unknown): AiOptimizerSettings
