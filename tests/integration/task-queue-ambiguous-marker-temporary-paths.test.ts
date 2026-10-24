/**
 * A cancelled task's attempt keeps its temporary folders while processes
 * carrying its marker are still alive (matrix A5.1, the second finding).
 *
 * The rule: recovery reconciles a task as stopped only once no process that
 * may still run it is alive, and it never acts on a process it cannot verify
 * (`domains/sessions/task-recovery-manager.ts:372-398`). The attempt's
 * temporary folders are removed only when cleanup reports the process stopped
 * (`:244-250`). A delegated child uses its attempt folder under
 * `.runtime/tmp` as its TMPDIR, and that folder holds the attempt's copy of
 * the user's Pi credentials (`domains/agent-execution/agent-runner.ts:892-1001`),
 * so removing it while the child runs pulls its working files out from under it.
 *
 * The case: the cancelled task records no process target, and its identity
 * marker is carried by two live processes in separate groups, so no process
 * can be verified as the task's own. The queue keeps the task's slot and asks
 * the store to reconcile it.
 *
 * Substituted boundaries: the two workers are plain detached node processes
 * carrying the real `--runtime-process-identity` marker, so the store's real
 * `ps` probe classifies them. Each also carries a fixture marker of its own,
 * which cleanup verifies before every signal. No probe is mocked. The launcher
 * only records launches; no task runner runs. The store and the queue read one
 * fixed clock.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { requiredValue } from '../../core/required-value.js'
import { buildSessionRunAssignmentLocation } from '../../core/run-assignment-location.js'
import { TASK_QUEUE_EVENT_FILENAME } from '../../core/task-queue-events.js'
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import type { TaskAdmission } from '../../contracts/sessions.js'
import type { RunLauncher } from '../../domains/run/run-launcher.js'
import type { RunStartRequest } from '../../domains/run/run-store.js'
import {
  ensureRunPrivateRuntimeDirectory,
  getRunAttemptTemporaryPath,
} from '../../domains/runtime/runtime-paths.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import {
  classifyTaskProcessesByIdentity,
  PROCESS_IDENTITY_ARGUMENT,
} from '../../domains/sessions/task-process-supervisor.js'
import { TaskQueue } from '../../services/task-queue.js'
import { FileSystemWorkflowStateStore } from '../../workflows/workflow-state-store.js'
import { hashWorkflowContent } from '../../workflows/workflow-state-validation.js'
import { stopProcessCarrying } from '../support/owned-processes.js'

const FIXED_NOW = new Date('2026-01-01T09:00:00.000Z')
const TEST_TICK_INTERVAL_MS = 60_000
const CHILD_RUN_ID = 'answer-child-run'

/** A fixture worker, registered by pid and the fixture marker only it carries. */
interface FixtureWorker {
  readonly pid: number
  readonly marker: string
}

/** Records launches; nothing is waiting, so none is expected. */
class RecordingLauncher implements RunLauncher {
  readonly launches: string[] = []

  async startRun(request: RunStartRequest): Promise<never> {
    this.launches.push(request.env?.TEAM_RUNTIME_TASK_ID ?? 'unknown task')
    return await new Promise<never>(() => undefined)
  }
}

/**
 * Starts a detached worker in its own group that carries the task's marker and
 * a fixture marker of its own, with the attempt's folder as its TMPDIR. It is
 * registered as soon as it has a pid, before anything else can fail.
 */
async function startMarkedWorker(params: {
  processIdentity: string
  attemptTemporaryPath: string
  workers: FixtureWorker[]
}): Promise<void> {
  const marker = `--coverage-fixture-worker=${randomUUID()}`
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1e9)', '--', `${PROCESS_IDENTITY_ARGUMENT}${params.processIdentity}`, marker],
    { detached: true, stdio: 'ignore', env: { TMPDIR: params.attemptTemporaryPath } },
  )
  if (child.pid !== undefined) params.workers.push({ pid: child.pid, marker })
  await once(child, 'spawn')
}

function grantedAdmission(
  executionAttemptId: string,
): Extract<TaskAdmission, { phase: 'granted' }> {
  const at = FIXED_NOW.toISOString()
  return {
    version: 1,
    phase: 'granted',
    requestId: `request-${executionAttemptId}`,
    order: '1',
    requestedAt: at,
    executionKind: 'initial',
    source: 'apply',
    expectedExecutionAttemptId: null,
    grantId: `grant-${executionAttemptId}`,
    ownerEpoch: 'launching-owner-epoch',
    grantedAt: at,
    executionAttemptId,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The queue's cancelled-cleanup requests for one task, from its event log. */
function cleanupRequests(workspacePath: string, taskId: string): number {
  const eventsPath = path.join(workspacePath, 'task-queue', TASK_QUEUE_EVENT_FILENAME)
  if (!fs.existsSync(eventsPath)) return 0
  return fs
    .readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): unknown => JSON.parse(line))
    .filter(isRecord)
    .filter((event) =>
      event.event === 'task_queue.reconciled' &&
      event.reason === 'cancelled_process_cleanup' &&
      event.task_id === taskId,
    )
    .length
}

test('a cancelled task whose marker two live processes carry keeps its attempt\'s temporary folders', {
  timeout: 60_000,
  skip: process.platform === 'win32',
}, async (t) => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-ambiguous-temporary-'))
  const store = new FileSystemSessionStore(workspacePath, {
    instanceId: 'desktop-owner',
    now: () => FIXED_NOW,
  })
  const launcher = new RecordingLauncher()
  const workers: FixtureWorker[] = []
  let owner: WorkspaceDispatcherOwner | undefined
  let queue: TaskQueue | undefined
  let processIdentity: string | undefined

  // Every cleanup is attempted, whatever failed before it. The workspace is
  // kept for inspection when a worker could not be stopped.
  t.after(async () => {
    const failures: unknown[] = []
    const attempt = async (step: () => Promise<void>): Promise<void> => {
      try {
        await step()
      } catch (error) {
        failures.push(error)
      }
    }
    await attempt(async () => { await queue?.close(1) })
    const stops = await Promise.allSettled(
      workers.map((worker) => stopProcessCarrying(worker.pid, worker.marker)),
    )
    for (const stop of stops) if (stop.status === 'rejected') failures.push(stop.reason)
    await attempt(async () => { await owner?.release() })
    if (processIdentity !== undefined) {
      const left = classifyTaskProcessesByIdentity(processIdentity)
      if (left.kind !== 'absent') {
        failures.push(new Error(`Processes still carry the task's marker: ${JSON.stringify(left.matches)}`))
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Fixture cleanup failed; workspace kept at ${workspacePath}`)
    }
    fs.rmSync(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  const session = await store.createSession({ title: 'Ambiguous cancellation' })
  const created = requiredValue(
    await store.createTaskRecord(session.id, {
      workflowId: 'ambiguous-cleanup-workflow',
      brief: 'Keep the attempt folder while its workers may still run.',
    }),
    'created task',
  )
  assert.ok(created.assignmentId, 'the task uses the session run layout the recovery resolves')
  const executionAttemptId = `attempt-${created.id}`
  processIdentity = executionAttemptId

  // The workflow's one step ran as a delegated child in its own assignment.
  const stateStore = new FileSystemWorkflowStateStore(
    requiredValue(created.assignmentPath, 'task assignment path'),
  )
  await stateStore.initialize({
    manifest: {
      taskId: created.id,
      sessionId: session.id,
      rootRunId: created.runId,
      workflowId: created.workflowId,
      workflowDefinitionHash: hashWorkflowContent('ambiguous-cleanup-workflow'),
      briefHash: hashWorkflowContent(created.brief),
      teamDefinitionHashes: { writers: hashWorkflowContent('writers') },
      runtimeVersion: 'fixture-v1',
    },
    executionAttemptId,
    steps: [{
      stepId: 'write',
      stepIndex: 0,
      stepType: 'team',
      team: 'writers',
      childRunId: CHILD_RUN_ID,
      definitionHash: hashWorkflowContent('write'),
      recoveryPolicy: 'safe_retry',
      inputArtifact: 'incoming-brief.md',
      resultArtifact: 'answer.md',
      requestedResultType: 'artifact:answer.md',
    }],
  })
  await stateStore.update({ expectedRevision: 0, executionAttemptId, mutate: (draft) => {
    const step = requiredValue(draft.steps[0], 'workflow step')
    step.status = 'launching'
    step.attemptCount = 1
    draft.currentStepId = step.stepId
  } })
  await stateStore.update({ expectedRevision: 1, executionAttemptId, mutate: (draft) => {
    requiredValue(draft.steps[0], 'workflow step').status = 'running'
  } })

  // The child's attempt folder, made as the agent runner makes it.
  const childLocation = requiredValue(
    buildSessionRunAssignmentLocation(workspacePath, {
      sessionId: session.id,
      runId: created.runId,
      assignmentId: CHILD_RUN_ID,
    }),
    'child assignment location',
  )
  fs.mkdirSync(childLocation.assignmentPath, { recursive: true })
  ensureRunPrivateRuntimeDirectory(childLocation.assignmentPath)
  const attemptTemporaryPath = getRunAttemptTemporaryPath(childLocation.assignmentPath, randomUUID())
  fs.mkdirSync(attemptTemporaryPath, { recursive: true, mode: 0o700 })
  const workingFile = path.join(attemptTemporaryPath, 'in-use.txt')
  fs.writeFileSync(workingFile, 'A live worker is using this file.')

  await startMarkedWorker({ processIdentity: executionAttemptId, attemptTemporaryPath, workers })
  await startMarkedWorker({ processIdentity: executionAttemptId, attemptTemporaryPath, workers })

  // A cancel that fenced the attempt; no process target is recorded.
  const seeded = await store.compareAndSetTaskRecord(
    session.id,
    created.id,
    ['queued'],
    {
      status: 'cancelled',
      admission: grantedAdmission(executionAttemptId),
      processIdentity: executionAttemptId,
      executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      attemptStartedAt: FIXED_NOW.toISOString(),
      workerStartedAt: FIXED_NOW.toISOString(),
      completedAt: FIXED_NOW.toISOString(),
      error: 'Cancelled by user',
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(seeded?.updated, true)
  const cancelled = requiredValue(seeded?.task, 'cancelled task')
  const before = classifyTaskProcessesByIdentity(executionAttemptId)
  assert.deepEqual(
    {
      marker: before.kind,
      markedGroups: before.matches.length,
      pid: cancelled.pid,
      processGroupId: cancelled.processGroupId,
      workingFile: fs.existsSync(workingFile),
    },
    { marker: 'ambiguous', markedGroups: 2, pid: undefined, processGroupId: undefined, workingFile: true },
    'arrangement: two live groups carry the marker, and no process target is recorded',
  )

  owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  queue = new TaskQueue({
    sessionStore: store,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
    now: () => FIXED_NOW,
  })
  // initialize awaits its startup pass and every reconciliation that pass
  // requested, so the store has acted on this task when it resolves.
  assert.deepEqual(await queue.initialize(), { pending: 0, granted: 1, legacyActive: 0 })

  const held = requiredValue(await store.getTaskRecord(session.id, cancelled.id), 'held task')
  const workingFileKept = fs.existsSync(workingFile)
  const attemptFolderKept = fs.existsSync(attemptTemporaryPath)
  const after = classifyTaskProcessesByIdentity(executionAttemptId)
  t.diagnostic(`cleanup requests by the time of the check: ${cleanupRequests(workspacePath, cancelled.id)}`)
  assert.deepEqual(
    {
      attemptFolderKept,
      workingFileKept,
      markedGroups: after.matches.length,
      status: held.status,
      admissionPhase: held.admission?.phase,
      launches: launcher.launches,
    },
    {
      attemptFolderKept: true,
      workingFileKept: true,
      markedGroups: 2,
      status: 'cancelled',
      admissionPhase: 'granted',
      launches: [],
    },
    'While live processes carry the attempt\'s marker, nothing shows the attempt stopped: its ' +
      'temporary folders must stay, and the task keeps its cancelled state and its slot.',
  )
})
