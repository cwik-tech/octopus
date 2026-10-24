import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  launchSessionTask,
  resumeSessionTask,
} from '../../services/task-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { SessionTaskRunnerLauncher } from '../../domains/sessions/session-task-launcher.js'
import type { SessionTask } from '../../contracts/sessions.js'
import {
  defaultIsProcessAlive,
  PROCESS_IDENTITY_ARGUMENT,
} from '../../domains/sessions/task-process-supervisor.js'
import {
  describeErrors,
  stopProcessesCarrying,
  stopProcessesWithEnvironment,
  withinBound,
} from '../support/fixture-process-markers.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import {
  claimRecordSchema,
  OWNED_PROCESS_ARGUMENT,
  readScopeRecord,
  scopeRecordSchema,
} from '../../core/owned-processes/owned-process-records.js'
import { readExecutionJournal } from '../../core/execution-journal.js'
import {
  rebuildWorkflowStateProjection,
  WORKFLOW_STATE_STREAM_KIND,
} from '../../workflows/workflow-journal.js'
import { createWorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import { EXECUTION_JOURNAL_TENANT_PIN_FILENAME } from '../../services/execution-journal-tenant-pin.js'
import {
  FileSystemWorkflowStateStore,
  readWorkflowCompletionReceipt,
  type WorkflowExecutionSnapshot,
} from '../../workflows/workflow-state-store.js'

const repoRoot = process.cwd()

const TEST_ENV_KEYS = [
  'NODE_ENV',
  'PATH',
  'TEAM_RUNTIME_PI_CLI_PATH',
  'TEAM_RUNTIME_PI_NODE_PATH',
  'TEAM_RUNTIME_TEST_CONTROL_DIR',
  'TEAM_RUNTIME_TEST_SCENARIO',
  'TEAM_RUNTIME_TEST_CRASH_AFTER_RECEIPT_STEP',
  'TEAM_RUNTIME_TEST_CRASH_AFTER_RECEIPT_MARKER',
  'TEAM_RUNTIME_TEST_CRASH_AFTER_WORKFLOW_TERMINAL_MARKER',
  'PIPELINE_DURABLE_JOURNAL',
  'TEAM_TENANT_ID',
  'PIPELINE_TEST_FIXTURE_ID',
] as const

/** Names this harness's fixture identity; not read by any product code. */
const FIXTURE_ID_ENV = 'PIPELINE_TEST_FIXTURE_ID'

interface FakePiInvocation {
  scenario: string
  rootRunId: string
  childRunId: string
  executionAttemptId: string
  recoveryMode: boolean
  outputArtifact: string
  /** The fake Pi's own process, recorded by the process itself. */
  pid: number
}

/** What the harness needs to find a task runner process it launched. */
interface TrackedTaskProcess {
  readonly pid?: number | undefined
  readonly processIdentity?: string | undefined
}

interface ProcessHarness {
  rootPath: string
  workspacePath: string
  controlPath: string
  /** This harness's own fixture identity, in the environment of every process it starts. */
  fixtureId: string
  trackedTasks: TrackedTaskProcess[]
}

async function withProcessHarness(
  params: { scenario: string; nodeEnv: string },
  fn: (harness: ProcessHarness) => Promise<void>,
): Promise<void> {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-workflow-process-'))
  const fixtureId = randomUUID()
  const workspacePath = path.join(rootPath, 'workspace')
  const controlPath = path.join(rootPath, 'control')
  const binPath = path.join(rootPath, 'bin')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(controlPath, { recursive: true })
  fs.mkdirSync(binPath, { recursive: true })
  writeFakePi(path.join(binPath, 'pi'))

  const previous = new Map<string, string | undefined>(
    TEST_ENV_KEYS.map((key) => [key, process.env[key]]),
  )
  process.env.NODE_ENV = params.nodeEnv
  process.env.PATH = `${binPath}${path.delimiter}${previous.get('PATH') ?? ''}`
  process.env.TEAM_RUNTIME_PI_CLI_PATH = path.join(binPath, 'pi')
  process.env.TEAM_RUNTIME_PI_NODE_PATH = process.execPath
  process.env.TEAM_RUNTIME_TEST_CONTROL_DIR = controlPath
  process.env.TEAM_RUNTIME_TEST_SCENARIO = params.scenario
  // Inherited by every process this harness starts, and by their children.
  process.env[FIXTURE_ID_ENV] = fixtureId
  delete process.env.TEAM_RUNTIME_TEST_CRASH_AFTER_RECEIPT_STEP
  delete process.env.TEAM_RUNTIME_TEST_CRASH_AFTER_RECEIPT_MARKER
  delete process.env.TEAM_RUNTIME_TEST_CRASH_AFTER_WORKFLOW_TERMINAL_MARKER

  const harness: ProcessHarness = {
    rootPath,
    workspacePath,
    controlPath,
    fixtureId,
    trackedTasks: [],
  }
  let bodyFailure: { readonly error: unknown } | undefined
  try {
    await fn(harness)
  } catch (error) {
    bodyFailure = { error }
  }
  // Cleanup runs whether the body passed or failed, and the root, which holds
  // the ownership records, is kept until every process this harness started
  // is confirmed gone.
  const cleanupErrors: unknown[] = []
  // Every step is attempted whatever failed before. Runners first, so they
  // start nothing more; then everything that inherited this harness's fixture
  // identity, including hosts and children no record names; then any process
  // still running this harness's own fake Pi.
  const cleanupSteps: Array<() => Promise<void>> = [
    ...harness.trackedTasks.flatMap((task) => task.processIdentity
      ? [() => stopProcessesCarrying(`${PROCESS_IDENTITY_ARGUMENT}${task.processIdentity}`)]
      : []),
    () => stopProcessesWithEnvironment(FIXTURE_ID_ENV, harness.fixtureId),
    () => stopProcessesCarrying(path.join(binPath, 'pi')),
  ]
  for (const step of cleanupSteps) {
    try {
      await step()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  for (const key of TEST_ENV_KEYS) {
    const value = previous.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (cleanupErrors.length === 0) {
    fs.rmSync(rootPath, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 25,
    })
  }
  if (bodyFailure && cleanupErrors.length > 0) {
    throw new AggregateError(
      [bodyFailure.error, ...cleanupErrors],
      `The test failed, and so did its process cleanup; ${rootPath} is kept as evidence: ${describeErrors(cleanupErrors)}`,
    )
  }
  if (bodyFailure) throw bodyFailure.error
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `Process cleanup failed; ${rootPath} is kept as evidence: ${describeErrors(cleanupErrors)}`)
  }
}

type ProcessProbe =
  | { readonly running: false }
  | { readonly running: true, readonly groupId: number, readonly command: string }

/**
 * What runs at `pid`, read with `ps`.
 *
 * `ps` exits 1 with no output and no error text when no process has this
 * pid, which is the only result read as absence. Any other failure (no `ps`,
 * a refused read, a timeout, error text, unreadable output) throws, so an
 * unknown identity can never make cleanup look complete.
 */
function probeProcess(pid: number): ProcessProbe {
  let output: string
  try {
    output = execFileSync('ps', ['-o', 'pgid=,command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5_000,
    })
  } catch (error) {
    if (
      error instanceof Error &&
      'status' in error && error.status === 1 &&
      'stdout' in error && typeof error.stdout === 'string' && error.stdout.trim() === '' &&
      'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim() === ''
    ) {
      return { running: false }
    }
    throw error
  }
  const match = /^(\d+)\s+(.+)$/su.exec(output.trim())
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new Error(`Unreadable process listing for ${pid}: ${JSON.stringify(output)}`)
  }
  return { running: true, groupId: Number(match[1]), command: match[2] }
}

function writeFakePi(filePath: string): void {
  fs.writeFileSync(
    filePath,
    `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function main() {
  const controlPath = process.env.TEAM_RUNTIME_TEST_CONTROL_DIR
  const scenario = process.env.TEAM_RUNTIME_TEST_SCENARIO || 'complete'
  const rootRunId = process.env.TEAM_ROOT_SESSION_ID || ''
  const childRunId = process.env.TEAM_SESSION_ID || path.basename(process.cwd())
  const executionAttemptId = process.env.TEAM_RUNTIME_EXECUTION_ATTEMPT_ID || ''
  const recoveryMode = process.env.TEAM_RUNTIME_RECOVERY === '1'
  const outputArtifact = process.env.TEAM_OUTPUT_ARTIFACT || 'output.md'
  if (!controlPath) throw new Error('TEAM_RUNTIME_TEST_CONTROL_DIR is required')

  fs.mkdirSync(controlPath, { recursive: true })
  fs.appendFileSync(path.join(controlPath, 'invocations.jsonl'), JSON.stringify({
    scenario,
    rootRunId,
    childRunId,
    executionAttemptId,
    recoveryMode,
    outputArtifact,
    pid: process.pid,
  }) + '\\n')

  const runtimePath = path.join(process.cwd(), '.runtime')
  fs.mkdirSync(path.join(runtimePath, 'pipeline', 'test-stage'), { recursive: true })
  fs.writeFileSync(
    path.join(runtimePath, 'checkpoint.json'),
    JSON.stringify({ rootRunId, childRunId, executionAttemptId }),
  )
  fs.writeFileSync(
    path.join(runtimePath, 'pipeline', 'test-stage', 'plan.md'),
    '# Run-local plan\\n\\n' + rootRunId + ':' + childRunId + '\\n',
  )

  fs.writeFileSync(path.join(controlPath, 'started-' + rootRunId), childRunId)
  if (scenario === 'concurrent') {
    while (!fs.existsSync(path.join(controlPath, 'release'))) await sleep(20)
  }

  if (
    scenario === 'recover-mid-step' &&
    outputArtifact === 'final-draft.md' &&
    !recoveryMode
  ) {
    fs.writeFileSync(path.join(controlPath, 'blocked-' + rootRunId), childRunId)
    while (true) await sleep(1000)
  }

  const outputPath = path.join(process.cwd(), outputArtifact)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(
    outputPath,
    [
      '---',
      'artifact_type: "report"',
      '---',
      '# Fake process result',
      '',
      'Root: ' + rootRunId,
      'Child: ' + childRunId,
      'Attempt: ' + executionAttemptId,
      'Recovery: ' + recoveryMode,
    ].join('\\n'),
  )
  // A protocol-valid success: an assistant message_end carrying text, then
  // agent_settled. The artifact written above is what this fixture is really
  // about, but a real Pi run that settles always says something, and a turn
  // with no assistant text is a failure at the provider boundary — so leaving
  // the content empty would have this recovery path exercised through a failed
  // turn rather than the successful one it claims to test.
  process.stdout.write(JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Wrote the report artifact.' }],
      usage: { cost: { total: 0.125 } },
    },
  }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error))
  process.exit(1)
})
`,
    { mode: 0o755 },
  )
}

function createWorkflowRegistry(params: {
  rootPath: string
  workflowId: string
  twoSteps?: boolean
}): string {
  const registryPath = path.join(params.rootPath, `${params.workflowId}-registry.yaml`)
  const templatePath = path.join(params.rootPath, `${params.workflowId}.yaml`)
  const steps = params.twoSteps
    ? [
        '    - id: discuss',
        '      type: team',
        '      team: problem-thinking-board',
        '      input_artifact: incoming-brief.md',
        '      result_artifact: output/decomposition-plan.md',
        '      recovery_policy: safe_retry',
        '    - id: write',
        '      type: team',
        '      team: writing-team',
        '      input_artifact: incoming-brief.md',
        '      result_artifact: final-draft.md',
        '      recovery_policy: safe_retry',
        '      handoff:',
        '        from_step: discuss',
        '        from_artifact: output/decomposition-plan.md',
        '        to_artifact: incoming-brief.md',
      ]
    : [
        '    - id: write',
        '      type: team',
        '      team: writing-team',
        '      input_artifact: incoming-brief.md',
        '      result_artifact: final-draft.md',
        '      recovery_policy: safe_retry',
      ]
  fs.writeFileSync(
    templatePath,
    [
      'workflow:',
      `  id: ${params.workflowId}`,
      '  steps:',
      ...steps,
      '  output:',
      '    from_step: write',
      '    artifact: final-draft.md',
      '  on_blocked: stop',
      '  on_failed: stop',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(
    registryPath,
    [
      `${params.workflowId}:`,
      '  description: Durable process recovery integration fixture.',
      `  template_path: ./${path.basename(templatePath)}`,
      '',
    ].join('\n'),
  )
  return registryPath
}

async function launchRealTask(params: {
  store: FileSystemSessionStore
  sessionId: string
  workspacePath: string
  workflowId: string
  registryPath: string
}): Promise<SessionTask> {
  const launched = await launchSessionTask({
    sessionId: params.sessionId,
    sessionStore: params.store,
    taskLauncher: new SessionTaskRunnerLauncher(repoRoot),
    repoRootPath: repoRoot,
    workspacePath: params.workspacePath,
    workflowsRegistryPath: params.registryPath,
    workflowId: params.workflowId,
    briefMarkdown: `# Task Brief\n\nRun ${params.workflowId}.\n`,
    startupTimeoutMs: 10_000,
  })
  if (!launched.ok) {
    assert.fail(
      `${launched.error}${'detail' in launched ? `: ${launched.detail}` : ''}`,
    )
  }
  return launched.task
}

async function resumeRealTask(params: {
  store: FileSystemSessionStore
  sessionId: string
  taskId: string
  workspacePath: string
  registryPath: string
}): Promise<SessionTask> {
  const resumed = await resumeSessionTask({
    sessionId: params.sessionId,
    taskId: params.taskId,
    sessionStore: params.store,
    taskLauncher: new SessionTaskRunnerLauncher(repoRoot),
    repoRootPath: repoRoot,
    workspacePath: params.workspacePath,
    workflowsRegistryPath: params.registryPath,
    startupTimeoutMs: 10_000,
  })
  if (!resumed.ok) {
    assert.fail(
      `${resumed.error}${'detail' in resumed ? `: ${resumed.detail}` : ''}`,
    )
  }
  return resumed.task
}

async function waitFor<T>(params: {
  description: string
  read: () => T | Promise<T>
  matches: (value: T) => boolean
  timeoutMs?: number
}): Promise<T> {
  const deadline = Date.now() + (params.timeoutMs ?? 15_000)
  let latest = await params.read()
  while (!params.matches(latest) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    latest = await params.read()
  }
  assert.ok(params.matches(latest), `Timed out waiting for ${params.description}`)
  return latest
}

/**
 * Resolves once `name` exists in `folder`, checked on every change there: the
 * fake Pi writes it. The bound only stops a broken arrangement from outliving
 * the test.
 */
async function fileAppears(folder: string, name: string, description: string): Promise<void> {
  let watcher: fs.FSWatcher | undefined
  const appeared = new Promise<void>((resolve, reject) => {
    const check = (): void => {
      if (fs.existsSync(path.join(folder, name))) resolve()
    }
    // Watched before the first check, so a write between the two is not missed.
    watcher = fs.watch(folder, check)
    watcher.on('error', reject)
    check()
  })
  try {
    await withinBound(appeared, 20_000, description)
  } finally {
    watcher?.close()
  }
}

async function waitForWorkflowState(
  task: SessionTask,
  matches: (snapshot: WorkflowExecutionSnapshot) => boolean,
): Promise<WorkflowExecutionSnapshot> {
  const assignmentPath = requireTaskAssignmentPath(task)
  const store = new FileSystemWorkflowStateStore(
    assignmentPath,
  )
  return waitFor({
    description: `workflow state for ${task.runId}`,
    read: async () => {
      const snapshot = await store.load()
      return snapshot
    },
    matches: (snapshot): snapshot is WorkflowExecutionSnapshot =>
      snapshot !== null && matches(snapshot),
  }) as Promise<WorkflowExecutionSnapshot>
}

function requireTaskAssignmentPath(task: SessionTask): string {
  assert.ok(task.assignmentPath, `Task ${task.id} must persist its assignment path`)
  return task.assignmentPath
}

function resolveChildAssignmentPath(
  workspacePath: string,
  task: SessionTask,
  childRunId: string,
): string {
  const location = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: task.sessionId,
    runId: task.runId,
    assignmentId: childRunId,
  })
  assert.ok(location, `Child assignment ${childRunId} must have a canonical session-run location`)
  return location.assignmentPath
}

async function waitForTerminalTask(
  store: FileSystemSessionStore,
  sessionId: string,
  taskId: string,
): Promise<SessionTask> {
  return waitFor({
    description: `terminal task ${taskId}`,
    read: () => store.getTaskRecord(sessionId, taskId),
    matches: (task) => Boolean(
      task && ['done', 'failed', 'blocked', 'cancelled'].includes(task.status),
    ),
    timeoutMs: 20_000,
  }) as Promise<SessionTask>
}

function processTarget(task: SessionTask): number | null {
  if (!task.pid) return null
  return process.platform === 'win32'
    ? task.pid
    : -(task.processGroupId ?? task.pid)
}

async function killTaskProcessAndWait(task: SessionTask): Promise<void> {
  const target = processTarget(task)
  assert.notEqual(target, null, 'Task process target must be persisted')
  process.kill(target!, 'SIGKILL')
  await waitFor({
    description: `process group ${target} to stop`,
    read: () => defaultIsProcessAlive(target!),
    matches: (alive) => !alive,
    timeoutMs: 5_000,
  })
}

function readInvocations(controlPath: string): FakePiInvocation[] {
  const filePath = path.join(controlPath, 'invocations.jsonl')
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakePiInvocation)
}

test('two real workflow task processes keep roots, children, checkpoints, plans, and durable state isolated', { timeout: 30_000 }, async () => {
  await withProcessHarness(
    { scenario: 'concurrent', nodeEnv: 'production' },
    async (harness) => {
      const workflowId = 'concurrent-run-isolation'
      const registryPath = createWorkflowRegistry({
        rootPath: harness.rootPath,
        workflowId,
      })
      const inertMarkerPath = path.join(harness.controlPath, 'must-not-crash')
      process.env.TEAM_RUNTIME_TEST_CRASH_AFTER_RECEIPT_STEP = 'write'
      process.env.TEAM_RUNTIME_TEST_CRASH_AFTER_RECEIPT_MARKER = inertMarkerPath

      const store = new FileSystemSessionStore(harness.workspacePath, {
        instanceId: 'concurrent-api',
      })
      const [firstSession, secondSession] = await Promise.all([
        store.createSession({ title: 'Concurrent workflow one' }),
        store.createSession({ title: 'Concurrent workflow two' }),
      ])
      const [firstTask, secondTask] = await Promise.all([
        launchRealTask({
          store,
          sessionId: firstSession.id,
          workspacePath: harness.workspacePath,
          workflowId,
          registryPath,
        }),
        launchRealTask({
          store,
          sessionId: secondSession.id,
          workspacePath: harness.workspacePath,
          workflowId,
          registryPath,
        }),
      ])
      harness.trackedTasks.push(firstTask, secondTask)

      assert.notEqual(firstTask.runId, secondTask.runId)
      assert.notEqual(firstTask.executionAttemptId, secondTask.executionAttemptId)
      await Promise.all([
        [firstSession.id, firstTask],
        [secondSession.id, secondTask],
      ].map(([sessionId, task]) => waitFor({
        description: `fake child process for ${(task as SessionTask).runId}`,
        read: async () => ({
          started: fs.existsSync(
            path.join(harness.controlPath, `started-${(task as SessionTask).runId}`),
          ),
          task: await store.getTaskRecord(
            sessionId as string,
            (task as SessionTask).id,
          ),
        }),
        matches: (observation) => {
          if (observation.started) return true
          if (
            observation.task &&
            ['done', 'failed', 'blocked', 'cancelled'].includes(observation.task.status)
          ) {
            assert.fail(
              `Task ${observation.task.id} became ${observation.task.status} before its fake child started: ` +
                `${observation.task.error ?? 'no error recorded'}`,
            )
          }
          return false
        },
      })))

      const [firstSnapshot, secondSnapshot] = await Promise.all([
        waitForWorkflowState(
          firstTask,
          (snapshot) => snapshot.state.steps[0]?.status === 'running',
        ),
        waitForWorkflowState(
          secondTask,
          (snapshot) => snapshot.state.steps[0]?.status === 'running',
        ),
      ])
      const firstChildId = firstSnapshot.state.steps[0]!.childRunId
      const secondChildId = secondSnapshot.state.steps[0]!.childRunId
      assert.notEqual(firstChildId, secondChildId)
      assert.notEqual(firstChildId, firstTask.runId)
      assert.notEqual(secondChildId, secondTask.runId)
      assert.equal(firstSnapshot.state.ownerExecutionAttemptId, firstTask.executionAttemptId)
      assert.equal(secondSnapshot.state.ownerExecutionAttemptId, secondTask.executionAttemptId)

      for (const [task, childId] of [
        [firstTask, firstChildId],
        [secondTask, secondChildId],
      ] as const) {
        const rootAssignmentPath = requireTaskAssignmentPath(task)
        const childAssignmentPath = resolveChildAssignmentPath(
          harness.workspacePath,
          task,
          childId,
        )
        assert.ok(fs.existsSync(path.join(rootAssignmentPath, '.runtime', 'workflow-state.json')))
        assert.ok(fs.existsSync(path.join(rootAssignmentPath, '.runtime', 'execution-manifest.json')))
        assert.deepEqual(
          JSON.parse(
            fs.readFileSync(path.join(childAssignmentPath, '.runtime', 'checkpoint.json'), 'utf8'),
          ),
          {
            rootRunId: task.runId,
            childRunId: childId,
            executionAttemptId: '',
          },
        )
        assert.equal(
          fs.readFileSync(
            path.join(childAssignmentPath, '.runtime', 'pipeline', 'test-stage', 'plan.md'),
            'utf8',
          ),
          `# Run-local plan\n\n${task.runId}:${childId}\n`,
        )
      }

      assert.equal(fs.existsSync(path.join(harness.workspacePath, 'checkpoint.json')), false)
      assert.equal(
        fs.existsSync(path.join(harness.workspacePath, '.pi-tasks', 'plan.md')),
        false,
      )
      // No run-scoped state reaches the workspace root. Stated as "nothing but
      // the workspace tenant pin" rather than "no `.runtime` directory at all",
      // because with the journal active the product legitimately creates
      // `<workspace>/.runtime` to hold that pin. The weaker phrasing would have
      // made this assertion mean one thing with PIPELINE_DURABLE_JOURNAL unset
      // and another with it authoritative; this phrasing means the same in both.
      const workspaceRuntimePath = path.join(harness.workspacePath, '.runtime')
      const workspaceRuntimeEntries = fs.existsSync(workspaceRuntimePath)
        ? fs.readdirSync(workspaceRuntimePath).sort()
        : []
      assert.deepEqual(
        workspaceRuntimeEntries.filter(
          (entry) => entry !== EXECUTION_JOURNAL_TENANT_PIN_FILENAME,
        ),
        [],
      )
      assert.equal(defaultIsProcessAlive(processTarget(firstTask)!), true)
      assert.equal(defaultIsProcessAlive(processTarget(secondTask)!), true)

      fs.writeFileSync(path.join(harness.controlPath, 'release'), 'go')
      const [firstDone, secondDone] = await Promise.all([
        waitForTerminalTask(store, firstSession.id, firstTask.id),
        waitForTerminalTask(store, secondSession.id, secondTask.id),
      ])
      assert.equal(firstDone.status, 'done')
      assert.equal(secondDone.status, 'done')
      assert.equal(fs.existsSync(inertMarkerPath), false)

      for (const [task, childId] of [
        [firstDone, firstChildId],
        [secondDone, secondChildId],
      ] as const) {
        const artifact = fs.readFileSync(
          path.join(
            resolveChildAssignmentPath(harness.workspacePath, task, childId),
            'final-draft.md',
          ),
          'utf8',
        )
        assert.match(artifact, new RegExp(`Root: ${task.runId}`))
        assert.match(artifact, new RegExp(`Child: ${childId}`))
      }
    },
  )
})

test('a fresh store interrupts and resumes a killed mid-step workflow without rerunning a committed step', { timeout: 35_000 }, async () => {
  await withProcessHarness(
    { scenario: 'recover-mid-step', nodeEnv: 'test' },
    async (harness) => {
      const workflowId = 'recover-killed-workflow'
      const registryPath = createWorkflowRegistry({
        rootPath: harness.rootPath,
        workflowId,
        twoSteps: true,
      })
      const originalStore = new FileSystemSessionStore(harness.workspacePath, {
        instanceId: 'original-api',
      })
      const session = await originalStore.createSession({ title: 'Recover killed workflow' })
      const launched = await launchRealTask({
        store: originalStore,
        sessionId: session.id,
        workspacePath: harness.workspacePath,
        workflowId,
        registryPath,
      })
      harness.trackedTasks.push(launched)

      await waitFor({
        description: 'second fake child to block',
        read: () => fs.existsSync(path.join(harness.controlPath, `blocked-${launched.runId}`)),
        matches: Boolean,
      })
      const beforeCrash = await waitForWorkflowState(
        launched,
        (snapshot) =>
          snapshot.state.steps[0]?.status === 'completed' &&
          snapshot.state.steps[1]?.status === 'running',
      )
      const committedStepBeforeCrash = structuredClone(beforeCrash.state.steps[0]!)
      const interruptedChildId = beforeCrash.state.steps[1]!.childRunId
      const firstExecutionAttemptId = launched.executionAttemptId
      assert.ok(firstExecutionAttemptId)

      await killTaskProcessAndWait(launched)

      const restartedStore = new FileSystemSessionStore(harness.workspacePath, {
        instanceId: 'restarted-api',
        staleTaskGraceMs: 0,
      })
      const reconciledTasks = await restartedStore.listTaskRecords(session.id)
      const interrupted = reconciledTasks.find((task) => task.id === launched.id)
      assert.ok(interrupted)
      assert.equal(interrupted.status, 'interrupted')
      assert.equal(interrupted.recoveryDisposition, 'automatic')
      assert.match(interrupted.recoveryReason ?? '', /safe retry/i)
      assert.equal(interrupted.id, launched.id)
      assert.equal(interrupted.runId, launched.runId)

      const resumed = await resumeRealTask({
        store: restartedStore,
        sessionId: session.id,
        taskId: launched.id,
        workspacePath: harness.workspacePath,
        registryPath,
      })
      harness.trackedTasks.push(resumed)
      const completed = await waitForTerminalTask(
        restartedStore,
        session.id,
        launched.id,
      )
      assert.equal(completed.status, 'done')
      assert.equal(completed.id, launched.id)
      assert.equal(completed.runId, launched.runId)
      assert.equal(completed.executionAttemptNumber, 2)
      assert.equal(completed.executionKind, 'recovery')
      assert.notEqual(completed.executionAttemptId, firstExecutionAttemptId)

      const recoveredSnapshot = await waitForWorkflowState(
        completed,
        (snapshot) => snapshot.state.status === 'completed',
      )
      assert.equal(recoveredSnapshot.state.ownerExecutionAttemptId, completed.executionAttemptId)
      assert.equal(recoveredSnapshot.state.recoveryCount, 1)
      assert.deepEqual(recoveredSnapshot.state.steps[0], committedStepBeforeCrash)
      assert.equal(recoveredSnapshot.state.steps[0]!.attemptCount, 1)
      assert.equal(recoveredSnapshot.state.steps[1]!.childRunId, interruptedChildId)
      assert.equal(recoveredSnapshot.state.steps[1]!.attemptCount, 2)
      assert.equal(recoveredSnapshot.state.steps[1]!.status, 'completed')

      const invocations = readInvocations(harness.controlPath)
        .filter((invocation) => invocation.rootRunId === launched.runId)
      assert.equal(
        invocations.filter(
          (invocation) => invocation.outputArtifact === 'output/decomposition-plan.md',
        ).length,
        1,
      )
      const writeInvocations = invocations.filter(
        (invocation) => invocation.outputArtifact === 'final-draft.md',
      )
      assert.equal(writeInvocations.length, 2)
      assert.equal(writeInvocations[0]!.recoveryMode, false)
      assert.equal(writeInvocations[1]!.recoveryMode, true)
      assert.equal(writeInvocations[0]!.childRunId, interruptedChildId)
      assert.equal(writeInvocations[1]!.childRunId, interruptedChildId)
    },
  )
})

test('a task is not reported interrupted while the Team child of its dead attempt is still running', { timeout: 35_000 }, async () => {
  await withProcessHarness(
    { scenario: 'recover-mid-step', nodeEnv: 'test' },
    async (harness) => {
      const workflowId = 'orphaned-team-child'
      const registryPath = createWorkflowRegistry({
        rootPath: harness.rootPath,
        workflowId,
        twoSteps: true,
      })
      const originalStore = new FileSystemSessionStore(harness.workspacePath, {
        instanceId: 'original-api',
      })
      const session = await originalStore.createSession({ title: 'Orphaned Team child' })
      const launched = await launchRealTask({
        store: originalStore,
        sessionId: session.id,
        workspacePath: harness.workspacePath,
        workflowId,
        registryPath,
      })
      harness.trackedTasks.push(launched)
      await fileAppears(harness.controlPath, `blocked-${launched.runId}`, 'second fake child to block')
      const teamChildPid = readInvocations(harness.controlPath).find(
        (invocation) =>
          invocation.rootRunId === launched.runId &&
          invocation.outputArtifact === 'final-draft.md' &&
          !invocation.recoveryMode,
      )?.pid
      assert.ok(teamChildPid !== undefined, 'the Team child of the second step recorded its pid')
      const fakePi = path.join(harness.rootPath, 'bin', 'pi')
      const isThatChild = (): boolean => {
        const probe = probeProcess(teamChildPid)
        return probe.running && probe.command.includes(fakePi)
      }
      // The arrangement: that exact child is running, in its own process
      // group, while the root worker is still alive.
      assert.equal(isThatChild(), true, `Team child ${teamChildPid} is not running before the root dies`)

      // The root worker dies. Nothing has resumed the task yet.
      await killTaskProcessAndWait(launched)

      const restartedStore = new FileSystemSessionStore(harness.workspacePath, {
        instanceId: 'restarted-api',
        staleTaskGraceMs: 0,
      })
      const reconciled = (await restartedStore.listTaskRecords(session.id))
        .find((task) => task.id === launched.id)

      // Recovery reports the same task and attempt as interrupted and
      // recoverable, as it does for a worker that died alone.
      assert.ok(reconciled)
      assert.equal(reconciled.status, 'interrupted')
      assert.equal(reconciled.recoveryDisposition, 'automatic')
      assert.equal(reconciled.runId, launched.runId)
      assert.equal(reconciled.executionAttemptId, launched.executionAttemptId)
      // Recovery's rule: a task is not reconciled as dead, and so made
      // resumable, while a process that may still run it lives. By the time
      // it reports the task interrupted, the dead attempt's Team child is
      // gone, before any replacement attempt can be admitted.
      assert.equal(
        isThatChild(),
        false,
        `task ${reconciled.id} was reported interrupted while its attempt's Team child ${teamChildPid} still runs`,
      )
    },
  )
})

/**
 * A real task whose root worker has been killed while its second step's Team
 * child still runs, and what the tests below need to know about both.
 */
interface DeadRootWithLiveTeamChild {
  readonly sessionId: string
  readonly launched: SessionTask
  /** The task record as the live root left it, just before it was killed. */
  readonly beforeDeath: SessionTask
  readonly teamChildPid: number
  readonly teamChildRunId: string
  readonly registryPath: string
  /** Whether that exact Team child, this harness's fake Pi, still runs. */
  readonly isThatChild: () => boolean
}

async function arrangeDeadRootWithLiveTeamChild(
  harness: ProcessHarness,
  workflowId: string,
): Promise<DeadRootWithLiveTeamChild> {
  const registryPath = createWorkflowRegistry({
    rootPath: harness.rootPath,
    workflowId,
    twoSteps: true,
  })
  const originalStore = new FileSystemSessionStore(harness.workspacePath, {
    instanceId: 'original-api',
  })
  const session = await originalStore.createSession({ title: workflowId })
  const launched = await launchRealTask({
    store: originalStore,
    sessionId: session.id,
    workspacePath: harness.workspacePath,
    workflowId,
    registryPath,
  })
  harness.trackedTasks.push(launched)
  await fileAppears(harness.controlPath, `blocked-${launched.runId}`, 'second fake child to block')
  const invocation = readInvocations(harness.controlPath).find(
    (candidate) =>
      candidate.rootRunId === launched.runId &&
      candidate.outputArtifact === 'final-draft.md' &&
      !candidate.recoveryMode,
  )
  assert.ok(invocation, 'the Team child of the second step recorded itself')
  const fakePi = path.join(harness.rootPath, 'bin', 'pi')
  const isThatChild = (): boolean => {
    const probe = probeProcess(invocation.pid)
    return probe.running && probe.command.includes(fakePi)
  }
  assert.equal(isThatChild(), true, `Team child ${invocation.pid} is not running before the root dies`)
  const beforeDeath = await originalStore.getTaskRecord(session.id, launched.id)
  assert.ok(beforeDeath, 'the live task record')
  await killTaskProcessAndWait(launched)
  return {
    sessionId: session.id,
    launched,
    beforeDeath,
    teamChildPid: invocation.pid,
    teamChildRunId: invocation.childRunId,
    registryPath,
    isThatChild,
  }
}

/** A fresh store in a restarted process, reading the dead attempt's task. */
async function reconcileAfterRestart(
  harness: ProcessHarness,
  arranged: DeadRootWithLiveTeamChild,
): Promise<SessionTask> {
  const restartedStore = new FileSystemSessionStore(harness.workspacePath, {
    instanceId: 'restarted-api',
    staleTaskGraceMs: 0,
  })
  const reconciled = (await restartedStore.listTaskRecords(arranged.sessionId))
    .find((task) => task.id === arranged.launched.id)
  assert.ok(reconciled, 'the reconciled task record')
  return reconciled
}

/**
 * The reason of a task's process-cleanup hold
 * (`docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md`, section 7).
 */
function processCleanupHoldReason(task: SessionTask): unknown {
  const hold: unknown = Reflect.get(task, 'processCleanupHold')
  return typeof hold === 'object' && hold !== null ? Reflect.get(hold, 'reason') : undefined
}

/** The attempt's ownership scope folder, derived from the task record as recovery derives it. */
function ownedProcessScopePath(workspacePath: string, task: SessionTask): string {
  assert.ok(task.executionAttemptNumber, `task ${task.id} records its attempt number`)
  return path.join(
    workspacePath,
    'sessions',
    task.sessionId,
    'tasks',
    task.id,
    'owned-processes',
    `attempt-${task.executionAttemptNumber}`,
  )
}

/** The intents a scope records, each with its id and the Team child it started. */
function readScopeIntents(
  scopePath: string,
): Array<{ readonly ownedProcessId: string; readonly childRunId: unknown }> {
  const intentsPath = path.join(scopePath, 'intents')
  if (!fs.existsSync(intentsPath)) return []
  return fs.readdirSync(intentsPath)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(intentsPath, name), 'utf8'))
      assert.ok(typeof parsed === 'object' && parsed !== null, `intent ${name} is an object`)
      const ownedProcessId: unknown = Reflect.get(parsed, 'ownedProcessId')
      assert.equal(typeof ownedProcessId, 'string', `intent ${name} names its owned process`)
      return { ownedProcessId: String(ownedProcessId), childRunId: Reflect.get(parsed, 'childRunId') }
    })
}

/**
 * A `ps` that always fails, as a broken or refused process listing would.
 * Returns the folder to put first on PATH.
 */
function writeFailingPs(rootPath: string): string {
  const folder = path.join(rootPath, 'failing-ps')
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(
    path.join(folder, 'ps'),
    '#!/bin/sh\necho "ps: process listing unavailable" >&2\nexit 2\n',
    { mode: 0o755 },
  )
  return folder
}

/** Runs `read` with `folder` first on PATH, and restores PATH before returning. */
async function withPathFirst<T>(folder: string, read: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH
  process.env.PATH = `${folder}${path.delimiter}${previous ?? ''}`
  try {
    return await read()
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  }
}

test('a launched task records its Team child in its attempt\'s scope, and the child runs in the group of the host that claimed it', { timeout: 35_000 }, async () => {
  await withProcessHarness(
    { scenario: 'recover-mid-step', nodeEnv: 'test' },
    async (harness) => {
      const workflowId = 'scoped-team-child'
      const registryPath = createWorkflowRegistry({ rootPath: harness.rootPath, workflowId, twoSteps: true })
      const store = new FileSystemSessionStore(harness.workspacePath, { instanceId: 'scoped-api' })
      const session = await store.createSession({ title: workflowId })
      const launched = await launchRealTask({
        store,
        sessionId: session.id,
        workspacePath: harness.workspacePath,
        workflowId,
        registryPath,
      })
      harness.trackedTasks.push(launched)
      await fileAppears(harness.controlPath, `blocked-${launched.runId}`, 'second fake child to block')
      const invocation = readInvocations(harness.controlPath).find(
        (candidate) =>
          candidate.rootRunId === launched.runId &&
          candidate.outputArtifact === 'final-draft.md' &&
          !candidate.recoveryMode,
      )
      assert.ok(invocation, 'the Team child of the second step recorded itself')
      const task = await store.getTaskRecord(session.id, launched.id)
      assert.ok(task)
      assert.equal(Reflect.get(task, 'ownedProcessScope'), 1, 'the attempt was launched with an ownership scope')

      const scopePath = ownedProcessScopePath(harness.workspacePath, task)
      const scope = await readScopeRecord({ target: path.join(scopePath, 'scope.json'), schema: scopeRecordSchema })
      assert.deepEqual(
        scope.kind === 'present'
          ? { taskId: scope.record.taskId, sessionId: scope.record.sessionId, attempt: scope.record.executionAttemptNumber }
          : scope,
        { taskId: task.id, sessionId: task.sessionId, attempt: task.executionAttemptNumber },
      )
      const intent = readScopeIntents(scopePath).find((candidate) => candidate.childRunId === invocation.childRunId)
      assert.ok(intent, `the scope records the Team child ${invocation.childRunId}`)
      const claim = await readScopeRecord({
        target: path.join(scopePath, 'claims', `${intent.ownedProcessId}.json`),
        schema: claimRecordSchema,
        expectedOwnedProcessId: intent.ownedProcessId,
      })
      assert.ok(claim.kind === 'present' && claim.record.claimant === 'host', 'a host claimed the Team child')
      const host = probeProcess(claim.record.pid)
      assert.ok(host.running, 'the host that claimed the child runs')
      assert.ok(
        host.command.includes(`${OWNED_PROCESS_ARGUMENT}${intent.ownedProcessId}`),
        'the host carries the owned process marker',
      )
      assert.equal(host.groupId, claim.record.pid, 'the host leads its group')
      const child = probeProcess(invocation.pid)
      assert.ok(child.running)
      assert.equal(child.groupId, claim.record.pid, 'the Team child runs in its host\'s group')
    },
  )
})

test('a failed process probe never lets recovery report a task interrupted while its Team child may still run', { timeout: 35_000 }, async () => {
  await withProcessHarness(
    { scenario: 'recover-mid-step', nodeEnv: 'test' },
    async (harness) => {
      const arranged = await arrangeDeadRootWithLiveTeamChild(harness, 'probe-failure-team-child')
      const failingPs = writeFailingPs(harness.rootPath)

      // Only the recovering store's reads meet the failing ps; the harness's
      // own probes below run after PATH is restored.
      const reconciled = await withPathFirst(failingPs, () => reconcileAfterRestart(harness, arranged))

      assert.equal(
        reconciled.status,
        arranged.beforeDeath.status,
        `task ${reconciled.id} left ${arranged.beforeDeath.status} although its descendants could not be verified`,
      )
      assert.equal(reconciled.recoveryDisposition, undefined)
      assert.equal(reconciled.executionAttemptId, arranged.launched.executionAttemptId)
      // A direct launch holds no admission, and restart reconciliation invents
      // none. A granted admission is the queue's case (owned-process-queue-hold).
      assert.equal(arranged.beforeDeath.admission, undefined, 'a direct launch holds no admission')
      assert.equal(reconciled.admission, undefined, 'restart reconciliation invents no admission')
      assert.equal(processCleanupHoldReason(reconciled), 'owned_processes_unverified')
      assert.equal(
        arranged.isThatChild(),
        true,
        `Team child ${arranged.teamChildPid} was stopped although its identity could not be verified`,
      )
    },
  )
})

test('an unreadable claim keeps the task held and signals nothing', { timeout: 35_000 }, async () => {
  await withProcessHarness(
    { scenario: 'recover-mid-step', nodeEnv: 'test' },
    async (harness) => {
      const arranged = await arrangeDeadRootWithLiveTeamChild(harness, 'unreadable-claim-team-child')
      const scopePath = ownedProcessScopePath(harness.workspacePath, arranged.beforeDeath)
      const intent = readScopeIntents(scopePath)
        .find((candidate) => candidate.childRunId === arranged.teamChildRunId)
      assert.ok(
        intent,
        `the attempt's scope ${scopePath} records its Team child ${arranged.teamChildRunId}`,
      )
      // What a create-then-write crash would leave: the claim's name with no
      // content. The host's pid and group are no longer readable.
      fs.writeFileSync(path.join(scopePath, 'claims', `${intent.ownedProcessId}.json`), '')

      const reconciled = await reconcileAfterRestart(harness, arranged)

      assert.equal(reconciled.status, arranged.beforeDeath.status)
      assert.equal(reconciled.recoveryDisposition, undefined)
      // A direct launch holds no admission, and restart reconciliation invents
      // none. A granted admission is the queue's case (owned-process-queue-hold).
      assert.equal(arranged.beforeDeath.admission, undefined, 'a direct launch holds no admission')
      assert.equal(reconciled.admission, undefined, 'restart reconciliation invents no admission')
      assert.equal(processCleanupHoldReason(reconciled), 'owned_processes_unverified')
      assert.equal(arranged.isThatChild(), true, 'nothing may signal a member whose claim is unreadable')
    },
  )
})

test('a directly launched earlier-version task, without a scope or an admission, is held while its Team child may still run, and restart reconciliation invents no admission', { timeout: 35_000 }, async () => {
  await withProcessHarness(
    { scenario: 'recover-mid-step', nodeEnv: 'test' },
    async (harness) => {
      const arranged = await arrangeDeadRootWithLiveTeamChild(harness, 'earlier-version-team-child')
      // What an earlier version leaves: no scope field on the task record and
      // no scope folder beside it.
      const taskFolder = path.join(
        harness.workspacePath,
        'sessions',
        arranged.sessionId,
        'tasks',
        arranged.launched.id,
      )
      const recordPath = path.join(taskFolder, 'task.json')
      const record: unknown = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
      assert.ok(typeof record === 'object' && record !== null)
      Reflect.deleteProperty(record, 'ownedProcessScope')
      fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`)
      fs.rmSync(path.join(taskFolder, 'owned-processes'), { recursive: true, force: true })

      const reconciled = await reconcileAfterRestart(harness, arranged)

      assert.equal(
        reconciled.status,
        arranged.beforeDeath.status,
        `task ${reconciled.id} left ${arranged.beforeDeath.status} although its earlier-version descendants cannot be verified`,
      )
      assert.equal(reconciled.recoveryDisposition, undefined)
      // A direct launch holds no admission, and restart reconciliation invents
      // none. A granted admission is the queue's case (owned-process-queue-hold).
      assert.equal(arranged.beforeDeath.admission, undefined, 'a direct launch holds no admission')
      assert.equal(reconciled.admission, undefined, 'restart reconciliation invents no admission')
      assert.equal(processCleanupHoldReason(reconciled), 'descendants_unverified_without_scope')
      const resumed = await resumeSessionTask({
        sessionId: arranged.sessionId,
        taskId: arranged.launched.id,
        sessionStore: new FileSystemSessionStore(harness.workspacePath, {
          instanceId: 'resume-api',
          staleTaskGraceMs: 0,
        }),
        taskLauncher: new SessionTaskRunnerLauncher(repoRoot),
        repoRootPath: repoRoot,
        workspacePath: harness.workspacePath,
        workflowsRegistryPath: arranged.registryPath,
        startupTimeoutMs: 10_000,
      })
      if (resumed.ok) harness.trackedTasks.push(resumed.task)
      assert.equal(resumed.ok, false, 'no resume may start beside a descendant that may still run')
      assert.equal(arranged.isThatChild(), true, 'nothing may signal a process no record ties to the task')
    },
  )
})

test('when a test body fails, the process harness still stops the Pi child it started and reports that failure', { timeout: 35_000 }, async () => {
  const bodyFailure = new Error('deliberate test-body failure while the second child is blocked')
  let harnessRoot = ''
  let blockedPid: number | undefined

  await assert.rejects(
    withProcessHarness({ scenario: 'recover-mid-step', nodeEnv: 'test' }, async (harness) => {
      harnessRoot = harness.rootPath
      const workflowId = 'harness-failure-cleanup'
      const registryPath = createWorkflowRegistry({
        rootPath: harness.rootPath,
        workflowId,
        twoSteps: true,
      })
      const store = new FileSystemSessionStore(harness.workspacePath, { instanceId: 'failing-body' })
      const session = await store.createSession({ title: 'Harness failure cleanup' })
      const launched = await launchRealTask({
        store,
        sessionId: session.id,
        workspacePath: harness.workspacePath,
        workflowId,
        registryPath,
      })
      harness.trackedTasks.push(launched)
      await waitFor({
        description: 'second fake child to block',
        read: () => fs.existsSync(path.join(harness.controlPath, `blocked-${launched.runId}`)),
        matches: Boolean,
      })
      blockedPid = readInvocations(harness.controlPath).find(
        (invocation) => invocation.outputArtifact === 'final-draft.md' && !invocation.recoveryMode,
      )?.pid
      throw bodyFailure
    }),
    (error: unknown) => error === bodyFailure,
  )

  // The blocked child ran in its own process group, outside the task runner's.
  assert.ok(blockedPid !== undefined, 'the blocked child recorded its pid')
  const afterwards = probeProcess(blockedPid)
  assert.ok(
    !afterwards.running || !afterwards.command.includes(path.join(harnessRoot, 'bin', 'pi')),
    `the harness's blocked Pi child ${blockedPid} is still running`,
  )
  // Deleted only after the cleanup was confirmed.
  assert.equal(fs.existsSync(harnessRoot), false)
})

test('the process harness leaves an unrelated process alone when its pid appears in the harness records', { timeout: 20_000 }, async () => {
  // A real process that is not this harness's, leading its own process group,
  // so a signal aimed at the wrong process or group would end it.
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    detached: true,
    stdio: 'ignore',
  })
  await once(unrelated, 'spawn')
  const unrelatedPid = unrelated.pid
  assert.ok(unrelatedPid !== undefined)
  const unrelatedExit = once(unrelated, 'exit')
  try {
    await withProcessHarness({ scenario: 'complete', nodeEnv: 'test' }, async (harness) => {
      // As if the pids a fake Pi and a task runner recorded had since been
      // reused by the system for this unrelated process.
      fs.appendFileSync(path.join(harness.controlPath, 'invocations.jsonl'), `${JSON.stringify({
        scenario: 'complete',
        rootRunId: 'reused-root',
        childRunId: 'reused-child',
        executionAttemptId: 'reused-attempt',
        recoveryMode: false,
        outputArtifact: 'output.md',
        pid: unrelatedPid,
      })}\n`)
      harness.trackedTasks.push({ pid: unrelatedPid, processIdentity: 'a-runner-that-has-exited' })
    })

    const afterwards = probeProcess(unrelatedPid)
    assert.ok(
      afterwards.running && afterwards.command.includes('setInterval'),
      `the unrelated process ${unrelatedPid} was signalled by the harness`,
    )
  } finally {
    // Our own unreaped child, so its pid cannot have been reused.
    unrelated.kill('SIGKILL')
    await withinBound(unrelatedExit, 5_000, 'the unrelated process to exit')
  }
})

test('recovery adopts an immutable child completion receipt after the parent dies before committing it', { timeout: 35_000 }, async () => {
  await withProcessHarness(
    { scenario: 'receipt-adoption', nodeEnv: 'test' },
    async (harness) => {
      const workflowId = 'adopt-child-receipt'
      const registryPath = createWorkflowRegistry({
        rootPath: harness.rootPath,
        workflowId,
      })
      const crashMarkerPath = path.join(harness.controlPath, 'receipt-published')
      process.env.TEAM_RUNTIME_TEST_CRASH_AFTER_RECEIPT_STEP = 'write'
      process.env.TEAM_RUNTIME_TEST_CRASH_AFTER_RECEIPT_MARKER = crashMarkerPath

      const originalStore = new FileSystemSessionStore(harness.workspacePath, {
        instanceId: 'receipt-original-api',
      })
      const session = await originalStore.createSession({ title: 'Adopt child receipt' })
      const launched = await launchRealTask({
        store: originalStore,
        sessionId: session.id,
        workspacePath: harness.workspacePath,
        workflowId,
        registryPath,
      })
      harness.trackedTasks.push(launched)

      await waitFor({
        description: 'receipt publication crash marker',
        read: () => fs.existsSync(crashMarkerPath),
        matches: Boolean,
      })
      await waitFor({
        description: 'receipt failpoint process to stop',
        read: () => {
          const target = processTarget(launched)
          return target === null || !defaultIsProcessAlive(target)
        },
        matches: Boolean,
        timeoutMs: 5_000,
      })

      const beforeRecovery = await new FileSystemWorkflowStateStore(
        requireTaskAssignmentPath(launched),
      ).requireSnapshot()
      const durableStep = beforeRecovery.state.steps[0]!
      assert.equal(beforeRecovery.state.status, 'running')
      assert.equal(durableStep.status, 'running')
      assert.equal(durableStep.attemptCount, 1)
      assert.equal(durableStep.artifact, undefined)

      const childAssignmentPath = resolveChildAssignmentPath(
        harness.workspacePath,
        launched,
        durableStep.childRunId,
      )
      const receipt = await readWorkflowCompletionReceipt(childAssignmentPath, {
        taskId: launched.id,
        rootRunId: launched.runId,
        workflowId,
        stepId: 'write',
        childRunId: durableStep.childRunId,
        ...whenDefined(launched.executionAttemptId, (executionAttemptId) => ({
          executionAttemptId,
        })),
      })
      assert.ok(receipt)
      assert.equal(receipt.status, 'completed')
      assert.ok(receipt.artifact)
      assert.equal(readInvocations(harness.controlPath).length, 1)

      const restartedStore = new FileSystemSessionStore(harness.workspacePath, {
        instanceId: 'receipt-restarted-api',
        staleTaskGraceMs: 0,
      })
      const reconciled = await restartedStore.listTaskRecords(session.id)
      const interrupted = reconciled.find((task) => task.id === launched.id)
      assert.ok(interrupted)
      assert.equal(interrupted.status, 'interrupted')
      assert.equal(interrupted.recoveryDisposition, 'automatic')

      const resumed = await resumeRealTask({
        store: restartedStore,
        sessionId: session.id,
        taskId: launched.id,
        workspacePath: harness.workspacePath,
        registryPath,
      })
      harness.trackedTasks.push(resumed)
      const completed = await waitForTerminalTask(
        restartedStore,
        session.id,
        launched.id,
      )
      assert.equal(completed.status, 'done')
      assert.equal(completed.executionAttemptNumber, 2)
      assert.notEqual(completed.executionAttemptId, launched.executionAttemptId)

      const recovered = await waitForWorkflowState(
        completed,
        (snapshot) => snapshot.state.status === 'completed',
      )
      assert.equal(recovered.state.steps[0]!.status, 'completed')
      assert.equal(recovered.state.steps[0]!.attemptCount, 1)
      assert.deepEqual(recovered.state.steps[0]!.artifact, receipt.artifact)
      assert.equal(readInvocations(harness.controlPath).length, 1)
      assert.ok(
        fs.existsSync(path.join(childAssignmentPath, 'final-draft.md')),
        'The adopted receipt must still point at the original child artifact',
      )
    },
  )
})

test('fresh-process reconciliation reconstructs the public result after a terminal-journal crash window', { timeout: 35_000 }, async () => {
  await withProcessHarness(
    { scenario: 'terminal-publication-crash', nodeEnv: 'test' },
    async (harness) => {
      const workflowId = 'terminal-publication-repair'
      const registryPath = createWorkflowRegistry({
        rootPath: harness.rootPath,
        workflowId,
      })
      const crashMarkerPath = path.join(
        harness.controlPath,
        'terminal-journal-committed',
      )
      process.env.TEAM_RUNTIME_TEST_CRASH_AFTER_WORKFLOW_TERMINAL_MARKER =
        crashMarkerPath

      const originalStore = new FileSystemSessionStore(harness.workspacePath, {
        instanceId: 'terminal-original-api',
      })
      const session = await originalStore.createSession({
        title: 'Repair terminal publication',
      })
      const launched = await launchRealTask({
        store: originalStore,
        sessionId: session.id,
        workspacePath: harness.workspacePath,
        workflowId,
        registryPath,
      })
      harness.trackedTasks.push(launched)

      await waitFor({
        description: 'terminal journal crash marker',
        read: () => fs.existsSync(crashMarkerPath),
        matches: Boolean,
      })
      await waitFor({
        description: 'terminal publication failpoint process to stop',
        read: () => {
          const target = processTarget(launched)
          return target === null || !defaultIsProcessAlive(target)
        },
        matches: Boolean,
        timeoutMs: 5_000,
      })

      const rootAssignmentPath = requireTaskAssignmentPath(launched)
      const snapshot = await new FileSystemWorkflowStateStore(
        rootAssignmentPath,
      ).requireSnapshot()
      assert.equal(snapshot.state.status, 'completed')
      assert.ok(snapshot.state.terminalOutcome)
      const publicResultPath = path.join(
        rootAssignmentPath,
        `workflow-${workflowId}-result.md`,
      )
      assert.equal(fs.existsSync(publicResultPath), false)
      assert.equal(readInvocations(harness.controlPath).length, 1)

      const restartedStore = new FileSystemSessionStore(harness.workspacePath, {
        instanceId: 'terminal-restarted-api',
        staleTaskGraceMs: 0,
      })
      const reconciled = await restartedStore.listTaskRecords(session.id)
      const repaired = reconciled.find((task) => task.id === launched.id)
      assert.equal(repaired?.status, 'done')
      assert.equal(repaired?.id, launched.id)
      assert.equal(repaired?.runId, launched.runId)
      assert.equal(repaired?.executionAttemptId, launched.executionAttemptId)
      assert.equal(fs.existsSync(publicResultPath), true)
      const publicResult = fs.readFileSync(publicResultPath, 'utf8')
      assert.match(publicResult, /# Workflow Result/)
      assert.match(publicResult, /terminal-publication-repair/)
      assert.match(publicResult, /finished with status completed/)
      assert.equal(readInvocations(harness.controlPath).length, 1)

      const engineEvents = fs.readFileSync(
        path.join(rootAssignmentPath, 'logs', 'engine-events.jsonl'),
        'utf8',
      )
      assert.match(engineEvents, /"type":"artifact.written"/)
      assert.match(engineEvents, /"type":"artifact.delivery_selected"/)
    },
  )
})
import { whenDefined } from '../../core/optional-properties.js'

test('an enrolled workflow keeps journaling across a real worker restart with enrolment turned off', { timeout: 40_000 }, async () => {
  // AC4's documented observable (plan §6, AC4): a real worker enrols and
  // crashes; a second real worker restarts **with enrolment turned off**, records a
  // further transition; `workflow-state.json` is deleted; and the rebuild from
  // the canonical journal contains that second transition.
  //
  // An earlier version of this test called the registry factory directly and
  // read the existing projection. It never spawned `session-task-runner`, so
  // reverting the worker wiring left it green — it proved the factory, not the
  // worker.
  await withProcessHarness(
    { scenario: 'journal-authority-restart', nodeEnv: 'test' },
    async (harness) => {
      process.env.PIPELINE_DURABLE_JOURNAL = 'authoritative'
      process.env.TEAM_TENANT_ID = 'tenant-authority-restart'

      const workflowId = 'journal-authority-restart'
      const registryPath = createWorkflowRegistry({
        rootPath: harness.rootPath,
        workflowId,
        twoSteps: true,
      })
      const store = new FileSystemSessionStore(harness.workspacePath)
      const session = await store.createSession({ title: 'Authority restart' })

      // Crash the first worker after it publishes the receipt for `discuss`,
      // so `write` is still outstanding and the second worker has real work.
      const crashMarker = path.join(harness.controlPath, 'discuss-receipt')
      process.env.TEAM_RUNTIME_TEST_CRASH_AFTER_RECEIPT_STEP = 'discuss'
      process.env.TEAM_RUNTIME_TEST_CRASH_AFTER_RECEIPT_MARKER = crashMarker

      const task = await launchRealTask({
        store,
        sessionId: session.id,
        workspacePath: harness.workspacePath,
        workflowId,
        registryPath,
      })
      harness.trackedTasks.push(task)

      await waitFor({
        description: 'the first worker to publish the discuss receipt and die',
        read: () => fs.existsSync(crashMarker),
        matches: (published) => published,
      })
      await waitFor({
        description: 'the crashed worker process to exit',
        read: () => {
          const pid = processTarget(task)
          return pid === null || !defaultIsProcessAlive(pid)
        },
        matches: (exited) => exited,
      })

      const assignmentPath = requireTaskAssignmentPath(task)
      const atCrash = await readExecutionJournal(assignmentPath)
      assert.equal(atCrash.kind, 'ok', 'the first worker must have enrolled')
      if (atCrash.kind !== 'ok') return
      const eventsAtCrash = atCrash.events.filter(
        (event) => event.streamKind === WORKFLOW_STATE_STREAM_KIND,
      ).length
      assert.ok(eventsAtCrash > 0, 'the first worker must journal its transitions')

      // The restart: enrolment turned off, failpoint disarmed. Authority is
      // sticky, so this assignment must still be journaled. Stated explicitly
      // rather than by deleting the flag — since A-14 an absent flag means
      // `authoritative`, which would journal for the ordinary reason and prove
      // nothing about stickiness.
      process.env.PIPELINE_DURABLE_JOURNAL = 'disabled'
      delete process.env.TEAM_RUNTIME_TEST_CRASH_AFTER_RECEIPT_STEP
      delete process.env.TEAM_RUNTIME_TEST_CRASH_AFTER_RECEIPT_MARKER

      // A killed worker leaves its task record `running`. A fresh store
      // reconciles it to `interrupted`, which is what a restarted API process
      // does and what makes the task resumable.
      const restartedStore = new FileSystemSessionStore(harness.workspacePath, {
        instanceId: 'restarted-api',
        staleTaskGraceMs: 0,
      })
      const reconciled = await restartedStore.listTaskRecords(session.id)
      const interrupted = reconciled.find((record) => record.id === task.id)
      assert.ok(interrupted)
      assert.equal(interrupted.status, 'interrupted')

      const resumed = await resumeRealTask({
        store: restartedStore,
        sessionId: session.id,
        taskId: task.id,
        workspacePath: harness.workspacePath,
        registryPath,
      })
      harness.trackedTasks.push(resumed)
      await waitForTerminalTask(restartedStore, session.id, task.id)

      const afterRestart = await readExecutionJournal(assignmentPath)
      assert.equal(afterRestart.kind, 'ok')
      if (afterRestart.kind !== 'ok') return
      const eventsAfterRestart = afterRestart.events.filter(
        (event) => event.streamKind === WORKFLOW_STATE_STREAM_KIND,
      ).length
      assert.ok(
        eventsAfterRestart > eventsAtCrash,
        'the restarted worker must keep journaling with enrolment turned off: ' +
          `${eventsAtCrash} events at the crash, ${eventsAfterRestart} after`,
      )

      // The state file is a projection: delete it and rebuild from the journal
      // alone, and the second worker's work must be there.
      const journalStore = new FileSystemWorkflowStateStore(assignmentPath)
      const before = await journalStore.requireSnapshot()
      const writeStepBefore = before.state.steps.find((step) => step.stepId === 'write')
      assert.ok(writeStepBefore, 'the two-step workflow must have a write step')
      assert.ok(
        ['completed', 'completed_with_warnings'].includes(writeStepBefore.status),
        `the restarted worker must have executed 'write', saw ${writeStepBefore.status}`,
      )
      fs.rmSync(journalStore.paths.statePath)

      const rebuildRegistry = createWorkspaceExecutionJournalRegistry(
        harness.workspacePath,
      )
      try {
        const journal = await rebuildRegistry.resolveJournalHandle({
          context: {
            contractVersion: 1,
            requestId: 'rebuild-authority-restart',
            sessionId: task.sessionId,
            runId: task.runId,
            assignmentId: task.assignmentId ?? task.runId,
            agentPath: 'workflows/runner',
            authority: {
              kind: 'runtime-assignment',
              processIdentity: 'rebuild',
            },
          },
          signal: new AbortController().signal,
          deadlineMs: Date.now() + 10_000,
        })
        assert.ok(journal, 'the enrolled assignment must resolve with the flag off')
        await rebuildWorkflowStateProjection(journal, journalStore)
      } finally {
        await rebuildRegistry.close()
      }

      const rebuilt = await journalStore.requireSnapshot()
      assert.deepEqual(
        rebuilt.state,
        before.state,
        'the journal alone must reproduce the state the restarted worker left',
      )
    },
  )
})
