/**
 * The launch shell's use of the display-stream port.
 *
 * The decision and the lifetime rules are proved on their own in
 * `tests/unit/agent-text-stream-launch-plan.test.ts` and
 * `tests/unit/agent-text-stream-launch-port.test.ts`. What is left, and what
 * these cover, is the wiring: that a Team launch actually carries the port's
 * values into the child, that nothing else does, and that a launch which never
 * takes does not leave a live credential behind.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { launchReservedTaskExecutionAttempt } from '../../services/task-service.js'
import { TaskQueue } from '../../services/task-queue.js'
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import {
  AGENT_TEXT_STREAM_CHANNEL_ENV,
  AGENT_TEXT_STREAM_TOKEN_ENV,
  AGENT_TEXT_STREAM_URL_ENV,
} from '../../domains/runtime/agent-text-delta-tokens.js'
import { createAgentTextStreamLaunchPort } from '../../domains/runtime/agent-text-delta-launch.js'
import type { RunLauncher } from '../../domains/run/run-launcher.js'
import type { RunLaunchResult, RunStartRequest } from '../../contracts/runs.js'
import type { SessionTask, TaskAdmission } from '../../contracts/sessions.js'
import type { RunPlan } from '../../contracts/run-plan.js'

function readyPlan(): RunPlan {
  return {
    id: `plan-${Date.now()}`,
    goal: 'Exercise a Team launch.',
    summary: 'Ready.',
    status: 'ready',
    selectedWorkflow: {
      id: 'wf-1',
      rationale: 'Selected for launch-grant testing.',
      confidence: 'high',
    },
    requiredInputs: [],
    actions: [
      {
        id: 'launch-workflow',
        type: 'launch_workflow',
        status: 'ready',
        title: 'Launch wf-1',
        rationale: 'Ready.',
      },
    ],
    warnings: [],
    createdAt: new Date().toISOString(),
  }
}

const ENDPOINT = 'http://127.0.0.1:4321/internal/agent-text-stream'

class CapturingLauncher implements RunLauncher {
  readonly launches: RunStartRequest[] = []

  constructor(
    private readonly outcome: 'ok' | 'fail' = 'ok',
    /** Observes the world at the moment the child would start. */
    private readonly onSpawn: (request: RunStartRequest) => void = () => {},
  ) {}

  async startRun(request: RunStartRequest): Promise<RunLaunchResult> {
    this.launches.push(request)
    this.onSpawn(request)
    if (this.outcome === 'fail') throw new Error('the worker refused to start')
    return {
      launched: true,
      pid: 9911,
      cwd: request.cwd,
      ...(request.processIdentity
        ? { processIdentity: request.processIdentity }
        : {}),
    }
  }
}

function grantedAdmission(
  executionAttemptId: string,
): Extract<TaskAdmission, { phase: 'granted' }> {
  const now = new Date().toISOString()
  return {
    version: 1,
    phase: 'granted',
    requestId: `request-${executionAttemptId}`,
    order: '1',
    requestedAt: now,
    executionKind: 'initial',
    source: 'apply',
    expectedExecutionAttemptId: null,
    grantId: `grant-${executionAttemptId}`,
    ownerEpoch: 'owner-epoch-1',
    grantedAt: now,
    executionAttemptId,
  }
}

/** Records what the hub and the registry were asked to do. */
function createStreamFakes() {
  const openChannels = new Map<string, string>()
  const liveRuns = new Set<string>()
  let counter = 0
  const port = createAgentTextStreamLaunchPort({
    hub: {
      openChannel: (channelId, ownerId) => openChannels.set(channelId, ownerId),
      closeChannel: (channelId) => {
        openChannels.delete(channelId)
      },
    },
    tokens: {
      issue: ({ runId }) => {
        liveRuns.add(runId)
        return `token-${(counter += 1)}`
      },
      revokeByRun: (runId) => {
        liveRuns.delete(runId)
      },
    },
    endpoint: { url: ENDPOINT },
  })
  return { port, openChannels, liveRuns }
}

interface Reserved {
  readonly store: FileSystemSessionStore
  readonly sessionId: string
  readonly task: SessionTask
  readonly workspacePath: string
  readonly dispose: () => void
}

async function reserveTask(
  target: 'team-chat' | 'workflow',
): Promise<Reserved> {
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'launch-stream-')),
  )
  const store = new FileSystemSessionStore(workspacePath, {
    instanceId: `launch-stream-${process.pid}`,
  })
  const session = await store.createSession({ title: 'Launch grant' })
  const created = await store.createTaskRecord(session.id, {
    workflowId: 'wf-1',
    brief: 'Say something.',
    ...(target === 'team-chat'
      ? { targetKind: 'team-chat' as const, teamId: 'line-team' }
      : {}),
  })
  assert.ok(created)

  const executionAttemptId = `attempt-${Date.now()}`
  const admitted = await store.compareAndSetTaskRecord(
    session.id,
    created.id,
    ['queued'],
    {
      status: 'queued',
      admission: grantedAdmission(executionAttemptId),
      processIdentity: executionAttemptId,
      executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      attemptStartedAt: new Date().toISOString(),
    },
    { expectedExecutionAttemptId: null },
  )
  assert.ok(admitted?.updated)

  return {
    store,
    sessionId: session.id,
    task: admitted.task,
    workspacePath,
    dispose: () => fs.rmSync(workspacePath, { recursive: true, force: true }),
  }
}

test('a Team launch carries the display channel, its address and its token to the child', async () => {
  const reserved = await reserveTask('team-chat')
  const streams = createStreamFakes()
  // A stub launcher never acknowledges startup, so the shell rolls the grant
  // back afterwards — correctly. What matters is the state the child would
  // have found, so it is captured at spawn rather than read after the fact.
  let ownerAtSpawn: string | undefined
  const launcher = new CapturingLauncher('ok', (request) => {
    const channelId = request.env?.[AGENT_TEXT_STREAM_CHANNEL_ENV]
    ownerAtSpawn = channelId ? streams.openChannels.get(channelId) : undefined
  })
  try {
    await launchReservedTaskExecutionAttempt({
      sessionId: reserved.sessionId,
      sessionStore: reserved.store,
      taskLauncher: launcher,
      repoRootPath: process.cwd(),
      workspacePath: reserved.workspacePath,
      task: reserved.task,
      warnings: [],
      startupTimeoutMs: 300,
      textStream: streams.port,
    })

    const env = launcher.launches[0]?.env ?? {}
    assert.equal(env[AGENT_TEXT_STREAM_URL_ENV], ENDPOINT)
    const channelId = env[AGENT_TEXT_STREAM_CHANNEL_ENV]
    assert.ok(channelId)
    assert.ok(env[AGENT_TEXT_STREAM_TOKEN_ENV])
    // The address is not a credential and never carries one.
    assert.equal(
      env[AGENT_TEXT_STREAM_URL_ENV]?.includes(
        env[AGENT_TEXT_STREAM_TOKEN_ENV] ?? '',
      ),
      false,
    )
    // Owned by the session, and open before the child could post anything.
    assert.equal(ownerAtSpawn, reserved.sessionId)
  } finally {
    reserved.dispose()
  }
})

test('a workflow launch carries none of them, and mints nothing', async () => {
  const reserved = await reserveTask('workflow')
  const streams = createStreamFakes()
  const launcher = new CapturingLauncher()
  try {
    await launchReservedTaskExecutionAttempt({
      sessionId: reserved.sessionId,
      sessionStore: reserved.store,
      taskLauncher: launcher,
      repoRootPath: process.cwd(),
      workspacePath: reserved.workspacePath,
      task: reserved.task,
      warnings: [],
      startupTimeoutMs: 300,
      textStream: streams.port,
    })

    const env = launcher.launches[0]?.env ?? {}
    assert.equal(env[AGENT_TEXT_STREAM_URL_ENV], undefined)
    assert.equal(env[AGENT_TEXT_STREAM_CHANNEL_ENV], undefined)
    assert.equal(env[AGENT_TEXT_STREAM_TOKEN_ENV], undefined)
    assert.equal(streams.openChannels.size, 0)
    assert.equal(streams.liveRuns.size, 0)
  } finally {
    reserved.dispose()
  }
})

test('a launch that never takes leaves no open channel and no working credential', async () => {
  const reserved = await reserveTask('team-chat')
  const streams = createStreamFakes()
  const launcher = new CapturingLauncher('fail')
  try {
    const result = await launchReservedTaskExecutionAttempt({
      sessionId: reserved.sessionId,
      sessionStore: reserved.store,
      taskLauncher: launcher,
      repoRootPath: process.cwd(),
      workspacePath: reserved.workspacePath,
      task: reserved.task,
      warnings: [],
      startupTimeoutMs: 300,
      textStream: streams.port,
    })

    assert.equal(result.ok, false)
    // The credential was minted before the spawn was attempted, so a spawn
    // that failed has to take it back. Otherwise a token stays valid for a run
    // that never started, and nothing later will ever revoke it.
    assert.equal(streams.openChannels.size, 0)
    assert.equal(streams.liveRuns.size, 0)
  } finally {
    reserved.dispose()
  }
})

test('a Team task admitted through the queue reaches its launch with the grant intact', async () => {
  // The queue is what launches in production. Covering the shell alone would
  // leave the forward between them as the one untested line, and a dropped
  // option there would be invisible: Team runs would simply never stream.
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'launch-stream-queue-')),
  )
  const store = new FileSystemSessionStore(workspacePath, {
    instanceId: `launch-stream-queue-${process.pid}`,
  })
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const streams = createStreamFakes()
  const launcher = new CapturingLauncher()
  const queue = new TaskQueue({
    sessionStore: store,
    owner,
    maximumConcurrentTasks: 2,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: 10,
    textStream: streams.port,
  })

  try {
    await queue.initialize()
    const session = await store.createSession({ title: 'Queue grant' })
    const plan = readyPlan()
    await store.saveRunPlan(session.id, plan)
    // Admission commits only under a claimed plan, the same way the real
    // apply path reaches the queue.
    const claimed = await store.claimRunPlanForApply(session.id, plan.id)
    assert.ok(claimed?.plan.applyClaimId, 'expected the plan to be claimable')

    await queue.enqueueInitial({
      sessionId: session.id,
      admissionSource: 'apply',
      task: {
        workflowId: 'wf-1',
        targetKind: 'team-chat',
        teamId: 'line-team',
        brief: 'Say something.',
        runPlanId: plan.id,
        runPlanApplyClaimId: claimed.plan.applyClaimId,
      },
    })

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && launcher.launches.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const env = launcher.launches[0]?.env ?? {}
    assert.equal(env[AGENT_TEXT_STREAM_URL_ENV], ENDPOINT)
    assert.ok(env[AGENT_TEXT_STREAM_CHANNEL_ENV])
    assert.ok(env[AGENT_TEXT_STREAM_TOKEN_ENV])
  } finally {
    await queue.close(1)
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
