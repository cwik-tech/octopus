import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { launchSessionTask } from '../../services/task-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { SessionTaskRunnerLauncher } from '../../domains/sessions/session-task-launcher.js'
import { defaultIsProcessAlive } from '../../domains/sessions/task-process-supervisor.js'

async function waitForTask(
  store: FileSystemSessionStore,
  sessionId: string,
  predicate: (task: NonNullable<Awaited<ReturnType<FileSystemSessionStore['getTaskRecord']>>>) => boolean,
  timeoutMs = 4_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const tasks = await store.listTaskRecords(sessionId)
    const task = tasks.find(predicate)
    if (task) return task
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for session task state')
}

async function waitForProcessStop(target: number, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (defaultIsProcessAlive(target) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(defaultIsProcessAlive(target), false)
}

test('real session runner executes the sealed workflow snapshot from the nested assignment', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'session-run-snapshot-'))
  const registryPath = path.join(workspacePath, 'workflow-registry.yaml')
  const liveWorkflowPath = path.join(workspacePath, 'live-workflow.yaml')
  const previousDelay = process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS
  const previousDryRun = process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
  process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS = '750'
  delete process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN

  const originalWorkflow = [
    'workflow:',
    '  id: snapshot-workflow',
    '  steps:',
    '    - id: execute',
    '      type: team',
    '      team: snapshot-original-missing-team',
    '      input_artifact: incoming-brief.md',
    '      result_artifact: result.md',
    '  output:',
    '    from_step: execute',
    '    artifact: result.md',
    '',
  ].join('\n')
  fs.writeFileSync(
    registryPath,
    'snapshot-workflow:\n  template_path: ./live-workflow.yaml\n',
  )
  fs.writeFileSync(liveWorkflowPath, originalWorkflow)

  const store = new FileSystemSessionStore(workspacePath)
  let sessionId: string | undefined
  try {
    const session = await store.createSession({ title: 'Real sealed workflow' })
    sessionId = session.id
    await store.saveUploadedFile(session.id, {
      filename: 'evidence.txt',
      contents: Buffer.from('sealed evidence'),
    })

    const launchPromise = launchSessionTask({
      sessionId: session.id,
      sessionStore: store,
      taskLauncher: new SessionTaskRunnerLauncher(process.cwd()),
      repoRootPath: process.cwd(),
      workspacePath,
      workflowsRegistryPath: registryPath,
      workflowId: 'snapshot-workflow',
      briefMarkdown: '# Task Brief\n\nUse the workflow snapshot.\n',
    })

    const queued = await waitForTask(
      store,
      session.id,
      (task) => Boolean(task.workflowSnapshotPath && fs.existsSync(task.workflowSnapshotPath)),
    )
    fs.writeFileSync(
      liveWorkflowPath,
      originalWorkflow.replace(
        'snapshot-original-missing-team',
        'mutated-live-missing-team',
      ),
    )

    await launchPromise

    // What this test is about is which workflow definition the run used: the
    // one sealed at launch, not the file mutated afterwards. The launch call's
    // own return value is not that contract. It reports whether startup was
    // acknowledged, and acknowledgement is recorded before the registry is
    // loaded and the unknown Team is rejected, so it can resolve `ok: true`
    // while the failure is still being written. Waiting for the task itself to
    // reach `failed` observes the outcome rather than the timing of the report.
    const failed = await waitForTask(
      store,
      session.id,
      (task) => task.id === queued.id && task.status === 'failed',
    )
    assert.match(failed.error ?? '', /snapshot-original-missing-team/)
    assert.doesNotMatch(failed.error ?? '', /mutated-live-missing-team/)
    assert.ok(failed.assignmentPath)
    assert.equal(
      failed.assignmentPath,
      path.join(
        workspacePath,
        'sessions',
        session.id,
        'runs',
        failed.runId,
        'assignments',
        failed.assignmentId ?? failed.runId,
      ),
    )
    assert.equal(fs.readFileSync(failed.workflowSnapshotPath!, 'utf8'), originalWorkflow)
    assert.equal(
      fs.readFileSync(
        path.join(failed.inputSnapshotPath!, 'files', 'evidence.txt'),
        'utf8',
      ),
      'sealed evidence',
    )
    assert.equal(fs.existsSync(path.join(failed.assignmentPath, 'job-request.md')), true)
    assert.equal(fs.existsSync(path.join(workspacePath, 'assignments', failed.runId)), false)
    if (failed.pid) {
      await waitForProcessStop(
        process.platform === 'win32'
          ? failed.pid
          : -(failed.processGroupId ?? failed.pid),
      )
    }
    assert.equal(await store.deleteSession(session.id), true)
    sessionId = undefined
  } finally {
    if (sessionId) await store.deleteSession(sessionId).catch(() => undefined)
    if (previousDelay === undefined) {
      delete process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS
    } else {
      process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS = previousDelay
    }
    if (previousDryRun === undefined) {
      delete process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
    } else {
      process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = previousDryRun
    }
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
