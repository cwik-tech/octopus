import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityApprovalInteraction,
  CapabilityDispatchEvent,
  CapabilityDispatchRequest,
  CapabilityExecutionContext,
  CapabilityInvocationIdentity,
} from '../../contracts/capability-dispatch.js'
import type {
  RuntimeCapabilityAuthorityClaims,
  RuntimeCapabilityAuthorityPort,
} from '../../contracts/runtime-capability-authority.js'
import { McpApprovalCoordinator } from '../../domains/mcp/mcp-approval-coordinator.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { resolveExecutionJournalOptions } from '../../server/composition.js'
import { readExecutionJournal } from '../../core/execution-journal.js'
import { DURABLE_DISPATCH_STREAM_KIND } from '../../core/durable-dispatch.js'
import {
  ExecutionJournalConfigurationError,
  type ExecutionJournalMode,
} from '../../services/workspace-execution-journal-registry.js'
import {
  CapabilityDispatchRuntime,
  type CapabilityDispatchRuntimeOptions,
} from '../../services/capability-dispatch-runtime.js'

test('the production runtime authorizes an exact live MCP lease and rejects a changed agent', async (context) => {
  const fixture = await makeRuntime(context)
  const lease = fixture.leases.issue({
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    taskId: 'task-1',
    allowedAgentPaths: ['agents/researcher'],
  })
  const execution = makeContext({
    authority: { kind: 'mcp-lease', leaseId: lease.leaseId },
    agentPath: 'agents/researcher',
  })

  const allowed = await fixture.runtime.authority.authorize({
    context: execution,
    invocation: invocationIdentity('browser'),
    phase: 'initial',
  })
  const rejected = await fixture.runtime.authority.authorize({
    context: { ...execution, agentPath: 'agents/other' },
    invocation: invocationIdentity('browser'),
    phase: 'before-execute',
  })

  assert.deepEqual(allowed, { kind: 'allow' })
  assert.equal(rejected.kind, 'deny')
  assert.equal(rejected.kind === 'deny' ? rejected.code : undefined, 'lease_invalid')
})

test('MCP lease authority requires an exact optional task binding', async (context) => {
  const fixture = await makeRuntime(context)
  const taskBoundLease = fixture.leases.issue({
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    taskId: 'task-1',
    allowedAgentPaths: ['agents/researcher'],
  })
  const unboundLease = fixture.leases.issue({
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    allowedAgentPaths: ['agents/researcher'],
  })

  const omittedTask = await fixture.runtime.authority.authorize({
    context: withoutTaskId(makeContext({
      authority: { kind: 'mcp-lease', leaseId: taskBoundLease.leaseId },
    })),
    invocation: invocationIdentity('browser'),
    phase: 'initial',
  })
  const forgedTask = await fixture.runtime.authority.authorize({
    context: makeContext({
      taskId: 'task-1',
      authority: { kind: 'mcp-lease', leaseId: unboundLease.leaseId },
    }),
    invocation: invocationIdentity('browser'),
    phase: 'initial',
  })

  assert.equal(omittedTask.kind, 'deny')
  assert.equal(forgedTask.kind, 'deny')
  if (omittedTask.kind === 'deny') {
    assert.equal(omittedTask.code, 'lease_invalid')
  }
  if (forgedTask.kind === 'deny') {
    assert.equal(forgedTask.code, 'lease_invalid')
  }
})

test('parent capability authority requires its exact endpoint and active runtime claims', async (context) => {
  const authorizations: RuntimeCapabilityAuthorityClaims[] = []
  const fixture = await makeRuntime(context, {
    runtimeAuthority: {
      authorize: async (claims) => {
        authorizations.push(claims)
        return {
          taskId: claims.taskId,
          workflowId: claims.workflowId ?? 'workflow-1',
          runPath: fixture.runPath,
          assignmentPath: fixture.assignmentPath,
        }
      },
    },
  })
  const execution = makeContext({
    authority: {
      kind: 'parent-capability',
      endpointId: 'browser',
      processIdentity: 'process-1',
    },
  })

  const allowed = await fixture.runtime.authority.authorize({
    context: execution,
    invocation: invocationIdentity('browser'),
    phase: 'initial',
  })
  const wrongEndpoint = await fixture.runtime.authority.authorize({
    context: execution,
    invocation: invocationIdentity('youtube'),
    phase: 'initial',
  })
  const missingTask = await fixture.runtime.authority.authorize({
    context: withoutTaskId(execution),
    invocation: invocationIdentity('browser'),
    phase: 'initial',
  })

  assert.deepEqual(allowed, { kind: 'allow' })
  assert.equal(wrongEndpoint.kind, 'deny')
  assert.equal(missingTask.kind, 'deny')
  assert.equal(authorizations.length, 1)
  assert.equal(authorizations[0]?.processIdentity, 'process-1')
})

test('route authority evidence is rejected outside the initial phase without consuming it', async (context) => {
  const evidence = Object.freeze({ kind: 'route-authority-evidence' })
  let consumed = false
  let authorityCalls = 0
  const fixture = await makeRuntime(context, {
    runtimeAuthority: {
      authorize: async (claims, verification) => {
        authorityCalls += 1
        assert.equal(verification?.kind, 'reuse-evidence')
        if (verification?.kind !== 'reuse-evidence') {
          throw new Error('Expected route authority evidence.')
        }
        assert.equal(verification.evidence, evidence)
        if (consumed) throw new Error('Route authority evidence was replayed.')
        consumed = true
        return {
          taskId: claims.taskId,
          workflowId: claims.workflowId ?? 'workflow-1',
          runPath: fixture.runPath,
          assignmentPath: fixture.assignmentPath,
        }
      },
    },
  })
  const authorization = {
    context: makeContext(),
    invocation: invocationIdentity('browser'),
    evidence,
  }

  const rejected = await fixture.runtime.authority.authorize({
    ...authorization,
    phase: 'before-execute',
  })

  assert.equal(rejected.kind, 'deny')
  assert.equal(authorityCalls, 0)

  const allowed = await fixture.runtime.authority.authorize({
    ...authorization,
    phase: 'initial',
  })
  assert.deepEqual(allowed, { kind: 'allow' })
  assert.equal(authorityCalls, 1)
})

test('the production dispatcher writes one sanitized lifecycle to the assignment log', async (context) => {
  const fixture = await makeRuntime(context)
  const lease = fixture.leases.issue({
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    taskId: 'task-1',
    allowedAgentPaths: ['agents/researcher'],
  })
  const adapter: CapabilityAdapter = {
    capabilityId: 'browser',
    prepare: async () => ({
      effect: { kind: 'read-only', concurrency: 'serial' },
      risk: 'read-only',
      argumentNames: ['url'],
      policyDecision: { kind: 'allow' },
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => ({ secret: 'raw-result' }),
      acceptResult: async () => ({ value: { ok: true } }),
    }),
  }

  const result = await fixture.runtime.dispatcher.dispatch({
    context: makeContext({
      authority: { kind: 'mcp-lease', leaseId: lease.leaseId },
      agentPath: 'agents/researcher',
    }),
    invocation: {
      ...invocationIdentity('browser'),
      input: { url: 'https://secret.example/path' },
    },
    adapter,
  })
  await fixture.runtime.close()

  assert.equal(result.status, 'completed')
  const logPath = path.join(
    fixture.assignmentPath,
    'logs',
    'capability-dispatch-events.jsonl',
  )
  const records = (await fs.readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line: string): unknown => JSON.parse(line))
  assert.equal(records.length, 3)
  const serialized = JSON.stringify(records)
  assert.doesNotMatch(serialized, /secret\.example|raw-result/)
})

test('the production runtime exposes its assignment writer to source-specific dispatchers', async (context) => {
  const fixture = await makeRuntime(context)
  const event: CapabilityDispatchEvent = {
    contractVersion: 1,
    type: 'capability.dispatch.requested',
    timestamp: '2026-08-14T12:00:00.000Z',
    dispatchId: 'dispatch-source-specific',
    attemptId: 'attempt-source-specific',
    requestId: 'request-source-specific',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    taskId: 'task-1',
    agentPath: 'agents/researcher',
    authorityKind: 'mcp-lease',
    capabilityId: 'mcp__server__tool',
    sourceKind: 'mcp',
    sourceId: 'mcp-parent-broker',
    argumentDigest: 'a'.repeat(64),
    argumentNames: ['marker'],
    effect: { kind: 'read-only', concurrency: 'serial' },
  }

  await fixture.runtime.evidencePort.append(event)
  await fixture.runtime.close()

  const contents = await fs.readFile(
    path.join(
      fixture.assignmentPath,
      'logs',
      'capability-dispatch-events.jsonl',
    ),
    'utf8',
  )
  assert.match(contents, /dispatch-source-specific/)
})

/**
 * Deliberate contract reversal (AC18).
 *
 * This test previously asserted that a released assignment could be
 * dispatched again — release evicted its retained bindings, so the next
 * dispatch re-executed instead of replaying a cached result. That is no
 * longer true, and the change is intended: release is terminal, and admitting
 * new work for an assignment whose teardown has begun is what let a dispatch
 * run an external effect the assignment could no longer account for.
 *
 * What survives is the retained-result contract: the second dispatch *before*
 * release replays the first result rather than executing again. What is
 * deliberately superseded is the post-release half — reuse after eviction is
 * no longer a behaviour this runtime offers, because the assignment is gone.
 */
test('explicit assignment release permanently refuses later dispatch', async (context) => {
  const fixture = await makeRuntime(context)
  const lease = fixture.leases.issue({
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    taskId: 'task-1',
    allowedAgentPaths: ['agents/researcher'],
  })
  const executionContext = makeContext({
    authority: { kind: 'mcp-lease', leaseId: lease.leaseId },
    agentPath: 'agents/researcher',
  })
  let executions = 0
  const adapter: CapabilityAdapter = {
    capabilityId: 'browser',
    prepare: async () => ({
      effect: { kind: 'read-only', concurrency: 'serial' },
      risk: 'read-only',
      argumentNames: ['url'],
      policyDecision: { kind: 'allow' },
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => {
        executions += 1
        return { execution: executions }
      },
      acceptResult: async ({ value }) => ({ value }),
    }),
  }
  const request = {
    context: executionContext,
    invocation: {
      ...invocationIdentity('browser'),
      input: { url: 'https://example.com' },
    },
    adapter,
  }

  const first = await fixture.runtime.dispatcher.dispatch(request)
  const retained = await fixture.runtime.dispatcher.dispatch(request)
  await fixture.runtime.releaseAssignment({
    sessionId: executionContext.sessionId,
    runId: executionContext.runId,
    assignmentId: executionContext.assignmentId,
  })
  const afterRelease = await fixture.runtime.dispatcher.dispatch(request)

  assert.equal(first.status, 'completed')
  // Still the retention contract: an identical invocation before release
  // replays the first result rather than executing a second time.
  assert.equal(retained.status, 'completed')

  assert.equal(afterRelease.status, 'failed')
  assert.equal(
    afterRelease.status === 'failed' ? afterRelease.code : '',
    'dispatch_assignment_released',
    'a released assignment is terminal, and the refusal must name that reason',
  )
  assert.equal(
    executions,
    1,
    'and nothing executed after release — the point of the barrier is that no ' +
      'external effect runs for an assignment that can no longer account for it',
  )
})

/**
 * The enrolled case for this suite (N28).
 *
 * Every other fixture here builds the runtime with no journal, so this suite —
 * the primary behavioural suite for the production dispatch runtime — described
 * only the unenrolled path, and a forced-authoritative run changed nothing for
 * it. This one attaches a real registry, and asks for it explicitly rather than
 * reading the ambient environment, so it means the same thing in both gates.
 *
 * There is deliberately no enrolled twin of the release test above. The release
 * bar cannot distinguish the two paths: the runtime refuses a released
 * assignment ahead of the durable authority entirely
 * (`services/capability-dispatch-runtime.ts:475-481`), and the registry's own
 * bar is set unconditionally, before any mode check
 * (`services/workspace-execution-journal-registry.ts:520-522`). An enrolled
 * copy of that test would pass with the journal wiring removed, so it would
 * assert enrollment while proving nothing about it.
 */
test('an enrolled dispatch records its canonical events in the journal', async (context) => {
  const fixture = await makeRuntime(context, {
    executionJournal: { mode: 'authoritative', tenantId: 'capability-runtime-tenant' },
  })
  const lease = fixture.leases.issue({
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    taskId: 'task-1',
    allowedAgentPaths: ['agents/researcher'],
  })
  const executionContext = makeContext({
    authority: { kind: 'mcp-lease', leaseId: lease.leaseId },
    agentPath: 'agents/researcher',
  })
  const adapter: CapabilityAdapter = {
    capabilityId: 'browser',
    prepare: async () => ({
      effect: { kind: 'read-only', concurrency: 'serial' },
      risk: 'read-only',
      argumentNames: ['url'],
      policyDecision: { kind: 'allow' },
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => ({ execution: 1 }),
      acceptResult: async ({ value }) => ({ value }),
    }),
  }

  const result = await fixture.runtime.dispatcher.dispatch({
    context: executionContext,
    invocation: {
      ...invocationIdentity('browser'),
      input: { url: 'https://example.com' },
    },
    adapter,
  })

  assert.equal(result.status, 'completed')
  const read = await readExecutionJournal(fixture.assignmentPath)
  assert.equal(
    read.kind,
    'ok',
    `an enrolled dispatch must leave a readable journal, got: ${read.kind}`,
  )
  if (read.kind !== 'ok') return
  const dispatchEvents = read.events.filter(
    (event) => event.streamKind === DURABLE_DISPATCH_STREAM_KIND,
  )
  assert.ok(
    dispatchEvents.length > 0,
    'the dispatch ran on the journal authority, so its canonical events are ' +
      'the record of it — an empty stream would mean the runtime silently ' +
      'stayed on the legacy path while reporting success',
  )
})

/**
 * Deliberate contract reversal (AC18), same as the test above: this asserted
 * that a dispatch after the terminal notification re-executed. A terminal
 * task's assignment is released, and release is now terminal.
 */
test('a terminal task notification permanently refuses later dispatch', async (context) => {
  let terminalListener: ((scope: {
    readonly sessionId: string
    readonly runId: string
    readonly assignmentId: string
  }) => void | Promise<void>) | undefined
  let unsubscribeCalls = 0
  const fixture = await makeRuntime(context, {
    assignmentLifecycle: {
      subscribeTaskTerminal: (listener) => {
        terminalListener = listener
        return () => {
          unsubscribeCalls += 1
        }
      },
    },
  })
  const lease = fixture.leases.issue({
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    taskId: 'task-1',
    allowedAgentPaths: ['agents/researcher'],
  })
  let executions = 0
  const adapter: CapabilityAdapter = {
    capabilityId: 'browser',
    prepare: async () => ({
      effect: { kind: 'read-only', concurrency: 'serial' },
      risk: 'read-only',
      argumentNames: ['url'],
      policyDecision: { kind: 'allow' },
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => {
        executions += 1
        return { execution: executions }
      },
      acceptResult: async ({ value }) => ({ value }),
    }),
  }
  const request = {
    context: makeContext({
      authority: { kind: 'mcp-lease' as const, leaseId: lease.leaseId },
    }),
    invocation: {
      ...invocationIdentity('browser'),
      input: { url: 'https://example.com' },
    },
    adapter,
  }

  await fixture.runtime.dispatcher.dispatch(request)
  await fixture.runtime.dispatcher.dispatch(request)
  assert.ok(terminalListener)
  await terminalListener({
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
  })
  const afterTerminal = await fixture.runtime.dispatcher.dispatch(request)
  await fixture.runtime.close()

  assert.equal(afterTerminal.status, 'failed')
  assert.equal(
    afterTerminal.status === 'failed' ? afterTerminal.code : '',
    'dispatch_assignment_released',
    'the terminal notification releases the assignment, and release is ' +
      'terminal — a later dispatch is refused, not re-executed',
  )
  assert.equal(
    executions,
    1,
    'no external effect ran after the task reached a terminal state',
  )
  assert.equal(unsubscribeCalls, 1)
})

test('the production approval port preserves the coordinator exact interaction binding', async (context) => {
  let fixture: Awaited<ReturnType<typeof makeRuntime>>
  fixture = await makeRuntime(context, { withApproval: true })
  const approval = fixture.runtime.approval
  assert.ok(approval)
  let observed: CapabilityApprovalInteraction | undefined

  const decision = await approval.request({
    context: makeContext({
      authority: {
        kind: 'parent-capability',
        endpointId: 'browser',
        processIdentity: 'process-1',
      },
    }),
    invocation: invocationIdentity('browser'),
    arguments: { pageId: 'page-1', ref: 'ref-1' },
    dispatchId: 'dispatch-approval',
    argumentDigest: 'a'.repeat(64),
    canonicalArguments: '{"pageId":"page-1","ref":"ref-1"}',
    effect: { kind: 'mutating', concurrency: 'serial' },
    risk: 'mutating',
    description: {
      serverId: 'builtin.browser',
      namespacedToolName: 'mcp__builtin-browser__click',
      title: 'Browser action',
      description: 'Click submit.',
    },
    signal: new AbortController().signal,
    onInteraction: async (interaction) => {
      observed = interaction
      await fixture.approvalCoordinator?.respond(
        {
          sessionId: 'session-1',
          runId: 'run-1',
          assignmentId: 'assignment-1',
        },
        {
          interactionId: interaction.interactionId,
          responseId: 'response-1',
          decision: 'approve',
          scope: 'once',
        },
      )
    },
  })

  assert.equal(decision.outcome, 'approved')
  assert.equal(decision.interaction.interactionId, observed?.interactionId)
  assert.equal(decision.interaction.reused, false)
})

/**
 * Deliberate contract reversal (AC18).
 *
 * This asserted that `close` cancelled active dispatches immediately, so a
 * live one settled `cancelled`. Shutdown now drains to a stated bound first
 * and only then aborts, because aborting an effect that was about to finish
 * turns a completed external operation into an unproven one — the same rule
 * assignment release already followed.
 *
 * Scope note: this fixture has **no durable authority**, so there is no
 * attempt to finalize and no `shutdown_deadline_exceeded` decision to make.
 * What it still pins is the legacy, non-durable path — and that path has an
 * authority of its own. A dispatch that cooperates with the abort settles
 * `cancelled` and writes that terminal to the capability evidence stream, so
 * shutdown must not close that writer out from under it: reporting
 * `indeterminate` for work that was cleanly cancelled is the same
 * truthfulness defect as closing a journal early, one authority down.
 *
 * The durable half is asserted separately, under authoritative journaling, in
 * `tests/integration/execution-journal-teardown-races.test.ts`.
 */
test('runtime close drains to its bound before cancelling active dispatches', async (context) => {
  const fixture = await makeRuntime(context)
  const lease = fixture.leases.issue({
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    taskId: 'task-1',
    allowedAgentPaths: ['agents/researcher'],
  })
  const executionStarted = deferredVoid()
  let dispatchSettled = false
  const caller = new AbortController()
  context.after(() => caller.abort())
  const adapter: CapabilityAdapter = {
    capabilityId: 'browser',
    prepare: async () => ({
      effect: { kind: 'read-only', concurrency: 'serial' },
      risk: 'read-only',
      argumentNames: ['url'],
      policyDecision: { kind: 'allow' },
      authorize: async () => ({ kind: 'allow' }),
      execute: async ({ signal }) => {
        executionStarted.resolve()
        await waitForAbort(signal)
        throw signal.reason
      },
      acceptResult: async ({ value }) => ({ value }),
    }),
  }
  const request = {
    context: makeContext({
      authority: { kind: 'mcp-lease' as const, leaseId: lease.leaseId },
      agentPath: 'agents/researcher',
    }),
    invocation: {
      ...invocationIdentity('browser'),
      input: { url: 'https://example.com' },
    },
    adapter,
    signal: caller.signal,
  }
  const dispatch = fixture.runtime.dispatcher.dispatch(request).finally(() => {
    dispatchSettled = true
  })
  await executionStarted.promise

  // An already-due absolute deadline: public API, and it reaches the bound by
  // configuration rather than by waiting out the default five seconds.
  await fixture.runtime.close({ deadlineMs: Date.now() })
  const runtimeCancelled = caller.signal.aborted === false && dispatchSettled
  if (!dispatchSettled) caller.abort()
  const result = await dispatch
  const afterClose = await fixture.runtime.dispatcher.dispatch(
    withoutSignal({
      ...request,
      context: { ...request.context, requestId: 'request-after-close' },
    }),
  )

  assert.equal(runtimeCancelled, true)
  assert.equal(
    result.status,
    'cancelled',
    'a dispatch that cooperates with the abort was cleanly cancelled, and ' +
      'must be able to record that before its evidence writer closes — ' +
      'reporting an unproven outcome for work that demonstrably stopped is ' +
      'the defect, not the contract',
  )
  assert.equal(afterClose.status, 'failed')
  if (afterClose.status === 'failed') {
    assert.equal(afterClose.code, 'dispatch_runtime_closed')
  }
})

interface RuntimeFixtureOptions {
  readonly runtimeAuthority?: RuntimeCapabilityAuthorityPort
  readonly withApproval?: boolean
  readonly assignmentLifecycle?: {
    subscribeTaskTerminal(listener: (scope: {
      readonly sessionId: string
      readonly runId: string
      readonly assignmentId: string
    }) => void | Promise<void>): () => void
  }
  readonly releaseDrainTimeoutMs?: number
  /**
   * Attach a real journal registry to this runtime.
   *
   * Every other fixture in this file omits it, which is why forcing
   * `PIPELINE_DURABLE_JOURNAL` changes nothing for them: the flag is read by
   * `resolveExecutionJournalOptions`, and this suite constructs its options
   * directly. Enrollment is therefore requested explicitly, so the enrolled
   * path is covered identically whether or not the ambient flag is set.
   */
  readonly executionJournal?: {
    readonly mode: ExecutionJournalMode
    readonly tenantId: string
  }
}

async function makeRuntime(
  testContext: test.TestContext,
  options: RuntimeFixtureOptions = {},
): Promise<{
  readonly runtime: CapabilityDispatchRuntime
  readonly leases: McpRunLeaseStore
  readonly approvalCoordinator?: McpApprovalCoordinator
  readonly runPath: string
  readonly assignmentPath: string
}> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'capability-runtime-')),
  )
  testContext.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspacePath = path.join(root, 'workspace')
  const location = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
  })
  assert.ok(location)
  await fs.mkdir(location.assignmentPath, { recursive: true })
  const leases = new McpRunLeaseStore()
  const approvalCoordinator = options.withApproval
    ? new McpApprovalCoordinator({
        workspacePath,
        pollIntervalMs: 1,
        waitTimeoutMs: 2_000,
      })
    : undefined
  const runtimeOptions: CapabilityDispatchRuntimeOptions = {
    workspacePath,
    leaseResolver: (context) => leases.resolve(context),
    runtimeAuthority: options.runtimeAuthority ?? {
      authorize: async (claims) => ({
        taskId: claims.taskId,
        workflowId: claims.workflowId ?? 'workflow-1',
        runPath: location.runPath,
        assignmentPath: location.assignmentPath,
      }),
    },
    ...(approvalCoordinator ? { approvalCoordinator } : {}),
    ...(options.assignmentLifecycle
      ? { assignmentLifecycle: options.assignmentLifecycle }
      : {}),
    ...(options.releaseDrainTimeoutMs === undefined
      ? {}
      : { releaseDrainTimeoutMs: options.releaseDrainTimeoutMs }),
    ...(options.executionJournal
      ? { executionJournal: options.executionJournal }
      : {}),
  }
  const runtime = new CapabilityDispatchRuntime(runtimeOptions)
  testContext.after(() => runtime.close())
  return {
    runtime,
    leases,
    ...(approvalCoordinator ? { approvalCoordinator } : {}),
    runPath: location.runPath,
    assignmentPath: location.assignmentPath,
  }
}

function makeContext(
  overrides: Partial<CapabilityExecutionContext> = {},
): CapabilityExecutionContext {
  return {
    contractVersion: 1,
    requestId: 'request-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    taskId: 'task-1',
    agentPath: 'agents/researcher',
    authority: { kind: 'runtime-assignment', processIdentity: 'process-1' },
    ...overrides,
  }
}

function withoutTaskId(
  context: CapabilityExecutionContext,
): CapabilityExecutionContext {
  const { taskId: _omitted, ...rest } = context
  return rest
}

function withoutSignal(
  request: CapabilityDispatchRequest,
): CapabilityDispatchRequest {
  const { signal: _omitted, ...rest } = request
  return rest
}

function invocationIdentity(capabilityId: string): CapabilityInvocationIdentity {
  return {
    capabilityId,
    source: { kind: 'builtin', id: capabilityId, version: '1' },
    toolCallId: 'call-1',
  }
}

function deferredVoid(): {
  readonly promise: Promise<void>
  resolve(): void
} {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: () => resolvePromise?.(),
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

test('releasing an assignment waits for its in-flight dispatches to finish', async (context) => {
  const fixture = await makeRuntime(context)
  const order: string[] = []
  let openGate = (): void => undefined
  const gate = new Promise<void>((resolve) => {
    openGate = () => resolve()
  })

  const dispatching = fixture.runtime.dispatcher.dispatch({
    context: makeContext({
      authority: { kind: 'runtime-assignment', processIdentity: 'runtime-1' },
      agentPath: 'agents/researcher',
    }),
    invocation: {
      capabilityId: 'browser',
      source: { kind: 'builtin', id: 'browser', version: '1' },
      toolCallId: 'call-draining',
      input: { target: 'value' },
    },
    adapter: {
      capabilityId: 'browser',
      prepare: async () => ({
        effect: serialCapabilityEffect('mutating'),
        risk: 'test-mutating',
        argumentNames: ['target'],
        policyDecision: { kind: 'allow' },
        authorize: async () => ({ kind: 'allow' }),
        execute: async () => {
          await gate
          order.push('effect-finished')
          return { done: true }
        },
        acceptResult: async ({ value }) => ({ value }),
      }),
    },
  })

  // Teardown starts while the effect is still running. Tearing the
  // assignment's resources down underneath it would turn a successful
  // operation into an unproven one.
  await delay(20)
  const releasing = fixture.runtime
    .releaseAssignment({
      sessionId: 'session-1',
      runId: 'run-1',
      assignmentId: 'assignment-1',
    })
    .then(() => {
      order.push('released')
    })

  await delay(20)
  openGate()
  const [result] = await Promise.all([dispatching, releasing])

  assert.deepEqual(order, ['effect-finished', 'released'])
  assert.equal(result.status, 'completed')
})

test('assignment release does not wait forever for a dispatch that never settles', async (context) => {
  // Terminal-task finalization awaits this listener, so an unbounded drain
  // hangs task completion whenever a dispatch is parked — awaiting approval,
  // or in an adapter with no deadline of its own.
  const fixture = await makeRuntime(context, { releaseDrainTimeoutMs: 50 })
  let released = false
  const parked = new Promise<void>(() => undefined)

  const dispatching = fixture.runtime.dispatcher.dispatch({
    context: makeContext({
      authority: { kind: 'runtime-assignment', processIdentity: 'runtime-1' },
      agentPath: 'agents/researcher',
    }),
    invocation: {
      capabilityId: 'browser',
      source: { kind: 'builtin', id: 'browser', version: '1' },
      toolCallId: 'call-parked',
      input: { target: 'value' },
    },
    adapter: {
      capabilityId: 'browser',
      prepare: async () => ({
        effect: serialCapabilityEffect('mutating'),
        risk: 'test-mutating',
        argumentNames: ['target'],
        policyDecision: { kind: 'allow' },
        authorize: async () => ({ kind: 'allow' }),
        execute: async (input: { signal: AbortSignal }) => {
          await Promise.race([parked, waitForAbort(input.signal)])
          return { done: true }
        },
        acceptResult: async (input: { value: unknown }) => ({
          value: input.value,
        }),
      }),
    },
  })

  await delay(20)
  const releasing = fixture.runtime
    .releaseAssignment({
      sessionId: 'session-1',
      runId: 'run-1',
      assignmentId: 'assignment-1',
    })
    .then(() => {
      released = true
    })

  await Promise.race([releasing, delay(2_000)])
  assert.equal(
    released,
    true,
    'release must complete rather than block terminal-task finalization',
  )
  await dispatching.catch(() => undefined)
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('the cutover flag maps recognised environment values to journal modes', async () => {
  const original = process.env.PIPELINE_DURABLE_JOURNAL
  const originalTenant = process.env.TEAM_TENANT_ID
  try {
    const cases: ReadonlyArray<{
      readonly value: string | undefined
      readonly mode: string
      readonly deprecated?: string
    }> = [
      // Unset is the supported configuration since A-14: the journal is on
      // unless a deployment says otherwise.
      { value: undefined, mode: 'authoritative' },
      // An empty value is "flag removed", not "flag set", so it reads the same
      // as unset — which is now `authoritative` rather than `disabled`.
      { value: '', mode: 'authoritative' },
      // Turning it off is something a deployment states explicitly.
      { value: 'disabled', mode: 'disabled' },
      { value: 'authoritative', mode: 'authoritative' },
      // Deprecated aliases, retained for one release: a repository search
      // cannot inventory the environments this is exported in, so removing an
      // accepted value is a user-visible change with its own release note.
      { value: 'shadow', mode: 'disabled', deprecated: 'disabled' },
      { value: '1', mode: 'authoritative', deprecated: 'authoritative' },
    ]
    for (const { value, mode, deprecated } of cases) {
      if (value === undefined) delete process.env.PIPELINE_DURABLE_JOURNAL
      else process.env.PIPELINE_DURABLE_JOURNAL = value
      const resolved = resolveExecutionJournalOptions()
      assert.equal(resolved.mode, mode, `flag ${JSON.stringify(value)}`)
      if (deprecated === undefined) {
        assert.deepEqual(
          resolved.deprecations,
          [],
          `flag ${JSON.stringify(value)} must not be deprecated`,
        )
      } else {
        assert.equal(
          resolved.deprecations.length,
          1,
          `flag ${JSON.stringify(value)} must record one deprecation`,
        )
        assert.match(resolved.deprecations[0] ?? '', new RegExp(deprecated))
      }
    }

    // The tenant is sealed immutably into every manifest, so it comes from the
    // runtime's own source rather than being invented at the composition root.
    delete process.env.TEAM_TENANT_ID
    assert.equal(resolveExecutionJournalOptions().tenantId, 'local')
    process.env.TEAM_TENANT_ID = 'acme'
    assert.equal(resolveExecutionJournalOptions().tenantId, 'acme')
  } finally {
    if (original === undefined) delete process.env.PIPELINE_DURABLE_JOURNAL
    else process.env.PIPELINE_DURABLE_JOURNAL = original
    if (originalTenant === undefined) delete process.env.TEAM_TENANT_ID
    else process.env.TEAM_TENANT_ID = originalTenant
  }
})

test('an unrecognised cutover flag value fails rather than silently disabling the journal', async () => {
  const original = process.env.PIPELINE_DURABLE_JOURNAL
  try {
    // Every one of these reads as "protection on" to whoever typed it, and
    // every one of them currently resolves to `disabled` without a word.
    for (const value of [
      'authoratative',
      'off',
      'true',
      'yes',
      'AUTHORITATIVE',
      ' authoritative',
      '0',
    ]) {
      process.env.PIPELINE_DURABLE_JOURNAL = value
      assert.throws(
        () => resolveExecutionJournalOptions(),
        (error: unknown) => {
          assert.ok(error instanceof ExecutionJournalConfigurationError)
          assert.equal(error.variable, 'PIPELINE_DURABLE_JOURNAL')
          assert.equal(error.value, value)
          // The message must name the variable and the value, because the
          // whole point is that the operator can see what they typed.
          assert.match(error.message, /PIPELINE_DURABLE_JOURNAL/)
          assert.ok(error.message.includes(value))
          return true
        },
        `flag ${JSON.stringify(value)} must be rejected`,
      )
    }
  } finally {
    if (original === undefined) delete process.env.PIPELINE_DURABLE_JOURNAL
    else process.env.PIPELINE_DURABLE_JOURNAL = original
  }
})

test('a tenant the journal manifest could never accept fails at the configuration boundary', async () => {
  const original = process.env.TEAM_TENANT_ID
  try {
    // The boundary is deliberately narrow: reject what a manifest would reject
    // (control characters, over-long values) plus what is meaningless or
    // silently lossy (whitespace-only, or padding that would be sealed into a
    // manifest and never match a re-typed value). It does not invent a
    // character set, because a repository search cannot inventory the tenants
    // already in use.
    //
    // A control character is deliberately absent: Node's `process.env` setter
    // truncates the value at the first NUL, so it can never reach the resolver
    // through this channel. That branch is reachable only where the tenant
    // arrives as JSON, which is the workspace pin's problem, not this one.
    for (const value of ['   ', ' acme', 'acme ', 'x'.repeat(513)]) {
      process.env.TEAM_TENANT_ID = value
      assert.throws(
        () => resolveExecutionJournalOptions(),
        (error: unknown) => {
          assert.ok(error instanceof ExecutionJournalConfigurationError)
          assert.equal(error.variable, 'TEAM_TENANT_ID')
          return true
        },
        `tenant ${JSON.stringify(value)} must be rejected`,
      )
    }
  } finally {
    if (original === undefined) delete process.env.TEAM_TENANT_ID
    else process.env.TEAM_TENANT_ID = original
  }
})
