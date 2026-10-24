export const GEMINI_PRICING_MAXIMUM_AGE_DAYS = 30

export interface GeminiPricingMetadata {
  readonly pricingSchemaVersion: 1
  readonly model: string
  readonly currency: 'USD'
  readonly inputUsdPerMillionTokens: number
  readonly outputUsdPerMillionTokens: number
  readonly estimatedVideoTokensPerSecond: number
  readonly estimatedOutputTokens: number
  readonly effectiveDate: string
  readonly verifiedAt: string
  readonly sourceUrl: string
}

export const GEMINI_PRICING_METADATA: GeminiPricingMetadata = {
  pricingSchemaVersion: 1,
  model: 'gemini-3.6-flash',
  currency: 'USD',
  inputUsdPerMillionTokens: 1.5,
  outputUsdPerMillionTokens: 7.5,
  estimatedVideoTokensPerSecond: 300,
  estimatedOutputTokens: 6_000,
  effectiveDate: '2026-07-21',
  verifiedAt: '2026-08-12T00:00:00.000Z',
  sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
}

export interface GeminiCostEstimate {
  readonly available: true
  readonly currency: 'USD'
  readonly estimatedInputTokens: number
  readonly estimatedOutputTokens: number
  readonly estimatedCost: number
  readonly pricingVerifiedAt: string
}

export type GeminiAdmissionReason =
  | 'long_video'
  | 'rolling_budget'
  | 'pricing_unavailable'

export function estimateGeminiVideoCost(input: {
  readonly durationSeconds: number
  readonly model: string
  readonly pricing?: GeminiPricingMetadata
  readonly now?: Date
}): GeminiCostEstimate | undefined {
  const { pricing } = input
  if (!pricing || pricing.model !== input.model || !pricingIsFresh(pricing, input.now)) {
    return undefined
  }
  const estimatedInputTokens = Math.ceil(input.durationSeconds * pricing.estimatedVideoTokensPerSecond)
  const inputCost = estimatedInputTokens * pricing.inputUsdPerMillionTokens / 1_000_000
  const outputCost = pricing.estimatedOutputTokens * pricing.outputUsdPerMillionTokens / 1_000_000
  return {
    available: true,
    currency: pricing.currency,
    estimatedInputTokens,
    estimatedOutputTokens: pricing.estimatedOutputTokens,
    estimatedCost: roundCurrency(inputCost + outputCost),
    pricingVerifiedAt: pricing.verifiedAt,
  }
}

export function evaluateGeminiAdmission(input: {
  readonly durationSeconds: number
  readonly rollingUsedMinutes: number
  readonly dailyLimitMinutes: number
  readonly confirmationThresholdMinutes: number
  readonly model: string
  readonly pricing?: GeminiPricingMetadata
  readonly cacheHit?: boolean
  readonly now?: Date
}): {
  readonly confirmationRequired: boolean
  readonly reasons: readonly GeminiAdmissionReason[]
  readonly estimate?: GeminiCostEstimate
} {
  if (input.cacheHit) return { confirmationRequired: false, reasons: [] }
  const estimate = estimateGeminiVideoCost(input)
  const durationMinutes = input.durationSeconds / 60
  // Only the operator's own limits withhold an analysis. Both are counted in
  // video minutes, which are known whether or not a price can be quoted.
  const withholding: GeminiAdmissionReason[] = []
  if (durationMinutes > input.confirmationThresholdMinutes) withholding.push('long_video')
  if (input.rollingUsedMinutes + durationMinutes > input.dailyLimitMinutes) {
    withholding.push('rolling_budget')
  }
  // A missing estimate is reported so a caller can say the cost is unknown, and
  // it is deliberately not a reason to stop. The pricing table expires 30 days
  // after its verifiedAt, and treating that as a refusal turned one stale file
  // into "Gemini analysis is off" for every video, with a notice that blamed
  // cost confirmation rather than the expiry.
  const reasons = estimate ? withholding : [...withholding, 'pricing_unavailable' as const]
  return {
    confirmationRequired: withholding.length > 0,
    reasons,
    ...(estimate ? { estimate } : {}),
  }
}

function pricingIsFresh(pricing: GeminiPricingMetadata, now = new Date()): boolean {
  const verifiedAt = Date.parse(pricing.verifiedAt)
  if (!Number.isFinite(verifiedAt)) return false
  const maximumAgeMs = GEMINI_PRICING_MAXIMUM_AGE_DAYS * 24 * 60 * 60 * 1_000
  const ageMs = now.getTime() - verifiedAt
  return ageMs >= 0 && ageMs <= maximumAgeMs
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000
}
