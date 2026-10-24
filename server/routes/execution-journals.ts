import type * as http from 'node:http'
import type { URL } from 'node:url'

import type { RouteCredentialScope } from '../../contracts/route-credentials.js'
import type {
  OperatorResolutionDecision,
  OperatorSuppliedResult,
} from '../../contracts/durable-dispatch.js'
import {
  ExecutionJournalAuthorizationError,
  type ExecutionJournalInspectionService,
  type ExecutionJournalResolutionReport,
} from '../../services/execution-journal-inspection.js'
import type { ConversationJournalInspectionService } from '../../services/conversation-journal-inspection.js'
import { decodeSafePathSegment } from '../../core/path-safety.js'
import { ApiRequestError, readJsonBody, writeJson } from '../http.js'

/**
 * Operator surface for the durable execution journal (ADR §15, ADR §7).
 *
 * Recovery leaves dispatches an operator has to act on — blocked outcomes that
 * cannot be proven, or committed effects awaiting reconciliation. Nothing else
 * can find them after a restart, because the dispatch registry only holds
 * journals it happened to open. The `GET` shapes are derived from the
 * canonical journal and provision nothing.
 *
 * `POST .../resolutions` is the one write, and it changes what the *next*
 * dispatch on that identity does. It records only the decision, the reason and
 * the dispatch it concerns: the principal is assembled server-side from the
 * credential the transport resolved, never from this body.
 */

/** A resolution body may not be large; it carries a decision, not a payload. */
const MAX_RESOLUTION_BODY_BYTES = 256 * 1024

const RESOLUTION_SEGMENT = 'resolutions'
const CONVERSATION_SEGMENT = 'conversation'
const RUN_SESSION_SEGMENT = 'run-session'

interface ExecutionJournalRouteParams {
  req: http.IncomingMessage
  res: http.ServerResponse
  url: URL
  service?: ExecutionJournalInspectionService
  conversations?: ConversationJournalInspectionService
  credentialScope?: RouteCredentialScope
}

export async function handleExecutionJournalRoutes(
  params: ExecutionJournalRouteParams,
): Promise<boolean> {
  const segments = params.url.pathname.split('/').filter(Boolean)
  if (segments[0] !== 'execution-journals') return false
  const isResolution =
    segments.length === 5 && segments[4] === RESOLUTION_SEGMENT
  // Only the shapes this route declares in the inventory are its own; any
  // other is left for a later route rather than answered 404 here.
  if (segments.length !== 1 && segments.length !== 4 && !isResolution) {
    return false
  }
  params.res.setHeader('cache-control', 'no-store')

  // A conversation address is discriminated by a literal segment rather than
  // by reusing the three-segment assignment address for two meanings. Session
  // ids are uuids, so `conversation` can never be one.
  if (segments.length === 4 && segments[1] === CONVERSATION_SEGMENT) {
    return handleConversationInspection(params, segments)
  }

  // The method is a property of the request, not of the server's
  // configuration, so it is decided before configuration is consulted.
  const expectedMethod = isResolution ? 'POST' : 'GET'
  if (params.req.method !== expectedMethod) {
    writeJson(params.res, 405, { error: 'Method not allowed' })
    return true
  }
  if (!params.service) {
    writeJson(params.res, 501, {
      error: 'Execution journal inspection is not configured on this server',
    })
    return true
  }

  try {
    if (segments.length === 1) {
      writeJson(params.res, 200, {
        journals: (await params.service.listJournals()).map((entry) => entry.scope),
      })
      return true
    }
    // `pathname` stays percent-encoded, so each segment is decoded exactly
    // once after validation, as every comparable route does.
    const [, encodedSession, encodedRun, encodedAssignment] = segments
    const sessionId = encodedSession ? decodeSafePathSegment(encodedSession) : null
    const runId = encodedRun ? decodeSafePathSegment(encodedRun) : null
    const assignmentId = encodedAssignment
      ? decodeSafePathSegment(encodedAssignment)
      : null
    if (!sessionId || !runId || !assignmentId) {
      writeJson(params.res, 404, { error: 'Not found' })
      return true
    }
    const scope = { sessionId, runId, assignmentId }

    if (isResolution) {
      const body = await readJsonBody(params.req, MAX_RESOLUTION_BODY_BYTES)
      const request = parseResolutionRequest(body)
      const report = await params.service.resolveDispatch({
        scope,
        dispatchId: request.dispatchId,
        decision: request.decision,
        reason: request.reason,
        ...(request.result === undefined ? {} : { result: request.result }),
        ...(params.credentialScope === undefined
          ? {}
          : { credentialScope: params.credentialScope }),
      })
      writeJson(params.res, statusForResolution(report.kind), report)
      return true
    }

    const report = await params.service.inspect(scope)
    writeJson(params.res, statusForReport(report.kind), report)
    return true
  } catch (error) {
    if (error instanceof ExecutionJournalAuthorizationError) {
      writeJson(params.res, 403, { error: 'Forbidden' })
      return true
    }
    throw error
  }
}

interface ResolutionRequest {
  readonly dispatchId: string
  readonly decision: OperatorResolutionDecision
  readonly reason: string
  readonly result?: OperatorSuppliedResult
}

/**
 * Narrow the request to the three fields the journal records, and nothing else.
 *
 * Everything a caller may say about itself is dropped here rather than later:
 * a `principal` in this body is not rejected as an error, it simply has no way
 * through, because the field it would fill does not come from the request.
 */
function parseResolutionRequest(body: unknown): ResolutionRequest {
  if (!isJsonRecord(body)) {
    throw new ApiRequestError('Request body must be a JSON object', 400)
  }
  const dispatchId = body['dispatchId']
  if (typeof dispatchId !== 'string' || dispatchId === '') {
    throw new ApiRequestError('dispatchId is required', 400)
  }
  const decision = body['decision']
  if (
    decision !== 'not_committed' &&
    decision !== 'committed' &&
    decision !== 'abandon'
  ) {
    throw new ApiRequestError(
      "decision must be one of 'not_committed', 'committed', 'abandon'",
      400,
    )
  }
  const reason = body['reason']
  if (typeof reason !== 'string' || reason.trim() === '') {
    // A resolution with no stated reason is an audit record that explains
    // nothing to whoever reads it next.
    throw new ApiRequestError('reason is required', 400)
  }
  const result = parseSuppliedResult(body['result'])
  return {
    dispatchId,
    decision,
    reason,
    ...(result === undefined ? {} : { result }),
  }
}

function parseSuppliedResult(value: unknown): OperatorSuppliedResult | undefined {
  if (value === undefined) return undefined
  if (!isJsonRecord(value)) {
    throw new ApiRequestError('result must be a JSON object', 400)
  }
  if (value['kind'] === 'inline') {
    return { kind: 'inline', value: value['value'] }
  }
  if (value['kind'] === 'receipt') {
    return { kind: 'receipt', receipt: value['receipt'] }
  }
  throw new ApiRequestError("result.kind must be 'inline' or 'receipt'", 400)
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Each failure mode is distinguishable to the caller, never collapsed. */
function statusForReport(kind: string): number {
  switch (kind) {
    case 'report':
      return 200
    case 'not_found':
      return 404
    case 'identity_mismatch':
      return 409
    case 'unsupported_version':
      return 501
    default:
      return 422
  }
}

/**
 * A refused resolution is not a server fault and not a missing resource: the
 * operator asked for something the dispatch's own state does not admit, and
 * the answer has to say which.
 */
function statusForResolution(
  kind: ExecutionJournalResolutionReport['kind'],
): number {
  switch (kind) {
    case 'recorded':
      return 200
    case 'not_found':
      return 404
    case 'not_resolvable':
    case 'conflict':
      return 409
    case 'invalid_result':
      return 400
    case 'journal_unavailable':
      return 503
    case 'not_configured':
      return 501
  }
}

/**
 * A sanitized report for one conversation's activity journals.
 *
 * Read-only, bounded, `no-store`, and content-free: the report is built from
 * lifecycle payloads, and there is no query that makes it return transcript
 * text. Reading the conversation itself is a separate content route with its
 * own authorization.
 */
async function handleConversationInspection(
  params: ExecutionJournalRouteParams,
  segments: string[],
): Promise<boolean> {
  if (params.req.method !== 'GET') {
    writeJson(params.res, 405, { error: 'Method not allowed' })
    return true
  }
  if (segments[2] !== RUN_SESSION_SEGMENT) {
    writeJson(params.res, 404, { kind: 'not_found' })
    return true
  }
  const rawSessionId = segments[3]
  const sessionId =
    rawSessionId === undefined ? undefined : decodeSafePathSegment(rawSessionId)
  if (!sessionId) {
    writeJson(params.res, 400, { error: 'Invalid session id' })
    return true
  }
  if (!params.conversations) {
    writeJson(params.res, 503, { kind: 'unavailable' })
    return true
  }

  const limitRaw = params.url.searchParams.get('limit')
  const limit = limitRaw === null ? undefined : Number(limitRaw)
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    writeJson(params.res, 400, { error: 'Invalid limit' })
    return true
  }

  const cursor = params.url.searchParams.get('cursor')
  let outcome
  try {
    outcome = await params.conversations.inspectRunSession({
      sessionId,
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === null || cursor === '' ? {} : { cursor }),
      ...(params.credentialScope === undefined
        ? {}
        : { credentialScope: params.credentialScope }),
    })
  } catch (error) {
    if (error instanceof ExecutionJournalAuthorizationError) {
      // The same body a refused caller gets for a conversation that does not
      // exist, because telling those two apart is the fact being withheld.
      writeJson(params.res, 403, { error: 'Forbidden' })
      return true
    }
    throw error
  }
  if (outcome.kind === 'not_found') {
    writeJson(params.res, 404, { kind: 'not_found' })
    return true
  }
  if (outcome.kind === 'unavailable') {
    writeJson(params.res, 503, { kind: 'unavailable' })
    return true
  }
  writeJson(params.res, 200, outcome.report)
  return true
}
