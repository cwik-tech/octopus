/**
 * The HTTP transport the broker tool routes share: who may call, how the body
 * is read, and how each outcome is answered.
 *
 * What a route authorizes and dispatches stays in the route file, passed in as
 * `run`, so the capability id, source, and authority a route uses are read
 * where the route is defined.
 */
import type * as http from 'node:http'
import type * as z from 'zod/v4'

import { statusForRuntimeCapabilityAuthorityError } from '../services/runtime-capability-authority.js'
import { ApiRequestError, readJsonBody, writeJson } from './http.js'
import {
  reportToolRouteFailureToStderr,
  toolRouteFailureDiagnostic,
  type ToolRouteCorrelation,
  type ToolRouteFailureReporter,
  type ToolRouteId,
} from './tool-route-failure.js'

/**
 * Marks the response no-store, then answers a request that is not a POST with
 * 405, and a request carrying any Origin header, loopback included, with 403.
 * Returns false once it has answered, true when the request may proceed.
 *
 * {@link serveBrokerToolRoute} calls this itself. A capability route that
 * does not use it calls this first.
 */
export function admitCapabilityPost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  res.setHeader('cache-control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST')
    writeJson(res, 405, { error: 'Method not allowed' })
    return false
  }
  if (req.headers.origin !== undefined) {
    writeJson(res, 403, { error: 'Origin not allowed' })
    return false
  }
  return true
}

export interface BrokerToolRoutePolicy<Request> {
  readonly tool: ToolRouteId
  readonly maxRequestBytes: number
  readonly schema: z.ZodType<Request>
  /** The whole error text for each refusal. A caller never sees an error's own message. */
  readonly messages: {
    /** Unreadable, oversized, or schema-invalid body. */
    readonly invalid: string
    /** The runtime capability authority refused the caller. */
    readonly denied: string
    /** Anything else. */
    readonly failed: string
  }
  /** The tool contract version echoed in the 200 envelope. */
  readonly version: number
  /** The ids an unexpected failure is reported by, once the request has parsed. */
  readonly correlate: (request: Request) => ToolRouteCorrelation
  /**
   * Authorizes and dispatches one parsed request, and returns the tool output.
   * See {@link serveBrokerToolRoute} for when `signal` aborts.
   */
  readonly run: (request: Request, signal: AbortSignal) => Promise<unknown>
  /** Where an unexpected failure is recorded. Defaults to one JSON line on stderr. */
  readonly reportFailure?: ToolRouteFailureReporter | undefined
}

/**
 * Admits the request with {@link admitCapabilityPost}, then reads and parses
 * it, runs it, and answers 200 with `{ version, output }`, or the refusal the
 * failure calls for.
 */
export async function serveBrokerToolRoute<Request>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  policy: BrokerToolRoutePolicy<Request>,
): Promise<void> {
  if (!admitCapabilityPost(req, res)) return
  // Node emits 'aborted' only while the request body is incomplete: the
  // request errors or the client goes away before the body has been read.
  // A client that disconnects after the body has been read does not abort
  // this signal, so it does not cancel the tool call.
  const controller = new AbortController()
  const abort = () => controller.abort()
  req.once('aborted', abort)
  let correlation: ToolRouteCorrelation | undefined
  try {
    const parsed = policy.schema.safeParse(
      await readJsonBody(req, policy.maxRequestBytes),
    )
    if (!parsed.success) {
      throw new ApiRequestError(policy.messages.invalid, 400)
    }
    const request = parsed.data
    correlation = policy.correlate(request)
    const output = await policy.run(request, controller.signal)
    if (!res.destroyed) {
      writeJson(res, 200, { version: policy.version, output })
    }
  } catch (error) {
    if (res.destroyed) return
    if (error instanceof ApiRequestError) {
      writeJson(res, error.statusCode, { error: policy.messages.invalid })
      return
    }
    const authorityStatus = statusForRuntimeCapabilityAuthorityError(error)
    if (authorityStatus) {
      writeJson(res, authorityStatus, { error: policy.messages.denied })
      return
    }
    // Nobody's bad request: the dispatcher, the journal, or a bug. The log
    // gets the ids to find the call by, never the error's text.
    const reportFailure = policy.reportFailure ?? reportToolRouteFailureToStderr
    reportFailure(toolRouteFailureDiagnostic(policy.tool, error, correlation))
    writeJson(res, 500, { error: policy.messages.failed })
  } finally {
    req.off('aborted', abort)
  }
}
