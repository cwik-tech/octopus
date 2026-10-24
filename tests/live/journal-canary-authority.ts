import {
  RUNTIME_PROCESS_IDENTITY_ENV,
  RUNTIME_TASK_ID_ENV,
} from '../../contracts/runtime-capability-authority.js'

/**
 * Seed the managed parent identity a direct `runWorkflow` caller must provide.
 *
 * In production `services/task-service.ts:577-582` puts this identity in the
 * child's environment when it launches a task, and
 * `prepareDelegatedRuntimeAssignmentAuthority` reads it back from `process.env`
 * (`domains/run/runtime-assignment-authority.ts:40-46`). A caller that passes
 * `taskId` and `executionAttemptId` as `runWorkflow` *options* alone leaves the
 * environment empty: the authority resolves to `undefined`, and the child team
 * runtime then fails closed with "Managed Team Runtime capability authority is
 * unavailable".
 *
 * This seeds the same two variables with the same values the caller passes as
 * options, so the identity the environment carries and the identity the run
 * claims are one thing rather than two. It fabricates nothing in the child, and
 * changes nothing about how lineage is checked — an identity that does not
 * match its parent and child locations is still refused.
 *
 * @returns a restore function returning both variables to their prior state.
 */
export function seedCanaryRuntimeAuthority(identity: {
  readonly taskId: string
  readonly processIdentity: string
}): () => void {
  const previousTaskId = process.env[RUNTIME_TASK_ID_ENV]
  const previousProcessIdentity = process.env[RUNTIME_PROCESS_IDENTITY_ENV]

  process.env[RUNTIME_TASK_ID_ENV] = identity.taskId
  process.env[RUNTIME_PROCESS_IDENTITY_ENV] = identity.processIdentity

  return () => {
    if (previousTaskId === undefined) delete process.env[RUNTIME_TASK_ID_ENV]
    else process.env[RUNTIME_TASK_ID_ENV] = previousTaskId
    if (previousProcessIdentity === undefined) {
      delete process.env[RUNTIME_PROCESS_IDENTITY_ENV]
    } else {
      process.env[RUNTIME_PROCESS_IDENTITY_ENV] = previousProcessIdentity
    }
  }
}
