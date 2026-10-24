import {
  challengeMessage,
  classifyChallenge,
} from '../browser/browser-page-classifier.js'
import type {
  AcquisitionAttemptOutcome,
  AcquisitionChallengeType,
  ResearchWebErrorCode,
} from './acquisition-types.js'

export interface AcquisitionQualityInput {
  readonly title?: string
  readonly url: string
  readonly text: string
  readonly httpStatus?: number
  readonly mediaType: string
  readonly structuredRepresentationCount?: number
  readonly clientRenderedShell?: boolean
}

export interface AcquisitionQualityReport {
  readonly status: 'usable' | 'partial' | 'unusable'
  readonly score: number
  readonly signals: readonly string[]
  readonly readableCharacters: number
  readonly uniqueWordRatio: number
  readonly structuredRepresentationCount: number
}

export type AcquisitionQualityDecision =
  | {
      readonly usable: true
      readonly report: AcquisitionQualityReport
    }
  | {
      readonly usable: false
      readonly outcome: AcquisitionAttemptOutcome
      readonly code: ResearchWebErrorCode
      readonly reason: string
      readonly terminal: boolean
      readonly report: AcquisitionQualityReport
      /** Present only when `outcome` is `challenge`. */
      readonly challengeType?: AcquisitionChallengeType
    }

const ACCESS_PATTERNS = [
  /\baccess denied\b/u,
  /\bpermission denied\b/u,
  /\byou (?:must|need to) (?:sign|log) in\b/u,
  /\bsubscription required\b/u,
]

const ERROR_PAGE_PATTERNS = [
  /\bpage not found\b/u,
  /\bthe page you requested (?:does not|doesn't) exist\b/u,
  /\binternal server error\b/u,
]

const ERROR_PAGE_LEADING_CHARACTERS = 1_000

export function evaluateAcquisitionQuality(
  input: AcquisitionQualityInput,
): AcquisitionQualityDecision {
  const normalized = `${input.title ?? ''}\n${input.text}`
    .toLocaleLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
  const report = qualityReport(input, normalized)

  // The gate and the taxonomy are shared with managed Chrome, so a rung cannot
  // disagree with another rung about what a wall is.
  const challengeType = classifyChallenge(normalized, {
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
  })
  if (challengeType) {
    return rejected(
      'challenge',
      'access_challenge',
      // Named by the wall it met, from the same table managed Chrome uses. A
      // paywall reported as an anti-bot page sends the agent to retry where it
      // should look elsewhere.
      challengeMessage(challengeType),
      true,
      unusableReport(report, 'challenge-page'),
      challengeType,
    )
  }
  if (input.httpStatus === 429) {
    return rejected(
      'rate-limited',
      'rate_limited',
      'The source rate-limited acquisition. Use another source.',
      true,
      unusableReport(report, 'rate-limited'),
    )
  }
  if (
    input.httpStatus === 401 ||
    input.httpStatus === 403 ||
    ACCESS_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return rejected(
      'access-denied',
      'access_denied',
      'The source requires authorization or denied access. Use another source.',
      true,
      unusableReport(report, 'access-denied'),
    )
  }
  if (
    input.httpStatus === 404 ||
    input.httpStatus === 410 ||
    matchesErrorPage(input)
  ) {
    return rejected(
      'not-found',
      'not_found',
      'The source is missing or returned an error page. Use another source.',
      true,
      unusableReport(report, 'missing-or-error-page'),
    )
  }
  if (input.httpStatus !== undefined && input.httpStatus >= 500) {
    return rejected(
      'failed',
      'internal',
      `The source returned HTTP ${input.httpStatus}.`,
      false,
      unusableReport(report, 'server-error'),
    )
  }
  if (!input.text.trim()) {
    return rejected(
      'insufficient',
      'empty_content',
      'The source produced no extractable evidence.',
      false,
      unusableReport(report, 'empty-content'),
    )
  }
  if (
    input.clientRenderedShell &&
    report.structuredRepresentationCount === 0
  ) {
    return rejected(
      'insufficient',
      'empty_content',
      'The page requires client rendering before it contains usable evidence.',
      false,
      unusableReport(report, 'client-rendering-required'),
    )
  }
  if (
    input.mediaType.includes('html') &&
    normalized.length < 160 &&
    report.structuredRepresentationCount === 0
  ) {
    return rejected(
      'insufficient',
      'empty_content',
      'The page did not contain enough readable content to support evidence.',
      false,
      unusableReport(report, 'insufficient-readable-content'),
    )
  }
  return { usable: true, report }
}

function matchesErrorPage(input: AcquisitionQualityInput): boolean {
  const title = (input.title ?? '').toLocaleLowerCase().replace(/\s+/gu, ' ').trim()
  const leadingText = input.text
    .slice(0, ERROR_PAGE_LEADING_CHARACTERS)
    .toLocaleLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
  return ERROR_PAGE_PATTERNS.some(
    (pattern) => pattern.test(title) || pattern.test(leadingText),
  )
}

function rejected(
  outcome: AcquisitionAttemptOutcome,
  code: ResearchWebErrorCode,
  reason: string,
  terminal: boolean,
  report: AcquisitionQualityReport,
  challengeType?: AcquisitionChallengeType,
): Extract<AcquisitionQualityDecision, { readonly usable: false }> {
  return {
    usable: false,
    outcome,
    code,
    reason,
    terminal,
    report,
    ...(challengeType ? { challengeType } : {}),
  }
}

function qualityReport(
  input: AcquisitionQualityInput,
  normalized: string,
): AcquisitionQualityReport {
  const words = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []
  const uniqueWordRatio = words.length === 0
    ? 0
    : new Set(words.map((word) => word.toLocaleLowerCase())).size / words.length
  const structuredRepresentationCount = Math.max(
    0,
    Math.floor(input.structuredRepresentationCount ?? 0),
  )
  const signals: string[] = []
  let score = 100
  if (normalized.length < 400) {
    score -= 30
    signals.push('short-readable-content')
  }
  if (words.length >= 20 && uniqueWordRatio < 0.25) {
    score -= 25
    signals.push('high-repetition')
  }
  if (
    input.mediaType.includes('html') &&
    (
      input.clientRenderedShell ||
      /(?:<div id=["'](?:root|app)["'][^>]*>\s*<\/div>|javascript required)/iu.test(
        input.text,
      )
    )
  ) {
    score -= 35
    signals.push('client-rendering-shell')
  }
  if (structuredRepresentationCount > 0) {
    score += 15
    signals.push('structured-data-available')
  }
  const boundedScore = Math.max(0, Math.min(100, score))
  return {
    status: boundedScore >= 70 ? 'usable' : 'partial',
    score: boundedScore,
    signals,
    readableCharacters: normalized.length,
    uniqueWordRatio: Number(uniqueWordRatio.toFixed(4)),
    structuredRepresentationCount,
  }
}

function unusableReport(
  report: AcquisitionQualityReport,
  signal: string,
): AcquisitionQualityReport {
  return {
    ...report,
    status: 'unusable',
    score: 0,
    signals: [...report.signals, signal],
  }
}
