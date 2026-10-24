import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { logRuntimeEvent, logSessionStart } from '../../domains/runtime/logger.js'
import {
  buildSessionRunAssignmentLocation,
  writeRunAssignmentLocator,
} from '../../domains/run/run-location.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'run-store-compatibility-'))
}

test('RunStore reads both layouts and prefers nested duplicate assignments', async () => {
  const workspacePath = makeWorkspace()
  try {
    const duplicateId = 'duplicate-run'
    const legacyDuplicate = path.join(workspacePath, 'assignments', duplicateId)
    fs.mkdirSync(legacyDuplicate, { recursive: true })
    writeRun(legacyDuplicate, duplicateId, 'run.failed')
    fs.writeFileSync(path.join(legacyDuplicate, 'result.txt'), 'legacy')

    const nestedDuplicate = await createNestedAssignment({
      workspacePath,
      sessionId: 'session-1',
      runId: duplicateId,
      assignmentId: duplicateId,
    })
    writeRun(nestedDuplicate, duplicateId, 'run.completed')
    fs.writeFileSync(path.join(nestedDuplicate, 'result.txt'), 'nested')

    const legacyOnlyId = 'legacy-only'
    const legacyOnly = path.join(workspacePath, 'assignments', legacyOnlyId)
    fs.mkdirSync(legacyOnly, { recursive: true })
    writeRun(legacyOnly, legacyOnlyId, 'run.completed')

    const nestedOnlyId = 'nested-only'
    const nestedOnly = await createNestedAssignment({
      workspacePath,
      sessionId: 'session-1',
      runId: nestedOnlyId,
      assignmentId: nestedOnlyId,
    })
    writeRun(nestedOnly, nestedOnlyId, 'run.completed')

    const store = new FileSystemRunStore(workspacePath)
    const duplicate = await store.getRun(duplicateId)
    const duplicateArtifact = await store.readArtifact(duplicateId, 'result.txt')
    const runIds = (await store.listRuns()).map((run) => run.id).sort()

    assert.equal(duplicate?.assignmentPath, nestedDuplicate)
    assert.equal(duplicate?.status, 'completed')
    assert.equal(duplicateArtifact?.content, 'nested')
    assert.deepEqual(runIds, [duplicateId, legacyOnlyId, nestedOnlyId].sort())
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('RunStore aggregates indexed nested and legacy child events', async () => {
  const workspacePath = makeWorkspace()
  try {
    const rootId = 'root-run'
    const rootPath = await createNestedAssignment({
      workspacePath,
      sessionId: 'session-2',
      runId: rootId,
      assignmentId: rootId,
    })
    writeRun(rootPath, rootId, 'run.completed')

    const nestedChildId = 'nested-child'
    const nestedChildPath = await createNestedAssignment({
      workspacePath,
      sessionId: 'session-2',
      runId: rootId,
      assignmentId: nestedChildId,
    })
    writeChildEvent(nestedChildPath, nestedChildId, rootId, 'artifact.nested')

    const legacyChildId = 'legacy-child'
    const legacyChildPath = path.join(workspacePath, 'assignments', legacyChildId)
    fs.mkdirSync(legacyChildPath, { recursive: true })
    writeChildEvent(legacyChildPath, legacyChildId, rootId, 'artifact.legacy')

    const events = await new FileSystemRunStore(workspacePath).listRunEvents(rootId)
    assert.equal(events.some((event) => event.type === 'artifact.nested'), true)
    assert.equal(events.some((event) => event.type === 'artifact.legacy'), true)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

async function createNestedAssignment(params: {
  workspacePath: string
  sessionId: string
  runId: string
  assignmentId: string
}): Promise<string> {
  const location = buildSessionRunAssignmentLocation(params.workspacePath, params)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })
  await writeRunAssignmentLocator(params.workspacePath, location)
  return location.assignmentPath
}

function writeRun(
  assignmentPath: string,
  runId: string,
  terminalEvent: 'run.completed' | 'run.failed',
): void {
  logSessionStart(assignmentPath, runId, 'example-team', ['example-agent'], runId)
  logRuntimeEvent(assignmentPath, {
    timestamp: new Date().toISOString(),
    event: terminalEvent,
    session_id: runId,
    root_session_id: runId,
    assignment_path: assignmentPath,
    team: 'example-team',
  })
}

function writeChildEvent(
  assignmentPath: string,
  runId: string,
  rootRunId: string,
  event: string,
): void {
  logRuntimeEvent(assignmentPath, {
    timestamp: new Date().toISOString(),
    event,
    session_id: runId,
    root_session_id: rootRunId,
    assignment_path: assignmentPath,
    team: 'example-team',
  })
}
