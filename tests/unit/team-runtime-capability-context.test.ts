import assert from 'node:assert/strict'
import test from 'node:test'

import { readTeamRuntimeCapabilityIdentity } from '../../team-runtime/runtime-capability-context.js'

const LOCATION = {
  layout: 'session' as const,
  sessionId: 'session-context-1',
  runId: 'run-context-1',
  assignmentId: 'assignment-context-1',
  runPath: '/tmp/run-context-1',
  assignmentPath: '/tmp/run-context-1/assignments/assignment-context-1',
  relativeRunPath: 'sessions/session-context-1/runs/run-context-1',
  relativeAssignmentPath:
    'sessions/session-context-1/runs/run-context-1/assignments/assignment-context-1',
}

test('Team Runtime capability identity rejects a launch missing managed authority', () => {
  assert.equal(readTeamRuntimeCapabilityIdentity({
    location: LOCATION,
    runtimeSessionId: LOCATION.sessionId,
    environment: { TEAM_RUNTIME_TASK_ID: 'task-context-1' },
  }), null)
  assert.equal(readTeamRuntimeCapabilityIdentity({
    location: LOCATION,
    runtimeSessionId: LOCATION.sessionId,
    environment: { TEAM_RUNTIME_PROCESS_IDENTITY: 'process-context-1' },
  }), null)
})

test('Team Runtime capability identity binds the managed task and process', () => {
  assert.deepEqual(readTeamRuntimeCapabilityIdentity({
    location: LOCATION,
    runtimeSessionId: LOCATION.sessionId,
    environment: {
      TEAM_RUNTIME_TASK_ID: 'task-context-1',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-context-1',
    },
  }), {
    sessionId: 'session-context-1',
    runId: 'run-context-1',
    assignmentId: 'assignment-context-1',
    taskId: 'task-context-1',
    processIdentity: 'process-context-1',
  })
})
