import assert from 'node:assert/strict'
import * as os from 'node:os'
import test from 'node:test'

import type { SessionTask } from '../../contracts/sessions.js'
import { terminateTaskProcess } from '../../domains/sessions/task-process-supervisor.js'

function runningTask(): SessionTask {
  return {
    id: 'cancel-race',
    sessionId: 'cancel-race-session',
    runId: 'cancel-race-run',
    workflowId: 'cancel-race-workflow',
    brief: 'Wait until cancelled.',
    status: 'running',
    createdAt: new Date(0).toISOString(),
    cwd: os.tmpdir(),
    pid: 4242,
    processGroupId: 4242,
  }
}

function permissionDenied(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('kill EPERM')
  error.code = 'EPERM'
  return error
}

// On macOS a process group whose only member has exited but not been reaped
// refuses every signal with EPERM. A task that exits between the liveness
// check and the signal leaves its group in exactly that state.
test('a task whose process group exits between the liveness check and the signal is reported exited', {
  // On Windows the supervisor signals the pid, and there is no process group.
  skip: process.platform === 'win32',
}, async () => {
  let groupExited = false
  let signalledTarget: number | undefined
  const outcome = await terminateTaskProcess(runningTask(), {
    allowUnverifiedIdentity: true,
    isProcessAlive: () => !groupExited,
    signalProcess: (target) => {
      signalledTarget = target
      groupExited = true
      throw permissionDenied()
    },
  })

  assert.equal(signalledTarget, -4242, 'the signal goes to the task process group')
  assert.equal(outcome, 'exited')
})

test('a signal refused while the process group is still alive is reported, not treated as an exit', async () => {
  await assert.rejects(
    terminateTaskProcess(runningTask(), {
      allowUnverifiedIdentity: true,
      isProcessAlive: () => true,
      signalProcess: () => {
        throw permissionDenied()
      },
    }),
    { code: 'EPERM' },
  )
})
