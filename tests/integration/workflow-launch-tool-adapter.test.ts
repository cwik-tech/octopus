import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import { z } from 'zod/v4'

import { MCP_RUNTIME_CONTRACT_VERSION } from '../../contracts/mcp.js'
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { TaskQueue } from '../../services/task-queue.js'
import {
  createWorkflowLaunchToolAdapter,
  WORKFLOW_LAUNCH_ACTIVATION_PROMPT,
} from '../../services/workflow-launch-tool-adapter.js'
import { createRunPlanService } from '../../services/run-orchestrator-service.js'
import { agentChatTurnWiring } from '../../services/agent-chat-turn-wiring.js'
import { buildChatMessage } from '../../services/session-service.js'
import { createSchedulerFixture, type SchedulerFixture } from '../helpers/scheduler-fixture.js'

/**
 * The front door's `start_workflow` tool against the real launch machinery:
 * a durable session store, the workflow registry, and the admission queue with
 * a capturing launcher. The provider is not involved — the tool's own contract
 * is what these cases pin.
 */

const DETAILED_REQUEST =
  'Write a detailed launch announcement for our beta release next month, aimed at existing customers who run the current version in production.'

/** The proposal the invariant requires: an assistant message naming the id. */
const PROPOSAL =
  'test-workflow fits this request. Say the word and I will start it.'

interface AdapterFixture {
  readonly repo: SchedulerFixture
  readonly store: FileSystemSessionStore
  readonly queue: TaskQueue
  readonly sessionId: string
  readonly launched: { count: number }
}

async function createAdapterFixture(
  t: TestContext,
  options: { initializeQueue?: boolean } = {},
): Promise<AdapterFixture> {
  const repo = createSchedulerFixture('workflow-launch-adapter-')
  const store = new FileSystemSessionStore(repo.workspacePath)
  const owner = await WorkspaceDispatcherOwner.acquire({
    workspacePath: repo.workspacePath,
  })
  const launched = { count: 0 }
  const queue = new TaskQueue({
    sessionStore: store,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: repo.repoRootPath,
    workspacePath: repo.workspacePath,
    taskLauncher: {
      async startRun(request) {
        launched.count += 1
        return { launched: true as const, pid: 0, cwd: request.cwd }
      },
    },
    tickIntervalMs: 10,
  })
  if (options.initializeQueue !== false) await queue.initialize()
  const session = await store.createSession({ title: 'Tool launch' })
  t.after(async () => {
    await queue.close(1)
    await owner.release()
    repo.cleanup()
  })
  return { repo, store, queue, sessionId: session.id, launched }
}

function makeAdapter(fixture: AdapterFixture, onLaunched?: (outcome: unknown) => void) {
  return createWorkflowLaunchToolAdapter({
    sessionId: fixture.sessionId,
    sessionStore: fixture.store,
    repoRootPath: fixture.repo.repoRootPath,
    workspacePath: fixture.repo.workspacePath,
    workflowsRegistryPath: fixture.repo.workflowsRegistryPath,
    taskQueue: fixture.queue,
    goal: 'go for it',
    sourceTurn: { turnId: randomUUID(), fingerprint: 'test-fingerprint' },
    ...(onLaunched ? { onLaunched } : {}),
  })
}

function executionContext(sessionId: string) {
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: randomUUID(),
    leaseId: randomUUID(),
    sessionId,
    runId: randomUUID(),
    assignmentId: randomUUID(),
    agentPath: 'agents/general-agent',
  } satisfies Parameters<
    ReturnType<typeof createWorkflowLaunchToolAdapter>['execute']
  >[0]['context']
}

test('the tool is a mutating builtin named start_workflow taking a workflowId', () => {
  const prompt = WORKFLOW_LAUNCH_ACTIVATION_PROMPT
  // The model-side gate: confirmation of a proposed workflow only.
  assert.match(prompt, /start_workflow/)
  assert.match(prompt, /unambiguous confirmation/i)
  assert.match(prompt, /already proposed/i)
  assert.match(prompt, /exact registered workflow id/i)
  assert.match(prompt, /never call it on a first request/i)
  assert.match(prompt, /new requirements/i)
  // Report only confirmed starts; relay refusals.
  assert.match(prompt, /only after the tool confirms/i)
  assert.match(prompt, /refus/i)
})

test('an unknown workflow id is refused and persists nothing', async (t) => {
  const fixture = await createAdapterFixture(t)
  const adapter = makeAdapter(fixture)

  const refused = await adapter.execute({
    context: executionContext(fixture.sessionId),
    toolCallId: 'unknown-workflow',
    input: { workflowId: 'not-a-workflow' },
  })

  assert.equal(refused.isError, true)
  assert.equal(
    z.object({ code: z.string() }).parse(refused.output).code,
    'bad_request',
  )
  assert.match(refused.content, /not-a-workflow/)
  assert.equal(await fixture.store.getRunPlan(fixture.sessionId), null)
  assert.equal((await fixture.store.listTaskRecords(fixture.sessionId)).length, 0)
})

test('a thin conversation produces no launch and says what is missing', async (t) => {
  const fixture = await createAdapterFixture(t)
  await fixture.store.appendChatMessage(
    fixture.sessionId,
    buildChatMessage('assistant', PROPOSAL),
  )
  const adapter = makeAdapter(fixture)

  const refused = await adapter.execute({
    context: executionContext(fixture.sessionId),
    toolCallId: 'thin-brief',
    input: { workflowId: 'test-workflow' },
  })

  assert.equal(refused.isError, true)
  const output = z
    .object({ code: z.string(), requiredInputs: z.array(z.string()) })
    .parse(refused.output)
  assert.equal(output.code, 'needs_input')
  assert.ok(output.requiredInputs.length > 0)
  // The plan is persisted as the user's own selection, ready for the detail
  // the agent must now ask for — but nothing was admitted.
  const plan = await fixture.store.getRunPlan(fixture.sessionId)
  assert.equal(plan?.status, 'needs_input')
  assert.equal(plan?.selectedWorkflow?.id, 'test-workflow')
  assert.equal(plan?.selectedWorkflow?.selectionSource, 'user')
  assert.equal((await fixture.store.listTaskRecords(fixture.sessionId)).length, 0)
  assert.equal(fixture.launched.count, 0)
})

test('a confirmation with substance behind it launches and reports the task', async (t) => {
  const fixture = await createAdapterFixture(t)
  await fixture.store.appendChatMessage(
    fixture.sessionId,
    buildChatMessage('user', DETAILED_REQUEST),
  )
  await fixture.store.appendChatMessage(
    fixture.sessionId,
    buildChatMessage('assistant', PROPOSAL),
  )
  let launchedOutcome: { task?: { id: string }; plan?: { id: string } } | undefined
  const adapter = makeAdapter(fixture, (outcome) => {
    launchedOutcome = outcome as typeof launchedOutcome
  })

  const result = await adapter.execute({
    context: executionContext(fixture.sessionId),
    toolCallId: 'confirmed-launch',
    input: { workflowId: 'test-workflow' },
  })

  assert.equal(result.isError, false, result.content)
  const output = z
    .object({
      code: z.literal('started'),
      task: z.object({ id: z.string(), workflowId: z.string() }),
      plan: z.object({ id: z.string() }),
    })
    .parse(result.output)
  assert.equal(output.task.workflowId, 'test-workflow')

  const tasks = await fixture.store.listTaskRecords(fixture.sessionId)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]?.id, output.task.id)
  assert.equal(tasks[0]?.sourceTurn?.fingerprint, 'test-fingerprint')
  assert.equal(
    (await fixture.store.getRunPlan(fixture.sessionId))?.taskId,
    output.task.id,
  )
  assert.equal(launchedOutcome?.task?.id, output.task.id)
  assert.equal(launchedOutcome?.plan?.id, output.plan.id)
})

test('a repeated call in the same turn reports the same task instead of launching twice', async (t) => {
  const fixture = await createAdapterFixture(t)
  await fixture.store.appendChatMessage(
    fixture.sessionId,
    buildChatMessage('user', DETAILED_REQUEST),
  )
  await fixture.store.appendChatMessage(
    fixture.sessionId,
    buildChatMessage('assistant', PROPOSAL),
  )
  const adapter = makeAdapter(fixture)
  const execute = () =>
    adapter.execute({
      context: executionContext(fixture.sessionId),
      toolCallId: randomUUID(),
      input: { workflowId: 'test-workflow' },
    })

  // Concurrent and sequential duplicates: both must land on one task.
  const [first, second] = await Promise.all([execute(), execute()])
  const third = await execute()

  const taskIds = [first, second, third].map((result) => {
    assert.equal(result.isError, false, result.content)
    return z
      .object({ task: z.object({ id: z.string() }) })
      .parse(result.output).task.id
  })
  assert.equal(new Set(taskIds).size, 1, 'every call observes the one launch')
  assert.equal((await fixture.store.listTaskRecords(fixture.sessionId)).length, 1)
})

test('a confirmation while admission is recovering refuses without claiming a start', async (t) => {
  const fixture = await createAdapterFixture(t, { initializeQueue: false })
  await fixture.store.appendChatMessage(
    fixture.sessionId,
    buildChatMessage('user', DETAILED_REQUEST),
  )
  await fixture.store.appendChatMessage(
    fixture.sessionId,
    buildChatMessage('assistant', PROPOSAL),
  )
  const adapter = makeAdapter(fixture)

  const refused = await adapter.execute({
    context: executionContext(fixture.sessionId),
    toolCallId: 'recovering-queue',
    input: { workflowId: 'test-workflow' },
  })

  assert.equal(refused.isError, true)
  const output = z.object({ code: z.string() }).parse(refused.output)
  assert.equal(output.code, 'task_admission_recovering')
  assert.match(refused.content, /recovering/i)
  // The plan is still there, still ready, and nothing was admitted.
  const plan = await fixture.store.getRunPlan(fixture.sessionId)
  assert.equal(plan?.status, 'ready')
  assert.equal(plan?.applyClaimId, undefined)
  assert.equal((await fixture.store.listTaskRecords(fixture.sessionId)).length, 0)
  assert.equal(fixture.launched.count, 0)
})


/**
 * The proposal invariant: the tool refuses to launch a Workflow the
 * conversation never proposed. Language judgment ("is this a confirmation?")
 * stays with the model; the durable evidence — a persisted plan selecting the
 * workflow, or an assistant message naming its exact id — is checked here.
 */
test('a tool call without any prior proposal is refused and admits nothing', async (t) => {
  const fixture = await createAdapterFixture(t)
  await fixture.store.appendChatMessage(
    fixture.sessionId,
    buildChatMessage('user', DETAILED_REQUEST),
  )
  const adapter = makeAdapter(fixture)

  const refused = await adapter.execute({
    context: executionContext(fixture.sessionId),
    toolCallId: 'unproposed-start',
    input: { workflowId: 'test-workflow' },
  })

  assert.equal(refused.isError, true, 'there is no assistant proposal in this conversation')
  const output = z.object({ code: z.string() }).parse(refused.output)
  assert.equal(output.code, 'no_proposal')
  assert.match(refused.content, /propose/i)
  assert.equal(await fixture.store.getRunPlan(fixture.sessionId), null, 'no plan is persisted either')
  assert.equal((await fixture.store.listTaskRecords(fixture.sessionId)).length, 0)
  assert.equal(fixture.launched.count, 0)
})

test('a user message naming the workflow is not proposal evidence', async (t) => {
  const fixture = await createAdapterFixture(t)
  await fixture.store.appendChatMessage(
    fixture.sessionId,
    buildChatMessage('user', `${DETAILED_REQUEST} Use test-workflow.`),
  )
  const adapter = makeAdapter(fixture)

  const refused = await adapter.execute({
    context: executionContext(fixture.sessionId),
    toolCallId: 'user-named-start',
    input: { workflowId: 'test-workflow' },
  })

  assert.equal(refused.isError, true)
  assert.equal(
    z.object({ code: z.string() }).parse(refused.output).code,
    'no_proposal',
    'only the assistant may propose; a user naming the id is a request, not a proposal',
  )
  assert.equal((await fixture.store.listTaskRecords(fixture.sessionId)).length, 0)
})

test('a persisted plan selecting the workflow is proposal evidence without an assistant mention', async (t) => {
  const fixture = await createAdapterFixture(t)
  await fixture.store.appendChatMessage(
    fixture.sessionId,
    buildChatMessage('user', DETAILED_REQUEST),
  )
  // The Coordinator planning path selected the workflow in an earlier turn;
  // no assistant prose ever named it.
  await fixture.store.saveRunPlan(fixture.sessionId, {
    id: 'plan-coordinator-selected',
    goal: DETAILED_REQUEST,
    summary: 'Ready.',
    status: 'ready',
    selectedWorkflow: {
      id: 'test-workflow',
      rationale: 'Selected by the Coordinator.',
      confidence: 'medium',
      selectionSource: 'coordinator',
    },
    requiredInputs: [],
    actions: [],
    warnings: [],
    createdAt: new Date().toISOString(),
  })
  const adapter = makeAdapter(fixture)

  const result = await adapter.execute({
    context: executionContext(fixture.sessionId),
    toolCallId: 'plan-evidence-start',
    input: { workflowId: 'test-workflow' },
  })

  assert.equal(result.isError, false, result.content)
  const output = z
    .object({ task: z.object({ id: z.string(), workflowId: z.string() }) })
    .parse(result.output)
  assert.equal(output.task.workflowId, 'test-workflow')
  assert.equal((await fixture.store.listTaskRecords(fixture.sessionId)).length, 1)
})

test('a launch folds the turn\'s carried results into the admitted task brief', async (t) => {
  const fixture = await createAdapterFixture(t)
  await fixture.store.appendChatMessage(
    fixture.sessionId,
    buildChatMessage('user', DETAILED_REQUEST),
  )
  await fixture.store.appendChatMessage(
    fixture.sessionId,
    buildChatMessage('assistant', PROPOSAL),
  )
  const adapter = createWorkflowLaunchToolAdapter({
    sessionId: fixture.sessionId,
    sessionStore: fixture.store,
    repoRootPath: fixture.repo.repoRootPath,
    workspacePath: fixture.repo.workspacePath,
    workflowsRegistryPath: fixture.repo.workflowsRegistryPath,
    taskQueue: fixture.queue,
    continuationContext: 'CARRIED: the earlier analysis concluded retention drives growth.',
    goal: 'go for it',
    sourceTurn: { turnId: randomUUID(), fingerprint: 'carry-fingerprint' },
  })

  const result = await adapter.execute({
    context: executionContext(fixture.sessionId),
    toolCallId: 'carry-results',
    input: { workflowId: 'test-workflow' },
  })

  assert.equal(result.isError, false, result.content)
  const tasks = await fixture.store.listTaskRecords(fixture.sessionId)
  assert.equal(tasks.length, 1)
  assert.match(tasks[0]?.brief ?? '', /## Carried Results/)
  assert.match(tasks[0]?.brief ?? '', /retention drives growth/)
})


test('an older proposal cannot replace a different selected workflow', async (t) => {
  const fixture = await createAdapterFixture(t)
  await fixture.store.appendChatMessage(fixture.sessionId, buildChatMessage('user', DETAILED_REQUEST))
  await fixture.store.appendChatMessage(fixture.sessionId, buildChatMessage('assistant', PROPOSAL))
  const selected = {
    id: 'newer-user-selection', goal: DETAILED_REQUEST, summary: 'Ready.',
    status: 'ready' as const,
    selectedWorkflow: { id: 'other-workflow', rationale: 'User selected it.', confidence: 'high' as const, selectionSource: 'user' as const },
    requiredInputs: [], actions: [], warnings: [], createdAt: '2026-10-19T12:00:00.000Z',
  }
  await fixture.store.saveRunPlan(fixture.sessionId, selected)

  const savedSelection = await fixture.store.getRunPlan(fixture.sessionId)

  const refused = await makeAdapter(fixture).execute({
    context: executionContext(fixture.sessionId), toolCallId: 'stale-proposal',
    input: { workflowId: 'test-workflow' },
  })

  assert.equal(refused.isError, true, 'a confirmation must preserve the newer selection')
  assert.equal(z.object({ code: z.string() }).parse(refused.output).code, 'conflict')
  assert.deepEqual(await fixture.store.getRunPlan(fixture.sessionId), savedSelection)
  assert.deepEqual(await fixture.store.listTaskRecords(fixture.sessionId), [])
})

test('plan creation refuses when another window selected a plan after the observed empty state', async (t) => {
  const fixture = await createAdapterFixture(t)
  await fixture.store.appendChatMessage(fixture.sessionId, buildChatMessage('user', DETAILED_REQUEST))
  const selected = await createRunPlanService({
    sessionId: fixture.sessionId, sessionStore: fixture.store,
    repoRootPath: fixture.repo.repoRootPath, workflowsRegistryPath: fixture.repo.workflowsRegistryPath,
    workflowId: 'test-workflow', goal: DETAILED_REQUEST, selectionSource: 'user',
  })
  const observedEmptyState = {
    sessionId: fixture.sessionId, sessionStore: fixture.store,
    repoRootPath: fixture.repo.repoRootPath, workflowsRegistryPath: fixture.repo.workflowsRegistryPath,
    workflowId: 'test-workflow', goal: 'go for it', selectionSource: 'user' as const,
    expectedPlanId: null,
  }

  await assert.rejects(createRunPlanService(observedEmptyState), { code: 'conflict' })
  assert.equal((await fixture.store.getRunPlan(fixture.sessionId))?.id, selected.id)
  assert.deepEqual(await fixture.store.listTaskRecords(fixture.sessionId), [])
})

test('shared turn wiring retains the workflow registry for approved retries', () => {
  const sources = { workspacePath: '/fixture/workspace', workflowsRegistryPath: '/fixture/workflows/registry.yaml' }
  const wiring = agentChatTurnWiring(sources)
  assert.equal(wiring.workflowsRegistryPath, sources.workflowsRegistryPath)
})
