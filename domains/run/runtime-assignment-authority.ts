import * as fs from 'node:fs/promises'

import {
  RUNTIME_PROCESS_IDENTITY_ENV,
  RUNTIME_TASK_ID_ENV,
} from '../../contracts/runtime-capability-authority.js'
import {
  deriveRuntimeAssignmentCredential,
  type RuntimeAssignmentCredentialParent,
} from '../../core/runtime-assignment-credential.js'
import {
  RUN_ASSIGNMENT_AUTHORITY_GRANT_VERSION,
  readRunAssignmentAuthorityGrant,
  writeRunAssignmentAuthorityGrant,
  type RunAssignmentAuthorityGrant,
} from './run-assignment-authority-store.js'
import type { RunAssignmentLocation } from './run-location.js'

export const RUNTIME_EXECUTION_ATTEMPT_ID_ENV =
  'TEAM_RUNTIME_EXECUTION_ATTEMPT_ID'
export const RUNTIME_TASK_LAUNCH_GATE_PATH_ENV =
  'TEAM_RUNTIME_TASK_LAUNCH_GATE_PATH'

export interface DelegatedRuntimeAssignmentAuthority {
  readonly taskId: string
  readonly processIdentity: string
}

/**
 * Mint the exact child-assignment credential before launching delegated work.
 * No authority variables means an unmanaged legacy run; a partial managed
 * identity fails closed instead of creating an unauthorised child.
 */
export async function prepareDelegatedRuntimeAssignmentAuthority(input: {
  readonly workspacePath: string
  readonly parentLocation: RunAssignmentLocation | undefined
  readonly childLocation: RunAssignmentLocation | undefined
  readonly environment: NodeJS.ProcessEnv
}): Promise<DelegatedRuntimeAssignmentAuthority | undefined> {
  const taskId = input.environment[RUNTIME_TASK_ID_ENV]?.trim()
  const processIdentity =
    input.environment[RUNTIME_PROCESS_IDENTITY_ENV]?.trim()
  if (!taskId && !processIdentity) return undefined
  if (!taskId || !processIdentity) {
    throw new Error('Managed delegated runtime authority is incomplete.')
  }
  const parent = input.parentLocation
  const child = input.childLocation
  if (
    !parent ||
    parent.layout !== 'session' ||
    !child ||
    child.layout !== 'session' ||
    parent.sessionId !== child.sessionId ||
    parent.runId !== child.runId ||
    parent.assignmentId === child.assignmentId
  ) {
    throw new Error('Managed delegated assignment lineage is invalid.')
  }
  const authorityWorkspacePath = await fs.realpath(input.workspacePath)

  let parentGrant = await readRunAssignmentAuthorityGrant(
    authorityWorkspacePath,
    parent.assignmentId,
  )
  if (!parentGrant) {
    if (processIdentity.startsWith('d1.')) {
      throw new Error('Managed delegated parent authority is unavailable.')
    }
    parentGrant = rootGrant({
      sessionId: parent.sessionId,
      runId: parent.runId,
      taskId,
      assignmentId: parent.assignmentId,
    })
    await writeRunAssignmentAuthorityGrant(authorityWorkspacePath, parentGrant)
  }
  requireMatchingParentGrant(parentGrant, {
    sessionId: parent.sessionId,
    runId: parent.runId,
    taskId,
    assignmentId: parent.assignmentId,
  })

  const credentialParent: RuntimeAssignmentCredentialParent =
    parentGrant.depth === 0
      ? {
          kind: 'root',
          seed: {
            sessionId: parent.sessionId,
            runId: parent.runId,
            taskId,
            rootAssignmentId: parent.assignmentId,
            taskProcessIdentity: processIdentity,
          },
        }
      : {
          kind: 'delegated',
          credential: processIdentity,
          assignmentId: parent.assignmentId,
        }
  const childCredential = deriveRuntimeAssignmentCredential({
    parent: credentialParent,
    assignmentId: child.assignmentId,
  })
  await writeRunAssignmentAuthorityGrant(authorityWorkspacePath, {
    version: RUN_ASSIGNMENT_AUTHORITY_GRANT_VERSION,
    sessionId: child.sessionId,
    runId: child.runId,
    taskId,
    assignmentId: child.assignmentId,
    parentAssignmentId: parent.assignmentId,
    depth: parentGrant.depth + 1,
  })
  return { taskId, processIdentity: childCredential }
}

/** Remove root-only startup secrets before constructing a delegated env. */
export function withoutRootTaskLaunchSecrets(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const {
    [RUNTIME_EXECUTION_ATTEMPT_ID_ENV]: _executionAttemptId,
    [RUNTIME_TASK_LAUNCH_GATE_PATH_ENV]: _launchGatePath,
    ...delegatedEnvironment
  } = environment
  return delegatedEnvironment
}

function rootGrant(input: {
  readonly sessionId: string
  readonly runId: string
  readonly taskId: string
  readonly assignmentId: string
}): RunAssignmentAuthorityGrant {
  return {
    version: RUN_ASSIGNMENT_AUTHORITY_GRANT_VERSION,
    ...input,
    parentAssignmentId: null,
    depth: 0,
  }
}

function requireMatchingParentGrant(
  grant: RunAssignmentAuthorityGrant,
  expected: {
    readonly sessionId: string
    readonly runId: string
    readonly taskId: string
    readonly assignmentId: string
  },
): void {
  if (
    grant.sessionId !== expected.sessionId ||
    grant.runId !== expected.runId ||
    grant.taskId !== expected.taskId ||
    grant.assignmentId !== expected.assignmentId
  ) {
    throw new Error('Managed delegated parent authority does not match.')
  }
}
