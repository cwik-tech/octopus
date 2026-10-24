import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'
import { teamTurnFingerprint } from '../../services/team-launch-service.js'
import * as fsPromises from 'node:fs/promises'
import { registerProvider } from '../../providers/registry.js'
import {
  getRuntimeDefaultModelState,
  setRuntimeDefaultModelState,
} from '../../domains/provider/default-model-selection.js'
import type { ChatMessage, SessionTask } from '../../contracts/sessions.js'
import type { RunPlan } from '../../contracts/run-plan.js'
import type { SessionMessageTarget } from '../../contracts/schemas/session-requests.js'

const LM_STUDIO_HOST = 'localhost:1234'

interface DispatchResponse {
  readonly dispatch: {
    readonly kind: string
    readonly agentNames?: string[]
    readonly teamId?: string
    readonly workflowId?: string
    readonly selectedWorkflowId?: string
  }
  readonly user: ChatMessage
  readonly messages: ChatMessage[]
  readonly plan?: RunPlan
  readonly task?: SessionTask
  readonly session?: { readonly title: string }
  readonly replayed: boolean
}

/**
 * Intercept only the model endpoint. The test's own calls to the API server
 * must keep working, so everything else is delegated to the real fetch.
 */
function installModelStub(finalText: string): () => void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    if (!url.includes(LM_STUDIO_HOST)) return originalFetch(input, init)
    const frames = [
      { type: 'message.delta', content: finalText },
      {
        type: 'chat.end',
        result: {
          output: [{ type: 'message', content: finalText }],
          stats: { input_tokens: 1, total_output_tokens: 1 },
        },
      },
    ]
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
        }
        controller.close()
      },
    })
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof globalThis.fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

function makeWorkspace(prefix: string): {
  directory: string
  workspacePath: string
  projectRoot: string
} {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
  )
  const workspacePath = path.join(directory, 'workspace')
  const projectRoot = path.join(directory, 'project')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'agents'), { recursive: true })
  return { directory, workspacePath, projectRoot }
}

function writeAgent(repoRootPath: string, name: string): void {
  const directory = path.join(repoRootPath, 'agents', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      'tier: strategic',
      'provider: lm-studio',
      'model: test-model',
      'thinking: low',
      '---',
      '',
      `# ${name}`,
      '',
      'Answer the question.',
      '',
    ].join('\n'),
    'utf8',
  )
}

async function startServer(
  workspacePath: string,
  projectRoot: string,
): Promise<StartedApiServer> {
  return startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new PiRunLauncher(),
    sessionStore: new FileSystemSessionStore(workspacePath),
    repoRootPath: projectRoot,
    workspacePath,
  })
}

async function createSession(url: string): Promise<string> {
  const response = await fetch(`${url}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Unified dispatch' }),
  })
  assert.equal(response.status, 201)
  const session = (await response.json()) as { id: string }
  return session.id
}

async function postMessage(
  url: string,
  sessionId: string,
  text: string,
  input?: { target?: SessionMessageTarget; turnId?: string },
): Promise<Response> {
  return fetch(`${url}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      provider: 'lm-studio',
      model: 'test-model',
      ...(input?.target ? { target: input.target } : {}),
      ...(input?.turnId ? { turnId: input.turnId } : {}),
    }),
  })
}

async function listChat(url: string, sessionId: string): Promise<ChatMessage[]> {
  const response = await fetch(`${url}/sessions/${sessionId}/messages`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as { messages: ChatMessage[] }
  return body.messages
}

test('an untargeted turn and an explicit Agent turn share one endpoint and one transcript', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('dispatch-agent-')
  writeAgent(projectRoot, 'analyst')
  const restoreFetch = installModelStub('Analysed.')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)

    // Arrange / Act: an untargeted turn is the Run Coordinator's.
    const coordinatorResponse = await postMessage(
      server.url,
      sessionId,
      'I want a market overview',
    )
    assert.equal(
      coordinatorResponse.status,
      201,
      await coordinatorResponse.clone().text(),
    )
    const coordinatorTurn = (await coordinatorResponse.json()) as DispatchResponse
    assert.equal(coordinatorTurn.dispatch.kind, 'coordinator')
    assert.equal(coordinatorTurn.replayed, false)
    assert.ok(coordinatorTurn.plan, 'a Coordinator turn always carries its plan')

    // Act: the same endpoint, now addressed to one Agent.
    const agentResponse = await postMessage(server.url, sessionId, 'Your read?', {
      target: { kind: 'agents', agentNames: ['analyst'] },
    })
    assert.equal(agentResponse.status, 201, await agentResponse.clone().text())
    const agentTurn = (await agentResponse.json()) as DispatchResponse

    // Assert: that exact Agent answered, in the same conversation.
    assert.deepEqual(agentTurn.dispatch, { kind: 'agents', agentNames: ['analyst'] })
    assert.equal(agentTurn.messages.length, 1)
    assert.equal(agentTurn.messages[0]?.speaker?.name, 'analyst')

    const transcript = await listChat(server.url, sessionId)
    assert.deepEqual(
      transcript.map((message) => message.role),
      ['user', 'assistant', 'user', 'assistant'],
      'both turns land in one durable transcript',
    )
  } finally {
    await server?.close()
    restoreFetch()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('an Agent dispatch replays as 200 with the same durable messages', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('dispatch-replay-')
  writeAgent(projectRoot, 'analyst')
  const restoreFetch = installModelStub('Analysed.')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const turnId = randomUUID()
    const target: SessionMessageTarget = {
      kind: 'agents',
      agentNames: ['analyst'],
    }

    const first = await postMessage(server.url, sessionId, 'Your read?', {
      target,
      turnId,
    })
    assert.equal(first.status, 201, await first.clone().text())
    const firstTurn = (await first.json()) as DispatchResponse
    assert.equal(firstTurn.replayed, false)

    const replay = await postMessage(server.url, sessionId, 'Your read?', {
      target,
      turnId,
    })
    assert.equal(replay.status, 200, 'a replay is a 200, not a second 201')
    const replayTurn = (await replay.json()) as DispatchResponse

    assert.equal(replayTurn.replayed, true)
    assert.deepEqual(
      replayTurn.messages.map((message) => message.id),
      firstTurn.messages.map((message) => message.id),
      'a replay hands back the durable messages, not new ones',
    )
    const transcript = await listChat(server.url, sessionId)
    assert.equal(
      transcript.filter((message) => message.role === 'assistant').length,
      1,
      'a replay must not append a second reply',
    )
  } finally {
    await server?.close()
    restoreFetch()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a Coordinator dispatch replays as 200 on the same turn id', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('dispatch-coord-replay-')
  const restoreFetch = installModelStub('Noted.')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const turnId = randomUUID()

    const first = await postMessage(server.url, sessionId, 'A market overview', {
      turnId,
    })
    assert.equal(first.status, 201, await first.clone().text())
    assert.equal(((await first.json()) as DispatchResponse).replayed, false)

    const replay = await postMessage(server.url, sessionId, 'A market overview', {
      turnId,
    })
    assert.equal(replay.status, 200, 'a replay is a 200, not a second 201')
    const replayTurn = (await replay.json()) as DispatchResponse
    assert.equal(replayTurn.replayed, true)
    assert.equal(replayTurn.dispatch.kind, 'coordinator')
  } finally {
    await server?.close()
    restoreFetch()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('reusing one turn id with a different target is a conflict, not a replay', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('dispatch-reuse-')
  writeAgent(projectRoot, 'analyst')
  writeAgent(projectRoot, 'writer')
  const restoreFetch = installModelStub('Analysed.')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const turnId = randomUUID()

    const first = await postMessage(server.url, sessionId, 'Your read?', {
      target: { kind: 'agents', agentNames: ['analyst'] },
      turnId,
    })
    assert.equal(first.status, 201, await first.clone().text())

    const reused = await postMessage(server.url, sessionId, 'Your read?', {
      target: { kind: 'agents', agentNames: ['writer'] },
      turnId,
    })
    assert.equal(
      reused.status,
      409,
      'the same id addressed elsewhere is a different request',
    )

    const transcript = await listChat(server.url, sessionId)
    assert.equal(
      transcript.filter((message) => message.role === 'assistant').length,
      1,
      'the rejected request must not produce a second reply',
    )
  } finally {
    await server?.close()
    restoreFetch()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('an unknown Agent is refused without touching the transcript', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('dispatch-unknown-')
  const restoreFetch = installModelStub('x')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)

    const response = await postMessage(server.url, sessionId, 'Your read?', {
      target: { kind: 'agents', agentNames: ['nobody'] },
    })
    assert.equal(response.status, 400)

    assert.deepEqual(await listChat(server.url, sessionId), [])
  } finally {
    await server?.close()
    restoreFetch()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/*  Team dispatch                                                       */
/* ------------------------------------------------------------------ */

interface TeamFixture {
  readonly server: StartedApiServer
  readonly sessionId: string
  readonly workspacePath: string
  readonly cleanup: () => Promise<void>
}

/**
 * A session whose repository holds one user-invocable Team.
 *
 * The shared scheduler fixture ships the Team as `user_facing: false`, which
 * chat targets are refused; flipping both flags is what makes it selectable the
 * way a real Team the user can pick is.
 */
async function withTeamSession(
  run: (fixture: TeamFixture) => Promise<void>,
): Promise<void> {
  const schedulerFixture = createSchedulerFixture('dispatch-team-')
  const teamYamlPath = path.join(
    schedulerFixture.repoRootPath,
    'teams',
    'test-team',
    'team.yaml',
  )
  fs.writeFileSync(
    teamYamlPath,
    fs
      .readFileSync(teamYamlPath, 'utf8')
      .replace('  user_facing: false\n', '  user_facing: true\n')
      .replace('    - team\n', '    - team\n    - user\n'),
  )
  const server = await startApiServer({
    store: new FileSystemRunStore(schedulerFixture.workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 0, cwd: '' }
      },
    },
    taskLauncher: {
      async startRun(request) {
        return { launched: true as const, pid: 0, cwd: request.cwd }
      },
    },
    sessionStore: new FileSystemSessionStore(schedulerFixture.workspacePath),
    workspacePath: schedulerFixture.workspacePath,
    repoRootPath: schedulerFixture.repoRootPath,
    workflowsRegistryPath: schedulerFixture.workflowsRegistryPath,
  })
  try {
    const sessionId = await createSession(server.url)
    await run({
      server,
      sessionId,
      workspacePath: schedulerFixture.workspacePath,
      cleanup: async () => {
        await server.close()
      },
    })
  } finally {
    await server.close()
    schedulerFixture.cleanup()
  }
}

async function listTasks(url: string, sessionId: string): Promise<SessionTask[]> {
  const response = await fetch(`${url}/sessions/${sessionId}/tasks`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as { tasks: SessionTask[] }
  return body.tasks
}

const TEAM_TARGET: SessionMessageTarget = { kind: 'team', teamId: 'test-team' }

test('a Team dispatch starts one task and replays it on a sequential retry', async () => {
  await withTeamSession(async ({ server, sessionId }) => {
    const turnId = randomUUID()

    const first = await postMessage(server.url, sessionId, 'Review the brief', {
      target: TEAM_TARGET,
      turnId,
    })
    assert.equal(first.status, 201, await first.clone().text())
    const firstTurn = (await first.json()) as DispatchResponse
    assert.deepEqual(firstTurn.dispatch, { kind: 'team', teamId: 'test-team' })
    assert.ok(firstTurn.task, 'a Team dispatch always carries its task')
    assert.equal(firstTurn.replayed, false)

    const retry = await postMessage(server.url, sessionId, 'Review the brief', {
      target: TEAM_TARGET,
      turnId,
    })
    assert.equal(retry.status, 200, await retry.clone().text())
    const retryTurn = (await retry.json()) as DispatchResponse
    assert.equal(retryTurn.replayed, true)
    assert.equal(
      retryTurn.task?.id,
      firstTurn.task?.id,
      'a retry hands back the task it already started',
    )

    const tasks = await listTasks(server.url, sessionId)
    assert.equal(tasks.length, 1, 'a retry must not start a second task')
  })
})

test('a Team dispatch still replays after its task reaches a terminal state', async () => {
  await withTeamSession(async ({ server, sessionId }) => {
    const turnId = randomUUID()

    const first = await postMessage(server.url, sessionId, 'Review the brief', {
      target: TEAM_TARGET,
      turnId,
    })
    assert.equal(first.status, 201, await first.clone().text())
    const startedTask = ((await first.json()) as DispatchResponse).task
    assert.ok(startedTask)

    // A finished run reopens every status gate that was protecting the session
    // while the task was active. Only the turn's own durable identity can still
    // tell a retry from a new request at this point.
    const cancelled = await fetch(
      `${server.url}/sessions/${sessionId}/tasks/${startedTask.id}`,
      { method: 'DELETE' },
    )
    assert.ok(
      cancelled.status === 200 || cancelled.status === 202,
      await cancelled.clone().text(),
    )

    const retry = await postMessage(server.url, sessionId, 'Review the brief', {
      target: TEAM_TARGET,
      turnId,
    })
    assert.equal(retry.status, 200, await retry.clone().text())
    assert.equal(((await retry.json()) as DispatchResponse).replayed, true)

    const tasks = await listTasks(server.url, sessionId)
    assert.equal(
      tasks.length,
      1,
      'a post-terminal retry must not start a second task',
    )
  })
})

test('concurrent duplicate Team dispatches produce exactly one task', async () => {
  await withTeamSession(async ({ server, sessionId }) => {
    const turnId = randomUUID()

    const [a, b] = await Promise.all([
      postMessage(server.url, sessionId, 'Review the brief', {
        target: TEAM_TARGET,
        turnId,
      }),
      postMessage(server.url, sessionId, 'Review the brief', {
        target: TEAM_TARGET,
        turnId,
      }),
    ])

    const statuses = [a.status, b.status].sort()
    assert.ok(
      statuses.every((status) => status === 200 || status === 201 || status === 409),
      `unexpected statuses: ${statuses.join(', ')}`,
    )

    const tasks = await listTasks(server.url, sessionId)
    assert.equal(tasks.length, 1, 'two racing duplicates start one task')
  })
})

test('one turn id addressed to a different Team is a conflict', async () => {
  await withTeamSession(async ({ server, sessionId }) => {
    const turnId = randomUUID()

    const first = await postMessage(server.url, sessionId, 'Review the brief', {
      target: TEAM_TARGET,
      turnId,
    })
    assert.equal(first.status, 201, await first.clone().text())

    const reused = await postMessage(server.url, sessionId, 'Review the brief', {
      target: { kind: 'team', teamId: 'other-team' },
      turnId,
    })
    assert.equal(
      reused.status,
      409,
      `a reused id addressed elsewhere is a conflict: ${await reused.clone().text()}`,
    )

    const tasks = await listTasks(server.url, sessionId)
    assert.equal(tasks.length, 1)
  })
})

test('a Team dispatch records its source turn on the durable task', async () => {
  await withTeamSession(async ({ server, sessionId }) => {
    const turnId = randomUUID()

    const response = await postMessage(server.url, sessionId, 'Review the brief', {
      target: TEAM_TARGET,
      turnId,
    })
    assert.equal(response.status, 201, await response.clone().text())

    const [task] = await listTasks(server.url, sessionId)
    assert.equal(
      task?.sourceTurn?.turnId,
      turnId,
      'the task names the turn that started it, so a retry can find it',
    )
    assert.equal(typeof task?.sourceTurn?.fingerprint, 'string')
  })
})

test('a Team brief reaches the transcript exactly once across retries', async () => {
  await withTeamSession(async ({ server, sessionId }) => {
    const turnId = randomUUID()

    await postMessage(server.url, sessionId, 'Review the brief', {
      target: TEAM_TARGET,
      turnId,
    })
    await postMessage(server.url, sessionId, 'Review the brief', {
      target: TEAM_TARGET,
      turnId,
    })

    const transcript = await listChat(server.url, sessionId)
    assert.equal(
      transcript.filter((message) => message.role === 'user').length,
      1,
      'the submitted brief is persisted once, not once per retry',
    )
  })
})

/* ------------------------------------------------------------------ */
/*  Workflow selection                                                  */
/* ------------------------------------------------------------------ */

async function readRunPlan(url: string, sessionId: string): Promise<RunPlan | null> {
  const response = await fetch(`${url}/sessions/${sessionId}/run-plan`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as { plan: RunPlan | null }
  return body.plan
}

test('a first Workflow selection uses a null expectation and records user provenance', async () => {
  await withTeamSession(async ({ server, sessionId }) => {
    assert.equal(
      await readRunPlan(server.url, sessionId),
      null,
      'the journey starts with no plan at all',
    )

    const response = await postMessage(server.url, sessionId, 'Use this workflow', {
      target: {
        kind: 'workflow',
        workflowId: 'test-workflow',
        expectedPlanId: null,
      },
    })
    assert.equal(response.status, 201, await response.clone().text())
    const turn = (await response.json()) as DispatchResponse
    assert.deepEqual(turn.dispatch, {
      kind: 'workflow',
      workflowId: 'test-workflow',
    })

    const plan = await readRunPlan(server.url, sessionId)
    assert.equal(plan?.selectedWorkflow?.id, 'test-workflow')
    assert.equal(
      plan?.selectedWorkflow?.selectionSource,
      'user',
      'the user picked it, so it carries launch authority',
    )
  })
})

test('a stale plan expectation is refused rather than rebased', async () => {
  await withTeamSession(async ({ server, sessionId }) => {
    const first = await postMessage(server.url, sessionId, 'Use this workflow', {
      target: {
        kind: 'workflow',
        workflowId: 'test-workflow',
        expectedPlanId: null,
      },
    })
    assert.equal(first.status, 201, await first.clone().text())

    const stale = await postMessage(server.url, sessionId, 'Use it again', {
      target: {
        kind: 'workflow',
        workflowId: 'test-workflow',
        expectedPlanId: 'run-plan-does-not-exist',
      },
    })
    assert.equal(
      stale.status,
      409,
      `a stale expectation is a conflict: ${await stale.clone().text()}`,
    )
  })
})

test('a null expectation against an existing plan is refused', async () => {
  await withTeamSession(async ({ server, sessionId }) => {
    const first = await postMessage(server.url, sessionId, 'Use this workflow', {
      target: {
        kind: 'workflow',
        workflowId: 'test-workflow',
        expectedPlanId: null,
      },
    })
    assert.equal(first.status, 201, await first.clone().text())

    // `null` asserts "there is no plan". Once one exists, that assertion is
    // false, and answering it by overwriting whatever is there is the silent
    // rebase this contract exists to prevent.
    const repeated = await postMessage(server.url, sessionId, 'Use it again', {
      target: {
        kind: 'workflow',
        workflowId: 'test-workflow',
        expectedPlanId: null,
      },
    })
    assert.equal(
      repeated.status,
      409,
      `a null expectation against a live plan is a conflict: ${await repeated.clone().text()}`,
    )
  })
})

test('an exact plan expectation revises the selection in place', async () => {
  await withTeamSession(async ({ server, sessionId }) => {
    const first = await postMessage(server.url, sessionId, 'Use this workflow', {
      target: {
        kind: 'workflow',
        workflowId: 'test-workflow',
        expectedPlanId: null,
      },
    })
    assert.equal(first.status, 201, await first.clone().text())
    const currentPlan = await readRunPlan(server.url, sessionId)
    assert.ok(currentPlan)

    const revised = await postMessage(server.url, sessionId, 'Refine it', {
      target: {
        kind: 'workflow',
        workflowId: 'test-workflow',
        expectedPlanId: currentPlan.id,
      },
    })
    assert.equal(revised.status, 201, await revised.clone().text())

    const plan = await readRunPlan(server.url, sessionId)
    assert.equal(plan?.selectedWorkflow?.id, 'test-workflow')
    assert.equal(plan?.selectedWorkflow?.selectionSource, 'user')
  })
})

test('a user-selected Workflow governs the next untargeted turn', async () => {
  await withTeamSession(async ({ server, sessionId }) => {
    await postMessage(server.url, sessionId, 'Use this workflow', {
      target: {
        kind: 'workflow',
        workflowId: 'test-workflow',
        expectedPlanId: null,
      },
    })

    const followUp = await postMessage(server.url, sessionId, 'Add more detail')
    assert.equal(followUp.status, 201, await followUp.clone().text())
    const turn = (await followUp.json()) as DispatchResponse

    assert.deepEqual(turn.dispatch, {
      kind: 'coordinator',
      selectedWorkflowId: 'test-workflow',
    })
  })
})

test('an explicit Agent override leaves the selected Workflow in place', async () => {
  await withTeamSession(async ({ server, sessionId }) => {
    await postMessage(server.url, sessionId, 'Use this workflow', {
      target: {
        kind: 'workflow',
        workflowId: 'test-workflow',
        expectedPlanId: null,
      },
    })

    const override = await postMessage(server.url, sessionId, 'Your read?', {
      target: { kind: 'agents', agentNames: ['test-agent'] },
    })
    assert.equal(override.status, 201, await override.clone().text())
    assert.equal(
      ((await override.json()) as DispatchResponse).dispatch.kind,
      'agents',
    )

    const plan = await readRunPlan(server.url, sessionId)
    assert.equal(
      plan?.selectedWorkflow?.id,
      'test-workflow',
      'a one-turn override does not clear the selection',
    )
    assert.equal(plan?.selectedWorkflow?.selectionSource, 'user')
  })
})

test('a Team dispatch names the session and returns the renamed summary', async () => {
  // The old Team submit refetched the session after launching, so the
  // generated title reached the sidebar. The unified turn must carry that
  // rename back in its own response instead, or a Team conversation stays
  // "Untitled session" for the rest of its life.
  const titleRequests: string[] = []
  registerProvider(
    {
      name: 'fake-dispatch-title',
      async execute(options) {
        titleRequests.push(options.userMessage)
        return {
          text: '**Compare The Desktop Runtimes**',
          cost: 0,
          durationMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          contextTokens: 0,
          model: options.model,
        }
      },
    },
    {
      source: 'tests/integration/session-dispatch-api.test.ts#team-title',
      trustClass: 'test',
    },
    { replaceExisting: true },
  )
  const previousDefaultModel = getRuntimeDefaultModelState()
  try {
    await withTeamSession(async ({ server }) => {
      // Set after the server is up: starting it establishes its own default.
      setRuntimeDefaultModelState({
        status: 'available',
        provider: 'fake-dispatch-title',
        model: 'fake-title-model',
      })
      // Untitled, like a conversation the desktop just created: that is the
      // only state in which a title is generated at all.
      const created = await fetch(`${server.url}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      assert.equal(created.status, 201)
      const sessionId = ((await created.json()) as { id: string }).id

      const response = await postMessage(server.url, sessionId, 'Review the brief', {
        target: TEAM_TARGET,
        turnId: randomUUID(),
      })
      assert.equal(response.status, 201, await response.clone().text())
      const turn = (await response.json()) as DispatchResponse

      assert.ok(titleRequests.length > 0, 'the launch asks for a title')
      assert.equal(
        turn.session?.title,
        'Compare The Desktop Runtimes',
        'the response carries the renamed session',
      )

      const listed = await fetch(`${server.url}/sessions/${sessionId}`)
      assert.equal(listed.status, 200)
      const persisted = (await listed.json()) as { title: string }
      assert.equal(persisted.title, 'Compare The Desktop Runtimes')
    })
  } finally {
    setRuntimeDefaultModelState(previousDefaultModel)
  }
})

test('an explicit Workflow turn replays as 200 on the same turn id', async () => {
  await withTeamSession(async ({ server, sessionId }) => {
    const turnId = randomUUID()
    const target: SessionMessageTarget = {
      kind: 'workflow',
      workflowId: 'test-workflow',
      expectedPlanId: null,
    }

    const first = await postMessage(server.url, sessionId, 'Use this workflow', {
      target,
      turnId,
    })
    assert.equal(first.status, 201, await first.clone().text())
    const firstTurn = (await first.json()) as DispatchResponse
    assert.equal(firstTurn.replayed, false)

    // The identical request again. Its `expectedPlanId: null` was true when the
    // turn was admitted and is stale only because that same turn created the
    // plan, so re-running the compare-and-set would reject a turn this session
    // has already answered.
    const replay = await postMessage(server.url, sessionId, 'Use this workflow', {
      target,
      turnId,
    })
    assert.equal(
      replay.status,
      200,
      `an exact replay is a 200 on every branch: ${await replay.clone().text()}`,
    )
    const replayTurn = (await replay.json()) as DispatchResponse
    assert.equal(replayTurn.replayed, true)
    assert.deepEqual(replayTurn.dispatch, {
      kind: 'workflow',
      workflowId: 'test-workflow',
    })

    const transcript = await listChat(server.url, sessionId)
    assert.equal(
      transcript.filter((message) => message.role === 'user').length,
      1,
      'a replay must not append a second user turn',
    )
  })
})

test('a stale plan expectation under a new turn id is still a conflict', async () => {
  await withTeamSession(async ({ server, sessionId }) => {
    const first = await postMessage(server.url, sessionId, 'Use this workflow', {
      target: {
        kind: 'workflow',
        workflowId: 'test-workflow',
        expectedPlanId: null,
      },
      turnId: randomUUID(),
    })
    assert.equal(first.status, 201, await first.clone().text())

    // A different turn making the same false assertion is not a replay of
    // anything, so the compare-and-set must still refuse it.
    const stale = await postMessage(server.url, sessionId, 'Use this workflow', {
      target: {
        kind: 'workflow',
        workflowId: 'test-workflow',
        expectedPlanId: null,
      },
      turnId: randomUUID(),
    })
    assert.equal(stale.status, 409, await stale.clone().text())
  })
})


test('a Team dispatch repairs a transcript lost between task commit and append', async () => {
  await withTeamSession(async ({ server, sessionId, workspacePath }) => {
    const turnId = randomUUID()

    const first = await postMessage(server.url, sessionId, 'Review the brief', {
      target: TEAM_TARGET,
      turnId,
    })
    assert.equal(first.status, 201, await first.clone().text())

    // The crash window this design exists for: the task is committed and
    // durable, but the process died before the brief reached the transcript.
    // Emptying the log reproduces exactly that state.
    const transcriptPath = path.join(
      workspacePath,
      'sessions',
      sessionId,
      'chat.jsonl',
    )
    await fsPromises.writeFile(transcriptPath, '', 'utf8')
    assert.deepEqual(await listChat(server.url, sessionId), [])

    const retry = await postMessage(server.url, sessionId, 'Review the brief', {
      target: TEAM_TARGET,
      turnId,
    })
    assert.equal(retry.status, 200, await retry.clone().text())
    assert.equal(((await retry.json()) as DispatchResponse).replayed, true)

    // A replay that hands back a message nobody stored leaves the user looking
    // at a conversation the reload will not show.
    const repaired = await listChat(server.url, sessionId)
    const userTurns = repaired.filter((message) => message.role === 'user')
    assert.equal(userTurns.length, 1, 'the lost brief is restored exactly once')
    assert.equal(userTurns[0]?.turnId, turnId)
    assert.equal(userTurns[0]?.text, 'Review the brief')

    const tasks = await listTasks(server.url, sessionId)
    assert.equal(tasks.length, 1, 'the repair must not start a second task')
  })
})

test('a reused turn id is refused before it can revise the plan', async () => {
  await withTeamSession(async ({ server, sessionId }) => {
    const turnId = randomUUID()

    const first = await postMessage(server.url, sessionId, 'Use this workflow', {
      target: {
        kind: 'workflow',
        workflowId: 'test-workflow',
        expectedPlanId: null,
      },
      turnId,
    })
    assert.equal(first.status, 201, await first.clone().text())
    const admitted = await readRunPlan(server.url, sessionId)
    assert.ok(admitted)

    // Same id, different ask. This is a conflict, and a request that is going
    // to be refused must not leave the plan changed on its way out: selecting
    // is a durable act, so doing it first and rejecting afterwards would apply
    // half of a turn nobody accepted.
    const reused = await postMessage(server.url, sessionId, 'A different ask', {
      target: {
        kind: 'workflow',
        workflowId: 'test-workflow',
        expectedPlanId: admitted.id,
      },
      turnId,
    })
    assert.equal(reused.status, 409, await reused.clone().text())

    const after = await readRunPlan(server.url, sessionId)
    assert.equal(after?.id, admitted.id, 'the refused turn revised nothing')
    assert.equal(after?.selectedWorkflow?.id, admitted.selectedWorkflow?.id)
    assert.equal(
      after?.updatedAt,
      admitted.updatedAt,
      'the plan was not rewritten',
    )
  })
})

/**
 * A Team commits its task record before it appends the user's brief, so a
 * crash between those two writes leaves the task as the only evidence that
 * the turn was admitted.
 *
 * A retry in that window has to reach the replay that hands back the run
 * already started. Refusing it over a result that stopped resolving in the
 * meantime would orphan a Team run the session had begun and the client would
 * never hear about.
 */
test('a Team turn already on record replays even when its context no longer resolves', async () => {
  await withTeamSession(async ({ server, sessionId, workspacePath }) => {
    // A first, ordinary turn, so the session has the run plan a replay reads.
    const opening = await postMessage(server.url, sessionId, 'Review the brief', {
      target: TEAM_TARGET,
      turnId: randomUUID(),
    })
    assert.equal(opening.status, 201, await opening.clone().text())

    const text = 'And now the second brief'
    const contextResultIds = ['team:from-a-run-that-moved']
    const turnId = randomUUID()
    const store = new FileSystemSessionStore(workspacePath)
    const seeded = await store.createTaskRecord(sessionId, {
      workflowId: 'chat-team-test-team',
      teamId: 'test-team',
      targetKind: 'team-chat',
      brief: text,
      sourceTurn: {
        turnId,
        fingerprint: teamTurnFingerprint({
          text,
          teamId: 'test-team',
          contextResultIds,
        }),
      },
    })
    assert.ok(seeded, 'the task is on record')
    const claimed = await listChat(server.url, sessionId)
    assert.ok(
      !claimed.some((message) => message.turnId === turnId),
      'while no transcript line claims its turn',
    )

    const retry = await fetch(`${server.url}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, target: TEAM_TARGET, turnId, contextResultIds }),
    })

    assert.equal(
      retry.status,
      200,
      `the started run is replayed: ${await retry.clone().text()}`,
    )
    const body = (await retry.json()) as DispatchResponse
    assert.equal(body.replayed, true)
    assert.equal(body.task?.id, seeded.id)
  })
})
