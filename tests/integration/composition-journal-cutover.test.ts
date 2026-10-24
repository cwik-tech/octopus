import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityExecutionContext,
  CapabilityInvocation,
} from '../../contracts/capability-dispatch.js'
import { buildSessionRunAssignmentLocation } from '../../core/run-assignment-location.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { PROCESS_IDENTITY_ARGUMENT } from '../../domains/sessions/task-process-supervisor.js'
import { SourceFileParserLauncher } from '../../core/file-parser-launcher.js'
import { startApiServer } from '../../server/api-server.js'
import { buildServices } from '../../server/composition.js'
import { cancelSessionTask } from '../../services/task-service.js'
import {
  FileSystemWorkflowStateStore,
  hashWorkflowContent,
} from '../../workflows/workflow-state-store.js'
import { readExecutionJournal } from '../../core/execution-journal.js'
import { WORKFLOW_STATE_STREAM_KIND } from '../../workflows/workflow-journal.js'
import { currentAttemptScope } from '../support/current-attempt-scope.js'

/**
 * Phase 2 acceptance at the production composition root (ADR §18 criteria 1
 * and 5). The existing cutover test drives `CapabilityDispatchRuntime`
 * directly, so nothing fails if `buildServices` stops passing the journal
 * options at all. This test observes enrollment through `buildServices`.
 */

interface Scope {
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly taskId: string
  readonly processIdentity: string
}

test('the composition root enrolls an assignment when the durable journal flag is on', async (t) => {
  const { workspacePath, scope, sessionStore } = await makeWorkspace(t)
  const previous = process.env.PIPELINE_DURABLE_JOURNAL
  process.env.PIPELINE_DURABLE_JOURNAL = 'authoritative'
  t.after(() => {
    if (previous === undefined) delete process.env.PIPELINE_DURABLE_JOURNAL
    else process.env.PIPELINE_DURABLE_JOURNAL = previous
  })

  const composition = await buildServices(
    await compositionOptions(workspacePath, sessionStore),
  )
  t.after(() => composition.dispose())

  const runtime = composition.services.capabilityDispatchRuntime
  assert.ok(runtime, 'composition must build a capability dispatch runtime')

  const result = await runtime.dispatcher.dispatch({
    context: makeContext(scope),
    invocation: makeInvocation(),
    adapter: makeAdapter(),
  })
  assert.equal(result.status, 'completed', JSON.stringify(result))

  assert.equal(
    await journalManifestExists(workspacePath, scope),
    true,
    'a dispatch under the flag must enroll the assignment through the composition root',
  )
})

test('releasing an assignment through the runtime bars it in the exposed registry', async (t) => {
  // AC3, and the assertion that actually distinguishes shared ownership from
  // two registries that happen to agree.
  //
  // A weaker version of this test resolved both handles from the exposed
  // registry and compared them. That proves only that a registry caches its
  // own handle: with the runtime owning a *separate* registry, the exposed one
  // would open its own handle and return that same handle twice, and the test
  // would still pass.
  //
  // `released` is per-registry state (ADR §16). So the observable that bites is
  // cross-instance: bar an assignment through the runtime, and the exposed
  // registry must refuse it too. Two registries cannot share that bar.
  const { workspacePath, scope, sessionStore } = await makeWorkspace(t)
  const previous = process.env.PIPELINE_DURABLE_JOURNAL
  process.env.PIPELINE_DURABLE_JOURNAL = 'authoritative'
  t.after(() => {
    if (previous === undefined) delete process.env.PIPELINE_DURABLE_JOURNAL
    else process.env.PIPELINE_DURABLE_JOURNAL = previous
  })

  const composition = await buildServices(
    await compositionOptions(workspacePath, sessionStore),
  )
  t.after(() => composition.dispose())

  const runtime = composition.services.capabilityDispatchRuntime
  const registry = composition.services.executionJournalRegistry
  assert.ok(runtime, 'composition must build a capability dispatch runtime')
  assert.ok(registry, 'composition must expose the journal registry it owns')

  const result = await runtime.dispatcher.dispatch({
    context: makeContext(scope),
    invocation: makeInvocation(),
    adapter: makeAdapter(),
  })
  assert.equal(result.status, 'completed', JSON.stringify(result))

  // Terminal teardown, through the runtime's own public method.
  await runtime.releaseAssignment({
    sessionId: scope.sessionId,
    runId: scope.runId,
    assignmentId: scope.assignmentId,
  })

  await assert.rejects(
    registry.resolveJournalHandle({
      context: makeContext(scope),
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5_000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /released/i)
      return true
    },
    'a terminal assignment released through the runtime must not reopen ' +
      'through the exposed registry — if it does, they are two registries',
  )
})

/**
 * Since A-14 the journal is on unless a deployment says otherwise, so the
 * observable worth protecting is the opposite one: `disabled` still means no
 * journal at all. Enrollment is irreversible, so this is the only escape hatch
 * a deployment has, and it has to keep working.
 */
test('the composition root creates no journal when the flag says disabled', async (t) => {
  const { workspacePath, scope, sessionStore } = await makeWorkspace(t)
  const previous = process.env.PIPELINE_DURABLE_JOURNAL
  process.env.PIPELINE_DURABLE_JOURNAL = 'disabled'
  t.after(() => {
    if (previous === undefined) delete process.env.PIPELINE_DURABLE_JOURNAL
    else process.env.PIPELINE_DURABLE_JOURNAL = previous
  })

  const composition = await buildServices(
    await compositionOptions(workspacePath, sessionStore),
  )
  t.after(() => composition.dispose())

  const runtime = composition.services.capabilityDispatchRuntime
  assert.ok(runtime)
  const result = await runtime.dispatcher.dispatch({
    context: makeContext(scope),
    invocation: makeInvocation(),
    adapter: makeAdapter(),
  })
  assert.equal(result.status, 'completed', JSON.stringify(result))

  assert.equal(
    await journalManifestExists(workspacePath, scope),
    false,
    'an explicit `disabled` must create no journal at all',
  )
})

async function journalManifestExists(
  workspacePath: string,
  scope: Scope,
): Promise<boolean> {
  const location = buildSessionRunAssignmentLocation(workspacePath, scope)
  assert.ok(location)
  try {
    await fs.stat(
      path.join(
        location.assignmentPath,
        '.runtime',
        'execution-journal',
        'manifest.json',
      ),
    )
    return true
  } catch {
    return false
  }
}

/**
 * AC5's release bar, with the second consumer AC3 could not supply.
 *
 * AC3 proved that a release through the runtime bars the assignment in the
 * *exposed registry*. That is one consumer asking the registry about itself.
 * AC5 adds a real second consumer — cancellation through `task-service` and
 * the session store — so the question becomes whether a released assignment
 * can be reopened by a different caller in the same process. It must not be,
 * and the fail-closed consequence is that the projection is left alone rather
 * than advanced without its journal (ADR §7, §16).
 */
test('a released assignment is not reopened by a cancellation in the same process', async (t) => {
  const { workspacePath, scope, sessionStore } = await makeWorkspace(t)
  const previous = process.env.PIPELINE_DURABLE_JOURNAL
  process.env.PIPELINE_DURABLE_JOURNAL = 'authoritative'
  t.after(() => {
    if (previous === undefined) delete process.env.PIPELINE_DURABLE_JOURNAL
    else process.env.PIPELINE_DURABLE_JOURNAL = previous
  })

  const composition = await buildServices(
    await compositionOptions(workspacePath, sessionStore),
  )
  t.after(() => composition.dispose())
  const runtime = composition.services.capabilityDispatchRuntime
  const registry = composition.services.executionJournalRegistry
  assert.ok(runtime)
  assert.ok(registry)

  const location = buildSessionRunAssignmentLocation(workspacePath, scope)
  assert.ok(location)
  await seedWorkflowExecution(location.assignmentPath, scope)

  // Enrol, then tear the assignment down through the runtime's own method.
  const dispatched = await runtime.dispatcher.dispatch({
    context: makeContext(scope),
    invocation: makeInvocation(),
    adapter: makeAdapter(),
  })
  assert.equal(dispatched.status, 'completed', JSON.stringify(dispatched))
  await runtime.releaseAssignment({
    sessionId: scope.sessionId,
    runId: scope.runId,
    assignmentId: scope.assignmentId,
  })

  const eventsAtRelease = await workflowStateEventCount(location.assignmentPath)
  const stateAtRelease = await new FileSystemWorkflowStateStore(
    location.assignmentPath,
  ).requireSnapshot()

  // The second consumer, wired exactly as production wires it.
  await cancelSessionTask({
    sessionId: scope.sessionId,
    taskId: scope.taskId,
    sessionStore,
    executionJournalRegistry: registry,
    isProcessAlive: () => false,
  })

  assert.equal(
    await workflowStateEventCount(location.assignmentPath),
    eventsAtRelease,
    'a released assignment must not be reopened to journal a cancellation',
  )
  const stateAfterCancel = await new FileSystemWorkflowStateStore(
    location.assignmentPath,
  ).requireSnapshot()
  assert.equal(
    stateAfterCancel.state.revision,
    stateAtRelease.state.revision,
    'and the projection must not advance without its journal — failing ' +
      'closed is the point of the bar',
  )

  await assert.rejects(
    registry.resolveJournalHandle({
      context: makeContext(scope),
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5_000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /released/i)
      return true
    },
    'the bar must still hold after the second consumer tried',
  )
})

/**
 * AC5a's production wiring, not its mechanism.
 *
 * The session store performs terminal workflow reconciliation, and it runs
 * *inside* the cancellation CAS — before any journal-aware code the caller
 * reaches. So the store is the site that decides whether a cancellation is
 * journaled, and it can only know the registry if the composition root binds
 * it. Nothing here hands `cancelSessionTask` a registry: if `buildServices`
 * stops calling `useExecutionJournalRegistry`, the projection silently leads
 * the journal again and this fails.
 */
test('the composition root binds its journal registry to the session store', async (t) => {
  const { workspacePath, scope, sessionStore } = await makeWorkspace(t)
  const previous = process.env.PIPELINE_DURABLE_JOURNAL
  process.env.PIPELINE_DURABLE_JOURNAL = 'authoritative'
  t.after(() => {
    if (previous === undefined) delete process.env.PIPELINE_DURABLE_JOURNAL
    else process.env.PIPELINE_DURABLE_JOURNAL = previous
  })

  const composition = await buildServices(
    await compositionOptions(workspacePath, sessionStore),
  )
  t.after(() => composition.dispose())

  const location = buildSessionRunAssignmentLocation(workspacePath, scope)
  assert.ok(location)
  await seedWorkflowExecution(location.assignmentPath, scope)

  const before = await workflowStateEventCount(location.assignmentPath)

  await cancelSessionTask({
    sessionId: scope.sessionId,
    taskId: scope.taskId,
    sessionStore,
    isProcessAlive: () => false,
  })

  assert.ok(
    (await workflowStateEventCount(location.assignmentPath)) > before,
    'the composition root must bind its registry to the session store, or a ' +
      'cancellation rewrites the projection without journaling it',
  )
})

/** A durable workflow execution for this scope, running its first step. */
async function seedWorkflowExecution(
  assignmentPath: string,
  scope: Scope,
): Promise<void> {
  await new FileSystemWorkflowStateStore(assignmentPath).initialize({
    manifest: {
      taskId: scope.taskId,
      sessionId: scope.sessionId,
      rootRunId: scope.runId,
      workflowId: 'workflow-cutover',
      workflowDefinitionHash: hashWorkflowContent('cutover-workflow:v1'),
      briefHash: hashWorkflowContent('Enrol this assignment'),
      teamDefinitionHashes: {
        researchers: hashWorkflowContent('researchers:v1'),
      },
      runtimeVersion: 'workflow-runtime-v1',
    },
    executionAttemptId: scope.processIdentity,
    steps: [
      {
        stepId: 'research',
        stepIndex: 0,
        stepType: 'team',
        team: 'researchers',
        definitionHash: hashWorkflowContent('research-step:v1'),
        recoveryPolicy: 'safe_retry',
        childRunId: `${scope.runId}-child`,
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'report.md',
        requestedResultType: 'artifact:report.md',
      },
    ],
  })
}

/** Workflow-state events currently in this assignment's canonical journal. */
async function workflowStateEventCount(
  assignmentPath: string,
): Promise<number> {
  const read = await readExecutionJournal(assignmentPath)
  // Before the cancellation the assignment has not enrolled yet, so an absent
  // journal is the expected starting point. Any other unreadable result is a
  // real failure and must not be counted as zero.
  if (read.kind === 'not_found') return 0
  assert.equal(read.kind, 'ok', `journal unreadable: ${read.kind}`)
  if (read.kind !== 'ok') return 0
  return read.events.filter(
    (event) => event.streamKind === WORKFLOW_STATE_STREAM_KIND,
  ).length
}

/**
 * A real session task, so the production runtime authority authorizes the
 * dispatch rather than the test substituting its own authority port.
 */
async function makeWorkspace(t: {
  after: (fn: () => unknown) => void
}): Promise<{
  workspacePath: string
  scope: Scope
  sessionStore: FileSystemSessionStore
}> {
  // realpath: the authority compares canonical paths, and macOS resolves
  // /var/folders to /private/var/folders.
  const workspacePath = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'composition-journal-cutover-')),
  )
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))

  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Journal cutover' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'workflow-cutover',
    brief: 'Enrol this assignment',
  })
  assert.ok(task?.assignmentId)

  const scope: Scope = {
    sessionId: session.id,
    runId: task.runId,
    assignmentId: task.assignmentId,
    taskId: task.id,
    processIdentity: 'composition-journal-cutover-process',
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, scope)
  assert.ok(location)
  await fs.mkdir(location.assignmentPath, { recursive: true })

  // The production authority only authorizes a running task owned by a live
  // process, so the fixture has to be one rather than a substituted port.
  const taskProcess = await startTaskProcess(scope.processIdentity)
  t.after(() => stopTaskProcess(taskProcess))
  assert.ok(taskProcess.pid)
  const running = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'running',
      processIdentity: scope.processIdentity,
      executionAttemptId: scope.processIdentity,
      executionAttemptNumber: 1,
      ...await currentAttemptScope(task, 1),
      ownerInstanceId: sessionStore.getInstanceId(),
      pid: taskProcess.pid,
      runPath: location.runPath,
      assignmentPath: location.assignmentPath,
    },
  )
  assert.equal(running?.updated, true)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (sessionStore.hasValidTaskProcessIdentity(running.task)) break
    await delay(10)
  }
  assert.ok(sessionStore.hasValidTaskProcessIdentity(running.task))

  return { workspacePath, scope, sessionStore }
}

async function startTaskProcess(processIdentity: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      'setInterval(() => undefined, 1_000)',
      '--',
      `${PROCESS_IDENTITY_ARGUMENT}${processIdentity}`,
    ],
    { stdio: 'ignore' },
  )
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
  })
  return child
}

async function stopTaskProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
  })
  child.kill('SIGKILL')
  await exited
}

async function compositionOptions(
  workspacePath: string,
  // The same store instance the fixture used: task-process ownership is
  // instance-scoped, so a second store would not own the running task.
  sessionStore: FileSystemSessionStore,
) {
  const repoRootPath = process.cwd()
  const launcher = {
    async startRun() {
      return { launched: true as const, pid: process.pid, cwd: repoRootPath }
    },
  }
  return {
    store: new FileSystemRunStore(workspacePath),
    launcher,
    taskLauncher: launcher,
    fileParserLauncher: new SourceFileParserLauncher(repoRootPath),
    sessionStore,
    workspacePath,
    repoRootPath,
    workflowsRegistryPath: path.join(repoRootPath, 'workflows', 'registry.yaml'),
  }
}

function makeAdapter(): CapabilityAdapter {
  return {
    capabilityId: 'test.readonly',
    prepare: async () => ({
      effect: serialCapabilityEffect('read-only'),
      risk: 'test-readonly',
      argumentNames: ['target'],
      policyDecision: { kind: 'allow' },
      recoveryPolicy: 'read_only_retryable' as const,
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => ({ ok: true }),
      acceptResult: async ({ value }: { value: unknown }) => ({ value }),
    }),
  }
}

function makeContext(scope: Scope): CapabilityExecutionContext {
  return {
    contractVersion: 1,
    requestId: 'request-cutover',
    sessionId: scope.sessionId,
    runId: scope.runId,
    assignmentId: scope.assignmentId,
    taskId: scope.taskId,
    workflowId: 'workflow-cutover',
    agentPath: 'agents/cutover',
    authority: {
      kind: 'runtime-assignment',
      processIdentity: scope.processIdentity,
    },
  }
}

function makeInvocation(): CapabilityInvocation {
  return {
    capabilityId: 'test.readonly',
    source: { kind: 'builtin', id: 'cutover', version: '1' },
    toolCallId: 'call-composition-cutover',
    input: { target: 'counter' },
  }
}

test('the operator journal route is reachable only through the authenticated transport', async (t) => {
  // The service-level authority port is a no-op in production, so the URL
  // token is the boundary that actually holds. Phase 3's mutation proof
  // targeted the port; this asserts the gate that production uses.
  const { workspacePath, sessionStore } = await makeWorkspace(t)
  const server = await startApiServer({
    ...(await compositionOptions(workspacePath, sessionStore)),
    apiToken: 'journal-route-token',
  })
  t.after(() => server.close())

  // `server.url` embeds the token; the same path without it must not answer.
  const authorized = await fetch(`${server.url}/execution-journals`)
  assert.equal(authorized.status, 200)

  const origin = new URL(server.url).origin
  const unauthenticated = await fetch(`${origin}/execution-journals`)
  assert.equal(
    unauthenticated.status,
    401,
    'an untokened caller must not reach the journal discovery route',
  )

  const wrongToken = await fetch(`${origin}/api/not-the-token/execution-journals`)
  assert.equal(wrongToken.status, 401)
})
