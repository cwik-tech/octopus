import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'
import { z } from 'zod/v4'

import type { ChatMessage } from '../../contracts/sessions.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'
import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { buildChatMessage } from '../../services/session-service.js'
import { createSchedulerFixture, type SchedulerFixture } from '../helpers/scheduler-fixture.js'
import {
  startFakeChatCompletionsServer,
  type FakeChatCompletionsRequest,
  type FakeChatCompletionsServer,
  type FakeChatCompletionsTurn,
} from '../support/fake-chat-completions-server.js'

/**
 * Chat-confirmed workflow launch, end to end.
 *
 * The front door proposes a Workflow in prose; the user confirms in chat; the
 * confirmation must start the workflow. A bare "start" with no proposal behind
 * it must start nothing. The provider is replaced at HTTP (deterministic
 * script); every store, the queue, and the API are real.
 */

const FRONT_DOOR = 'general-agent'

const DETAILED_USER_REQUEST =
  'Write a detailed launch announcement for our beta release next month, aimed at existing customers who run the current version in production.'
const PROPOSAL_TEXT =
  'test-workflow fits: it runs the launch-announcement team. Say the word and I will start it.'

interface LaunchFixture {
  readonly repo: SchedulerFixture
  readonly provider: FakeChatCompletionsServer
  readonly server: StartedApiServer
  readonly store: FileSystemSessionStore
  readonly sessionId: string
  readonly workflowId: string
  readonly launched: { count: number; modelPayloads: string[] }
  readonly choice: { provider: string; model: string }
  readonly project?: { id: string }
}

function sawToolResult(request: FakeChatCompletionsRequest): boolean {
  const messages = request.body.messages
  return (
    Array.isArray(messages) &&
    messages.some(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as { role?: unknown }).role === 'tool',
    )
  )
}

async function createLaunchFixture(
  t: TestContext,
  script: readonly FakeChatCompletionsTurn[],
  options: {
    project?: { name: string; brief: string; files: Record<string, string> }
    storeFactory?: (workspacePath: string) => FileSystemSessionStore
  } = {},
): Promise<LaunchFixture> {
  const repo = createSchedulerFixture('chat-launch-')
  let provider: FakeChatCompletionsServer | undefined
  let server: StartedApiServer | undefined
  t.after(async () => {
    await server?.close()
    await provider?.close()
    repo.cleanup()
  })

  provider = await startFakeChatCompletionsServer({
    models: ['fake/chat'],
    script,
  })
  const settings = new ProviderSettingsService({
    storagePath: path.join(repo.repoRootPath, 'providers.json'),
  })
  const connection = await settings.saveConnection({
    kind: 'lm-studio',
    name: 'Fixture',
    baseUrl: `${provider.url}/v1`,
    enabled: true,
  })
  assert.equal((await settings.validateConnection(connection.id)).status, 'connected')
  await settings.setModelEnabled(connection.id, 'fake/chat', true)
  await settings.setDefaultModel({
    provider: configuredProviderName(connection.id),
    model: 'fake/chat',
  })

  // The front door, pointed at the fake provider. Its persona file existing is
  // what routes untargeted turns to it.
  const agentDir = path.join(repo.repoRootPath, 'agents', FRONT_DOOR)
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, `${FRONT_DOOR}.md`),
    [
      '---',
      `name: ${FRONT_DOOR}`,
      'description: Front door fixture.',
      `provider: ${configuredProviderName(connection.id)}`,
      'model: fake/chat',
      'thinking: low',
      '---',
      '',
      'You are the General Agent fixture.',
      '',
    ].join('\n'),
    'utf8',
  )

  const store = options.storeFactory?.(repo.workspacePath) ?? new FileSystemSessionStore(repo.workspacePath)
  const launched: { count: number; modelPayloads: string[] } = { count: 0, modelPayloads: [] }
  const launcher = {
    async startRun(request: { cwd: string; env?: Record<string, string> }) {
      launched.count += 1
      launched.modelPayloads.push(request.env?.PIPELINE_WORKFLOW_MODEL_SELECTION ?? "")
      return { launched: true as const, pid: 0, cwd: request.cwd }
    },
  }
  server = await startApiServer({
    store: new FileSystemRunStore(repo.workspacePath),
    launcher,
    taskLauncher: launcher,
    sessionStore: store,
    agentTextStreamHub: new AgentTextStreamHub(),
    repoRootPath: repo.repoRootPath,
    workspacePath: repo.workspacePath,
    workflowsRegistryPath: repo.workflowsRegistryPath,
    providerSettingsService: settings,
    mcpSettingsService: new McpSettingsService({
      storagePath: path.join(repo.repoRootPath, 'mcp.json'),
    }),
  })
  // A project-bound session, when the test needs one: the project exists
  // before the session so the session belongs to it from creation.
  let project: { id: string } | undefined
  if (options.project) {
    project = (await (
      await fetch(`${server.url}/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({ name: options.project.name }),
      })
    ).json()) as { id: string }
    await fetch(`${server.url}/projects/${project.id}/brief`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({ content: options.project.brief }),
    })
    for (const [name, content] of Object.entries(options.project.files)) {
      await fetch(`${server.url}/projects/${project.id}/files`, {
        method: 'POST',
        headers: { 'x-filename': name },
        signal: AbortSignal.timeout(5_000),
        body: content,
      })
    }
  }
  const session = project
    ? ((await (
        await fetch(`${server.url}/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(5_000),
          body: JSON.stringify({ title: 'Chat launch', projectId: project.id }),
        })
      ).json()) as { id: string })
    : await store.createSession({ title: 'Chat launch' })
  return {
    repo,
    provider,
    server,
    store,
    sessionId: session.id,
    workflowId: repo.workflowId,
    launched,
    choice: { provider: configuredProviderName(connection.id), model: 'fake/chat' },
    ...(project ? { project } : {}),
  }
}

function postChat(
  fixture: LaunchFixture,
  text: string,
  options: { turnId?: string; projectContext?: Record<string, unknown> } = {},
): Promise<Response> {
  return fetch(`${fixture.server.url}/sessions/${fixture.sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      text,
      ...(options.turnId ? { turnId: options.turnId } : {}),
      ...(options.projectContext ? { projectContext: options.projectContext } : {}),
    }),
  })
}

/**
 * A second, registered workflow whose template requires an MCP capability no
 * configured server grants. The composition's real preflight service must
 * refuse its launch; the chat route is not exempt.
 */
function writeToolNeedingWorkflow(repo: SchedulerFixture): string {
  const workflowId = 'needs-tools-workflow'
  fs.writeFileSync(
    path.join(repo.repoRootPath, 'workflows', 'user-generated', `${workflowId}.yaml`),
    [
      'workflow:',
      `  id: ${workflowId}`,
      '  description: Workflow requiring an unavailable capability.',
      '  mcp_requirements:',
      '    - capability: calendar',
      '      access: write',
      '      necessity: required',
      '  input:',
      '    artifact: incoming-brief.md',
      '  steps:',
      '    - id: run-test-agent',
      '      type: agent',
      '      team: test-team',
      '      agent: test-agent',
      '      stage_type: chain',
      '      input_artifact: incoming-brief.md',
      '      result_artifact: result.md',
      "      requested_result_type: 'artifact:result.md'",
      '  output:',
      '    from_step: run-test-agent',
      '    artifact: result.md',
      '  on_blocked: stop',
      '  on_failed: stop',
      '',
    ].join('\n'),
    'utf8',
  )
  fs.appendFileSync(
    repo.workflowsRegistryPath,
    [
      `${workflowId}:`,
      '  description: Workflow requiring an unavailable capability.',
      `  template_path: ./user-generated/${workflowId}.yaml`,
      '',
    ].join('\n'),
    'utf8',
  )
  return workflowId
}

test('a chat confirmation of a proposed workflow launches it', { timeout: 30_000 }, async (t) => {
  const proposal =
    'test-workflow fits: it runs the launch-announcement team. Say the word and I will start it.'
  const started = 'Started test-workflow.'
  let captured = (_request: FakeChatCompletionsRequest) => {}
  const proposalRequestSeen = new Promise<FakeChatCompletionsRequest>((resolve) => {
    captured = resolve
  })
  const fixture = await createLaunchFixture(t, [
    {
      match: (request) => {
        const hit =
          !request.stream && request.userMessage?.includes('launch announcement') === true
        if (hit) captured(request)
        return hit
      },
      content: proposal,
    },
    {
      match: (request) =>
        request.stream && request.userMessage?.includes('launch announcement') === true,
      content: proposal,
      deltas: [proposal],
    },
    {
      match: (request) =>
        !request.stream &&
        request.userMessage?.includes('go for it') === true &&
        !sawToolResult(request),
      toolCalls: [
        {
          id: 'launch-call-1',
          name: 'start_workflow',
          arguments: { workflowId: 'test-workflow' },
        },
      ],
    },
    {
      match: (request) =>
        !request.stream &&
        request.userMessage?.includes('go for it') === true &&
        sawToolResult(request),
      content: started,
    },
    {
      match: (request) => request.stream && request.userMessage?.includes('go for it') === true,
      content: started,
      deltas: [started],
    },
    // Anything else — session titling, probes — gets a plain answer.
    { content: 'Chat about a launch.' },
  ])

  const proposalResponse = await postChat(
    fixture,
    'Write a detailed launch announcement for our beta release next month, aimed at existing customers who run the current version in production.',
  )
  assert.equal(proposalResponse.status, 201, await proposalResponse.clone().text())
  const proposalBody = (await proposalResponse.json()) as {
    dispatch: { kind: string }
    task?: unknown
  }
  assert.equal(proposalBody.dispatch.kind, 'agents')
  assert.equal(proposalBody.task, undefined, 'a proposal alone launches nothing')
  assert.equal(
    (await fixture.store.listTaskRecords(fixture.sessionId)).length,
    0,
    'a proposal alone creates no task',
  )

  // The front door was offered the launch tool and told when it may use it.
  const proposalRequest = await proposalRequestSeen
  const advertised = (
    zodToolList.parse(proposalRequest.body.tools) ?? []
  ).map((tool) => tool.function.name)
  assert.ok(
    advertised.includes('start_workflow'),
    'the front door must be offered the start_workflow tool',
  )
  assert.ok(
    proposalRequest.systemPrompt?.includes('start_workflow'),
    'the activation rules must reach the front door prompt',
  )

  const confirmationResponse = await postChat(fixture, 'go for it', {
    turnId: '44444444-4444-4444-8444-444444444444',
  })
  assert.equal(confirmationResponse.status, 201, await confirmationResponse.clone().text())
  const confirmation = (await confirmationResponse.json()) as {
    dispatch: { kind: string }
    task?: { id: string; workflowId: string }
    plan?: { selectedWorkflow?: { id: string } }
  }
  assert.equal(confirmation.dispatch.kind, 'agents')
  assert.ok(confirmation.task, 'the confirmation turn must report the launched task')
  assert.equal(confirmation.task.workflowId, 'test-workflow')
  assert.equal(confirmation.plan?.selectedWorkflow?.id, 'test-workflow')

  const tasks = await fixture.store.listTaskRecords(fixture.sessionId)
  assert.equal(tasks.length, 1, 'exactly one task exists for the confirmed workflow')
  assert.equal(tasks[0]?.workflowId, 'test-workflow')
  assert.equal(tasks[0]?.id, confirmation.task.id)

  // An exact retry after a dropped response owes the caller the same answer,
  // including what the turn launched — without running the provider again.
  const requestsBeforeReplay = fixture.provider.requests.length
  const replayResponse = await postChat(fixture, 'go for it', {
    turnId: '44444444-4444-4444-8444-444444444444',
  })
  assert.equal(replayResponse.status, 200, await replayResponse.clone().text())
  const replay = (await replayResponse.json()) as {
    task?: { id: string }
    plan?: { id: string }
  }
  assert.equal(replay.task?.id, confirmation.task.id, 'an exact retry recovers the admitted task')
  assert.equal(replay.plan?.id, tasks[0]?.runPlanId, 'and the plan it launched from')
  assert.equal(
    (await fixture.store.listTaskRecords(fixture.sessionId)).length,
    1,
    'a replay launches nothing new',
  )
  assert.equal(
    fixture.provider.requests.length,
    requestsBeforeReplay,
    'a replay does not call the provider',
  )
})

test('a bare start with no prior proposal launches nothing', { timeout: 30_000 }, async (t) => {
  const answer = 'There is nothing proposed to start yet — tell me what you want to run.'
  const fixture = await createLaunchFixture(t, [
    {
      match: (request) => !request.stream && request.userMessage?.includes('start') === true,
      content: answer,
    },
    {
      match: (request) => request.stream && request.userMessage?.includes('start') === true,
      content: answer,
      deltas: [answer],
    },
    { content: 'Chat about nothing.' },
  ])

  const response = await postChat(fixture, 'start')
  assert.equal(response.status, 201, await response.clone().text())
  const body = (await response.json()) as {
    dispatch: { kind: string }
    task?: unknown
    plan?: unknown
  }
  assert.equal(body.dispatch.kind, 'agents')
  assert.equal(body.task, undefined)
  assert.equal(body.plan, undefined)
  assert.equal((await fixture.store.listTaskRecords(fixture.sessionId)).length, 0)
})

// The smallest schema that reads the advertised tool list; the fixture request
// body is untrusted JSON, so it is parsed rather than cast.
const zodToolList = z
  .array(z.object({ function: z.object({ name: z.string() }) }))
  .optional()
  .catch(undefined)

test('a chat-confirmed launch of a workflow with unavailable tool prerequisites is refused before admission', { timeout: 30_000 }, async (t) => {
  const refusedReply = 'I could not start it: the workflow needs tools that are not available.'
  const fixture = await createLaunchFixture(t, [
    {
      match: (request) => !request.stream && request.userMessage?.includes('calendar report') === true,
      content: 'needs-tools-workflow fits: it assembles the calendar report. Say the word and I will start it.',
    },
    {
      match: (request) => request.stream && request.userMessage?.includes('calendar report') === true,
      content: 'needs-tools-workflow fits: it assembles the calendar report. Say the word and I will start it.',
      deltas: ['needs-tools-workflow fits: it assembles the calendar report. Say the word and I will start it.'],
    },
    {
      match: (request) =>
        !request.stream && request.userMessage?.includes('go for it') === true && !sawToolResult(request),
      toolCalls: [
        {
          id: 'launch-call-tools',
          name: 'start_workflow',
          arguments: { workflowId: 'needs-tools-workflow' },
        },
      ],
    },
    {
      match: (request) =>
        !request.stream && request.userMessage?.includes('go for it') === true && sawToolResult(request),
      content: refusedReply,
    },
    {
      match: (request) => request.stream && request.userMessage?.includes('go for it') === true,
      content: refusedReply,
      deltas: [refusedReply],
    },
    { content: 'Chat about tools.' },
  ])
  const workflowId = writeToolNeedingWorkflow(fixture.repo)

  await postChat(
    fixture,
    'Assemble a detailed calendar report of all team ceremonies for the next quarter, covering every recurring meeting and its audience.',
  )
  const confirmationResponse = await postChat(fixture, 'go for it')
  assert.equal(confirmationResponse.status, 201, await confirmationResponse.clone().text())
  const confirmation = (await confirmationResponse.json()) as { task?: unknown }
  assert.equal(confirmation.task, undefined, 'a workflow whose tools are unavailable must not launch')
  assert.equal(
    (await fixture.store.listTaskRecords(fixture.sessionId)).length,
    0,
    'the preflight refusal happens before admission',
  )
  const plan = await fixture.store.getRunPlan(fixture.sessionId)
  assert.equal(plan?.selectedWorkflow?.id, workflowId)
  assert.equal(plan?.status, 'ready', 'the plan stays ready for a later retry')
  assert.equal(plan?.applyClaimId, undefined, 'no apply claim is taken')
  assert.equal(fixture.launched.count, 0)
})

test('a chat-confirmed launch seals the selected project context into the admitted task', { timeout: 30_000 }, async (t) => {
  const proposal =
    'test-workflow fits: it runs the announcement team. Say the word and I will start it.'
  const started = 'Started test-workflow.'
  const fixture = await createLaunchFixture(
    t,
    [
      {
        match: (request) => !request.stream && request.userMessage?.includes('launch announcement') === true,
        content: proposal,
      },
      {
        match: (request) => request.stream && request.userMessage?.includes('launch announcement') === true,
        content: proposal,
        deltas: [proposal],
      },
      {
        match: (request) =>
          !request.stream && request.userMessage?.includes('go for it') === true && !sawToolResult(request),
        toolCalls: [
          {
            id: 'launch-call-project',
            name: 'start_workflow',
            arguments: { workflowId: 'test-workflow' },
          },
        ],
      },
      {
        match: (request) =>
          !request.stream && request.userMessage?.includes('go for it') === true && sawToolResult(request),
        content: started,
      },
      {
        match: (request) => request.stream && request.userMessage?.includes('go for it') === true,
        content: started,
        deltas: [started],
      },
      { content: 'Chat about a launch.' },
    ],
    {
      project: {
        name: 'Chat launch context',
        brief: 'Stable admission fact: 42.',
        files: { 'facts.md': 'Selected evidence: 84.' },
      },
    },
  )
  const project = fixture.project
  assert.ok(project)
  const projectContext = {
    projectId: project.id,
    includeBrief: true,
    fileNames: ['facts.md'],
  }

  await postChat(
    fixture,
    'Write a detailed launch announcement for our beta release next month, aimed at existing customers who run the current version in production.',
    { projectContext },
  )
  const confirmationResponse = await postChat(fixture, 'go for it', { projectContext })
  assert.equal(confirmationResponse.status, 201, await confirmationResponse.clone().text())
  const confirmation = (await confirmationResponse.json()) as {
    task?: { id: string }
  }
  assert.ok(confirmation.task, 'the confirmation launches')

  const tasks = await fixture.store.listTaskRecords(fixture.sessionId)
  assert.equal(tasks.length, 1)
  const task = tasks[0]
  assert.ok(task)
  assert.match(task.brief, /Stable admission fact: 42\./, 'the admitted task brief carries the selected project brief')
  assert.match(task.brief, /Selected evidence: 84\./, 'the admitted task brief carries the selected project file')
  const plan = await fixture.store.getRunPlan(fixture.sessionId)
  assert.deepEqual(plan?.projectContext, projectContext)
})

/**
 * The crash window between admission and publication: the tool launched, the
 * task is durable with this turn's identity, and then the reply was lost
 * before it reached the transcript. A retry of the same turn id must recover
 * the task — not relaunch, and not answer as if nothing had started.
 */
test('a turn that lost its reply after admission recovers the launched task on retry', { timeout: 30_000 }, async (t) => {
  // Inject one disk-write failure, while all reads, task admission, provider
  // HTTP calls and API dispatch still use their real implementations.
  class CrashOnceStore extends FileSystemSessionStore {
    armed = true
    override async appendChatMessageIfAbsent(id: string, message: ChatMessage) {
      if (this.armed && message.role === 'assistant') {
        throw new Error('disk lost the reply')
      }
      return super.appendChatMessageIfAbsent(id, message)
    }
  }
  const stores: CrashOnceStore[] = []
  const fixture = await createLaunchFixture(t, [
    {
      match: (request) => !request.stream && !sawToolResult(request),
      toolCalls: [{ id: 'crash-launch', name: 'start_workflow', arguments: { workflowId: 'test-workflow' } }],
    },
    { content: 'Started test-workflow.', deltas: ['Started test-workflow.'] },
    { content: 'Started test-workflow.', deltas: ['Started test-workflow.'] },
  ], {
    storeFactory: (workspacePath) => {
      const store = new CrashOnceStore(workspacePath)
      stores.push(store)
      return store
    },
  })
  const store = stores[0]
  assert.ok(store)
  await store.appendChatMessage(fixture.sessionId, buildChatMessage('user', DETAILED_USER_REQUEST))
  await store.appendChatMessage(fixture.sessionId, buildChatMessage('assistant', PROPOSAL_TEXT))
  const turnId = randomUUID()

  const failed = await postChat(fixture, 'go for it', { turnId })

  assert.equal(failed.status, 500, await failed.clone().text())
  const admitted = await store.listTaskRecords(fixture.sessionId)
  assert.equal(admitted.length, 1, 'admission is durable even though the reply was lost')
  assert.equal(admitted[0]?.sourceTurn?.turnId, turnId)
  const requestsBeforeRetry = fixture.provider.requests.length
  store.armed = false

  const response = await postChat(fixture, 'go for it', { turnId })
  const replay = z.object({
    replayed: z.boolean(), incomplete: z.boolean(),
    task: z.object({ id: z.string() }), plan: z.object({ id: z.string() }),
  }).parse(await response.json())

  assert.equal(response.status, 200)
  assert.equal(replay.replayed, true)
  assert.equal(replay.incomplete, true, 'the reply never reached the transcript')
  assert.equal(replay.task.id, admitted[0]?.id)
  assert.equal(replay.plan.id, admitted[0]?.runPlanId)
  assert.equal(fixture.provider.requests.length, requestsBeforeRetry, 'recovery does not call the provider')
  assert.equal((await store.listTaskRecords(fixture.sessionId)).length, 1, 'recovery never launches again')
})

test('a confirmed workflow persists and launches with the chat model instead of the saved worker pair', { timeout: 30_000 }, async (t) => {
  const fixture = await createLaunchFixture(t, [
    { match: (request) => !request.stream && !sawToolResult(request), toolCalls: [{ id: 'model-launch', name: 'start_workflow', arguments: { workflowId: 'test-workflow' } }] },
    { content: 'Started test-workflow.' },
  ])
  // The registered worker is explicitly pinned to OpenAI; the front door uses
  // the selected fixture connection. The task must retain the latter.
  await fixture.store.appendChatMessage(fixture.sessionId, buildChatMessage('user', DETAILED_USER_REQUEST))
  await fixture.store.appendChatMessage(fixture.sessionId, buildChatMessage('assistant', PROPOSAL_TEXT))
  const response = await postChat(fixture, 'go for it')
  assert.equal(response.status, 201, await response.clone().text())
  const body = z.object({ task: z.object({ workerModel: z.object({ provider: z.string(), model: z.string() }).optional() }) }).parse(await response.json())
  assert.deepEqual(body.task.workerModel, fixture.choice)
  const reopened = new FileSystemSessionStore(fixture.repo.workspacePath)
  const tasks = await reopened.listTaskRecords(fixture.sessionId)
  const persisted = z.object({ workerModel: z.object({ provider: z.string(), model: z.string() }).optional() }).parse(tasks[0])
  assert.deepEqual(persisted.workerModel, fixture.choice)
  assert.deepEqual(JSON.parse(Buffer.from(fixture.launched.modelPayloads[0] ?? '', 'base64').toString('utf8')), fixture.choice)
})
