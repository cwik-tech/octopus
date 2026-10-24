export interface UsageCostRate {
  inputPerMillion: number
  outputPerMillion: number
}

export interface UsageCostResult {
  cost: number
  tracked: boolean
  source: 'reported' | 'provider_config' | 'environment' | 'untracked'
}

interface CalculateUsageCostOptions {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  reportedCost?: number
  providerConfig?: Record<string, unknown>
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function rateFromRecord(record: Record<string, unknown> | undefined): UsageCostRate | null {
  if (!record) return null
  const inputPerMillion = nonNegativeNumber(
    record.input_cost_per_million_usd ?? record.inputPerMillion,
  )
  const outputPerMillion = nonNegativeNumber(
    record.output_cost_per_million_usd ?? record.outputPerMillion,
  )
  return inputPerMillion !== undefined && outputPerMillion !== undefined
    ? { inputPerMillion, outputPerMillion }
    : null
}

function environmentRate(provider: string, model: string): UsageCostRate | null {
  const raw = process.env.TEAM_PROVIDER_PRICING_JSON
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const exact = parsed[`${provider}:${model}`]
    const wildcard = parsed[`${provider}:*`]
    return rateFromRecord(
      (exact && typeof exact === 'object' ? exact : wildcard) as
        | Record<string, unknown>
        | undefined,
    )
  } catch {
    return null
  }
}

export function calculateUsageCost(
  options: CalculateUsageCostOptions,
): UsageCostResult {
  const reportedCost = nonNegativeNumber(options.reportedCost)
  if (reportedCost !== undefined) {
    return { cost: reportedCost, tracked: true, source: 'reported' }
  }

  const configuredRate = rateFromRecord(options.providerConfig)
  const rate = configuredRate ?? environmentRate(options.provider, options.model)
  if (!rate) return { cost: 0, tracked: false, source: 'untracked' }

  const inputTokens = Math.max(0, options.inputTokens)
  const outputTokens = Math.max(0, options.outputTokens)
  const cost =
    (inputTokens * rate.inputPerMillion + outputTokens * rate.outputPerMillion) /
    1_000_000
  return {
    cost,
    tracked: true,
    source: configuredRate ? 'provider_config' : 'environment',
  }
}
