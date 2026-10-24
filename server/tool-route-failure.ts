/**
 * What a tool route records when it fails for a reason that is nobody's bad
 * request: the dispatcher, the journal, or a bug.
 *
 * The error's message is never recorded. An executor error can carry a path, a
 * token, or somebody's document text, and the log is read by more people than
 * the run it came from. Neither are the ids the caller sent: they are text the
 * caller chose, so they are recorded as digests. An operator who holds an id
 * can digest it to find the entry; the log alone does not give the id back.
 * The error's class name is kept when it is an ordinary identifier.
 */
import { createHash } from 'node:crypto'

export type ToolRouteId = 'browser' | 'generate-excel' | 'generate-word' | 'youtube'

export interface ToolRouteFailureDiagnostic {
  readonly event: 'tool_route_unexpected_failure'
  readonly tool: ToolRouteId
  /** See {@link correlationDigest}. */
  readonly requestIdDigest?: string
  readonly toolCallIdDigest?: string
  /** A class name such as `Error` or `TypeError`, `non-error`, or `unnamed`. */
  readonly errorClass: string
}

export type ToolRouteFailureReporter = (diagnostic: ToolRouteFailureDiagnostic) => void

/** The ids a failure can be traced by, once the request has been read. */
export interface ToolRouteCorrelation {
  readonly requestId: string
  readonly toolCallId: string
}

const CLASS_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/

export function toolRouteFailureDiagnostic(
  tool: ToolRouteId,
  error: unknown,
  correlation: ToolRouteCorrelation | undefined,
): ToolRouteFailureDiagnostic {
  return {
    event: 'tool_route_unexpected_failure',
    tool,
    ...(correlation
      ? {
          requestIdDigest: correlationDigest(correlation.requestId),
          toolCallIdDigest: correlationDigest(correlation.toolCallId),
        }
      : {}),
    errorClass: errorClassOf(error),
  }
}

/**
 * The first 16 hex digits of SHA-256 over a fixed prefix and the id.
 *
 * Unkeyed on purpose, so anyone holding the id can compute it. That also means
 * an id guessable from a short list, such as an email address, can be matched
 * by trying the list; the ids the runtime mints are random, so for them the
 * digest reveals nothing.
 */
export function correlationDigest(id: string): string {
  return createHash('sha256')
    .update(`tool-route-correlation\0${id}`)
    .digest('hex')
    .slice(0, 16)
}

/**
 * The class a thrown value was made from, read from its constructor rather
 * than its `name`, which any code can set to any text.
 */
function errorClassOf(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error'
  const name: unknown = error.constructor.name
  return typeof name === 'string' && CLASS_NAME.test(name) ? name : 'unnamed'
}

/** One JSON object per line, so a log reader can parse every entry. */
export function formatToolRouteFailure(diagnostic: ToolRouteFailureDiagnostic): string {
  return `${JSON.stringify(diagnostic)}\n`
}

export const reportToolRouteFailureToStderr: ToolRouteFailureReporter = (diagnostic) => {
  process.stderr.write(formatToolRouteFailure(diagnostic))
}
