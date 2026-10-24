import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { startApiServer } from '../../server/api-server.js'
import { logRuntimeEvent, logSessionStart } from '../../domains/runtime/logger.js'
import { resolveRunAssignmentLocation } from '../../domains/run/run-location.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { SessionTaskRunnerLauncher } from '../../domains/sessions/session-task-launcher.js'
import type { SessionTask } from '../../contracts/sessions.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-scoped-run-e2e-'))
}

function makeTreeWritable(entryPath: string): void {
  const stat = fs.lstatSync(entryPath, { throwIfNoEntry: false })
  if (!stat || stat.isSymbolicLink()) return
  if (stat.isDirectory()) {
    fs.chmodSync(entryPath, 0o700)
    for (const entry of fs.readdirSync(entryPath)) {
      makeTreeWritable(path.join(entryPath, entry))
    }
    return
  }
  if (stat.isFile()) fs.chmodSync(entryPath, 0o600)
}

async function waitForTerminalTask(
  apiUrl: string,
  sessionId: string,
  taskId: string,
  timeoutMs = 10_000,
): Promise<SessionTask> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(
      `${apiUrl}/sessions/${sessionId}/tasks/${taskId}`,
    )
    assert.equal(response.status, 200)
    const task = (await response.json()) as SessionTask
    if (['done', 'failed', 'blocked', 'cancelled'].includes(task.status)) {
      return task
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Task ${taskId} did not finish within ${timeoutMs}ms`)
}

test('real session API and worker write a sealed nested run while legacy runs remain readable', async () => {
  const workspacePath = makeWorkspace()
  const repoRootPath = process.cwd()
  const workflowsRegistryPath = path.join(
    repoRootPath,
    'workflows',
    'registry.yaml',
  )
  const previousDryRun = process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
  process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = '1'

  const legacyPath = path.join(workspacePath, 'assignments', 'legacy-e2e-run')
  fs.mkdirSync(legacyPath, { recursive: true })
  logSessionStart(
    legacyPath,
    'legacy-e2e-run',
    'legacy-team',
    ['legacy-agent'],
    'legacy-e2e-run',
  )
  logRuntimeEvent(legacyPath, {
    timestamp: new Date().toISOString(),
    event: 'run.completed',
    session_id: 'legacy-e2e-run',
    root_session_id: 'legacy-e2e-run',
    assignment_path: legacyPath,
    team: 'legacy-team',
  })

  const sessionStore = new FileSystemSessionStore(workspacePath)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new PiRunLauncher(),
    taskLauncher: new SessionTaskRunnerLauncher(repoRootPath),
    sessionStore,
    repoRootPath,
    workspacePath,
    workflowsRegistryPath,
  })

  try {
    const sessionResponse = await fetch(`${server.url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Scoped storage E2E' }),
    })
    assert.equal(sessionResponse.status, 201)
    const session = (await sessionResponse.json()) as { id: string }

    const uploadResponse = await fetch(
      `${server.url}/sessions/${session.id}/files`,
      {
        method: 'POST',
        headers: { 'x-filename': 'source.txt' },
        body: 'original-session-input',
      },
    )
    assert.equal(uploadResponse.status, 201)

    const taskResponse = await fetch(
      `${server.url}/sessions/${session.id}/tasks`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workflowId: 'discussion-to-executive-summary',
          brief: 'Exercise the session-scoped storage boundary.',
        }),
      },
    )
    const taskResponseBody = await taskResponse.text()
    assert.equal(taskResponse.status, 202, taskResponseBody)
    const launchedTask = JSON.parse(taskResponseBody) as SessionTask
    const completed = await waitForTerminalTask(
      server.url,
      session.id,
      launchedTask.id,
    )
    assert.equal(completed.status, 'done', completed.error)
    assert.equal(completed.assignmentId, completed.runId)
    assert.ok(completed.runPath)
    assert.ok(completed.assignmentPath)
    assert.ok(completed.inputSnapshotPath)
    assert.ok(completed.workflowSnapshotPath)

    const expectedRunPath = path.join(
      workspacePath,
      'sessions',
      session.id,
      'runs',
      completed.runId,
    )
    assert.equal(completed.runPath, expectedRunPath)
    assert.equal(
      completed.assignmentPath,
      path.join(expectedRunPath, 'assignments', completed.runId),
    )
    assert.equal(
      fs.existsSync(path.join(workspacePath, 'assignments', completed.runId)),
      false,
    )

    const indexed = resolveRunAssignmentLocation(workspacePath, completed.runId)
    assert.equal(indexed?.layout, 'session')
    assert.equal(indexed?.assignmentPath, completed.assignmentPath)

    const snapshottedInput = path.join(
      completed.inputSnapshotPath,
      'files',
      'source.txt',
    )
    assert.equal(fs.readFileSync(snapshottedInput, 'utf8'), 'original-session-input')
    fs.writeFileSync(
      path.join(workspacePath, 'sessions', session.id, 'inputs', 'source.txt'),
      'changed-after-launch',
    )
    assert.equal(fs.readFileSync(snapshottedInput, 'utf8'), 'original-session-input')

    const snapshotManifest = JSON.parse(
      fs.readFileSync(
        path.join(completed.inputSnapshotPath, 'manifest.json'),
        'utf8',
      ),
    ) as {
      sessionId: string
      runId: string
      files: Array<{ path: string; sha256: string }>
      workflow?: { sha256: string }
      runPlan?: { sha256: string }
    }
    assert.equal(snapshotManifest.sessionId, session.id)
    assert.equal(snapshotManifest.runId, completed.runId)
    assert.equal(snapshotManifest.files[0]?.path, 'files/source.txt')
    assert.match(snapshotManifest.files[0]?.sha256 ?? '', /^[a-f0-9]{64}$/)
    assert.match(snapshotManifest.workflow?.sha256 ?? '', /^[a-f0-9]{64}$/)
    assert.match(snapshotManifest.runPlan?.sha256 ?? '', /^[a-f0-9]{64}$/)

    const resultArtifact = `workflow-discussion-to-executive-summary-result.md`
    const nestedArtifactResponse = await fetch(
      `${server.url}/runs/${completed.runId}/assignments/${resultArtifact}`,
    )
    assert.equal(nestedArtifactResponse.status, 200)
    assert.match(await nestedArtifactResponse.text(), /Dry-run task runner completed/)

    const legacyResponse = await fetch(`${server.url}/runs/legacy-e2e-run`)
    assert.equal(legacyResponse.status, 200)
    const runsResponse = await fetch(`${server.url}/runs`)
    const runs = (await runsResponse.json()) as {
      runs: Array<{ id: string }>
    }
    assert.ok(runs.runs.some((run) => run.id === completed.runId))
    assert.ok(runs.runs.some((run) => run.id === 'legacy-e2e-run'))

    const deleteSessionResponse = await fetch(
      `${server.url}/sessions/${session.id}`,
      { method: 'DELETE' },
    )
    assert.equal(deleteSessionResponse.status, 204)
    assert.equal(resolveRunAssignmentLocation(workspacePath, completed.runId), null)
    assert.equal(fs.existsSync(expectedRunPath), false)
    assert.equal(fs.existsSync(legacyPath), true)
  } finally {
    await server.close()
    if (previousDryRun === undefined) {
      delete process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
    } else {
      process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = previousDryRun
    }
    makeTreeWritable(workspacePath)
    fs.rmSync(workspacePath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    })
  }
})
