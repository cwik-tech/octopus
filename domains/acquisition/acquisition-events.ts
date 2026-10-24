import { createHash } from 'node:crypto'

import type { McpBrokerRequestContext } from '../../contracts/mcp.js'
import { publishEngineEvent } from '../runtime/runtime-events.js'
import type {
  AcquisitionAttempt,
  ResearchWebErrorCode,
  ResearchWebToolOutput,
} from './acquisition-types.js'

export const RESEARCH_ACQUISITION_COMPLETED_EVENT_TYPE =
  'research.acquisition.completed' as const

export const SEARCH_CAPABILITY_BLOCKED_EVENT_TYPE =
  'research.search_capability.blocked' as const

export type ResearchAcquisitionIssueKind =
  | 'none'
  | 'blocked'
  | 'rate-limited'
  | 'limited'
  | 'failed'
  | 'recovered'
  | 'ignored'

export function publishResearchAcquisitionCompletedEvent(input: {
  readonly assignmentPath: string
  readonly context: McpBrokerRequestContext & {
    readonly activityScopeId: string
  }
  readonly activityId: string
  readonly toolCallId: string
  readonly sourceUrl: string
  readonly output: ResearchWebToolOutput
  readonly occurredAt: string
}): void {
  const sourceUrl =
    input.output.canonicalUrl ??
    input.output.finalUrl ??
    input.output.requestedUrl ??
    input.sourceUrl
  if (!sourceUrl.trim()) return

  const usable = Boolean(
    input.output.ok &&
    input.output.action === 'acquire' &&
    input.output.observationReceipt,
  )
  const issueKind = classifyAcquisitionIssue(
    input.output.attempts ?? [],
    input.output.error?.code,
    usable,
  )

  publishEngineEvent(input.assignmentPath, {
    timestamp: input.occurredAt,
    category: 'tool',
    type: RESEARCH_ACQUISITION_COMPLETED_EVENT_TYPE,
    run_id: input.context.assignmentId,
    root_run_id: input.context.runId,
    assignment_path: input.assignmentPath,
    payload: {
      activity_id: input.activityId,
      activity_scope_id: input.context.activityScopeId,
      tool_call_id: input.toolCallId,
      source_key: createHash('sha256').update(sourceUrl).digest('hex'),
      usable,
      issue_kind: issueKind,
      /**
       * Which transport each rung used, in order, beside its outcome.
       *
       * Additive: `attempt_outcomes` keeps its meaning and position, and a
       * consumer that does not know this field is unaffected. Without it an
       * operator cannot tell a denial recovered through the Webshare proxy
       * from one recovered by the managed browser.
       */
      attempt_methods: (input.output.attempts ?? []).map(
        (attempt) => attempt.method,
      ),
      attempt_outcomes: (input.output.attempts ?? []).map(
        (attempt) => attempt.outcome,
      ),
      http_statuses: (input.output.attempts ?? []).flatMap((attempt) =>
        attempt.httpStatus === undefined ? [] : [attempt.httpStatus]),
      ...(input.output.error?.code
        ? { error_code: input.output.error.code }
        : {}),
      emitter_name: 'research-web-tool-service',
    },
  })
}

/**
 * Announce that a discovery-requiring run had no discovery path at all. This is
 * an operator action, not a source problem, so it carries its own event type —
 * distinct from per-source acquisition issues.
 *
 * The recorded failure codes and their cause travel with it, derived by the
 * caller that owns the discovery signal. Publishing a fixed "add an API key"
 * remediation sent operators to buy a credential for an unreadable settings
 * file, an empty web, or an exhausted budget.
 */
export function publishSearchCapabilityBlockedEvent(input: {
  readonly assignmentPath: string
  readonly sessionId: string
  readonly rootSessionId?: string
  readonly laneIds: readonly string[]
  readonly providerPriority: readonly string[]
  /** Recorded discovery failure codes, deduplicated by the caller. */
  readonly failureCodes: readonly string[]
  /** One sentence naming why every discovery attempt produced nothing. */
  readonly cause: string
  /** The operator action matched to those codes. */
  readonly remediation: string
}): void {
  publishEngineEvent(input.assignmentPath, {
    timestamp: new Date().toISOString(),
    category: 'tool',
    type: SEARCH_CAPABILITY_BLOCKED_EVENT_TYPE,
    run_id: input.sessionId,
    ...(input.rootSessionId ? { root_run_id: input.rootSessionId } : {}),
    assignment_path: input.assignmentPath,
    payload: {
      capability: 'search',
      lane_ids: [...input.laneIds],
      provider_priority: [...input.providerPriority],
      failure_codes: [...input.failureCodes],
      cause: input.cause,
      remediation: input.remediation,
      emitter_name: 'pipeline-engine',
    },
  })
}

function classifyAcquisitionIssue(
  attempts: readonly AcquisitionAttempt[],
  errorCode: ResearchWebErrorCode | undefined,
  usable: boolean,
): ResearchAcquisitionIssueKind {
  if (usable) {
    return hasRecoveredIssue(attempts) ? 'recovered' : 'none'
  }

  const finalAttempt = attempts.at(-1)
  if (finalAttempt) {
    switch (finalAttempt.outcome) {
      case 'challenge':
      case 'access-denied':
      case 'policy-denied':
        return 'blocked'
      case 'rate-limited':
        return 'rate-limited'
      case 'insufficient':
      case 'unsupported':
        return 'limited'
      case 'not-found':
      case 'timeout':
      case 'failed':
        return 'failed'
      case 'cancelled':
      case 'usable':
        return 'ignored'
    }
  }

  switch (errorCode) {
    case 'access_challenge':
    case 'access_denied':
      return 'blocked'
    case 'rate_limited':
      return 'rate-limited'
    case 'empty_content':
    case 'unsupported_content':
    case 'source_integrity':
      return 'limited'
    case 'not_found':
    case 'browser_unavailable':
    case 'timeout':
    case 'internal':
      return 'failed'
    case 'invalid_request':
    case 'not_configured':
    case 'domain_denied':
    case 'budget_exhausted':
    case 'cancelled':
    case undefined:
      return 'ignored'
  }
}

function hasRecoveredIssue(
  attempts: readonly AcquisitionAttempt[],
): boolean {
  if (
    attempts.length === 2 &&
    attempts[0]?.method === 'direct-http' &&
    attempts[0].outcome === 'insufficient' &&
    attempts[1]?.method === 'document-parser' &&
    attempts[1].outcome === 'usable'
  ) {
    return false
  }
  return attempts.some((attempt) => attempt.outcome !== 'usable')
}
