import type { RunAssignmentLocation } from '../core/run-assignment-location.js'

export interface TeamRuntimeCapabilityIdentity {
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly taskId: string
  readonly processIdentity: string
}

export function readTeamRuntimeCapabilityIdentity(input: {
  readonly location: RunAssignmentLocation | undefined
  readonly runtimeSessionId: string
  readonly environment: NodeJS.ProcessEnv
}): TeamRuntimeCapabilityIdentity | null {
  const taskId = input.environment.TEAM_RUNTIME_TASK_ID?.trim()
  const processIdentity =
    input.environment.TEAM_RUNTIME_PROCESS_IDENTITY?.trim()
  const sessionId = input.location?.layout === 'session'
    ? input.location.sessionId
    : input.runtimeSessionId
  if (
    !input.location ||
    !isIdentifier(sessionId) ||
    !isIdentifier(taskId) ||
    !isIdentifier(processIdentity)
  ) {
    return null
  }
  return {
    sessionId,
    runId: input.location.runId,
    assignmentId: input.location.assignmentId,
    taskId,
    processIdentity,
  }
}

export function requireTeamRuntimeCapabilityIdentity(input: {
  readonly location: RunAssignmentLocation | undefined
  readonly runtimeSessionId: string
  readonly environment: NodeJS.ProcessEnv
}): TeamRuntimeCapabilityIdentity {
  const identity = readTeamRuntimeCapabilityIdentity(input)
  if (!identity) {
    throw new Error('Managed Team Runtime capability authority is unavailable.')
  }
  return identity
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\0-\x1f\x7f]/u.test(value)
}
