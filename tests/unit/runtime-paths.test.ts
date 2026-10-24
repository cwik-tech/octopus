import test from 'node:test'
import assert from 'node:assert/strict'
import * as os from 'node:os'
import * as path from 'node:path'

import type { RuntimeContext } from '../../domains/runtime/runtime-context.js'
import {
  RUNTIME_ASSIGNMENT_ID_ENV,
  RUNTIME_ASSIGNMENT_PATH_ENV,
  RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
  RUNTIME_RUN_ID_ENV,
  RUNTIME_RUN_PATH_ENV,
  RUNTIME_SESSION_ID_ENV,
  buildChildAssignmentLocation,
  buildRuntimeAssignmentEnvironment,
  getAssignmentPath,
  getCheckpointDirectory,
  getRunAttemptTemporaryPath,
  getRunRuntimePaths,
  resolveAssignmentPath,
  resolveRuntimeAssignmentLocation,
} from '../../domains/runtime/runtime-paths.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { RUN_PRIVATE_RUNTIME_DIRECTORY_NAME as CORE_RUN_PRIVATE_RUNTIME_DIRECTORY_NAME } from '../../core/run-assignment-location.js'

const workspacePath = path.resolve('/tmp/runtime-paths-workspace')

test('runtime paths re-export the canonical private directory name', () => {
  assert.equal(
    RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
    CORE_RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
  )
})

test('runtime assignment scope resolves canonical paths and roundtrips through child env', () => {
  const rootLocation = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'product-session',
    runId: 'run-1',
    assignmentId: 'root-assignment',
  })
  assert.ok(rootLocation)

  const childLocation = buildChildAssignmentLocation(
    workspacePath,
    rootLocation,
    'child-assignment',
  )
  assert.ok(childLocation)
  assert.equal(childLocation.sessionId, rootLocation.sessionId)
  assert.equal(childLocation.runId, rootLocation.runId)
  assert.equal(
    childLocation.assignmentPath,
    path.join(
      workspacePath,
      'sessions',
      'product-session',
      'runs',
      'run-1',
      'assignments',
      'child-assignment',
    ),
  )

  const environment = buildRuntimeAssignmentEnvironment(childLocation)
  assert.deepEqual(environment, {
    [RUNTIME_SESSION_ID_ENV]: 'product-session',
    [RUNTIME_RUN_ID_ENV]: 'run-1',
    [RUNTIME_ASSIGNMENT_ID_ENV]: 'child-assignment',
    [RUNTIME_ASSIGNMENT_PATH_ENV]: childLocation.assignmentPath,
    [RUNTIME_RUN_PATH_ENV]: childLocation.runPath,
  })
  assert.deepEqual(
    resolveRuntimeAssignmentLocation(workspacePath, environment),
    childLocation,
  )
})

test('runtime assignment scope fails closed for partial or forged path metadata', () => {
  assert.throws(
    () => resolveRuntimeAssignmentLocation(workspacePath, {
      [RUNTIME_SESSION_ID_ENV]: 'product-session',
      [RUNTIME_RUN_ID_ENV]: 'run-1',
    }),
    /required together/,
  )

  assert.throws(
    () => resolveRuntimeAssignmentLocation(workspacePath, {
      [RUNTIME_SESSION_ID_ENV]: 'product-session',
      [RUNTIME_RUN_ID_ENV]: 'run-1',
      [RUNTIME_ASSIGNMENT_ID_ENV]: 'assignment-1',
      [RUNTIME_ASSIGNMENT_PATH_ENV]: path.join(workspacePath, 'assignments', 'wrong'),
    }),
    /does not match the canonical runtime location/,
  )

  assert.throws(
    () => buildChildAssignmentLocation(
      workspacePath,
      buildSessionRunAssignmentLocation(workspacePath, {
        sessionId: 'product-session',
        runId: 'run-1',
        assignmentId: 'root-assignment',
      })!,
      '../escape',
    ),
    /Invalid child assignment id/,
  )
})

test('runtime paths use explicit assignment scope while unscoped CLI paths stay legacy', () => {
  const assignmentLocation = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'product-session',
    runId: 'run-1',
    assignmentId: 'assignment-1',
  })
  assert.ok(assignmentLocation)
  const scopedContext = {
    teamConfig: { workspace: { path: workspacePath } },
    state: { sessionId: 'legacy-looking-id' },
    assignmentLocation,
  } as unknown as RuntimeContext
  assert.equal(getAssignmentPath(scopedContext), assignmentLocation.assignmentPath)
  assert.equal(getCheckpointDirectory(scopedContext), assignmentLocation.assignmentPath)

  const legacyContext = {
    teamConfig: { workspace: { path: workspacePath } },
    state: { sessionId: 'direct-cli-session' },
  } as unknown as RuntimeContext
  assert.equal(
    getAssignmentPath(legacyContext),
    path.join(workspacePath, 'assignments', 'direct-cli-session'),
  )
  assert.equal(getCheckpointDirectory(legacyContext), workspacePath)
  assert.equal(resolveRuntimeAssignmentLocation(workspacePath, {}), undefined)
})

test('resolveAssignmentPath keeps root and child run IDs below assignments', () => {
  const workspacePath = path.join(os.tmpdir(), 'runtime-paths-workspace')

  assert.equal(
    resolveAssignmentPath(
      workspacePath,
      '00000000-0000-4000-8000-000000000001',
    ),
    path.resolve(
      workspacePath,
      'assignments',
      '00000000-0000-4000-8000-000000000001',
    ),
  )
  assert.equal(
    resolveAssignmentPath(
      workspacePath,
      'child-writing-team-00000000-0000-4000-8000-000000000002',
    ),
    path.resolve(
      workspacePath,
      'assignments',
      'child-writing-team-00000000-0000-4000-8000-000000000002',
    ),
  )
})

test('resolveAssignmentPath rejects structural and encoded traversal IDs', () => {
  const workspacePath = path.join(os.tmpdir(), 'runtime-paths-workspace')

  for (const runId of [
    '',
    '.',
    '..',
    '../escape',
    'nested/run',
    'nested\\run',
    '%2e%2e%2fescape',
    '%252e%252e%252fescape',
  ]) {
    assert.throws(
      () => resolveAssignmentPath(workspacePath, runId),
      /Invalid run ID/,
    )
  }
})

test('getRunRuntimePaths resolves private state below the exact assignment', () => {
  const assignmentPath = path.join(
    os.tmpdir(),
    'runtime-paths-workspace',
    'assignments',
    'run-a',
  )
  const paths = getRunRuntimePaths(assignmentPath)

  assert.deepEqual(paths, {
    assignmentPath: path.resolve(assignmentPath),
    privateRuntimePath: path.resolve(assignmentPath, '.runtime'),
    checkpointPath: path.resolve(
      assignmentPath,
      '.runtime',
      'checkpoint.json',
    ),
    temporaryPath: path.resolve(assignmentPath, '.runtime', 'tmp'),
  })
})

test('run and attempt paths remain isolated for concurrent executions', () => {
  const workspacePath = path.join(os.tmpdir(), 'runtime-paths-workspace')
  const firstAssignmentPath = resolveAssignmentPath(workspacePath, 'run-a')
  const secondAssignmentPath = resolveAssignmentPath(workspacePath, 'run-b')
  const firstPaths = getRunRuntimePaths(firstAssignmentPath)
  const secondPaths = getRunRuntimePaths(secondAssignmentPath)

  assert.notEqual(firstPaths.checkpointPath, secondPaths.checkpointPath)
  assert.notEqual(firstPaths.temporaryPath, secondPaths.temporaryPath)
  assert.notEqual(
    getRunAttemptTemporaryPath(firstAssignmentPath, 'attempt-a'),
    getRunAttemptTemporaryPath(firstAssignmentPath, 'attempt-b'),
  )
  assert.equal(
    getRunAttemptTemporaryPath(firstAssignmentPath, 'attempt-a'),
    path.join(firstPaths.temporaryPath, 'attempt-a'),
  )
})

test('runtime path helpers reject missing paths and unsafe attempt IDs', () => {
  assert.throws(
    () => getRunRuntimePaths('  '),
    /Assignment path must be a non-empty filesystem path/,
  )
  assert.throws(
    () => resolveAssignmentPath('', 'run-a'),
    /Workspace path must be a non-empty filesystem path/,
  )
  assert.throws(
    () => getRunAttemptTemporaryPath('/tmp/assignments/run-a', '../attempt'),
    /Invalid execution attempt ID/,
  )
})
