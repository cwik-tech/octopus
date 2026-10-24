/**
 * The strictly parsed, composition-owned web evidence rollout configuration
 * (plan §6.2, ADR `2026-08-26-Web-Evidence-Rollout-And-Validation-Telemetry`).
 *
 * This module is pure: the composition root reads `process.env` once and
 * passes the raw strings in. An unknown mode, an out-of-range percentage, or
 * malformed cohort JSON fails startup naming the variable and the value,
 * because a misspelt attempt to widen or narrow enforcement must never
 * silently resolve to a different posture.
 */

export const WEB_EVIDENCE_LINKS_MODE_ENV = 'PIPELINE_WEB_EVIDENCE_LINKS'
export const WEB_EVIDENCE_LINKS_PERCENT_ENV =
  'PIPELINE_WEB_EVIDENCE_LINKS_PERCENT'
export const WEB_EVIDENCE_CLAIMS_MODE_ENV = 'PIPELINE_WEB_EVIDENCE_CLAIMS'
export const WEB_EVIDENCE_CLAIMS_PERCENT_ENV =
  'PIPELINE_WEB_EVIDENCE_CLAIMS_PERCENT'
export const WEB_EVIDENCE_CLAIM_COHORTS_ENV =
  'PIPELINE_WEB_EVIDENCE_CLAIM_COHORTS'

export const WEB_EVIDENCE_CAPABILITY_MODES = ['off', 'shadow', 'enforce'] as const
export type WebEvidenceCapabilityMode =
  (typeof WEB_EVIDENCE_CAPABILITY_MODES)[number]

/** Provider routes a claims cohort can name. */
export const WEB_EVIDENCE_PROVIDER_ROUTES = ['mcp-native', 'mcp-cli'] as const
export type WebEvidenceProviderRoute =
  (typeof WEB_EVIDENCE_PROVIDER_ROUTES)[number]

export const WEB_EVIDENCE_CLAIM_COHORT_SCHEMA_VERSION = 1

export interface WebEvidenceClaimCohort {
  readonly schemaVersion: typeof WEB_EVIDENCE_CLAIM_COHORT_SCHEMA_VERSION
  readonly provider: string
  readonly route: WebEvidenceProviderRoute
}

export interface WebEvidenceRolloutConfig {
  readonly links: {
    readonly mode: WebEvidenceCapabilityMode
    readonly percent: number
  }
  readonly claims: {
    readonly mode: WebEvidenceCapabilityMode
    readonly percent: number
    readonly cohorts: readonly WebEvidenceClaimCohort[]
  }
}

export class WebEvidenceRolloutConfigurationError extends Error {
  constructor(
    readonly variable: string,
    readonly value: string,
    detail: string,
  ) {
    super(`${variable}=${value || '(empty)'} is invalid: ${detail}`)
    this.name = 'WebEvidenceRolloutConfigurationError'
  }
}

export function parseWebEvidenceRolloutConfig(raw: {
  readonly links?: string | undefined
  readonly linksPercent?: string | undefined
  readonly claims?: string | undefined
  readonly claimsPercent?: string | undefined
  readonly claimCohorts?: string | undefined
}): WebEvidenceRolloutConfig {
  const linksMode = parseMode(raw.links, WEB_EVIDENCE_LINKS_MODE_ENV)
  const linksPercent = parsePercent(
    raw.linksPercent,
    WEB_EVIDENCE_LINKS_PERCENT_ENV,
  )
  const claimsMode = parseMode(raw.claims, WEB_EVIDENCE_CLAIMS_MODE_ENV)
  const claimsPercent = parsePercent(
    raw.claimsPercent,
    WEB_EVIDENCE_CLAIMS_PERCENT_ENV,
  )
  const cohorts = parseCohorts(raw.claimCohorts)
  if (claimsMode === 'enforce' && linksMode !== 'enforce') {
    throw new WebEvidenceRolloutConfigurationError(
      WEB_EVIDENCE_CLAIMS_MODE_ENV,
      raw.claims ?? '',
      `capability B 'enforce' requires ${WEB_EVIDENCE_LINKS_MODE_ENV}=enforce; ` +
        'claim binding can never outrun the link provenance it builds on.',
    )
  }
  return {
    links: { mode: linksMode, percent: linksPercent },
    claims: { mode: claimsMode, percent: claimsPercent, cohorts },
  }
}

/**
 * The effective Capability A mode for one assignment: the configured mode
 * applied to a deterministic sample of assignment identities.
 */
export function resolveWebEvidenceLinksMode(
  config: WebEvidenceRolloutConfig,
  assignmentId: string,
): WebEvidenceCapabilityMode {
  return sampleMode(config.links.mode, config.links.percent, assignmentId)
}

/**
 * The effective Capability B mode for one assignment on one provider route.
 * The route must be in the allowlist, the assignment must be in the sample,
 * and `enforce` additionally requires Capability A to be enforcing for this
 * same assignment.
 */
export function resolveWebEvidenceClaimsMode(
  config: WebEvidenceRolloutConfig,
  input: {
    readonly assignmentId: string
    readonly provider: string
    readonly route: WebEvidenceProviderRoute
  },
): WebEvidenceCapabilityMode {
  const inCohort = config.claims.cohorts.some(
    (cohort) =>
      cohort.provider === input.provider && cohort.route === input.route,
  )
  if (!inCohort) return 'off'
  const sampled = sampleMode(
    config.claims.mode,
    config.claims.percent,
    input.assignmentId,
  )
  if (
    sampled === 'enforce' &&
    resolveWebEvidenceLinksMode(config, input.assignmentId) !== 'enforce'
  ) {
    return 'off'
  }
  return sampled
}

/**
 * `shadow` and `enforce` exist to produce rollout evidence. Without a
 * recorder they would read as a cohort with zero rejections, so startup
 * rejects either mode when the journal registry is unavailable.
 */
export function webEvidenceRolloutRequiresRecorder(
  config: WebEvidenceRolloutConfig,
): boolean {
  return config.links.mode !== 'off' || config.claims.mode !== 'off'
}

function parseMode(
  value: string | undefined,
  variable: string,
): WebEvidenceCapabilityMode {
  if (value === undefined || value === '') return 'off'
  if ((WEB_EVIDENCE_CAPABILITY_MODES as readonly string[]).includes(value)) {
    return value as WebEvidenceCapabilityMode
  }
  throw new WebEvidenceRolloutConfigurationError(
    variable,
    value,
    `expected one of ${WEB_EVIDENCE_CAPABILITY_MODES.map((mode) => `'${mode}'`).join(', ')}.`,
  )
}

function parsePercent(value: string | undefined, variable: string): number {
  if (value === undefined || value === '') return 100
  if (!/^\d+$/.test(value)) {
    throw new WebEvidenceRolloutConfigurationError(
      variable,
      value,
      'expected an integer from 0 through 100.',
    )
  }
  const percent = Number(value)
  if (!Number.isSafeInteger(percent) || percent < 0 || percent > 100) {
    throw new WebEvidenceRolloutConfigurationError(
      variable,
      value,
      'expected an integer from 0 through 100.',
    )
  }
  return percent
}

/**
 * The allowlist is a versioned JSON array of provider/route pairs, not a
 * delimiter-dependent string: a provider name is itself opaque text, so any
 * in-band separator could appear inside one.
 */
function parseCohorts(value: string | undefined): WebEvidenceClaimCohort[] {
  const variable = WEB_EVIDENCE_CLAIM_COHORTS_ENV
  if (value === undefined || value === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new WebEvidenceRolloutConfigurationError(
      variable,
      value,
      'expected a JSON array of versioned provider/route cohort entries.',
    )
  }
  if (!Array.isArray(parsed)) {
    throw new WebEvidenceRolloutConfigurationError(
      variable,
      value,
      'expected a JSON array of versioned provider/route cohort entries.',
    )
  }
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new WebEvidenceRolloutConfigurationError(
        variable,
        value,
        'each cohort entry must be an object.',
      )
    }
    const record = entry as Record<string, unknown>
    const allowedKeys = new Set(['schemaVersion', 'provider', 'route'])
    const unexpected = Object.keys(record).filter((key) => !allowedKeys.has(key))
    if (unexpected.length > 0) {
      throw new WebEvidenceRolloutConfigurationError(
        variable,
        value,
        `cohort entry carries unexpected keys: ${unexpected.join(', ')}.`,
      )
    }
    if (record.schemaVersion !== WEB_EVIDENCE_CLAIM_COHORT_SCHEMA_VERSION) {
      throw new WebEvidenceRolloutConfigurationError(
        variable,
        value,
        `cohort entry schemaVersion must be ${WEB_EVIDENCE_CLAIM_COHORT_SCHEMA_VERSION}.`,
      )
    }
    if (typeof record.provider !== 'string' || record.provider.trim() === '') {
      throw new WebEvidenceRolloutConfigurationError(
        variable,
        value,
        'cohort entry provider must be a non-empty string.',
      )
    }
    if (
      typeof record.route !== 'string' ||
      !(WEB_EVIDENCE_PROVIDER_ROUTES as readonly string[]).includes(record.route)
    ) {
      throw new WebEvidenceRolloutConfigurationError(
        variable,
        value,
        `cohort entry route must be one of ${WEB_EVIDENCE_PROVIDER_ROUTES.map((route) => `'${route}'`).join(', ')}.`,
      )
    }
    return {
      schemaVersion: WEB_EVIDENCE_CLAIM_COHORT_SCHEMA_VERSION,
      provider: record.provider,
      route: record.route as WebEvidenceProviderRoute,
    }
  })
}

function sampleMode(
  mode: WebEvidenceCapabilityMode,
  percent: number,
  assignmentId: string,
): WebEvidenceCapabilityMode {
  if (mode === 'off' || percent <= 0) return 'off'
  if (percent >= 100) return mode
  return assignmentBucket(assignmentId) < percent ? mode : 'off'
}

/**
 * FNV-1a 32-bit over the assignment identity, folded into 0-99. Deterministic
 * across processes and restarts, so a canary cohort is a stable set of
 * assignments that configuration alone can widen, narrow, or roll back.
 */
function assignmentBucket(identity: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 100
}
