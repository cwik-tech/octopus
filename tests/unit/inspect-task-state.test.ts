import { requiredValue } from '../../core/required-value.js'
/**
 * Unit tests for domains/sessions/inspect-task-state.ts (Contract D)
 *
 * Tests deriveStages logic, resolveStatus logic, transcriptSummary
 * truncation, and the top-level inspectTaskState public API using a
 * real filesystem workspace (no mocks required for pure logic).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { inspectTaskState } from '../../domains/sessions/inspect-task-state.js'
import type { EngineEventEnvelope } from '../../domains/runtime/runtime-events.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { buildRuntimeAssignmentEnvironment } from '../../domains/runtime/runtime-paths.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-task-test-'))
  return dir
}

/** Write newline-delimited JSON objects to a file */
function writeJsonl(filePath: string, objects: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, objects.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
}

function makeEvent(overrides: Partial<EngineEventEnvelope>): EngineEventEnvelope {
  return {
    schema_version: 1,
    timestamp: new Date().toISOString(),
    tenant_id: 'test',
    category: 'run',
    type: 'run.session_started',
    payload: {},
    ...overrides,
  } as EngineEventEnvelope
}

function createTask(
  workspacePath: string,
  opts: {
    sessionId: string
    taskId: string
    runId: string
    assignmentId?: string
    assignmentPath?: string
    status?: 'queued' | 'running' | 'awaiting_input' | 'interrupted' | 'done' | 'failed' | 'blocked' | 'cancelled'
    admission?: Record<string, unknown>
    executionAttemptId?: string
  },
): void {
  // Write session metadata directly (store.createSession requires valid UUID session IDs)
  const sessionDir = path.join(workspacePath, 'sessions', opts.sessionId)
  const taskDir = path.join(sessionDir, 'tasks', opts.taskId)
  fs.mkdirSync(taskDir, { recursive: true })

  const sessionRecord = {
    id: opts.sessionId,
    name: 'Test Session',
    createdAt: new Date().toISOString(),
    status: 'active',
    files: [],
    parseStatus: 'pending',
  }
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(sessionRecord), 'utf8')

  const taskRecord = {
    id: opts.taskId,
    sessionId: opts.sessionId,
    runId: opts.runId,
    ...(opts.assignmentId ? { assignmentId: opts.assignmentId } : {}),
    workflowId: 'test-workflow',
    brief: 'Test task',
    status: opts.status ?? 'queued',
    ...(opts.admission ? { admission: opts.admission } : {}),
    ...(opts.executionAttemptId
      ? { executionAttemptId: opts.executionAttemptId }
      : {}),
    createdAt: new Date().toISOString(),
    cwd: taskDir,
    assignmentPath:
      opts.assignmentPath ?? path.join(workspacePath, 'assignments', opts.runId),
  }
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(taskRecord), 'utf8')
}

// ─── not_found for unknown taskId ─────────────────────────────────────────────

test('inspectTaskState returns not_found for unknown taskId', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const result = await inspectTaskState({ taskId: 'does-not-exist' })
    assert.equal(result.taskId, 'does-not-exist')
    assert.equal(result.status, 'not_found')
    assert.deepEqual(result.stages, [])
    assert.equal(result.transcriptSummary, '')
    assert.equal(result.artifactPath, undefined)
    assert.equal(result.errorMessage, undefined)
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

// ─── Contract D output shape ───────────────────────────────────────────────────

test('inspectTaskState returns correct Contract D shape for running task', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const sessionId = '00000000-0000-0000-0000-000000000001'
    const taskId = '10000000-0000-0000-0000-000000000001'
    const runId = 'run-abc'

    createTask(workspacePath, { sessionId, taskId, runId, status: 'running' })

    // Write engine events with a stage
    const eventsPath = path.join(workspacePath, 'assignments', runId, 'logs', 'engine-events.jsonl')
    writeJsonl(eventsPath, [
      makeEvent({ type: 'run.session_started', level_id: null }),
      makeEvent({ type: 'agent.start', level_id: 'phase-1', stage_type: 'discussion' }),
      makeEvent({ type: 'agent.end', level_id: 'phase-1', stage_type: 'discussion' }),
    ])

    const result = await inspectTaskState({ taskId, sessionId })
    assert.equal(result.taskId, taskId)
    assert.equal(result.status, 'running')
    assert.ok(Array.isArray(result.stages), 'stages should be an array')
    assert.equal(result.stages.length, 1)
    assert.equal(requiredValue(result.stages[0], 'tests/unit/inspect-task-state.test.ts:136').stageName, 'phase-1')
    assert.equal(requiredValue(result.stages[0], 'tests/unit/inspect-task-state.test.ts:137').stageType, 'discussion')
    assert.equal(requiredValue(result.stages[0], 'tests/unit/inspect-task-state.test.ts:138').status, 'running')
    assert.equal(typeof result.transcriptSummary, 'string')
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('inspectTaskState prefers a validated session-scoped task assignment over the legacy run path', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const sessionId = '00000000-0000-0000-0000-000000000021'
    const taskId = '10000000-0000-0000-0000-000000000021'
    const runId = 'run-scoped'
    const location = buildSessionRunAssignmentLocation(workspacePath, {
      sessionId,
      runId,
      assignmentId: runId,
    })
    assert.ok(location)
    createTask(workspacePath, {
      sessionId,
      taskId,
      runId,
      assignmentId: runId,
      assignmentPath: location.assignmentPath,
      status: 'running',
    })

    writeJsonl(path.join(location.assignmentPath, 'logs', 'engine-events.jsonl'), [
      makeEvent({ type: 'agent.start', level_id: 'scoped-stage', stage_type: 'chain' }),
      makeEvent({ type: 'run.completed' }),
    ])
    writeJsonl(path.join(workspacePath, 'assignments', runId, 'logs', 'engine-events.jsonl'), [
      makeEvent({ type: 'run.failed', payload: { error: 'wrong legacy run' } }),
    ])

    const result = await inspectTaskState({ taskId, sessionId })
    assert.equal(result.status, 'done')
    assert.equal(result.stages[0]?.stageName, 'scoped-stage')
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('inspectTaskState uses canonical runtime assignment env when the task path is untrusted', async () => {
  const workspacePath = makeWorkspace()
  const runtimeEnvironmentKeys = [
    'TEAM_RUNTIME_SESSION_ID',
    'TEAM_RUNTIME_RUN_ID',
    'TEAM_RUNTIME_ASSIGNMENT_ID',
    'TEAM_RUNTIME_ASSIGNMENT_PATH',
    'TEAM_RUNTIME_RUN_PATH',
  ]
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const sessionId = '00000000-0000-0000-0000-000000000022'
    const taskId = '10000000-0000-0000-0000-000000000022'
    const runId = 'run-env'
    const location = buildSessionRunAssignmentLocation(workspacePath, {
      sessionId,
      runId,
      assignmentId: runId,
    })
    assert.ok(location)
    createTask(workspacePath, {
      sessionId,
      taskId,
      runId,
      assignmentId: runId,
      assignmentPath: path.join(os.tmpdir(), 'forged-assignment-path'),
      status: 'running',
    })
    Object.assign(process.env, buildRuntimeAssignmentEnvironment(location))
    writeJsonl(path.join(location.assignmentPath, 'logs', 'engine-events.jsonl'), [
      makeEvent({ type: 'run.completed' }),
    ])

    const result = await inspectTaskState({ taskId, sessionId })
    assert.equal(result.status, 'done')
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    for (const key of runtimeEnvironmentKeys) delete process.env[key]
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

// ─── Status derivation from engine events ─────────────────────────────────────

test('resolveStatus: returns done when run.completed event present', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const sessionId = '00000000-0000-0000-0000-000000000002'
    const taskId = '10000000-0000-0000-0000-000000000002'
    const runId = 'run-done'

    createTask(workspacePath, { sessionId, taskId, runId, status: 'running' })

    const eventsPath = path.join(workspacePath, 'assignments', runId, 'logs', 'engine-events.jsonl')
    writeJsonl(eventsPath, [
      makeEvent({ type: 'run.session_started' }),
      makeEvent({ type: 'run.completed' }),
    ])

    const result = await inspectTaskState({ taskId, sessionId })
    assert.equal(result.status, 'done')
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('resolveStatus: returns error when run.failed event present', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const sessionId = '00000000-0000-0000-0000-000000000003'
    const taskId = '10000000-0000-0000-0000-000000000003'
    const runId = 'run-err'

    createTask(workspacePath, { sessionId, taskId, runId, status: 'running' })

    const eventsPath = path.join(workspacePath, 'assignments', runId, 'logs', 'engine-events.jsonl')
    writeJsonl(eventsPath, [
      makeEvent({ type: 'run.session_started' }),
      makeEvent({ type: 'run.failed', payload: { error: 'boom' } }),
    ])

    const result = await inspectTaskState({ taskId, sessionId })
    assert.equal(result.status, 'error')
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('resolveStatus: uses task record status when task is done in store', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const sessionId = '00000000-0000-0000-0000-000000000004'
    const taskId = '10000000-0000-0000-0000-000000000004'
    const runId = 'run-stored-done'

    createTask(workspacePath, { sessionId, taskId, runId, status: 'done' })

    // No engine events at all
    const result = await inspectTaskState({ taskId, sessionId })
    assert.equal(result.status, 'done')
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('resolveStatus: preserves blocked and cancelled task states', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const sessionId = '00000000-0000-0000-0000-000000000015'
    const blockedTaskId = '10000000-0000-0000-0000-000000000015'
    const cancelledTaskId = '10000000-0000-0000-0000-000000000016'

    createTask(workspacePath, {
      sessionId,
      taskId: blockedTaskId,
      runId: 'run-blocked',
      status: 'blocked',
    })
    createTask(workspacePath, {
      sessionId,
      taskId: cancelledTaskId,
      runId: 'run-cancelled',
      status: 'cancelled',
    })

    assert.equal(
      (await inspectTaskState({ taskId: blockedTaskId, sessionId })).status,
      'blocked',
    )
    assert.equal(
      (await inspectTaskState({ taskId: cancelledTaskId, sessionId })).status,
      'cancelled',
    )
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('resolveStatus: reports when a task is awaiting human input', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const sessionId = '00000000-0000-0000-0000-000000000017'
    const taskId = '10000000-0000-0000-0000-000000000017'

    createTask(workspacePath, {
      sessionId,
      taskId,
      runId: 'run-awaiting-input',
      status: 'awaiting_input',
    })

    assert.equal(
      (await inspectTaskState({ taskId, sessionId })).status,
      'awaiting_input',
    )
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('resolveStatus: pending initial and recovery admissions report queued', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const admission = {
      version: 1,
      requestId: 'request-1',
      order: '1',
      requestedAt: new Date().toISOString(),
      executionKind: 'initial',
      source: 'apply',
      expectedExecutionAttemptId: null,
      phase: 'pending',
    }
    createTask(workspacePath, {
      sessionId: '00000000-0000-0000-0000-000000000101',
      taskId: '10000000-0000-0000-0000-000000000101',
      runId: 'run-queued',
      status: 'queued',
      admission,
    })
    createTask(workspacePath, {
      sessionId: '00000000-0000-0000-0000-000000000102',
      taskId: '10000000-0000-0000-0000-000000000102',
      runId: 'run-recovery',
      status: 'interrupted',
      admission: {
        ...admission,
        requestId: 'request-2',
        order: '2',
        executionKind: 'recovery',
        source: 'manual_resume',
        expectedExecutionAttemptId: 'old-attempt',
      },
    })

    assert.equal(
      (await inspectTaskState({
        taskId: '10000000-0000-0000-0000-000000000101',
        sessionId: '00000000-0000-0000-0000-000000000101',
      })).status,
      'queued',
    )
    assert.equal(
      (await inspectTaskState({
        taskId: '10000000-0000-0000-0000-000000000102',
        sessionId: '00000000-0000-0000-0000-000000000102',
      })).status,
      'queued',
    )
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('resolveStatus: queued grant becomes running only for its matching start event', async () => {
  const workspacePath = makeWorkspace()
  const assignmentPath = path.join(workspacePath, 'assignments', 'run-granted')
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const executionAttemptId = 'attempt-current'
    createTask(workspacePath, {
      sessionId: '00000000-0000-0000-0000-000000000103',
      taskId: '10000000-0000-0000-0000-000000000103',
      runId: 'run-granted',
      assignmentPath,
      status: 'queued',
      executionAttemptId,
      admission: {
        version: 1,
        requestId: 'request-granted',
        order: '3',
        requestedAt: new Date().toISOString(),
        executionKind: 'recovery',
        source: 'manual_resume',
        expectedExecutionAttemptId: 'attempt-old',
        phase: 'granted',
        grantId: 'grant-1',
        ownerEpoch: 'owner-1',
        grantedAt: new Date().toISOString(),
        executionAttemptId,
      },
    })
    const eventsPath = path.join(assignmentPath, 'logs', 'engine-events.jsonl')
    writeJsonl(eventsPath, [
      makeEvent({
        type: 'session_task.workflow_started',
        payload: { execution_attempt_id: 'attempt-old' },
      }),
    ])
    assert.equal(
      (await inspectTaskState({
        taskId: '10000000-0000-0000-0000-000000000103',
        sessionId: '00000000-0000-0000-0000-000000000103',
      })).status,
      'queued',
    )

    writeJsonl(eventsPath, [
      makeEvent({
        type: 'session_task.workflow_started',
        payload: { execution_attempt_id: executionAttemptId },
      }),
    ])
    assert.equal(
      (await inspectTaskState({
        taskId: '10000000-0000-0000-0000-000000000103',
        sessionId: '00000000-0000-0000-0000-000000000103',
      })).status,
      'running',
    )
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

// ─── Stage derivation ─────────────────────────────────────────────────────────

test('deriveStages: gate.transition closes the from stage', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const sessionId = '00000000-0000-0000-0000-000000000005'
    const taskId = '10000000-0000-0000-0000-000000000005'
    const runId = 'run-stages'

    createTask(workspacePath, { sessionId, taskId, runId, status: 'running' })

    const ts1 = '2024-01-01T10:00:00.000Z'
    const ts2 = '2024-01-01T10:05:00.000Z'
    const ts3 = '2024-01-01T10:10:00.000Z'

    const eventsPath = path.join(workspacePath, 'assignments', runId, 'logs', 'engine-events.jsonl')
    writeJsonl(eventsPath, [
      { ...makeEvent({ type: 'agent.start', level_id: 'stage-A', stage_type: 'pipeline', timestamp: ts1 }) },
      { ...makeEvent({ type: 'gate.transition', level_id: 'stage-A', timestamp: ts2, payload: { from: 'stage-A', to: 'stage-B' } }) },
      { ...makeEvent({ type: 'agent.start', level_id: 'stage-B', stage_type: 'discussion', timestamp: ts3 }) },
    ])

    const result = await inspectTaskState({ taskId, sessionId })
    const stageA = result.stages.find((s) => s.stageName === 'stage-A')
    const stageB = result.stages.find((s) => s.stageName === 'stage-B')

    assert.ok(stageA, 'stage-A should exist')
    assert.equal(stageA!.status, 'completed', 'stage-A should be completed after gate.transition')
    assert.equal(stageA!.stageType, 'pipeline')

    assert.ok(stageB, 'stage-B should exist')
    assert.equal(stageB!.status, 'running', 'stage-B should still be running')
    assert.equal(stageB!.stageType, 'discussion')
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('deriveStages: skips root and done pseudo-stages', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const sessionId = '00000000-0000-0000-0000-000000000006'
    const taskId = '10000000-0000-0000-0000-000000000006'
    const runId = 'run-pseudo'

    createTask(workspacePath, { sessionId, taskId, runId, status: 'running' })

    const eventsPath = path.join(workspacePath, 'assignments', runId, 'logs', 'engine-events.jsonl')
    writeJsonl(eventsPath, [
      makeEvent({ type: 'agent.start', level_id: 'root' }),
      makeEvent({ type: 'agent.end', level_id: 'done' }),
      makeEvent({ type: 'agent.start', level_id: 'real-stage', stage_type: 'pipeline' }),
    ])

    const result = await inspectTaskState({ taskId, sessionId })
    const names = result.stages.map((s) => s.stageName)
    assert.ok(!names.includes('root'), 'root should be excluded')
    assert.ok(!names.includes('done'), 'done should be excluded')
    assert.ok(names.includes('real-stage'), 'real-stage should be included')
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('deriveStages: when run.completed, open stages are closed', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const sessionId = '00000000-0000-0000-0000-000000000007'
    const taskId = '10000000-0000-0000-0000-000000000007'
    const runId = 'run-close'

    createTask(workspacePath, { sessionId, taskId, runId, status: 'running' })

    const eventsPath = path.join(workspacePath, 'assignments', runId, 'logs', 'engine-events.jsonl')
    writeJsonl(eventsPath, [
      makeEvent({ type: 'agent.start', level_id: 'stage-X', stage_type: 'discussion' }),
      makeEvent({ type: 'run.completed' }),
    ])

    const result = await inspectTaskState({ taskId, sessionId })
    const stage = result.stages.find((s) => s.stageName === 'stage-X')
    assert.ok(stage, 'stage-X should exist')
    assert.equal(stage!.status, 'completed')
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

// ─── artifactPath resolution ───────────────────────────────────────────────────

test('resolveArtifactPath: returns path from artifact.written event', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const sessionId = '00000000-0000-0000-0000-000000000008'
    const taskId = '10000000-0000-0000-0000-000000000008'
    const runId = 'run-artifact'

    createTask(workspacePath, { sessionId, taskId, runId, status: 'done' })

    const eventsPath = path.join(workspacePath, 'assignments', runId, 'logs', 'engine-events.jsonl')
    writeJsonl(eventsPath, [
      makeEvent({ type: 'run.completed' }),
      makeEvent({ type: 'artifact.written', payload: { path: 'runs/run-artifact/output.md', artifact_type: 'result' } }),
    ])

    const result = await inspectTaskState({ taskId, sessionId })
    assert.equal(result.artifactPath, 'runs/run-artifact/output.md')
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('resolveArtifactPath: prefers result artifact over other artifact types', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const sessionId = '00000000-0000-0000-0000-000000000009'
    const taskId = '10000000-0000-0000-0000-000000000009'
    const runId = 'run-art2'

    createTask(workspacePath, { sessionId, taskId, runId, status: 'done' })

    const eventsPath = path.join(workspacePath, 'assignments', runId, 'logs', 'engine-events.jsonl')
    writeJsonl(eventsPath, [
      makeEvent({ type: 'artifact.written', payload: { path: 'runs/run-art2/intermediate.md', artifact_type: 'intermediate' } }),
      makeEvent({ type: 'artifact.written', payload: { path: 'runs/run-art2/result.md', artifact_type: 'result' } }),
      makeEvent({ type: 'run.completed' }),
    ])

    const result = await inspectTaskState({ taskId, sessionId })
    assert.equal(result.artifactPath, 'runs/run-art2/result.md')
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('resolveArtifactPath: returns undefined when no artifact.written events', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const sessionId = '00000000-0000-0000-0000-000000000010'
    const taskId = '10000000-0000-0000-0000-000000000010'
    const runId = 'run-noart'

    createTask(workspacePath, { sessionId, taskId, runId, status: 'done' })

    const eventsPath = path.join(workspacePath, 'assignments', runId, 'logs', 'engine-events.jsonl')
    writeJsonl(eventsPath, [makeEvent({ type: 'run.completed' })])

    const result = await inspectTaskState({ taskId, sessionId })
    assert.equal(result.artifactPath, undefined)
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

// ─── transcriptSummary ────────────────────────────────────────────────────────

test('buildTranscriptSummary: returns last 20 messages from chat.jsonl', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const sessionId = '00000000-0000-0000-0000-000000000011'
    const taskId = '10000000-0000-0000-0000-000000000011'
    const runId = 'run-transcript'

    createTask(workspacePath, { sessionId, taskId, runId, status: 'running' })

    // Write 25 chat messages
    const chatPath = path.join(workspacePath, 'sessions', sessionId, 'chat.jsonl')
    const messages = Array.from({ length: 25 }, (_, i) => ({ role: 'user', text: `message ${i + 1}` }))
    writeJsonl(chatPath, messages)

    const result = await inspectTaskState({ taskId, sessionId })
    // Should contain last 20 messages (6-25) but not first 5
    assert.ok(result.transcriptSummary.includes('message 25'), 'should include last message')
    assert.ok(result.transcriptSummary.includes('message 6'), 'should include message 6 (20th from end)')
    assert.ok(!result.transcriptSummary.includes('message 5\n'), 'should not include message 5 (21st from end)')
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('buildTranscriptSummary: caps output at 2000 chars', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const sessionId = '00000000-0000-0000-0000-000000000012'
    const taskId = '10000000-0000-0000-0000-000000000012'
    const runId = 'run-truncate'

    createTask(workspacePath, { sessionId, taskId, runId, status: 'running' })

    // Write 10 messages with 300 chars each — total >2000
    const chatPath = path.join(workspacePath, 'sessions', sessionId, 'chat.jsonl')
    const longMessages = Array.from({ length: 10 }, (_, i) => ({
      role: 'assistant',
      text: `[${'x'.repeat(290)}] msg ${i}`,
    }))
    writeJsonl(chatPath, longMessages)

    const result = await inspectTaskState({ taskId, sessionId })
    assert.ok(result.transcriptSummary.length <= 2000, `summary too long: ${result.transcriptSummary.length}`)
    // Most recent content should be preserved (end of string trimming from start)
    assert.ok(result.transcriptSummary.includes('msg 9'), 'most recent message should be in summary')
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('buildTranscriptSummary: returns empty string when chat.jsonl absent', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const sessionId = '00000000-0000-0000-0000-000000000013'
    const taskId = '10000000-0000-0000-0000-000000000013'
    const runId = 'run-no-chat'

    createTask(workspacePath, { sessionId, taskId, runId, status: 'running' })
    // Do not write chat.jsonl

    const result = await inspectTaskState({ taskId, sessionId })
    assert.equal(result.transcriptSummary, '')
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

// ─── taskId scan across all sessions ──────────────────────────────────────────

test('inspectTaskState finds task without explicit sessionId', async () => {
  const workspacePath = makeWorkspace()
  try {
    process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspacePath
    const sessionId = '00000000-0000-0000-0000-000000000014'
    const taskId = '10000000-0000-0000-0000-000000000014'
    const runId = 'run-scan'

    createTask(workspacePath, { sessionId, taskId, runId, status: 'done' })

    // Call without sessionId — should scan and find it
    const result = await inspectTaskState({ taskId })
    assert.equal(result.taskId, taskId)
    assert.equal(result.status, 'done')
  } finally {
    delete process.env.TEAM_RUNTIME_WORKSPACE_PATH
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

// ─── RunEvent field mapping invariant ─────────────────────────────────────────

test('RunEvent field mapping: toRunEvent produces correct shape from EngineEventEnvelope', () => {
  // This tests the documented mapping in run-event-types.ts without invoking the full
  // inspectTaskState pipeline. We apply the mapping inline per the comment block.
  interface Envelope {
    schema_version: number; timestamp: string; tenant_id: string; category: string
    type: string; payload: Record<string, unknown>
    run_id?: string; level_id?: string | null; stage_type?: string | null
  }
  function toRunEvent(id: string, env: Envelope) {
    const p = env.payload
    return {
      id,
      type: env.type,
      ts: Date.parse(env.timestamp),
      stageType: env.stage_type ?? undefined,
      stageName: env.level_id ?? undefined,
      agentId: env.run_id ?? undefined,
      agentName: typeof p.agent_name === 'string' ? p.agent_name : undefined,
      content: typeof p.text === 'string' ? p.text : typeof p.content === 'string' ? p.content : undefined,
      stepIndex: typeof p.step_index === 'number' ? p.step_index : undefined,
      artifactIn: typeof p.input_artifact === 'string' ? p.input_artifact : undefined,
      artifactOut: typeof p.output_artifact === 'string' ? p.output_artifact : undefined,
      artifactPath: typeof p.path === 'string' ? p.path : undefined,
      errorMessage: typeof p.error === 'string' ? p.error : undefined,
    }
  }

  const envelope: Envelope = {
    schema_version: 1,
    timestamp: '2024-01-01T12:00:00.000Z',
    tenant_id: 'test',
    category: 'agent',
    type: 'agent.start',
    run_id: 'run-xyz',
    level_id: 'stage-1',
    stage_type: 'discussion',
    payload: {
      agent_name: 'Alice',
      text: 'Hello world',
      step_index: 3,
      input_artifact: 'in.md',
      output_artifact: 'out.md',
    },
  }

  const event = toRunEvent('evt-42', envelope)

  assert.equal(event.id, 'evt-42')
  assert.equal(event.type, 'agent.start')
  assert.equal(event.ts, Date.parse('2024-01-01T12:00:00.000Z'))
  assert.equal(event.stageType, 'discussion')
  assert.equal(event.stageName, 'stage-1')
  assert.equal(event.agentId, 'run-xyz')
  assert.equal(event.agentName, 'Alice')
  assert.equal(event.content, 'Hello world')
  assert.equal(event.stepIndex, 3)
  assert.equal(event.artifactIn, 'in.md')
  assert.equal(event.artifactOut, 'out.md')
  assert.equal(event.errorMessage, undefined)
})

test('RunEvent field mapping: content falls back to payload.content when payload.text absent', () => {
  function mapContent(payload: Record<string, unknown>): string | undefined {
    return typeof payload.text === 'string' ? payload.text
      : typeof payload.content === 'string' ? payload.content : undefined
  }
  assert.equal(mapContent({ content: 'fallback' }), 'fallback')
  assert.equal(mapContent({ text: 'primary' }), 'primary')
  assert.equal(mapContent({ text: 'primary', content: 'fallback' }), 'primary')
  assert.equal(mapContent({}), undefined)
})

// ─── TaskMode state transitions ────────────────────────────────────────────────

test('TaskMode: queued is a distinct valid value', () => {
  // This is a type-level contract: ensures the enum-equivalent covers all modes
  const validModes = ['setup', 'queued', 'running', 'done', 'error', 'cancelled'] as const
  assert.equal(validModes.length, 6)
  assert.ok(validModes.includes('queued'), 'queued must be in TaskMode')
  assert.ok(validModes.includes('cancelled'), 'cancelled must be in TaskMode')
})

test('TaskMode: setup -> queued -> running -> done is the happy path', () => {
  // Simulate valid transitions (no mutation needed — just documents the contract)
  function applyEvent(mode: string, event: string): string {
    if (mode === 'setup' && event === 'task:accept') return 'queued'
    if (mode === 'queued' && event === 'task:start') return 'running'
    if (mode === 'running' && event === 'task:done') return 'done'
    if (mode === 'running' && event === 'task:error') return 'error'
    if (mode === 'running' && event === 'task:cancel') return 'cancelled'
    return mode
  }

  assert.equal(applyEvent('setup', 'task:accept'), 'queued')
  assert.equal(applyEvent('queued', 'task:start'), 'running')
  assert.equal(applyEvent('running', 'task:done'), 'done')
  assert.equal(applyEvent('running', 'task:error'), 'error')
  assert.equal(applyEvent('running', 'task:cancel'), 'cancelled')
  // terminal states don't change
  assert.equal(applyEvent('done', 'task:start'), 'done')
  assert.equal(applyEvent('error', 'task:start'), 'error')
  assert.equal(applyEvent('cancelled', 'task:start'), 'cancelled')
})
