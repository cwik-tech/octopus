import type { McpJsonObject } from '../../contracts/mcp.js'
import type { RuntimeCapabilityRequestContext } from '../../contracts/runtime-capability-authority.js'
import type { AcquisitionQualityReport } from './acquisition-quality.js'
import {
  isAcquisitionCloudBrowserRuntime,
  type AcquisitionCloudBrowserRuntime,
} from '../browser/cloud-browser-types.js'

export const RESEARCH_WEB_TOOL_NAME = 'research_web'
export const RESEARCH_WEB_SERVER_ID = 'builtin.research-web'
export const RESEARCH_WEB_TOOL_CONTRACT_VERSION = 3 as const
export const LEGACY_SOURCE_OBSERVATION_RECEIPT_VERSION = 1 as const
/**
 * The version new observation receipts are written at.
 *
 * v3 was the first that could carry `direct-http-proxied`; v4 is the first that
 * may carry `managed-browser-proxied`; v5 is the first whose attempts may carry
 * `challengeType`, `browserRuntime` and `proxyRuntime`; v6 is the first that
 * may carry the `cloud-browser` method and its `cloudBrowserRuntime`. Nothing
 * else about the file changed, and every added field is optional, so v1 through
 * v5 receipts stay on disk exactly as written and stay readable; no migration
 * runs. Compare a
 * stored version against
 * `isSupportedSourceObservationReceiptVersion` and
 * `receiptStoresStructuredRepresentations` rather than against this constant,
 * or raising it silently demotes every receipt written at the previous one.
 */
export const SOURCE_OBSERVATION_RECEIPT_VERSION = 6 as const

export type SourceObservationReceiptVersion = 1 | 2 | 3 | 4 | 5 | 6

/** Every version a reader accepts, newest last. */
export const SUPPORTED_SOURCE_OBSERVATION_RECEIPT_VERSIONS: readonly SourceObservationReceiptVersion[] =
  Object.freeze([1, 2, 3, 4, 5, 6])

export function isSupportedSourceObservationReceiptVersion(
  value: unknown,
): value is SourceObservationReceiptVersion {
  return (
    typeof value === 'number' &&
    (SUPPORTED_SOURCE_OBSERVATION_RECEIPT_VERSIONS as readonly number[]).includes(
      value,
    )
  )
}

/** True for every version that stored a structured-representation package. */
export function receiptStoresStructuredRepresentations(
  version: SourceObservationReceiptVersion,
): boolean {
  return version >= 2
}
export const SOURCE_EXTRACTION_RECEIPT_VERSION = 1 as const
export const RESEARCH_WEB_TOOL_URL_ENV = 'PIPELINE_RESEARCH_WEB_TOOL_URL'

export type AcquisitionMethod =
  | 'direct-http'
  /** A direct read re-issued through the configured Webshare proxy. */
  | 'direct-http-proxied'
  | 'managed-browser'
  /** A managed-browser read re-issued through the configured Webshare proxy. */
  | 'managed-browser-proxied'
  | 'managed-reader'
  /** A read through a third-party cloud browser. See `cloud-browser-types`. */
  | 'cloud-browser'
  | 'document-parser'

export type AcquisitionAttemptOutcome =
  | 'usable'
  | 'insufficient'
  | 'challenge'
  | 'access-denied'
  | 'rate-limited'
  | 'not-found'
  | 'unsupported'
  | 'policy-denied'
  | 'timeout'
  | 'cancelled'
  | 'failed'

/**
 * What kind of wall a `challenge` outcome actually met.
 *
 * The top-level outcome stays `challenge` so every existing reader keeps
 * working; this names the thing that has to be answered. `unknown` is a real
 * answer, not a gap: a page that verifies a human without naming a mechanism
 * must not be counted as a solved-or-solvable CAPTCHA.
 */
export type AcquisitionChallengeType =
  | 'captcha'
  | 'browser-verification'
  | 'consent-wall'
  | 'login-wall'
  | 'unknown'

/**
 * The managed-browser build that produced one attempt.
 *
 * Non-secret by construction: a driver name, two version strings, and the two
 * launch choices under comparison. No endpoint, credential, argument list, or
 * page-derived value belongs here.
 */
export interface AcquisitionBrowserRuntime {
  readonly driver: 'puppeteer-core'
  readonly driverVersion: string
  readonly browserVersion: string
  readonly mode: 'headed' | 'headless'
  readonly launchProfile: BrowserLaunchProfile
}

/** The two local Chrome builds Phase 1 compares. */
export type BrowserLaunchProfile = 'stock' | 'automation-controlled-disabled'

/**
 * The proxy an attempt went through, as configured rather than as observed.
 *
 * `mode` is read from the configuration the application actually sets. `tier`
 * stays `unknown` because nothing in this repository establishes whether the
 * account's exits are datacenter or residential, and an inferred value would
 * make the bake-off compare a guess.
 */
export interface AcquisitionProxyRuntime {
  readonly provider: 'webshare'
  readonly mode: 'rotating' | 'sticky' | 'unknown'
  readonly tier: 'datacenter' | 'residential' | 'unknown'
}

/**
 * The guards every reader of a stored or transported attempt shares.
 *
 * Two readers validate attempts they did not write — the runtime observation
 * receipt reader and the research capability boundary — and both meet these
 * fields as external input. One definition keeps them from disagreeing about
 * what a valid `browserRuntime` is, which is how a malformed value becomes
 * typed data everything downstream then trusts.
 */
export function isAcquisitionChallengeType(
  value: unknown,
): value is AcquisitionChallengeType {
  return (
    value === 'captcha' ||
    value === 'browser-verification' ||
    value === 'consent-wall' ||
    value === 'login-wall' ||
    value === 'unknown'
  )
}

/**
 * Both nested guards are exact-key.
 *
 * The guarded object is the one that is kept, so a guard that checked only the
 * fields it knows about would let an extra key ride into a receipt on the same
 * object — which is exactly how a credential, an endpoint, or a slice of page
 * data would reach telemetry that is documented as non-secret by construction.
 */
const BROWSER_RUNTIME_KEYS: readonly string[] = [
  'driver',
  'driverVersion',
  'browserVersion',
  'mode',
  'launchProfile',
]

const PROXY_RUNTIME_KEYS: readonly string[] = ['provider', 'mode', 'tier']

export function isAcquisitionBrowserRuntime(
  value: unknown,
): value is AcquisitionBrowserRuntime {
  if (!isExactRecord(value, BROWSER_RUNTIME_KEYS)) return false
  return (
    value.driver === 'puppeteer-core' &&
    isNonEmptyString(value.driverVersion) &&
    isNonEmptyString(value.browserVersion) &&
    (value.mode === 'headed' || value.mode === 'headless') &&
    (value.launchProfile === 'stock' ||
      value.launchProfile === 'automation-controlled-disabled')
  )
}

export function isAcquisitionProxyRuntime(
  value: unknown,
): value is AcquisitionProxyRuntime {
  if (!isExactRecord(value, PROXY_RUNTIME_KEYS)) return false
  return (
    value.provider === 'webshare' &&
    (value.mode === 'rotating' ||
      value.mode === 'sticky' ||
      value.mode === 'unknown') &&
    (value.tier === 'datacenter' ||
      value.tier === 'residential' ||
      value.tier === 'unknown')
  )
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) return false
  const present = Object.keys(value)
  return (
    present.length === keys.length && present.every((key) => keys.includes(key))
  )
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0
}

export interface AcquisitionAttempt {
  readonly method: AcquisitionMethod
  readonly outcome: AcquisitionAttemptOutcome
  readonly startedAt: string
  readonly durationMs: number
  readonly provider?: string
  readonly httpStatus?: number
  readonly contentBytes?: number
  readonly reason?: string
  /** Present only when `outcome` is `challenge`. */
  readonly challengeType?: AcquisitionChallengeType
  /** Present on managed-browser attempts that reached a launched Chrome. */
  readonly browserRuntime?: AcquisitionBrowserRuntime
  /** Present on attempts issued through the configured proxy. */
  readonly proxyRuntime?: AcquisitionProxyRuntime
  /** Present on attempts issued through a third-party cloud browser. */
  readonly cloudBrowserRuntime?: AcquisitionCloudBrowserRuntime
}

/**
 * Every key an attempt may carry, and nothing else.
 *
 * One definition, shared by the two readers that meet a stored or transported
 * attempt as external input: the capability boundary and the observation-receipt
 * reader. They had grown separate copies that already disagreed about how strict
 * a timestamp had to be, which is precisely the drift a new optional field makes
 * dangerous — a value one reader refuses and the other accepts becomes typed
 * data everything downstream trusts.
 */
const ACQUISITION_ATTEMPT_KEYS: readonly string[] = [
  'method',
  'outcome',
  'startedAt',
  'durationMs',
  'provider',
  'httpStatus',
  'contentBytes',
  'reason',
  'challengeType',
  'browserRuntime',
  'proxyRuntime',
  'cloudBrowserRuntime',
]

/** The subset of `ACQUISITION_ATTEMPT_KEYS` declared optional on the type. */
const OPTIONAL_ACQUISITION_ATTEMPT_KEYS: readonly string[] = [
  'provider',
  'httpStatus',
  'contentBytes',
  'reason',
  'challengeType',
  'browserRuntime',
  'proxyRuntime',
  'cloudBrowserRuntime',
]

const ACQUISITION_METHOD_VALUES: readonly string[] = [
  'direct-http',
  'direct-http-proxied',
  'managed-browser',
  'managed-browser-proxied',
  'managed-reader',
  'cloud-browser',
  'document-parser',
]

const ACQUISITION_OUTCOME_VALUES: readonly string[] = [
  'usable',
  'insufficient',
  'challenge',
  'access-denied',
  'rate-limited',
  'not-found',
  'unsupported',
  'policy-denied',
  'timeout',
  'cancelled',
  'failed',
]

/**
 * Establishes an attempt read from disk or across a tool boundary.
 *
 * Exact-key, so an unknown field is a refusal rather than something quietly
 * ignored; the timestamp must be the canonical ISO form it was written in; and
 * every nested runtime is established by its own guard rather than assumed.
 */
export function isAcquisitionAttempt(value: unknown): value is AcquisitionAttempt {
  if (!isPlainRecord(value)) return false
  if (Object.keys(value).some((key) => !ACQUISITION_ATTEMPT_KEYS.includes(key))) {
    return false
  }
  if (
    typeof value.method !== 'string' ||
    !ACQUISITION_METHOD_VALUES.includes(value.method)
  ) {
    return false
  }
  if (
    typeof value.outcome !== 'string' ||
    !ACQUISITION_OUTCOME_VALUES.includes(value.outcome)
  ) {
    return false
  }
  if (
    typeof value.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    new Date(value.startedAt).toISOString() !== value.startedAt
  ) {
    return false
  }
  if (!Number.isSafeInteger(value.durationMs) || Number(value.durationMs) < 0) {
    return false
  }
  // `exactOptionalPropertyTypes` is on, so an optional property is either
  // absent or holds its declared type. An own key set to `undefined` is neither,
  // and admitting one would hand every later reader an object the type says
  // cannot exist.
  for (const field of OPTIONAL_ACQUISITION_ATTEMPT_KEYS) {
    if (field in value && value[field] === undefined) return false
  }
  for (const field of ['provider', 'reason'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return false
  }
  for (const field of ['httpStatus', 'contentBytes'] as const) {
    if (
      value[field] !== undefined &&
      (!Number.isSafeInteger(value[field]) || Number(value[field]) < 0)
    ) {
      return false
    }
  }
  // A cloud attempt always knows what it cost and what became of its session,
  // because the session client produces that record on every path including
  // failure. An attempt on any other rung never has one.
  if ((value.cloudBrowserRuntime !== undefined) !== (value.method === 'cloud-browser')) {
    return false
  }
  return (
    (value.challengeType === undefined ||
      isAcquisitionChallengeType(value.challengeType)) &&
    (value.browserRuntime === undefined ||
      isAcquisitionBrowserRuntime(value.browserRuntime)) &&
    (value.proxyRuntime === undefined ||
      isAcquisitionProxyRuntime(value.proxyRuntime)) &&
    (value.cloudBrowserRuntime === undefined ||
      isAcquisitionCloudBrowserRuntime(value.cloudBrowserRuntime))
  )
}

export interface SourceObservationReceipt {
  readonly schemaVersion: SourceObservationReceiptVersion
  readonly receiptId: string
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly activityScopeId: string
  readonly activityId: string
  readonly agentPath: string
  readonly method: AcquisitionMethod
  readonly provider?: string
  readonly requestedUrl: string
  readonly finalUrl: string
  readonly canonicalUrl: string
  readonly title?: string
  readonly mediaType: string
  readonly normalizedMediaType: 'text/markdown'
  readonly observedAt: string
  readonly contentRelativePath: string
  readonly contentSha256: string
  readonly contentBytes: number
  readonly quality: 'usable'
  readonly qualityReport: AcquisitionQualityReport
  readonly sourceMetadata: SourceArtifactReference
  readonly representations: SourceArtifactReference
  readonly rawSource?: SourceArtifactReference & {
    readonly mediaType: string
    readonly truncated?: boolean
  }
  readonly rawOmissionReason?: string
  readonly attempts: readonly AcquisitionAttempt[]
}

export interface SourceArtifactReference {
  readonly relativePath: string
  readonly sha256: string
  readonly bytes: number
}

export interface SourceObservationReceiptView {
  readonly schemaVersion: SourceObservationReceiptVersion
  readonly receiptId: string
  readonly activityId: string
  readonly activityScopeId: string
  readonly relativePath: string
  readonly method: AcquisitionMethod
  readonly provider?: string
  readonly requestedUrl: string
  readonly finalUrl: string
  readonly canonicalUrl: string
  readonly observedAt: string
  readonly contentRelativePath: string
  readonly contentSha256: string
  readonly contentBytes: number
  readonly quality: AcquisitionQualityReport['status']
  readonly representationsRelativePath?: string
  readonly rawSourceRelativePath?: string
}

export type ResearchWebAction =
  | 'search'
  | 'acquire'
  | 'extract'
  | 'read_content'
  | 'search_content'

export type ExtractionMode = 'best-effort' | 'strict'

export type ExtractedFieldStatus =
  | 'present'
  | 'missing'
  | 'incompatible'
  | 'ambiguous'
  | 'conflicting'
  | 'unsupported'
  | 'invalid_evidence'

export interface ExtractionFieldProvenance {
  readonly sourceReceiptId: string
  readonly representationId: string
  readonly pointer?: string
  readonly quote?: string
  readonly method: 'deterministic' | 'model'
}

export interface ExtractedFieldResult {
  readonly path: string
  readonly status: ExtractedFieldStatus
  readonly value?: unknown
  readonly rawValue?: unknown
  readonly confidence?: number
  readonly provenance: readonly ExtractionFieldProvenance[]
  readonly message?: string
}

export interface SourceExtractionResult {
  readonly schemaVersion: 1
  readonly extractionId: string
  readonly sourceReceiptId: string
  readonly sourceContentSha256: string
  readonly schemaSha256: string
  readonly mode: ExtractionMode
  readonly complete: boolean
  readonly requirementsMet: boolean
  readonly data: Readonly<Record<string, unknown>>
  readonly fields: readonly ExtractedFieldResult[]
  readonly unmappedData: readonly {
    readonly representationId: string
    readonly pointer: string
    readonly value: unknown
  }[]
  readonly methodsAttempted: readonly ('deterministic' | 'model' | 'model-repair')[]
  readonly warnings: readonly string[]
}

export interface SourceExtractionReceipt {
  readonly schemaVersion: typeof SOURCE_EXTRACTION_RECEIPT_VERSION
  readonly extractionId: string
  readonly sourceReceiptId: string
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly activityScopeId: string
  readonly agentPath: string
  readonly sourceContentSha256: string
  readonly schemaSha256: string
  readonly request: SourceArtifactReference
  readonly result: SourceArtifactReference
  readonly provider?: string
  readonly model?: string
  readonly createdAt: string
  readonly durationMs: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cost: number
  readonly costTracked: boolean
  readonly repairCount: number
}

export interface SourceExtractionView {
  readonly extractionId: string
  readonly resultRelativePath: string
  readonly receiptRelativePath: string
  readonly complete: boolean
  readonly requirementsMet: boolean
  readonly data: Readonly<Record<string, unknown>>
  readonly fields: readonly ExtractedFieldResult[]
  readonly methodsAttempted: SourceExtractionResult['methodsAttempted']
  readonly warnings: readonly string[]
}

export interface ResearchWebToolInput {
  readonly action: ResearchWebAction
  readonly query?: string
  readonly url?: string
  readonly contentId?: string
  readonly chunkIndex?: number
  readonly searchText?: string
  readonly schema?: Readonly<Record<string, unknown>>
  readonly requiredFields?: readonly string[]
  readonly mode?: ExtractionMode
  readonly extractionInstructions?: string
  readonly maximumResults?: number
  readonly includeDomains?: readonly string[]
  readonly excludeDomains?: readonly string[]
  readonly publishedAfter?: string
  readonly publishedBefore?: string
  readonly sourceValue?: 'replaceable' | 'important' | 'unique-primary'
  readonly allowBrowserFallback?: boolean
  readonly allowManagedReaderFallback?: boolean
}

/**
 * Newest research activities retained per session.
 *
 * The journal is a bounded diagnostic window, not a complete record: once a
 * session exceeds this, the oldest entries are dropped. Any reader making an
 * "every call did X" claim must first check whether it is looking at a full
 * history or only the tail.
 */
export const MAX_RESEARCH_ACTIVITY_PER_SESSION = 300

export interface ResearchSearchResult {
  readonly title: string
  readonly url: string
  readonly canonicalUrl: string
  readonly snippet?: string
  readonly publishedAt?: string
  readonly provider: string
  readonly score: number
}

export interface AcquisitionContentView {
  readonly id: string
  readonly sizeBytes: number
  readonly chunkCount: number
  readonly currentChunk?: number
  readonly text?: string
}

export interface AcquisitionContentMatchView {
  readonly chunkIndex: number
  readonly snippet: string
}

export type ResearchWebErrorCode =
  | 'invalid_request'
  | 'not_configured'
  | 'domain_denied'
  | 'access_challenge'
  | 'access_denied'
  | 'rate_limited'
  | 'not_found'
  | 'empty_content'
  | 'unsupported_content'
  | 'source_integrity'
  | 'browser_unavailable'
  | 'budget_exhausted'
  | 'timeout'
  | 'cancelled'
  | 'internal'

export interface ResearchWebToolOutput {
  readonly ok: boolean
  readonly action: ResearchWebAction
  readonly results?: readonly ResearchSearchResult[]
  readonly requestedUrl?: string
  readonly finalUrl?: string
  readonly canonicalUrl?: string
  readonly title?: string
  readonly mediaType?: string
  readonly method?: AcquisitionMethod
  readonly provider?: string
  readonly text?: string
  readonly content?: AcquisitionContentView
  readonly matches?: readonly AcquisitionContentMatchView[]
  readonly observationReceipt?: SourceObservationReceiptView
  readonly extraction?: SourceExtractionView
  readonly attempts?: readonly AcquisitionAttempt[]
  readonly error?: {
    readonly code: ResearchWebErrorCode
    readonly message: string
    readonly retryable: boolean
  }
}

export interface ResearchWebToolRequest {
  readonly version: typeof RESEARCH_WEB_TOOL_CONTRACT_VERSION
  readonly context: RuntimeCapabilityRequestContext
  readonly activityScopeId?: string
  readonly toolCallId: string
  readonly input: ResearchWebToolInput
}

export interface ResearchWebToolResponse {
  readonly version: typeof RESEARCH_WEB_TOOL_CONTRACT_VERSION
  readonly output: ResearchWebToolOutput
}

export function researchWebToolInputSchema(): McpJsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'acquire', 'extract', 'read_content', 'search_content'],
      },
      query: { type: 'string', minLength: 1, maxLength: 2_000 },
      url: { type: 'string', minLength: 1, maxLength: 8_192 },
      contentId: { type: 'string', minLength: 1, maxLength: 256 },
      chunkIndex: { type: 'integer', minimum: 0 },
      searchText: { type: 'string', minLength: 1, maxLength: 1_000 },
      schema: { type: 'object' },
      requiredFields: {
        type: 'array',
        maxItems: 100,
        items: { type: 'string', minLength: 1, maxLength: 512 },
      },
      mode: { type: 'string', enum: ['best-effort', 'strict'] },
      extractionInstructions: { type: 'string', minLength: 1, maxLength: 4_000 },
      maximumResults: { type: 'integer', minimum: 1, maximum: 20 },
      includeDomains: {
        type: 'array',
        maxItems: 20,
        items: { type: 'string', minLength: 1, maxLength: 253 },
      },
      excludeDomains: {
        type: 'array',
        maxItems: 20,
        items: { type: 'string', minLength: 1, maxLength: 253 },
      },
      publishedAfter: { type: 'string', maxLength: 64 },
      publishedBefore: { type: 'string', maxLength: 64 },
      sourceValue: {
        type: 'string',
        enum: ['replaceable', 'important', 'unique-primary'],
        description: [
          'How much this one source is worth, which decides how far acquisition',
          'may escalate for it. `replaceable` is the exploratory setting for',
          'discovery, index, and browse pages: acquisition stays on direct HTTP and',
          'never spends browser or cloud budget, because an equally good substitute',
          'is expected. Raise a source to `important` or `unique-primary` only when a',
          'named claim still lacks a required field and no adequate substitute source',
          'is available; those settings let acquisition escalate to managed Chrome and',
          'the paid cloud rung. Stop escalating once that field is supported.',
        ].join(' '),
      },
      allowBrowserFallback: { type: 'boolean' },
      allowManagedReaderFallback: { type: 'boolean' },
    },
  }
}
