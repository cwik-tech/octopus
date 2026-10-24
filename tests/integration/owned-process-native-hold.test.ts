import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { requiredValue } from '../../core/required-value.js'
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import type { RunPlan } from '../../contracts/run-plan.js'
import type { SessionTask } from '../../contracts/sessions.js'
import {
  claimRecordSchema,
  closedRecordSchema,
  fenceRecordSchema,
  intentRecordSchema,
  OWNED_PROCESS_ARGUMENT,
  ownedProcessScopeFolders,
  readScopeRecord,
} from '../../core/owned-processes/owned-process-records.js'
import { ownedProcessScopePath } from '../../core/owned-processes/owned-process-scope.js'
import { TASK_QUEUE_EVENT_FILENAME } from '../../core/task-queue-events.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { SessionTaskRunnerLauncher } from '../../domains/sessions/session-task-launcher.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { DEFAULT_MODEL_SELECTION_ENV } from '../../domains/provider/provider-settings.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { startApiServer } from '../../server/api-server.js'
import { TaskQueue } from '../../services/task-queue.js'
import { launchSessionTask } from '../../services/task-service.js'
import { createWorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import {
  openHumanInputInteraction,
  submitHumanInputFeedback,
} from '../../services/workflow-human-input-service.js'
import { currentAttemptScope } from '../support/current-attempt-scope.js'
import {
  describeErrors,
  stopProcessesCarrying,
  stopProcessesWithEnvironment,
  withinBound,
} from '../support/fixture-process-markers.js'

// Requirements (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md,
// sections 7 and 8; verification items 6 and 7), through the real queue, the
// real task runner and a fake Pi:
//
// T6: a root that ends while one of its attempt's members cannot be verified
// (a nested Team whose host was killed alone, its target still running in the
// host's group) writes its status but keeps its admission and the hold; the
// slot stays taken across a restart, and a waiting task is not admitted; once
// the member's target is gone, the scope closes, the slot is released and the
// waiting task runs. Under the owner's T5 decision (2026-09-29), the step whose
// child left that member fails when its subtree close is held, so the root
// ends `failed`.
//
// T7 and T7b hold their wait through record damage (ADR section 9), not a live
// descendant: under the same decision a step cannot finish over a live
// unverifiable descendant. A first step's Team child exits and its subtree
// closes cleanly; while a later step runs, that child's claim is damaged, so
// the root's whole-scope close at the park is held. Repairing the claim is the
// cleanup. These cases never show a live host-killed descendant finishing its
// step; the seeded queue cases in owned-process-queue-hold.test.ts cover a
// live descendant.
//
// T7: a root that parks a human-input wait in that state keeps the wait's
// admission and the hold; an answer submitted meanwhile is kept and stages no
// continuation; once the claim is repaired, the continuation runs exactly once
// and its step sees the answer.
//
// T7b: the same for a model-choice wait, through the real API route: a step
// whose Agent is pinned to a pair that cannot run earns an offer; the consent
// given while the wait is held is recorded and stages no continuation; once
// the claim is repaired, the continuation runs exactly once, under that consent.
// Substituted boundary: the fake child dispatches its pinned attempt in its
// own process rather than through the parent's worker-turn route, and the
// approved retry only records the authorization its environment carries
// before writing its artifact. So T7b proves the held wait, the recorded
// consent and the one continuation that receives it; it does not prove that a
// sealed worker turn authorizes or runs the approved pair. That is covered by
// tests/integration/mcp-worker-model-choice-retry.test.ts (for one, "an
// approved model-choice retry is authorized against durable state, not the
// request").
//
// A root that has lost its task to a newer attempt closes only the attempt it
// was launched for: it never fences or closes the newer attempt's scope, and
// its own status write stays refused.

const repoRoot = process.cwd()
const FIXTURE_ID_ENV = 'PIPELINE_TEST_FIXTURE_ID'
const BOUND_MS = 30_000
const TEST_TICK_INTERVAL_MS = 60_000
const ANSWER = 'Please continue with the kept answer.'
/** The model-choice step's Agent pair. Deliberately unregistered, so it cannot run. */
const PINNED = { provider: 'connection:missing-connection', model: 'pinned-model' }
/** The application default the offer proposes. Also unregistered: nothing reaches a network. */
const APP_DEFAULT = { provider: 'connection:missing-default', model: 'default-model' }
const DIST_ROOT = fileURLToPath(new URL('../../', import.meta.url))

const HARNESS_ENV_KEYS = [
  'NODE_ENV',
  'PATH',
  'TEAM_RUNTIME_PI_CLI_PATH',
  'TEAM_RUNTIME_PI_NODE_PATH',
  'TEAM_RUNTIME_TEST_CONTROL_DIR',
  'TEAM_RUNTIME_TEST_AGENT_RUNNER_MODULE',
  'TEAM_RUNTIME_TEST_DIST_ROOT',
  DEFAULT_MODEL_SELECTION_ENV,
  FIXTURE_ID_ENV,
] as const

interface Invocation {
  readonly pid: number
  readonly depth: number
  readonly rootRunId: string
  readonly childRunId: string
  readonly output: string
  readonly role: string
  readonly stepId?: string
  readonly brief?: string
  /** The consent a model-choice retry ran under, as its own environment carried it. */
  readonly offerId?: string
  readonly approved?: { readonly provider: string; readonly model: string }
}

interface Harness {
  readonly rootPath: string
  readonly workspacePath: string
  readonly controlPath: string
  readonly fakePiPath: string
  readonly registryPath: string
  readonly fixtureId: string
}

function isInvocation(value: unknown): value is Invocation {
  return typeof value === 'object' && value !== null &&
    typeof Reflect.get(value, 'pid') === 'number' &&
    typeof Reflect.get(value, 'depth') === 'number' &&
    typeof Reflect.get(value, 'rootRunId') === 'string' &&
    typeof Reflect.get(value, 'role') === 'string'
}

function readInvocations(harness: Harness): Invocation[] {
  const filePath = path.join(harness.controlPath, 'invocations.jsonl')
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => {
    const parsed: unknown = JSON.parse(line)
    assert.ok(isInvocation(parsed), 'an unreadable invocation record')
    return parsed
  })
}

/**
 * A bounded poll, kept for the one wait that has no observable event yet: a
 * nested host's exit after it is killed alone (review rank 14, item 1).
 * Every other wait here ends on an event.
 */
async function waitFor<T>(description: string, read: () => T | Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + BOUND_MS
  let latest = await read()
  while (!matches(latest) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    latest = await read()
  }
  assert.ok(matches(latest), `Timed out waiting for ${description}`)
  return latest
}

/**
 * Resolves with `read()` once it matches, reading again on every change in
 * `folder`: a write the product or a fake Pi makes, never the passing of time.
 * BOUND_MS only stops a broken run from outliving the test.
 */
async function waitForChange<T>(
  description: string,
  folder: string,
  read: () => T | Promise<T>,
  matches: (value: T) => boolean,
): Promise<T> {
  let watcher: fs.FSWatcher | undefined
  const reached = new Promise<T>((resolve, reject) => {
    let reading = false
    let changedWhileReading = false
    const check = async (): Promise<void> => {
      if (reading) {
        changedWhileReading = true
        return
      }
      reading = true
      try {
        do {
          changedWhileReading = false
          const latest = await read()
          if (matches(latest)) {
            resolve(latest)
            return
          }
        } while (changedWhileReading)
      } catch (error) {
        reject(error)
      } finally {
        reading = false
      }
    }
    // Watched before the first read, so a change between the two is not missed.
    watcher = fs.watch(folder, () => { void check() })
    watcher.on('error', reject)
    void check()
  })
  try {
    return await withinBound(reached, BOUND_MS, description)
  } finally {
    watcher?.close()
  }
}

/** Resolves once `name` exists in the control folder, where the fake Pi writes it. */
async function controlFileAppears(harness: Harness, name: string, description: string): Promise<void> {
  await waitForChange(description, harness.controlPath, () => fs.existsSync(path.join(harness.controlPath, name)), Boolean)
}

/** The task's record once it matches, read again on each write to the task's folder. */
async function taskReaches(
  store: FileSystemSessionStore,
  sessionId: string,
  taskId: string,
  description: string,
  matches: (task: SessionTask) => boolean,
): Promise<SessionTask> {
  return waitForChange(description, store.taskDir(sessionId, taskId), () => taskRecord(store, sessionId, taskId), matches)
}

function isEventRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function queueFolder(harness: Harness): string {
  return path.join(harness.workspacePath, 'task-queue')
}

/** How many times the queue's event file records releasing `taskId`'s slot. */
function queueReleasesOf(harness: Harness, taskId: string): number {
  const eventsPath = path.join(queueFolder(harness), TASK_QUEUE_EVENT_FILENAME)
  if (!fs.existsSync(eventsPath)) return 0
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line): unknown => JSON.parse(line))
    .filter(isEventRecord)
    .filter((event) => event.event === 'task_queue.released' && event.task_id === taskId)
    .length
}

/** Resolves once the queue records releasing `taskId`'s slot again, after `before` releases. */
async function queueReleases(harness: Harness, taskId: string, before: number, description: string): Promise<void> {
  await waitForChange(description, queueFolder(harness), () => queueReleasesOf(harness, taskId), (count) => count > before)
}

/** What runs at `pid` (group and command), or undefined when ps says none. */
function processAt(pid: number): { readonly groupId: number; readonly command: string } | undefined {
  let output: string
  try {
    output = execFileSync('/bin/ps', ['-o', 'pgid=,command=', '-p', String(pid)], { encoding: 'utf8', env: {} })
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 1) return undefined
    throw error
  }
  const match = /^\s*(\d+)\s+(.+)$/su.exec(output.trim())
  assert.ok(match?.[1] && match[2], `unreadable process listing for ${pid}`)
  return { groupId: Number(match[1]), command: match[2] }
}

function writeFakePi(filePath: string): void {
  fs.writeFileSync(filePath, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// Resolves when the test writes this root's release file, seen on a change in
// the control folder; watched before the check, so a release between the two
// is not missed.
const released = (control, rootRunId) => new Promise((resolve) => {
  const release = path.join(control, 'release-' + rootRunId)
  const watcher = fs.watch(control, () => {
    if (fs.existsSync(release)) {
      watcher.close()
      resolve()
    }
  })
  if (fs.existsSync(release)) {
    watcher.close()
    resolve()
  }
})

async function main() {
  const control = process.env.TEAM_RUNTIME_TEST_CONTROL_DIR
  const depth = Number(process.env.TEAM_SPAWN_DEPTH || '0')
  const rootRunId = process.env.TEAM_ROOT_SESSION_ID || ''
  const childRunId = process.env.TEAM_SESSION_ID || path.basename(process.cwd())
  const output = process.env.TEAM_OUTPUT_ARTIFACT || 'output.md'
  const record = (extra) => fs.appendFileSync(path.join(control, 'invocations.jsonl'),
    JSON.stringify({ pid: process.pid, depth, rootRunId, childRunId, output, stepId: process.env.TEAM_RUNTIME_WORKFLOW_STEP_ID || '', ...extra }) + '\\n')
  if (depth >= 2) {
    record({ role: 'nested' })
    fs.writeFileSync(path.join(control, 'nested-ready-' + rootRunId), String(process.pid))
    setInterval(() => {}, 1 << 30)
    return
  }
  const stepId = process.env.TEAM_RUNTIME_WORKFLOW_STEP_ID || ''
  if (stepId === 'choose' && !process.env.PIPELINE_APPROVED_MODEL_CHOICE) {
    record({ role: 'pinned-attempt' })
    // A real dispatch for an Agent pinned to a connection that does not
    // exist: the adapter refuses before it sends anything and records the
    // refusal in this child's run log. Ending without the artifact is how a
    // child reports failure to runTeam. The parent's worker-turn route
    // authorizes only the Agents its launch sealed, and this Agent is not one
    // of the team's, so the dispatch runs in this process, as it does for a
    // child with no parent route.
    delete process.env.PIPELINE_MCP_WORKER_TURN_URL
    const load = (relative) => import(pathToFileURL(path.join(process.env.TEAM_RUNTIME_TEST_DIST_ROOT, relative)).href)
    const providers = await load('providers/index.js')
    const configured = await load('providers/configured-provider.js')
    const runner = await load('domains/agent-execution/agent-runner.js')
    providers.initProviders()
    configured.setConfiguredProviderConnections([])
    const pinned = ${JSON.stringify(PINNED)}
    await runner.dispatchToAgentOrTeam({
      agent: {
        name: 'writer', model: pinned.model, thinking: 'low', tools: [],
        systemPrompt: 'Write the requested draft.', experienceContent: '', experienceEnabled: false,
        skillsContent: '', knowledgeContent: '', agentDir: '', color: 1,
        provider: pinned.provider, providerConfig: {},
        selection: { provider: pinned.provider, model: pinned.model, source: 'agent', reason: 'explicit-agent-choice' },
      },
      rosterEntry: { type: 'agent' },
      finalPrompt: 'Write the requested draft.',
      userMessage: 'Draft a recommendation.',
      state: {
        sessionId: childRunId, currentLevelIndex: 0, levelStates: new Map(), totalCost: 0,
        startTime: 0, timerStarted: false, endTime: null, spawnDepth: depth,
      },
      workspacePath: process.cwd(),
      outputPath: process.cwd(),
      metrics: undefined,
      logicalInvocationId: stepId,
    }).catch(() => undefined)
    process.exit(0)
  }
  if (stepId === 'hold-open') {
    // Runs until the test releases it: the window in which a settled step's
    // record is damaged.
    record({ role: 'hold-open' })
    await released(control, rootRunId)
  } else if (output === 'output/decomposition-plan.md') {
    record({ role: 'work' })
    const { runTeam } = await import(pathToFileURL(process.env.TEAM_RUNTIME_TEST_AGENT_RUNNER_MODULE).href)
    // Started and left running: the member this step leaves behind.
    runTeam({
      teamPath: path.dirname(process.env.TEAM_CONFIG_PATH),
      workspacePath: process.env.TEAM_WORKSPACE_PATH,
      brief: 'A nested member',
      spawnDepth: depth,
      childSessionId: 'nested-' + process.pid,
    }).catch((error) => console.error(error && error.stack ? error.stack : String(error)))
    await released(control, rootRunId)
  } else if (stepId === 'choose') {
    const authorization = JSON.parse(Buffer.from(process.env.PIPELINE_APPROVED_MODEL_CHOICE, 'base64').toString('utf8'))
    record({ role: 'approved-retry', offerId: authorization.offerId, approved: authorization.proposedDefault })
  } else {
    let brief = ''
    try { brief = fs.readFileSync(path.join(process.cwd(), process.env.TEAM_INPUT_ARTIFACT || 'incoming-brief.md'), 'utf8') } catch {}
    record({ role: output, brief })
  }
  const outputPath = path.join(process.cwd(), output)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, ['---', 'artifact_type: "report"', '---', '# Fake result', '', 'Child: ' + childRunId].join('\\n'))
  process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant',
    content: [{ type: 'text', text: 'Wrote the report artifact.' }], usage: { cost: { total: 0.01 } } } }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n', () => process.exit(0))
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error))
  process.exit(1)
})
`, { mode: 0o755 })
}

function writeRegistry(rootPath: string): string {
  const templates: Record<string, string> = {
    'native-hold-end': [
      'workflow:',
      '  id: native-hold-end',
      '  steps:',
      '    - id: work',
      '      type: team',
      '      team: problem-thinking-board',
      '      input_artifact: incoming-brief.md',
      '      result_artifact: output/decomposition-plan.md',
      '      recovery_policy: safe_retry',
      '  output:',
      '    from_step: work',
      '    artifact: output/decomposition-plan.md',
      '  on_blocked: stop',
      '  on_failed: stop',
    ].join('\n'),
    'native-quick': [
      'workflow:',
      '  id: native-quick',
      '  steps:',
      '    - id: quick',
      '      type: team',
      '      team: writing-team',
      '      input_artifact: incoming-brief.md',
      '      result_artifact: final-draft.md',
      '      recovery_policy: safe_retry',
      '  output:',
      '    from_step: quick',
      '    artifact: final-draft.md',
      '  on_blocked: stop',
      '  on_failed: stop',
    ].join('\n'),
    'native-hold-choice': [
      'workflow:',
      '  id: native-hold-choice',
      '  steps:',
      '    - id: prep',
      '      type: team',
      '      team: writing-team',
      '      input_artifact: incoming-brief.md',
      '      result_artifact: final-draft.md',
      '      recovery_policy: safe_retry',
      '    - id: hold-open',
      '      type: team',
      '      team: problem-thinking-board',
      '      input_artifact: incoming-brief.md',
      '      result_artifact: output/decomposition-plan.md',
      '      recovery_policy: safe_retry',
      '    - id: choose',
      '      type: team',
      '      team: writing-team',
      '      input_artifact: incoming-brief.md',
      '      result_artifact: final-draft.md',
      '  output:',
      '    from_step: choose',
      '    artifact: final-draft.md',
      '  on_blocked: stop',
      '  on_failed: stop',
    ].join('\n'),
    'native-hold-wait': [
      'workflow:',
      '  id: native-hold-wait',
      '  steps:',
      '    - id: prep',
      '      type: team',
      '      team: writing-team',
      '      input_artifact: incoming-brief.md',
      '      result_artifact: final-draft.md',
      '      recovery_policy: safe_retry',
      '    - id: hold-open',
      '      type: team',
      '      team: problem-thinking-board',
      '      input_artifact: incoming-brief.md',
      '      result_artifact: output/decomposition-plan.md',
      '      recovery_policy: safe_retry',
      '    - id: human-feedback',
      '      type: human-in-the-loop',
      '      input_artifact: review/round-1.md',
      '      result_artifact: feedback/round-1.json',
      '      handoff:',
      '        from_step: hold-open',
      '        from_artifact: output/decomposition-plan.md',
      '        to_artifact: review/round-1.md',
      '    - id: final',
      '      type: team',
      '      team: writing-team',
      '      input_artifact: incoming-brief.md',
      '      result_artifact: final-draft.md',
      '      recovery_policy: safe_retry',
      '      handoff:',
      '        from_step: human-feedback',
      '        from_artifact: feedback/round-1.json',
      '        to_artifact: incoming-brief.md',
      '  output:',
      '    from_step: final',
      '    artifact: final-draft.md',
      '  on_blocked: stop',
      '  on_failed: stop',
    ].join('\n'),
  }
  const lines: string[] = []
  for (const [id, template] of Object.entries(templates)) {
    fs.writeFileSync(path.join(rootPath, `${id}.yaml`), `${template}\n`)
    lines.push(`${id}:`, '  description: Native owned-process hold fixture.', `  template_path: ./${id}.yaml`)
  }
  const registryPath = path.join(rootPath, 'native-registry.yaml')
  fs.writeFileSync(registryPath, `${lines.join('\n')}\n`)
  return registryPath
}

async function withHarness(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-native-hold-'))
  const workspacePath = path.join(rootPath, 'workspace')
  const controlPath = path.join(rootPath, 'control')
  const binPath = path.join(rootPath, 'bin')
  for (const folder of [workspacePath, controlPath, binPath]) fs.mkdirSync(folder, { recursive: true })
  const fakePiPath = path.join(binPath, 'pi')
  writeFakePi(fakePiPath)
  const fixtureId = randomUUID()
  const harness: Harness = { rootPath, workspacePath, controlPath, fakePiPath, registryPath: writeRegistry(rootPath), fixtureId }
  const previous = new Map<string, string | undefined>(HARNESS_ENV_KEYS.map((key) => [key, process.env[key]]))
  process.env.NODE_ENV = 'test'
  process.env.PATH = `${binPath}${path.delimiter}${previous.get('PATH') ?? ''}`
  process.env.TEAM_RUNTIME_PI_CLI_PATH = fakePiPath
  process.env.TEAM_RUNTIME_PI_NODE_PATH = process.execPath
  process.env.TEAM_RUNTIME_TEST_CONTROL_DIR = controlPath
  process.env.TEAM_RUNTIME_TEST_AGENT_RUNNER_MODULE = fileURLToPath(
    new URL('../../domains/agent-execution/agent-runner.js', import.meta.url),
  )
  process.env.TEAM_RUNTIME_TEST_DIST_ROOT = DIST_ROOT
  // Inherited by every process this harness starts, and by their children.
  process.env[FIXTURE_ID_ENV] = fixtureId

  const failures: unknown[] = []
  try {
    await fn(harness)
  } catch (error) {
    failures.push(error)
  }
  for (const step of [
    () => stopProcessesWithEnvironment(FIXTURE_ID_ENV, fixtureId),
    () => stopProcessesCarrying(fakePiPath),
  ]) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  for (const key of HARNESS_ENV_KEYS) {
    const value = previous.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (failures.length === 0) fs.rmSync(rootPath, { recursive: true, force: true })
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, `the test and its cleanup failed; ${rootPath} is kept: ${describeErrors(failures)}`)
}

interface RunningQueue {
  readonly queue: TaskQueue
  readonly owner: WorkspaceDispatcherOwner
  readonly store: FileSystemSessionStore
}

/**
 * A one-slot queue on the harness's workspace. It passes on the product's own
 * tick unless a test names another; a test with a long tick wakes it itself.
 */
async function startQueue(harness: Harness, tick: 'product' | { readonly intervalMs: number }): Promise<RunningQueue> {
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath: harness.workspacePath })
  const store = new FileSystemSessionStore(harness.workspacePath, { instanceId: `native-app-${randomUUID()}` })
  const queue = new TaskQueue({
    sessionStore: store,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: repoRoot,
    workspacePath: harness.workspacePath,
    workflowsRegistryPath: harness.registryPath,
    taskLauncher: new SessionTaskRunnerLauncher(repoRoot),
    ...(tick === 'product' ? {} : { tickIntervalMs: tick.intervalMs }),
  })
  await queue.initialize()
  return { queue, owner, store }
}

async function stopQueue(running: RunningQueue): Promise<void> {
  await running.queue.close(1)
  await running.owner.release()
}

/**
 * Admits one task through the queue the way the real apply path does: its own
 * session, a ready run plan for the workflow, claimed for apply.
 */
async function enqueueTask(running: RunningQueue, workflowId: string, brief: string): Promise<SessionTask> {
  const session = await running.store.createSession({ title: workflowId })
  const plan: RunPlan = {
    id: randomUUID(),
    goal: brief,
    summary: `Run ${workflowId}`,
    status: 'ready',
    selectedWorkflow: { id: workflowId, rationale: 'Native owned-process fixture.', confidence: 'high' },
    requiredInputs: [],
    brief,
    actions: [{
      id: 'launch-workflow',
      type: 'launch_workflow',
      status: 'ready',
      title: 'Launch workflow',
      rationale: 'Native owned-process fixture.',
      workflowId,
    }],
    warnings: [],
    createdAt: new Date().toISOString(),
  }
  await running.store.saveRunPlan(session.id, plan)
  const claimed = await running.store.claimRunPlanForApply(session.id, plan.id)
  const applyClaimId = requiredValue(claimed?.plan.applyClaimId, 'apply claim')
  return running.queue.enqueueInitial({
    sessionId: session.id,
    admissionSource: 'apply',
    task: { workflowId, brief, runPlanId: plan.id, runPlanApplyClaimId: applyClaimId },
  })
}

async function taskRecord(store: FileSystemSessionStore, sessionId: string, taskId: string): Promise<SessionTask> {
  return requiredValue(await store.getTaskRecord(sessionId, taskId), 'task record')
}

/**
 * Waits for the task's work step to leave a nested member, kills that
 * member's host alone (verified by its marker immediately before the signal),
 * and lets the work step finish. Returns the member target's pid, which keeps
 * running in the dead host's group.
 */
async function leaveUnverifiableMember(harness: Harness, store: FileSystemSessionStore, task: SessionTask): Promise<number> {
  await controlFileAppears(harness, `nested-ready-${task.runId}`, `the nested member of ${task.runId}`)
  const nested = requiredValue(
    readInvocations(harness).find((entry) => entry.rootRunId === task.runId && entry.role === 'nested'),
    'nested invocation',
  )
  const current = await taskRecord(store, task.sessionId, task.id)
  const scopePath = ownedProcessScopePath({
    workspacePath: harness.workspacePath,
    sessionId: current.sessionId,
    taskId: current.id,
    executionAttemptNumber: requiredValue(current.executionAttemptNumber, 'attempt number'),
  })
  const intents = fs.readdirSync(ownedProcessScopeFolders(scopePath).intents)
  let nestedHostPid: number | undefined
  for (const name of intents) {
    const intent = await readScopeRecord({ target: path.join(ownedProcessScopeFolders(scopePath).intents, name), schema: intentRecordSchema })
    if (intent.kind !== 'present' || intent.record.parentOwnedProcessId === null) continue
    const claim = await readScopeRecord({
      target: path.join(ownedProcessScopeFolders(scopePath).claims, name),
      schema: claimRecordSchema,
      expectedOwnedProcessId: intent.record.ownedProcessId,
    })
    assert.ok(claim.kind === 'present' && claim.record.claimant === 'host', 'the nested member was claimed by its host')
    const host = processAt(claim.record.pid)
    assert.ok(host, 'the nested host runs')
    assert.ok(` ${host.command} `.includes(` ${OWNED_PROCESS_ARGUMENT}${intent.record.ownedProcessId} `), 'the nested host carries its marker')
    assert.equal(processAt(nested.pid)?.groupId, claim.record.pid, 'the nested target runs in its host\'s group')
    process.kill(claim.record.pid, 'SIGKILL')
    nestedHostPid = claim.record.pid
  }
  assert.ok(nestedHostPid !== undefined, 'the scope records the nested member')
  // Bounded wait: no observable event yet (review rank 14, item 1)
  await waitFor('the nested host to exit', () => processAt(requiredValue(nestedHostPid, 'host pid')), (row) => row === undefined)
  fs.writeFileSync(path.join(harness.controlPath, `release-${task.runId}`), 'release')
  return nested.pid
}

/**
 * Record damage (ADR section 9): waits for the task's blocking step, by which
 * time its first step has settled and that step's Team child's subtree has
 * closed cleanly; damages that child's claim; and lets the blocking step
 * finish. The root's whole-scope close at its park then reads the claim as
 * unreadable. Returns the repair, which restores the claim's bytes.
 */
async function damageSettledClaim(harness: Harness, store: FileSystemSessionStore, task: SessionTask): Promise<() => void> {
  await waitForChange(`the blocking step of ${task.runId}`, harness.controlPath, () => readInvocations(harness), (entries) =>
    entries.some((entry) => entry.rootRunId === task.runId && entry.role === 'hold-open'))
  const prep = requiredValue(
    readInvocations(harness).find((entry) => entry.rootRunId === task.runId && entry.stepId === 'prep'),
    'the first step\'s invocation',
  )
  const current = await taskRecord(store, task.sessionId, task.id)
  const scopePath = ownedProcessScopePath({
    workspacePath: harness.workspacePath,
    sessionId: current.sessionId,
    taskId: current.id,
    executionAttemptNumber: requiredValue(current.executionAttemptNumber, 'attempt number'),
  })
  const folders = ownedProcessScopeFolders(scopePath)
  let claimPath: string | undefined
  for (const name of fs.readdirSync(folders.intents)) {
    const intent = await readScopeRecord({ target: path.join(folders.intents, name), schema: intentRecordSchema })
    if (intent.kind === 'present' && intent.record.childRunId === prep.childRunId) {
      claimPath = path.join(folders.claims, name)
    }
  }
  const settledClaimPath = requiredValue(claimPath, 'the first step\'s claim')
  const settled = await readScopeRecord({ target: settledClaimPath, schema: claimRecordSchema })
  assert.ok(settled.kind === 'present' && settled.record.claimant === 'host', 'the first step\'s child was claimed by its host')
  assert.equal(processAt(settled.record.pid), undefined, 'the first step\'s host has exited')
  const original = fs.readFileSync(settledClaimPath)
  fs.writeFileSync(settledClaimPath, '{"version": 1, "ownedProcessId": ')
  fs.writeFileSync(path.join(harness.controlPath, `release-${task.runId}`), 'release')
  return () => fs.writeFileSync(settledClaimPath, original)
}

/**
 * Kills the member's target, verified as this harness's fake Pi immediately
 * before the signal. Nothing observes its exit here: the queue releases the
 * held slot only once the member's group is gone, reaped, so that release is
 * what the caller waits for.
 */
function killMember(harness: Harness, pid: number): void {
  const running = processAt(pid)
  assert.ok(running && running.command.includes(harness.fakePiPath), 'the member target is this harness\'s fake Pi')
  process.kill(pid, 'SIGKILL')
}

function processCleanupHoldReason(task: SessionTask): unknown {
  return task.processCleanupHold?.reason
}

/** A JSON body's named field, or undefined when the body is not an object. */
function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null ? Reflect.get(body, name) : undefined
}

/** A JSON body's named string field, or a failed assertion. */
function stringField(body: unknown, name: string): string {
  const value = field(body, name)
  assert.equal(typeof value, 'string', `the response names its ${name}`)
  return String(value)
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function scopeClosed(harness: Harness, task: SessionTask): Promise<boolean> {
  const scopePath = ownedProcessScopePath({
    workspacePath: harness.workspacePath,
    sessionId: task.sessionId,
    taskId: task.id,
    executionAttemptNumber: requiredValue(task.executionAttemptNumber, 'attempt number'),
  })
  return (await readScopeRecord({ target: path.join(scopePath, 'closed.json'), schema: closedRecordSchema })).kind === 'present'
}

test('native T6: a root that ends with an unverifiable member keeps its slot across a restart until the member is gone', { timeout: 180_000, skip: process.platform === 'win32' }, async () => {
  await withHarness(async (harness) => {
    // The product's own tick: a pass that still finds the killed member's
    // target unreaped keeps the slot, and a later pass releases it.
    let running = await startQueue(harness, 'product')
    try {
      const held = await enqueueTask(running, 'native-hold-end', '# Task Brief\n\nLeave a member behind.\n')
      const waitingTask = await enqueueTask(running, 'native-quick', '# Task Brief\n\nWait for the slot.\n')
      const started = await taskReaches(running.store, held.sessionId, held.id, 'the held task to start', (task) => task.pid !== undefined)
      const memberPid = await leaveUnverifiableMember(harness, running.store, started)

      // The owner's T5 decision (2026-09-29): the step whose child left an
      // unverifiable member fails, so the root ends `failed`. Everything the
      // slot does from here on is unchanged.
      const ended = await taskReaches(running.store, held.sessionId, held.id, 'the held task to end', (task) => task.status === 'failed')
      assert.equal(ended.admission?.phase, 'granted', 'the root kept its admission while a member is unverifiable')
      assert.equal(processCleanupHoldReason(ended), 'owned_processes_unverified')
      assert.ok(processAt(memberPid), 'the unverifiable member is not signalled')

      for (let restart = 0; restart < 2; restart += 1) {
        if (restart > 0) {
          await stopQueue(running)
          running = await startQueue(harness, 'product')
        }
        const stillHeld = await taskRecord(running.store, held.sessionId, held.id)
        assert.equal(stillHeld.admission?.phase, 'granted', `restart ${restart}: the held task keeps its admission`)
        const waiting = await taskRecord(running.store, waitingTask.sessionId, waitingTask.id)
        assert.equal(waiting.admission?.phase, 'pending', `restart ${restart}: the waiting task is not admitted`)
        assert.equal(waiting.pid, undefined)
      }

      const releasesBefore = queueReleasesOf(harness, held.id)
      killMember(harness, memberPid)
      running.queue.wake()
      // The queue's own release is the signal that the member is gone.
      await queueReleases(harness, held.id, releasesBefore, 'the queue to release the held slot')
      const released = await taskRecord(running.store, held.sessionId, held.id)
      assert.equal(released.admission, undefined, 'the held slot is released')
      assert.equal(processAt(memberPid), undefined, 'the member target has exited')
      assert.equal(processCleanupHoldReason(released), undefined)
      assert.equal(await scopeClosed(harness, released), true, 'the closed scope is recorded')
      await taskReaches(running.store, waitingTask.sessionId, waitingTask.id, 'the waiting task to run to the end', (task) => task.status === 'done')
    } finally {
      await stopQueue(running)
    }
  })
})

test('native T7 (record damage): a held human-input wait keeps its answer and continues exactly once after cleanup, seeing the answer', { timeout: 180_000, skip: process.platform === 'win32' }, async () => {
  await withHarness(async (harness) => {
    const running = await startQueue(harness, { intervalMs: TEST_TICK_INTERVAL_MS })
    try {
      const task = await enqueueTask(running, 'native-hold-wait', '# Task Brief\n\nAsk after a settled record is damaged.\n')
      const session = { id: task.sessionId }
      const started = await taskReaches(running.store, session.id, task.id, 'the task to start', (current) => current.pid !== undefined)
      const repairClaim = await damageSettledClaim(harness, running.store, started)

      const parked = await taskReaches(running.store, session.id, task.id, 'the wait to be parked', (current) => current.status === 'awaiting_input')
      assert.equal(parked.admission?.phase, 'granted', 'the parked wait keeps its admission while a member is unverifiable')
      assert.equal(processCleanupHoldReason(parked), 'owned_processes_unverified')

      // Opened through the workspace's execution journal, as the API route
      // opens it, so the answer is recorded in the canonical journal.
      const journalRegistry = createWorkspaceExecutionJournalRegistry(harness.workspacePath)
      const opened = await openHumanInputInteraction(
        { sessionStore: running.store, executionJournalRegistry: journalRegistry },
        { sessionId: session.id, taskId: task.id },
      )
      assert.equal(opened.kind, 'open')
      if (opened.kind !== 'open') return
      const submitted = await submitHumanInputFeedback(
        { taskQueue: running.queue, now: () => new Date() },
        opened.open,
        {
          readRequest: async () => ({
            submissionId: randomUUID(),
            expectedWorkflowRevision: opened.open.workflowRevision,
            expectedSourceArtifactSha256: opened.open.interaction.sourceArtifact.sha256,
            mode: 'feedback',
            messages: [{ id: randomUUID(), text: ANSWER, recipients: 'all' }],
          }),
        },
      )
      assert.equal(submitted.kind, 'submitted')
      await journalRegistry.close()
      const afterSubmit = await taskRecord(running.store, session.id, task.id)
      assert.deepEqual(afterSubmit.admission, parked.admission, 'no continuation is staged while the wait is held')
      assert.equal((await running.queue.snapshot()).waitingCount, 0)
      assert.equal(readInvocations(harness).filter((entry) => entry.stepId === 'final').length, 0)

      repairClaim()
      running.queue.wake()
      const done = await taskReaches(running.store, session.id, task.id, 'the continuation to finish', (current) => current.status === 'done')
      assert.equal(done.executionKind, 'continuation')
      const finals = readInvocations(harness).filter((entry) => entry.stepId === 'final' && entry.rootRunId === task.runId)
      assert.equal(finals.length, 1, 'the continuation ran exactly once')
      assert.ok(finals[0]?.brief?.includes(ANSWER), 'the continued step saw the kept answer')
    } finally {
      await stopQueue(running)
    }
  })
})

test('a stale root closes only its own attempt\'s scope, never the scope of the newer attempt that took its task over', { timeout: 180_000, skip: process.platform === 'win32' }, async () => {
  await withHarness(async (harness) => {
    const store = new FileSystemSessionStore(harness.workspacePath, { instanceId: `native-app-${randomUUID()}` })
    const session = await store.createSession({ title: 'Stale root' })
    let signalRootClosed: () => void = () => undefined
    const rootClosed = new Promise<void>((resolve) => { signalRootClosed = resolve })
    const launched = await launchSessionTask({
      sessionId: session.id,
      sessionStore: store,
      // Told when the root it launches closes: the stale root's exit is what
      // the checks below wait for.
      taskLauncher: new SessionTaskRunnerLauncher(repoRoot, { onRelease: () => signalRootClosed() }),
      repoRootPath: repoRoot,
      workspacePath: harness.workspacePath,
      workflowsRegistryPath: harness.registryPath,
      workflowId: 'native-hold-end',
      briefMarkdown: '# Task Brief\n\nLose the task to a newer attempt.\n',
      startupTimeoutMs: 10_000,
    })
    if (!launched.ok) assert.fail(`${launched.error}${'detail' in launched ? `: ${launched.detail}` : ''}`)
    const stale = launched.task
    const staleAttemptNumber = requiredValue(stale.executionAttemptNumber, 'stale attempt number')
    await controlFileAppears(harness, `nested-ready-${stale.runId}`, `the nested member of ${stale.runId}`)
    const staleRootPid = requiredValue((await taskRecord(store, session.id, stale.id)).pid, 'stale root pid')

    // A newer attempt takes the task over while the stale root still runs,
    // with its own published scope, as the store-level fencing test rotates
    // an attempt.
    const newerAttemptId = `newer-attempt-${randomUUID()}`
    const newerAttemptNumber = staleAttemptNumber + 1
    const takenOver = await store.compareAndSetTaskRecord(
      session.id,
      stale.id,
      ['running'],
      {
        executionAttemptId: newerAttemptId,
        processIdentity: newerAttemptId,
        executionAttemptNumber: newerAttemptNumber,
        executionKind: 'recovery',
        attemptStartedAt: new Date().toISOString(),
        ...await currentAttemptScope(stale, newerAttemptNumber),
      },
      { expectedExecutionAttemptId: requiredValue(stale.executionAttemptId, 'stale attempt id') },
    )
    assert.equal(takenOver?.updated, true)

    fs.writeFileSync(path.join(harness.controlPath, `release-${stale.runId}`), 'release')
    await withinBound(rootClosed, BOUND_MS, 'the stale root to exit')
    assert.equal(processAt(staleRootPid), undefined, 'the stale root has exited')

    const newerScopePath = ownedProcessScopePath({
      workspacePath: harness.workspacePath,
      sessionId: session.id,
      taskId: stale.id,
      executionAttemptNumber: newerAttemptNumber,
    })
    const newerFence = await readScopeRecord({ target: path.join(ownedProcessScopeFolders(newerScopePath).fences, 'attempt.json'), schema: fenceRecordSchema })
    assert.equal(newerFence.kind, 'absent', 'the stale root fenced the newer attempt\'s scope')
    const newerClosed = await readScopeRecord({ target: path.join(newerScopePath, 'closed.json'), schema: closedRecordSchema })
    assert.equal(newerClosed.kind, 'absent', 'the stale root closed the newer attempt\'s scope')
    const current = await taskRecord(store, session.id, stale.id)
    assert.equal(current.executionAttemptId, newerAttemptId)
    assert.equal(current.status, 'running', 'the stale root\'s status write was refused')
    assert.equal(await scopeClosed(harness, stale), true, 'the stale root closed its own attempt\'s scope')
  })
})

test('native T7b (record damage): a held model-choice wait keeps its recorded consent and continues exactly once after cleanup, under that consent', { timeout: 180_000, skip: process.platform === 'win32' }, async () => {
  await withHarness(async (harness) => {
    const store = new FileSystemSessionStore(harness.workspacePath, { instanceId: `native-api-${randomUUID()}` })
    const launcher = new SessionTaskRunnerLauncher(repoRoot)
    const server = await startApiServer({
      store: new FileSystemRunStore(harness.workspacePath),
      launcher,
      taskLauncher: launcher,
      sessionStore: store,
      workspacePath: harness.workspacePath,
      repoRootPath: repoRoot,
      workflowsRegistryPath: harness.registryPath,
    })
    try {
      // Set once the server has booted: its composition hydrates the runtime
      // default from provider settings while it starts. Task runners inherit it.
      setRuntimeDefaultModelState({ status: 'available', ...APP_DEFAULT })
      const createdSession = await postJson(`${server.url}/sessions`, { title: 'Held model choice' })
      assert.equal(createdSession.status, 201)
      const sessionId = stringField(await createdSession.json(), 'id')
      const createdTask = await postJson(`${server.url}/sessions/${sessionId}/tasks`, {
        workflowId: 'native-hold-choice',
        brief: 'Ask for a model choice after a settled record is damaged.',
      })
      assert.equal(createdTask.status, 202, await createdTask.clone().text())
      const taskId = stringField(await createdTask.json(), 'id')

      const started = await taskReaches(store, sessionId, taskId, 'the task to start', (task) => task.pid !== undefined)
      const repairClaim = await damageSettledClaim(harness, store, started)
      const parked = await taskReaches(store, sessionId, taskId, 'the model-choice wait to be parked', (task) => task.status === 'awaiting_model_choice')
      assert.equal(parked.admission?.phase, 'granted', 'the parked model-choice wait keeps its admission while a member is unverifiable')
      assert.equal(processCleanupHoldReason(parked), 'owned_processes_unverified')

      const route = `${server.url}/sessions/${sessionId}/tasks/${taskId}/model-choice`
      const offered = await fetch(route)
      assert.equal(offered.status, 200, await offered.clone().text())
      const offer = field(await offered.json(), 'offer')
      assert.deepEqual(field(offer, 'failedChoice'), PINNED)
      assert.deepEqual(field(offer, 'proposedDefault'), APP_DEFAULT)
      const offerId = stringField(offer, 'offerId')
      const approved = await postJson(route, { offerId, idempotencyKey: randomUUID() })
      assert.equal(approved.status, 202, await approved.clone().text())
      const afterApproval = await taskRecord(store, sessionId, taskId)
      assert.deepEqual(afterApproval.admission, parked.admission, 'no continuation is staged while the wait is held')
      assert.equal(readInvocations(harness).filter((entry) => entry.role === 'approved-retry').length, 0)

      const releasesBefore = queueReleasesOf(harness, taskId)
      repairClaim()
      // The server's queue passes on its own tick; nothing outside it can wake
      // it but a cancellation. The release it records is the signal.
      await queueReleases(harness, taskId, releasesBefore, 'the queue to release the held wait')
      const done = await taskReaches(store, sessionId, taskId, 'the continuation to finish', (task) => task.status === 'done')
      assert.equal(done.executionKind, 'continuation')
      const retries = readInvocations(harness).filter((entry) => entry.role === 'approved-retry' && entry.rootRunId === started.runId)
      assert.equal(retries.length, 1, 'the continuation ran exactly once')
      assert.equal(retries[0]?.offerId, offerId, 'the continued step ran under the recorded consent')
      assert.deepEqual(retries[0]?.approved, APP_DEFAULT)
    } finally {
      setRuntimeDefaultModelState(undefined)
      await server.close()
    }
  })
})
