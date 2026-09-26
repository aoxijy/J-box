const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return null
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

export const summarizeNodeHistory = (samples, { now = Date.now(), maxAgeMs = 7 * 86400_000 } = {}) => {
  const valid = (Array.isArray(samples) ? samples : [])
    .filter((s) => s && Number.isFinite(Date.parse(s.time)) && Number.isFinite(s.delay) && s.delay >= 0 && now - Date.parse(s.time) <= maxAgeMs)
    .slice(-10)
  if (!valid.length) return { samples: 0, medianMs: null, p90Ms: null, failureRate: 1, jitterMs: null, recentMs: null }
  const delays = valid.map((s) => s.delay)
  const successes = delays.filter((d) => d > 0)
  const medianMs = quantile(successes, 0.5)
  const p90Ms = quantile(successes, 0.9)
  const mean = successes.length ? successes.reduce((a, b) => a + b, 0) / successes.length : null
  const variance = mean === null ? null : successes.reduce((a, b) => a + (b - mean) ** 2, 0) / successes.length
  return {
    samples: valid.length,
    medianMs,
    p90Ms,
    failureRate: 1 - successes.length / valid.length,
    jitterMs: variance === null ? null : Math.sqrt(variance),
    recentMs: successes.at(-1) ?? null,
  }
}

// Lower score is better; latency, stability and reliability all come from the shared ten-sample history.
export const scoreNode = (summary, settings = {}) => {
  if (!summary || !Number.isFinite(summary.medianMs) || summary.failureRate >= 1) return Infinity
  const priority = clamp(Number(settings.policyPriority) || 0, 0, 100) / 100
  const latencyWeight = clamp(Number(settings.latencyWeight) || 0, 0, 100) / 100
  const reliabilityWeight = clamp(Number(settings.reliabilityWeight) || 0, 0, 100) / 100
  const jitterWeight = clamp(Number(settings.jitterWeight) || 0, 0, 100) / 100
  const latency = summary.medianMs * (1 + latencyWeight * priority)
  const tailPenalty = (summary.p90Ms - summary.medianMs) * reliabilityWeight
  const failurePenalty = summary.failureRate * 1000 * reliabilityWeight
  const jitterPenalty = (summary.jitterMs || 0) * jitterWeight
  return Math.max(0, latency + tailPenalty + failurePenalty + jitterPenalty)
}

export const selectBestNode = (members, histories, settings, options = {}) => {
  const candidates = (Array.isArray(members) ? members : []).map((name, index) => {
    const summary = summarizeNodeHistory(histories && histories[name], options)
    return { name, index, summary, score: scoreNode(summary, settings) }
  }).filter((candidate) => Number.isFinite(candidate.score) && candidate.summary.samples >= Math.min(10, Math.max(1, Number(settings?.minSamples) || 1)))
    .sort((a, b) => a.score - b.score || a.index - b.index)
  if (!candidates.length) return { selected: '', candidates: [] }
  const incumbent = candidates.find((c) => c.name === options.current)
  const best = candidates[0]
  const switchMargin = Math.max(0, Number(settings?.sensitivityMs) || 0)
  if (incumbent && incumbent.name !== best.name && incumbent.score - best.score < switchMargin) {
    return { selected: incumbent.name, candidates }
  }
  return { selected: best.name, candidates }
}
