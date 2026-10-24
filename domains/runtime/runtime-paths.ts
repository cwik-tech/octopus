import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RuntimeContext } from './runtime-context.js'
import { hasErrorCode } from '../../core/node-errors.js'
import {
  buildSessionRunAssignmentLocation,
  RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
  type RunAssignmentLocation,
  type SessionRunAssignmentLocation,
} from '../../core/run-assignment-location.js'
import {
  isPathInside,
  isSafePathSegment,
  resolveRelativePathInside,
} from '../../core/path-safety.js'

export const RUNTIME_SESSION_ID_ENV = 'TEAM_RUNTIME_SESSION_ID'
export const RUNTIME_RUN_ID_ENV = 'TEAM_RUNTIME_RUN_ID'
export const RUNTIME_ASSIGNMENT_ID_ENV = 'TEAM_RUNTIME_ASSIGNMENT_ID'
export const RUNTIME_ASSIGNMENT_PATH_ENV = 'TEAM_RUNTIME_ASSIGNMENT_PATH'
export const RUNTIME_RUN_PATH_ENV = 'TEAM_RUNTIME_RUN_PATH'

export { RUN_PRIVATE_RUNTIME_DIRECTORY_NAME } from '../../core/run-assignment-location.js'

type RuntimePathEnvironment = Readonly<Record<string, string | undefined>>

export function resolveRuntimeAssignmentLocation(
  workspacePath: string,
  environment: RuntimePathEnvironment = process.env,
): SessionRunAssignmentLocation | undefined {
  const sessionId = environment[RUNTIME_SESSION_ID_ENV]?.trim()
  const runId = environment[RUNTIME_RUN_ID_ENV]?.trim()
  const assignmentId = environment[RUNTIME_ASSIGNMENT_ID_ENV]?.trim()
  const configuredAssignmentPath = environment[RUNTIME_ASSIGNMENT_PATH_ENV]?.trim()
  const configuredRunPath = environment[RUNTIME_RUN_PATH_ENV]?.trim()
  const hasExplicitScope = Boolean(
    sessionId ||
    runId ||
    assignmentId ||
    configuredAssignmentPath ||
    configuredRunPath,
  )

  if (!hasExplicitScope) return undefined
  if (!sessionId || !runId || !assignmentId) {
    throw new Error(
      'Incomplete runtime assignment scope: TEAM_RUNTIME_SESSION_ID, ' +
      'TEAM_RUNTIME_RUN_ID, and TEAM_RUNTIME_ASSIGNMENT_ID are required together.',
    )
  }

  const location = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId,
    runId,
    assignmentId,
  })
  if (!location) {
    throw new Error('Runtime assignment scope contains an invalid path segment.')
  }
  assertConfiguredPathMatches(
    RUNTIME_ASSIGNMENT_PATH_ENV,
    configuredAssignmentPath,
    location.assignmentPath,
  )
  assertConfiguredPathMatches(
    RUNTIME_RUN_PATH_ENV,
    configuredRunPath,
    location.runPath,
  )
  return location
}

export function buildRuntimeAssignmentEnvironment(
  location: SessionRunAssignmentLocation,
): Record<string, string> {
  return {
    [RUNTIME_SESSION_ID_ENV]: location.sessionId,
    [RUNTIME_RUN_ID_ENV]: location.runId,
    [RUNTIME_ASSIGNMENT_ID_ENV]: location.assignmentId,
    [RUNTIME_ASSIGNMENT_PATH_ENV]: location.assignmentPath,
    [RUNTIME_RUN_PATH_ENV]: location.runPath,
  }
}

export function buildChildAssignmentLocation(
  workspacePath: string,
  parentLocation: RunAssignmentLocation | undefined,
  assignmentId: string,
): SessionRunAssignmentLocation | undefined {
  if (!parentLocation || parentLocation.layout !== 'session') return undefined
  const childLocation = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: parentLocation.sessionId,
    runId: parentLocation.runId,
    assignmentId,
  })
  if (!childLocation) {
    throw new Error(`Invalid child assignment id: ${assignmentId}`)
  }
  return childLocation
}

export function getAssignmentPath(ctx: RuntimeContext): string {
  if (ctx.assignmentLocation) return ctx.assignmentLocation.assignmentPath
  const sessionId = ctx.state.sessionId || 'default'
  if (!isSafePathSegment(sessionId)) {
    throw new Error(`Invalid runtime session ID: ${sessionId}`)
  }
  return path.join(resolveRuntimeWorkspacePath(ctx), 'assignments', sessionId)
}

export function getCheckpointDirectory(ctx: RuntimeContext): string {
  return ctx.assignmentLocation?.assignmentPath ?? resolveRuntimeWorkspacePath(ctx)
}

function resolveRuntimeWorkspacePath(ctx: RuntimeContext): string {
  const configuredPath = ctx.teamConfig?.workspace?.path
  if (configuredPath) return configuredPath
  if (ctx.teamRoot) return path.join(ctx.teamRoot, 'workspace')
  return 'workspace'
}

function assertConfiguredPathMatches(
  environmentName: string,
  configuredPath: string | undefined,
  canonicalPath: string,
): void {
  if (!configuredPath) return
  if (path.resolve(configuredPath) !== path.resolve(canonicalPath)) {
    throw new Error(`${environmentName} does not match the canonical runtime location.`)
  }
}

export const ASSIGNMENTS_DIRECTORY_NAME = 'assignments'
export const RUN_CHECKPOINT_FILENAME = 'checkpoint.json'
export const RUN_TEMPORARY_DIRECTORY_NAME = 'tmp'

export interface RunRuntimePaths {
  assignmentPath: string
  privateRuntimePath: string
  checkpointPath: string
  temporaryPath: string
}

/** Resolve an artifact path without permitting private-state or symlink traversal. */
export function resolveOwnedRunRelativePath(params: {
  assignmentPath: string
  relativePath: string
  label: string
}): string {
  const segments = params.relativePath.split('/')
  if (
    segments[0]?.toLowerCase() ===
    RUN_PRIVATE_RUNTIME_DIRECTORY_NAME.toLowerCase()
  ) {
    throw new Error(
      `${params.label} must not use the reserved private runtime path: ${params.relativePath}`,
    )
  }

  const candidatePath = resolveRelativePathInside(
    params.assignmentPath,
    params.relativePath,
  )
  if (!candidatePath) {
    throw new Error(
      `${params.label} must stay inside the run assignment: ${params.relativePath}`,
    )
  }

  const assignmentStat = fs.lstatSync(params.assignmentPath)
  if (assignmentStat.isSymbolicLink() || !assignmentStat.isDirectory()) {
    throw new Error(`${params.label} requires an owned run assignment directory`)
  }
  const realAssignmentPath = fs.realpathSync(params.assignmentPath)
  let currentPath = params.assignmentPath

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (!segment) continue
    currentPath = path.join(currentPath, segment)
    let currentStat: fs.Stats
    try {
      currentStat = fs.lstatSync(currentPath)
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) break
      throw error
    }

    if (currentStat.isSymbolicLink()) {
      throw new Error(
        `${params.label} contains a symbolic-link component: ${params.relativePath}`,
      )
    }
    if (index < segments.length - 1 && !currentStat.isDirectory()) {
      throw new Error(
        `${params.label} contains a non-directory parent component: ${params.relativePath}`,
      )
    }

    const realCurrentPath = fs.realpathSync(currentPath)
    if (!isPathInside(realAssignmentPath, realCurrentPath)) {
      throw new Error(
        `${params.label} resolves outside the run assignment: ${params.relativePath}`,
      )
    }
  }

  return candidatePath
}

function normalizeDirectoryPath(directoryPath: string, label: string): string {
  if (!directoryPath.trim() || directoryPath.includes('\0')) {
    throw new Error(`${label} must be a non-empty filesystem path`)
  }

  return path.resolve(directoryPath)
}

function assertExistingDirectoryIsOwned(directoryPath: string, label: string): void {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(directoryPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be an owned directory, not a file or symbolic link`)
  }
}

/** Resolve one run assignment below the workspace's assignment root. */
export function resolveAssignmentPath(
  workspacePath: string,
  runId: string,
): string {
  const normalizedWorkspacePath = normalizeDirectoryPath(
    workspacePath,
    'Workspace path',
  )

  if (!isSafePathSegment(runId)) {
    throw new Error(`Invalid run ID: ${runId}`)
  }

  const assignmentsPath = path.join(
    normalizedWorkspacePath,
    ASSIGNMENTS_DIRECTORY_NAME,
  )
  assertExistingDirectoryIsOwned(assignmentsPath, 'Assignments path')
  const assignmentPath = resolveRelativePathInside(assignmentsPath, runId)
  if (!assignmentPath) {
    throw new Error(`Run ID resolves outside the assignments directory: ${runId}`)
  }
  assertExistingDirectoryIsOwned(assignmentPath, `Assignment '${runId}'`)

  return assignmentPath
}

/**
 * Create this assignment's run-private runtime directory and return its path.
 *
 * The single owner of that directory's existence and its mode. Every writer
 * that needs a path inside `.runtime` goes through here rather than letting
 * `mkdir(..., { recursive: true })` create it as a side effect: a recursive
 * mkdir with no mode inherits the umask, so whichever writer happened to run
 * first decided whether the run's private tree was world-readable.
 */
export function ensureRunPrivateRuntimeDirectory(assignmentPath: string): string {
  const { privateRuntimePath } = getRunRuntimePaths(assignmentPath)
  try {
    // Explicit 0700, and deliberately not recursive: the assignment directory
    // is the caller's to create, and a recursive mkdir here would silently
    // manufacture a whole path the caller got wrong.
    fs.mkdirSync(privateRuntimePath, { recursive: false, mode: 0o700 })
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error
  }
  // An existing directory is left exactly as it is. Repairing a mode on a
  // directory this process did not create would mean tightening permissions on
  // a path chosen by something else, which needs provenance this function
  // cannot establish.
  assertExistingDirectoryIsOwned(privateRuntimePath, 'Private runtime path')
  return privateRuntimePath
}

/**
 * Resolve private runtime paths from one exact run storage directory.
 *
 * Scoped product runs pass an assignment directory. Legacy direct CLI runs
 * may pass their workspace directory; each scope receives a private `.runtime`.
 */
export function getRunRuntimePaths(assignmentPath: string): RunRuntimePaths {
  const normalizedAssignmentPath = normalizeDirectoryPath(
    assignmentPath,
    'Assignment path',
  )
  assertExistingDirectoryIsOwned(normalizedAssignmentPath, 'Assignment path')
  const privateRuntimePath = path.join(
    normalizedAssignmentPath,
    RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
  )
  assertExistingDirectoryIsOwned(privateRuntimePath, 'Private runtime path')

  return {
    assignmentPath: normalizedAssignmentPath,
    privateRuntimePath,
    checkpointPath: path.join(privateRuntimePath, RUN_CHECKPOINT_FILENAME),
    temporaryPath: path.join(
      privateRuntimePath,
      RUN_TEMPORARY_DIRECTORY_NAME,
    ),
  }
}

/** Resolve one execution attempt's temporary directory inside its run. */
export function getRunAttemptTemporaryPath(
  assignmentPath: string,
  attemptId: string,
): string {
  if (!isSafePathSegment(attemptId)) {
    throw new Error(`Invalid execution attempt ID: ${attemptId}`)
  }

  const { temporaryPath } = getRunRuntimePaths(assignmentPath)
  assertExistingDirectoryIsOwned(temporaryPath, 'Run temporary path')
  const attemptPath = resolveRelativePathInside(temporaryPath, attemptId)
  if (!attemptPath) {
    throw new Error(
      `Execution attempt ID resolves outside the run temporary directory: ${attemptId}`,
    )
  }

  return attemptPath
}
