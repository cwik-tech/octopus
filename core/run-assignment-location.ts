import * as path from 'node:path'

import {
  isSafePathSegment,
  resolveRelativePathInside,
} from './path-safety.js'

export const RUN_PRIVATE_RUNTIME_DIRECTORY_NAME = '.runtime'

export interface SessionRunAssignmentLocation {
  readonly layout: 'session'
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly runPath: string
  readonly assignmentPath: string
  readonly relativeRunPath: string
  readonly relativeAssignmentPath: string
}

export interface LegacyRunAssignmentLocation {
  readonly layout: 'legacy'
  readonly runId: string
  readonly assignmentId: string
  readonly runPath: string
  readonly assignmentPath: string
  readonly relativeRunPath: string
  readonly relativeAssignmentPath: string
}

export type RunAssignmentLocation =
  | SessionRunAssignmentLocation
  | LegacyRunAssignmentLocation

export function buildSessionRunAssignmentLocation(
  workspacePath: string,
  identity: {
    readonly sessionId: string
    readonly runId: string
    readonly assignmentId: string
  },
): SessionRunAssignmentLocation | null {
  if (!areSafeLocationIds(identity)) return null
  const relativeRunPath = toPosixPath(
    path.join('sessions', identity.sessionId, 'runs', identity.runId),
  )
  const relativeAssignmentPath = toPosixPath(
    path.join(relativeRunPath, 'assignments', identity.assignmentId),
  )
  const runPath = resolveRelativePathInside(workspacePath, relativeRunPath)
  const assignmentPath = resolveRelativePathInside(
    workspacePath,
    relativeAssignmentPath,
  )
  if (!runPath || !assignmentPath) return null
  return {
    layout: 'session',
    sessionId: identity.sessionId,
    runId: identity.runId,
    assignmentId: identity.assignmentId,
    runPath,
    assignmentPath,
    relativeRunPath,
    relativeAssignmentPath,
  }
}

/**
 * Recover the session-scoped identity of one assignment directory.
 *
 * The inverse of `buildSessionRunAssignmentLocation`: callers that hold only an
 * assignment path (engines, artifact writers) need the owning session id to
 * reach session-scoped state such as the Research Web activity record. Returns
 * null for legacy or foreign layouts rather than guessing.
 */
export function parseSessionRunAssignmentLocation(
  workspacePath: string,
  assignmentPath: string,
): SessionRunAssignmentLocation | null {
  const relative = path.relative(
    path.resolve(workspacePath),
    path.resolve(assignmentPath),
  )
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null
  }
  const segments = relative.split(path.sep)
  if (
    segments.length !== 6 ||
    segments[0] !== 'sessions' ||
    segments[2] !== 'runs' ||
    segments[4] !== 'assignments'
  ) {
    return null
  }
  const [, sessionId, , runId, , assignmentId] = segments
  if (
    sessionId === undefined ||
    runId === undefined ||
    assignmentId === undefined
  ) {
    return null
  }
  return buildSessionRunAssignmentLocation(workspacePath, {
    sessionId,
    runId,
    assignmentId,
  })
}

function areSafeLocationIds(identity: {
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
}): boolean {
  return (
    isSafePathSegment(identity.sessionId) &&
    isSafePathSegment(identity.runId) &&
    isSafePathSegment(identity.assignmentId)
  )
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/')
}
