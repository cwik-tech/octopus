/**
 * The crash between the two writes, reproduced with real processes and a real
 * kill.
 *
 * Approving a model choice is two durable writes: the workflow records the
 * authorization, then the task records the admission that acts on it. Every
 * other test of this window seeds it by hand, which proves what recovery does
 * with that record but not that a real request ever produces it. If the real
 * route left something else behind, recovery would be correct about a situation
 * that never happens.
 *
 * So the window is made here rather than described. The parent holds the task's
 * own `.task.lock` — the same lock the real compare-and-set takes — through the
 * repository's own helper. A real API process commits the approval, blocks on
 * that lock exactly as it would behind any other writer, and is `SIGKILL`ed
 * there. Nothing gets to clean up. The parent then reads the durable state
 * itself to prove the premise: the approval is on disk and the admission is
 * not.
 *
 * A second real process opens the same workspace the way the desktop would, and
 * the assertion is about what the person retransmitting their approval gets
 * back. Only the launcher is injected, because starting a worker is outside
 * this phase; every store, queue, route and lock is the real one.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { withFileLock } from '../../domains/sessions/session-file-locks.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import {
  FileSystemWorkflowStateStore,
  hashWorkflowContent,
} from '../../workflows/workflow-state-store.js'
import type { DurableWorkflowState, DurableWorkflowStepState } from '../../workflows/types.js'

/**
 * The child, located from this file rather than from the working directory.
 *
 * `tests/fixtures/**` is excluded from the test compile, so the fixture is
 * plain JavaScript in the source tree and is spawned with bare `node`. This
 * module runs from `.tests-dist`, so the source tree is two levels above the
 * compiled `tests/` directory it sits in.
 */
const API_CHILD_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'tests',
  'fixtures',
  'model-choice-admission-crash-api-child.mjs',
)

const CHILD_READY_BUDGET_MS = 30_000
/**
 * How long the approval is given to reach the blocked admission.
 *
 * The cross-process file lock gives up after five seconds, so the kill has to
 * land inside that. Polling is at the filesystem's pace, not on a fixed sleep.
 */
const APPROVAL_COMMITTED_BUDGET_MS = 4_000

const FAILED_CHOICE = { provider: 'anthropic', model: 'claude-opus-4-6' }
const PROPOSED_DEFAULT = { provider: 'connection:abc', model: 'gpt-5.4-mini' }
const OFFER_ID = 'offer-crash-window'

/** A workspace whose task is suspended on one model-choice offer. */
async function seedSuspendedRun(workspacePath: string): Promise<{
  sessionId: string
  taskId: string
  assignmentPath: string
}> {
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Admission crash' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'admission-crash-workflow',
    brief: 'Draft a recommendation.',
  })
  assert.ok(task?.assignmentPath)
  const executionAttemptId = randomUUID()
  const waiting = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'awaiting_model_choice',
      admission: undefined,
      executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      attemptStartedAt: new Date().toISOString(),
      recoveryCount: 0,
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(waiting?.updated, true)

  const stateStore = new FileSystemWorkflowStateStore(task.assignmentPath)
  await stateStore.initialize({
    manifest: {
      taskId: task.id,
      sessionId: session.id,
      rootRunId: task.runId,
      workflowId: task.workflowId,
      workflowDefinitionHash: hashWorkflowContent('admission-crash:v1'),
      briefHash: hashWorkflowContent(task.brief),
      teamDefinitionHashes: { writers: hashWorkflowContent('writers:v1') },
      runtimeVersion: 'workflow-runtime-v1',
    },
    executionAttemptId,
    steps: [
      {
        stepId: 'research',
        stepIndex: 0,
        stepType: 'team',
        team: 'writers',
        definitionHash: hashWorkflowContent('research:v1'),
        recoveryPolicy: 'safe_retry',
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'research.md',
        requestedResultType: 'artifact:research.md',
      },
      {
        stepId: 'write',
        stepIndex: 1,
        stepType: 'team',
        team: 'writers',
        definitionHash: hashWorkflowContent('write:v1'),
        recoveryPolicy: 'safe_retry',
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'report.md',
        requestedResultType: 'artifact:report.md',
      },
    ],
  })

  let revision = 0
  const advance = async (
    mutate: (draft: DurableWorkflowState) => void,
  ): Promise<void> => {
    await stateStore.update({ expectedRevision: revision, executionAttemptId, mutate })
    revision += 1
  }
  const stepOf = (
    draft: DurableWorkflowState,
    stepId: string,
  ): DurableWorkflowStepState => {
    const step = draft.steps.find((candidate) => candidate.stepId === stepId)
    if (!step) throw new Error(`Fixture has no step '${stepId}'.`)
    return step
  }

  for (const status of ['launching', 'running'] as const) {
    await advance((draft) => {
      const step = stepOf(draft, 'research')
      step.status = status
      step.attemptCount = 1
      step.startedAt = new Date().toISOString()
    })
  }
  await advance((draft) => {
    const step = stepOf(draft, 'research')
    step.status = 'completed'
    step.summary = 'Research result.'
    step.costUsd = 0.25
    draft.totalCostUsd = 0.25
    step.completedAt = new Date().toISOString()
    step.artifact = {
      childRunId: step.childRunId,
      relativePath: 'research.md',
      sha256: hashWorkflowContent('Research result.'),
      byteLength: 16,
    }
  })
  for (const status of ['launching', 'running'] as const) {
    await advance((draft) => {
      const step = stepOf(draft, 'write')
      step.status = status
      step.attemptCount = 1
      step.startedAt = new Date().toISOString()
    })
  }
  const offerRevision = String(revision)
  await advance((draft) => {
    draft.status = 'awaiting_model_choice'
    const step = stepOf(draft, 'write')
    step.status = 'awaiting_model_choice'
    step.modelChoice = {
      offerId: OFFER_ID,
      scope: { kind: 'task', sessionId: session.id, taskId: task.id },
      agentName: 'writer',
      logicalInvocationId: 'write',
      expectedRevision: offerRevision,
      failedChoice: FAILED_CHOICE,
      proposedDefault: PROPOSED_DEFAULT,
      reason: 'missing-credential',
    }
  })

  return {
    sessionId: session.id,
    taskId: task.id,
    assignmentPath: task.assignmentPath,
  }
}

/**
 * The task's own lock, at the layout the session store writes.
 *
 * Taken by path rather than through the repository, which needs ports this test
 * has no reason to build. `tests/integration/workflow-model-choice-admission-crash`
 * asserts the CAS is genuinely blocked while it is held, so a layout change
 * fails this test rather than silently making it prove nothing.
 */
function taskLockPath(
  workspacePath: string,
  sessionId: string,
  taskId: string,
): string {
  return path.join(
    workspacePath,
    'sessions',
    sessionId,
    'tasks',
    taskId,
    '.task.lock',
  )
}

async function startApiChild(input: {
  workspacePath: string
  projectRoot: string
}): Promise<{ child: ChildProcessWithoutNullStreams; url: string }> {
  const child = spawn(
    process.execPath,
    [
      API_CHILD_PATH,
      input.workspacePath,
      input.projectRoot,
      PROPOSED_DEFAULT.provider,
      PROPOSED_DEFAULT.model,
    ],
    { cwd: input.projectRoot, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => stderr.push(chunk))

  const url = await within(
    new Promise<string>((resolve, reject) => {
      let buffered = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffered += chunk
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            continue
          }
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            Reflect.get(parsed, 'type') === 'ready'
          ) {
            const ready = Reflect.get(parsed, 'url')
            if (typeof ready === 'string') resolve(ready)
            return
          }
        }
      })
      child.once('exit', (code) =>
        reject(new Error(`the api child exited with ${code}: ${stderr.join('')}`)),
      )
    }),
    CHILD_READY_BUDGET_MS,
    () => `the api child never reported a url: ${stderr.join('')}`,
  ).catch((error: unknown) => {
    child.kill('SIGKILL')
    throw error
  })

  return { child, url }
}

/** Fails with a readable reason rather than letting a wait run to the gate. */
async function within<T>(
  work: Promise<T>,
  budgetMs: number,
  describe: () => string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(describe())), budgetMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Polls the durable state at the filesystem's pace, never on a fixed sleep. */
async function waitForApproval(
  store: FileSystemWorkflowStateStore,
  budgetMs: number,
): Promise<DurableWorkflowStepState> {
  const deadline = Date.now() + budgetMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const snapshot = await store.requireSnapshot()
      const step = snapshot.state.steps.find(
        (candidate) => candidate.stepId === 'write',
      )
      if (step?.approvedModelChoice) return step
      last = step?.status
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(
    `the approval was never committed within ${budgetMs}ms (last: ${String(last)})`,
  )
}

async function exited(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

test('an approval that outlived its process is answered from the attempt it authorized', async () => {
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'model-choice-admission-crash-')),
  )
  const projectRoot = path.join(workspacePath, 'project')
  fs.mkdirSync(projectRoot, { recursive: true })
  const seeded = await seedSuspendedRun(workspacePath)
  const store = new FileSystemWorkflowStateStore(seeded.assignmentPath)
  const sessionStore = new FileSystemSessionStore(workspacePath)

  let first: ChildProcessWithoutNullStreams | undefined
  let second: ChildProcessWithoutNullStreams | undefined
  let abandoned: Promise<unknown> | undefined
  let releaseLock: (() => void) | undefined
  let holdingLock: Promise<void> | undefined
  try {
    const started = await startApiChild({ workspacePath, projectRoot })
    first = started.child

    // The lock the real compare-and-set takes. Held here, so the approval
    // commits and the admission cannot.
    const acquired = new Promise<void>((resolveAcquired) => {
      const released = new Promise<void>((resolveReleased) => {
        releaseLock = resolveReleased
      })
      holdingLock = withFileLock(
        taskLockPath(workspacePath, seeded.sessionId, seeded.taskId),
        async () => {
          resolveAcquired()
          await released
        },
      )
    })
    await acquired

    // The request that dies in flight. Never awaited here: the process it is
    // talking to stops existing partway through.
    abandoned = fetch(
      `${started.url}/sessions/${seeded.sessionId}/tasks/${seeded.taskId}/model-choice`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k1' }),
      },
    ).catch(() => undefined)

    // The premise, read from disk rather than assumed: a real request committed
    // the approval, and the admission it would have written is blocked.
    const approving = await waitForApproval(store, APPROVAL_COMMITTED_BUDGET_MS)
    assert.equal(approving.approvedModelChoice?.offerId, OFFER_ID)
    assert.equal(approving.modelChoice, undefined, 'the offer was consumed')
    const authorization = approving.approvedModelChoice
    const midTask = await sessionStore.getTaskRecord(seeded.sessionId, seeded.taskId)
    assert.equal(midTask?.admission, undefined, 'no admission was committed')
    assert.equal(midTask?.status, 'awaiting_model_choice')

    first.kill('SIGKILL')
    await exited(first)

    // Only now does the lock come free, so nothing the dead process started can
    // still land.
    releaseLock?.()
    await holdingLock
    holdingLock = undefined
    await abandoned
    abandoned = undefined

    const stillUnadmitted = await sessionStore.getTaskRecord(
      seeded.sessionId,
      seeded.taskId,
    )
    assert.equal(
      stillUnadmitted?.admission,
      undefined,
      'the killed process committed an admission after all',
    )

    // The desktop reopens the same workspace.
    const restarted = await startApiChild({ workspacePath, projectRoot })
    second = restarted.child

    // The person retransmits the approval whose reply they never saw.
    const retransmitted = await fetch(
      `${restarted.url}/sessions/${seeded.sessionId}/tasks/${seeded.taskId}/model-choice`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k1' }),
      },
    )
    assert.equal(retransmitted.status, 202, await retransmitted.clone().text())

    const settled = await sessionStore.getTaskRecord(seeded.sessionId, seeded.taskId)
    assert.equal(settled?.admission?.source, 'model_choice')
    assert.equal(settled?.admission?.executionKind, 'continuation')
    assert.equal(settled?.recoveryCount, 0, 'the retry spent recovery budget it should not have')
    const admissionRequestId = settled?.admission?.requestId

    // Retransmitting once more is answered from the admission that already
    // exists. A double click, a second tab and a resent request all learn which
    // attempt belongs to the approval, and none of them starts another — and
    // none of them is told the decision disappeared after it was accepted.
    const again = await fetch(
      `${restarted.url}/sessions/${seeded.sessionId}/tasks/${seeded.taskId}/model-choice`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k2' }),
      },
    )
    assert.equal(again.status, 202, await again.clone().text())
    const final = await sessionStore.getTaskRecord(seeded.sessionId, seeded.taskId)
    assert.equal(final?.admission?.requestId, admissionRequestId)
    assert.equal(final?.admission?.source, 'model_choice')
    assert.equal(final?.recoveryCount, 0)

    // The authorization is exactly the one the user approved.
    const after = await store.requireSnapshot()
    const step = after.state.steps.find((candidate) => candidate.stepId === 'write')
    assert.deepEqual(step?.approvedModelChoice, authorization)
    assert.deepEqual(step?.approvedModelChoice?.proposedDefault, PROPOSED_DEFAULT)

    // The predecessor was not replayed.
    const predecessor = after.state.steps.find(
      (candidate) => candidate.stepId === 'research',
    )
    assert.equal(predecessor?.status, 'completed')
    assert.equal(predecessor?.attemptCount, 1)
    assert.equal(predecessor?.costUsd, 0.25)
  } finally {
    if (first && first.exitCode === null) first.kill('SIGKILL')
    if (second && second.exitCode === null) second.kill('SIGKILL')
    releaseLock?.()
    if (holdingLock) await holdingLock.catch(() => undefined)
    if (abandoned) await abandoned.catch(() => undefined)
    if (first) await exited(first)
    if (second) await exited(second)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
