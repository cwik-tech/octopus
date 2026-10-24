import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'
import type { ChatMessage } from '../../contracts/sessions.js'
import { getRuntimeDefaultModelState, setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'

/**
 * Who answers an untargeted turn depends on the Workflow selection at the
 * moment it is sent, and the two responders hash a request differently. That
 * makes the responder part of a turn's identity: recompute it from current
 * state on a retry and an ordinary replay is refused as a reused id.
 *
 * Both transitions live here rather than beside the pure dispatch cases,
 * because neither is reachable from `resolveSessionDispatch` alone — the
 * defect is in the interaction between the dispatch rule and turn identity.
 */

const LM_STUDIO_HOST = 'localhost:1234'

interface DispatchResponse {
  readonly dispatch: { readonly kind: string; readonly agentNames?: string[] }
  readonly user: ChatMessage
  readonly messages: ChatMessage[]
  readonly replayed: boolean
}

function installModelStub(finalText: string): () => void {
  // Replace the external model's HTTP boundary for deterministic, credential-free tests.
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

function installFrontDoor(repoRootPath: string): void {
  const directory = path.join(repoRootPath, 'agents', 'general-agent')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, 'general-agent.md'),
    [
      '---',
      'name: general-agent',
      'description: The Run front door.',
      'tier: orchestration',
      'provider: lm-studio',
      'model: test-model',
      'thinking: low',
      'system: true',
      '---',
      '',
      '# General Agent',
      '',
      'Answer the question.',
      '',
    ].join('\n'),
    'utf8',
  )
}

async function createSession(url: string): Promise<string> {
  const response = await fetch(`${url}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Front door replay' }),
  })
  assert.equal(response.status, 201)
  return ((await response.json()) as { id: string }).id
}

async function postMessage(
  url: string,
  sessionId: string,
  text: string,
  input?: {
    turnId?: string
    target?: { kind: 'workflow'; workflowId: string; expectedPlanId: string | null }
  },
): Promise<Response> {
  return fetch(`${url}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      provider: 'lm-studio',
      model: 'test-model',
      ...(input?.turnId ? { turnId: input.turnId } : {}),
      ...(input?.target ? { target: input.target } : {}),
    }),
  })
}

interface Fixture {
  readonly server: StartedApiServer
  readonly sessionId: string
  readonly repoRootPath: string
  readonly workspacePath: string
}

async function withSession(
  options: { frontDoorInstalled: boolean },
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const schedulerFixture = createSchedulerFixture('front-door-replay-')
  if (options.frontDoorInstalled) installFrontDoor(schedulerFixture.repoRootPath)
  const restoreFetch = installModelStub('Here is the answer.')
  const server = await startApiServer({
    store: new FileSystemRunStore(schedulerFixture.workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 0, cwd: '' }
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
      repoRootPath: schedulerFixture.repoRootPath,
      workspacePath: schedulerFixture.workspacePath,
    })
  } finally {
    await server.close()
    restoreFetch()
    schedulerFixture.cleanup()
  }
}

/** The durable transcript, edited in place to look like an older build wrote it. */
function stripRecordedResponder(workspacePath: string, sessionId: string): void {
  const chatPath = path.join(workspacePath, 'sessions', sessionId, 'chat.jsonl')
  const lines = fs
    .readFileSync(chatPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const message = JSON.parse(line) as {
        role: string
        turnRequest?: { responder?: string }
      }
      if (message.role === 'user' && message.turnRequest) {
        delete message.turnRequest.responder
      }
      return JSON.stringify(message)
    })
  fs.writeFileSync(chatPath, `${lines.join('\n')}\n`, 'utf8')
}

test('an untargeted turn is answered by the General Agent', async () => {
  await withSession({ frontDoorInstalled: true }, async ({ server, sessionId }) => {
    const response = await postMessage(server.url, sessionId, 'What is this app?')

    assert.equal(response.status, 201, await response.clone().text())
    const turn = (await response.json()) as DispatchResponse
    assert.deepEqual(turn.dispatch, {
      kind: 'agents',
      agentNames: ['general-agent'],
    })
    assert.equal(turn.messages[0]?.speaker?.id, 'general-agent')
    assert.equal(
      turn.messages[0]?.speaker?.name,
      'General Agent',
      'the durable id stays kebab-case; only the label a reader sees is prose',
    )
  })
})

test('General Agent messages record the app default until the composer supplies another selection', async () => {
  await withSession({ frontDoorInstalled: true }, async ({ server, sessionId }) => {
    const previousDefault = getRuntimeDefaultModelState()
    try {
      setRuntimeDefaultModelState({ status: 'available', provider: 'lm-studio', model: 'app-default-model' })
      const response = await fetch(`${server.url}/sessions/${sessionId}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Answer with the model shown by default.' }),
      })
      assert.equal(response.status, 201, await response.clone().text())
      const first = await response.json() as DispatchResponse
      assert.deepEqual(first.user.turnRequest?.admittedSelections?.['general-agent'], {
        provider: 'lm-studio', model: 'app-default-model', source: 'app-default',
        reason: 'agent-default', caller: 'agent',
      })

      const changed = await postMessage(server.url, sessionId, 'Use my new composer selection.')
      assert.equal(changed.status, 201, await changed.clone().text())
      const next = await changed.json() as DispatchResponse
      assert.deepEqual(next.user.turnRequest?.admittedSelections?.['general-agent'], {
        provider: 'lm-studio', model: 'test-model', source: 'user',
        reason: 'explicit-user-choice', caller: 'agent',
      })
    } finally {
      setRuntimeDefaultModelState(previousDefault)
    }
  })
})

test('a deployment without the front door persona keeps the Coordinator', async () => {
  await withSession({ frontDoorInstalled: false }, async ({ server, sessionId }) => {
    const response = await postMessage(server.url, sessionId, 'What is this app?')

    assert.equal(response.status, 201, await response.clone().text())
    const turn = (await response.json()) as DispatchResponse
    assert.equal(turn.dispatch.kind, 'coordinator')
  })
})

test('selecting a Workflow does not turn the General Agent turn into a reused id', async () => {
  await withSession({ frontDoorInstalled: true }, async ({ server, sessionId }) => {
    const turnId = randomUUID()
    const text = 'What is this app?'

    const first = await postMessage(server.url, sessionId, text, { turnId })
    assert.equal(first.status, 201, await first.clone().text())
    const firstTurn = (await first.json()) as DispatchResponse
    assert.equal(firstTurn.dispatch.kind, 'agents')

    // The user picks a Workflow. Every later untargeted turn is the
    // Coordinator's — but this one already happened.
    const selection = await postMessage(server.url, sessionId, 'Use this workflow', {
      target: {
        kind: 'workflow',
        workflowId: 'test-workflow',
        expectedPlanId: null,
      },
    })
    assert.equal(selection.status, 201, await selection.clone().text())

    const replay = await postMessage(server.url, sessionId, text, { turnId })
    assert.equal(
      replay.status,
      200,
      `an exact retry is a replay, not a conflict: ${await replay.clone().text()}`,
    )
    const replayTurn = (await replay.json()) as DispatchResponse
    assert.equal(replayTurn.replayed, true)
    assert.deepEqual(
      replayTurn.messages.map((message) => message.id),
      firstTurn.messages.map((message) => message.id),
      'the replay hands back the answer the General Agent already gave',
    )
  })
})

test('a Coordinator turn recorded before the front door existed still replays', async () => {
  await withSession(
    { frontDoorInstalled: false },
    async ({ server, sessionId, repoRootPath, workspacePath }) => {
      const turnId = randomUUID()
      const text = 'What is this app?'

      const first = await postMessage(server.url, sessionId, text, { turnId })
      assert.equal(first.status, 201, await first.clone().text())
      assert.equal(((await first.json()) as DispatchResponse).dispatch.kind, 'coordinator')

      // A record from a build that did not know what a responder was.
      stripRecordedResponder(workspacePath, sessionId)
      // ...and the front door arrives with the next release.
      installFrontDoor(repoRootPath)

      const replay = await postMessage(server.url, sessionId, text, { turnId })
      assert.equal(
        replay.status,
        200,
        `a pre-rollout turn replays through the responder that admitted it: ${await replay.clone().text()}`,
      )
      const replayTurn = (await replay.json()) as DispatchResponse
      assert.equal(replayTurn.replayed, true)
      assert.equal(replayTurn.dispatch.kind, 'coordinator')
    },
  )
})

test('a planning turn is published under the same name as an answering turn', async () => {
  // One identity, two modes. The interface used to show "Run Coordinator" here
  // because the reply carried no speaker at all and the panel filled the gap
  // with a hardcoded label.
  await withSession({ frontDoorInstalled: true }, async ({ server, sessionId }) => {
    const selection = await postMessage(server.url, sessionId, 'Use this workflow', {
      target: {
        kind: 'workflow',
        workflowId: 'test-workflow',
        expectedPlanId: null,
      },
    })
    assert.equal(selection.status, 201, await selection.clone().text())

    const planning = await postMessage(server.url, sessionId, 'Add more detail')
    assert.equal(planning.status, 201, await planning.clone().text())
    const turn = (await planning.json()) as DispatchResponse

    assert.equal(turn.dispatch.kind, 'coordinator')
    assert.equal(turn.messages[0]?.speaker?.id, 'general-agent')
    assert.equal(turn.messages[0]?.speaker?.name, 'General Agent')
  })
})
