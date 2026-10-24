import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  RUNTIME_PROCESS_IDENTITY_ENV,
  RUNTIME_TASK_ID_ENV,
} from '../../contracts/runtime-capability-authority.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { prepareDelegatedRuntimeAssignmentAuthority } from '../../domains/run/runtime-assignment-authority.js'
import { seedCanaryRuntimeAuthority } from '../live/journal-canary-authority.js'

/**
 * The managed parent identity a direct `runWorkflow` caller must seed.
 *
 * `prepareDelegatedRuntimeAssignmentAuthority` reads the identity from
 * `process.env` (`domains/run/runtime-assignment-authority.ts:40-46`), and in
 * production `services/task-service.ts:577-582` seeds it when launching the
 * task. A caller that passes `taskId` and `executionAttemptId` as *options*
 * only — which the live canary did — leaves the environment empty, the
 * authority correctly resolves to `undefined`, and the child team runtime then
 * fails closed with "Managed Team Runtime capability authority is unavailable".
 *
 * That was a canary fixture defect, not missing production wiring. These cases
 * pin the propagation the fixture has to perform, and the fail-closed lineage
 * it must not paper over.
 */
function makeWorkspace(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'canary-authority-')),
  )
}

function withClearedIdentity<T>(run: () => T): T {
  const previousTask = process.env[RUNTIME_TASK_ID_ENV]
  const previousIdentity = process.env[RUNTIME_PROCESS_IDENTITY_ENV]
  delete process.env[RUNTIME_TASK_ID_ENV]
  delete process.env[RUNTIME_PROCESS_IDENTITY_ENV]
  try {
    return run()
  } finally {
    if (previousTask === undefined) delete process.env[RUNTIME_TASK_ID_ENV]
    else process.env[RUNTIME_TASK_ID_ENV] = previousTask
    if (previousIdentity === undefined) delete process.env[RUNTIME_PROCESS_IDENTITY_ENV]
    else process.env[RUNTIME_PROCESS_IDENTITY_ENV] = previousIdentity
  }
}

test('an unseeded environment yields no delegated authority, which is what failed the canary', async () => {
  const workspacePath = makeWorkspace()
  try {
    const scope = { sessionId: 'session-a', runId: 'run-a', assignmentId: 'run-a' }
    const location = buildSessionRunAssignmentLocation(workspacePath, scope)
    assert.ok(location)

    const authority = await withClearedIdentity(() =>
      prepareDelegatedRuntimeAssignmentAuthority({
        workspacePath,
        parentLocation: location,
        childLocation: location,
        environment: process.env,
      }),
    )
    assert.equal(
      authority,
      undefined,
      'without a seeded managed identity there is no authority to delegate',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('seeding the canary identity makes the managed parent authority resolvable', async () => {
  const workspacePath = makeWorkspace()
  const restore = seedCanaryRuntimeAuthority({
    taskId: 'task-canary',
    processIdentity: 'attempt-canary',
  })
  try {
    assert.equal(process.env[RUNTIME_TASK_ID_ENV], 'task-canary')
    assert.equal(process.env[RUNTIME_PROCESS_IDENTITY_ENV], 'attempt-canary')

    const scope = { sessionId: 'session-b', runId: 'run-b', assignmentId: 'run-b' }
    const parent = buildSessionRunAssignmentLocation(workspacePath, scope)
    assert.ok(parent)
    const child = buildSessionRunAssignmentLocation(workspacePath, {
      ...scope,
      assignmentId: 'child-b',
    })
    assert.ok(child)
    fs.mkdirSync(child.assignmentPath, { recursive: true })

    const authority = await prepareDelegatedRuntimeAssignmentAuthority({
      workspacePath,
      parentLocation: parent,
      childLocation: child,
      environment: process.env,
    })
    assert.ok(
      authority,
      'a seeded identity with a same-session parent and child delegates authority',
    )
  } finally {
    restore()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('the seeded identity is fully restored, so one arm cannot leak into the next', () => {
  const before = {
    task: process.env[RUNTIME_TASK_ID_ENV],
    identity: process.env[RUNTIME_PROCESS_IDENTITY_ENV],
  }
  const restore = seedCanaryRuntimeAuthority({
    taskId: 'task-leak',
    processIdentity: 'attempt-leak',
  })
  restore()
  assert.deepEqual(
    {
      task: process.env[RUNTIME_TASK_ID_ENV],
      identity: process.env[RUNTIME_PROCESS_IDENTITY_ENV],
    },
    before,
    'restoring returns both variables to exactly their prior state',
  )
})

test('an incomplete identity fails closed rather than half-authorising', async () => {
  const workspacePath = makeWorkspace()
  const previous = process.env[RUNTIME_TASK_ID_ENV]
  const previousIdentity = process.env[RUNTIME_PROCESS_IDENTITY_ENV]
  process.env[RUNTIME_TASK_ID_ENV] = 'task-only'
  delete process.env[RUNTIME_PROCESS_IDENTITY_ENV]
  try {
    const scope = { sessionId: 'session-c', runId: 'run-c', assignmentId: 'run-c' }
    const location = buildSessionRunAssignmentLocation(workspacePath, scope)
    assert.ok(location)
    await assert.rejects(
      prepareDelegatedRuntimeAssignmentAuthority({
        workspacePath,
        parentLocation: location,
        childLocation: location,
        environment: process.env,
      }),
      /incomplete/i,
      'half an identity is refused, never treated as absent',
    )
  } finally {
    if (previous === undefined) delete process.env[RUNTIME_TASK_ID_ENV]
    else process.env[RUNTIME_TASK_ID_ENV] = previous
    if (previousIdentity === undefined) delete process.env[RUNTIME_PROCESS_IDENTITY_ENV]
    else process.env[RUNTIME_PROCESS_IDENTITY_ENV] = previousIdentity
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
