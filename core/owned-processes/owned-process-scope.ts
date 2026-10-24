/**
 * An execution attempt's ownership scope
 * (`docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md`,
 * section 1). POSIX only.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

import {
  ownedProcessScopeFolders,
  publishOrReadScopeRecord,
  scopeRecordSchema,
} from './owned-process-records.js'

export interface OwnedProcessScopeIdentity {
  readonly workspacePath: string
  readonly sessionId: string
  readonly taskId: string
  readonly executionAttemptNumber: number
}

export function ownedProcessScopePath(identity: OwnedProcessScopeIdentity): string {
  return path.join(
    identity.workspacePath,
    'sessions',
    identity.sessionId,
    'tasks',
    identity.taskId,
    'owned-processes',
    `attempt-${identity.executionAttemptNumber}`,
  )
}

/**
 * Creates the attempt's scope folders and publishes its `scope.json`, and
 * returns the scope's path. A launcher that lost the race for the same
 * attempt finds the winner's `scope.json`, which must name the same task and
 * attempt; one that names another, or cannot be read, is refused.
 */
export async function publishOwnedProcessScope(identity: OwnedProcessScopeIdentity): Promise<string> {
  const scopePath = ownedProcessScopePath(identity)
  const folders = ownedProcessScopeFolders(scopePath)
  for (const folder of [folders.intents, folders.claims, folders.fences, folders.staging]) {
    await fsp.mkdir(folder, { recursive: true, mode: 0o700 })
  }
  const published = await publishOrReadScopeRecord({
    scopePath,
    target: path.join(scopePath, 'scope.json'),
    record: {
      version: 1,
      taskId: identity.taskId,
      sessionId: identity.sessionId,
      executionAttemptNumber: identity.executionAttemptNumber,
      createdAt: new Date().toISOString(),
    },
    schema: scopeRecordSchema,
  })
  if (published.kind === 'unreadable') {
    throw new Error(`The ownership scope at ${scopePath} is unreadable: ${published.reason}`)
  }
  const { taskId, sessionId, executionAttemptNumber } = published.record
  if (
    taskId !== identity.taskId ||
    sessionId !== identity.sessionId ||
    executionAttemptNumber !== identity.executionAttemptNumber
  ) {
    throw new Error(`The ownership scope at ${scopePath} belongs to another task or attempt`)
  }
  return scopePath
}

/** Ownership scopes exist on POSIX only; Windows keeps today's behavior. */
export function ownedProcessScopesSupported(): boolean {
  return process.platform !== 'win32'
}

/**
 * The task record field for a new attempt, with its scope published first.
 * Recorded in the same write that assigns the attempt's number, so a record
 * that says it has a scope always has one. On Windows no scope is created and
 * the field is cleared.
 */
export async function prepareAttemptOwnedProcessScope(
  identity: OwnedProcessScopeIdentity,
): Promise<{ readonly ownedProcessScope: 1 | undefined }> {
  if (!ownedProcessScopesSupported()) return { ownedProcessScope: undefined }
  await publishOwnedProcessScope(identity)
  return { ownedProcessScope: 1 }
}

/** The scope a root worker is given, from its task record, or undefined when it has none. */
export function attemptOwnedProcessScopePath(input: {
  readonly workspacePath: string
  readonly sessionId: string
  readonly taskId: string
  readonly executionAttemptNumber: number | undefined
  readonly ownedProcessScope: 1 | undefined
}): string | undefined {
  if (input.ownedProcessScope !== 1 || input.executionAttemptNumber === undefined) return undefined
  return ownedProcessScopePath({
    workspacePath: input.workspacePath,
    sessionId: input.sessionId,
    taskId: input.taskId,
    executionAttemptNumber: input.executionAttemptNumber,
  })
}
