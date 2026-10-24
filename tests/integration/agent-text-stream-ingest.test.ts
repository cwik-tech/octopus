/**
 * The run child's way into the display channel.
 *
 * A Team runs two detached process hops away from the hub, so its frames have
 * to cross a process boundary. That means a credential, and a credential means
 * these rules are the point of the feature rather than a detail of it: the
 * token authorizes one channel and nothing else, it is never accepted from a
 * URL, and it never appears in anything the server says back.
 */
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'
import {
  AGENT_TEXT_STREAM_CHANNEL_ENV,
  AGENT_TEXT_STREAM_TOKEN_ENV,
  AgentTextDeltaTokenRegistry,
} from '../../domains/runtime/agent-text-delta-tokens.js'
import { createAgentTextStreamLaunchRuntime } from '../../domains/runtime/agent-text-delta-launch.js'

const INGEST_PATH = '/internal/agent-text-stream'

interface Harness {
  readonly server: StartedApiServer
  readonly hub: AgentTextStreamHub
  readonly tokens: AgentTextDeltaTokenRegistry
  readonly sessionId: string
  /** The same store the server was given, so a test can move a real task. */
  readonly sessionStore: FileSystemSessionStore
  readonly close: () => Promise<void>
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'delta-ingest-')),
  )
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(workspacePath, { recursive: true })
  const hub = new AgentTextStreamHub()
  const tokens = new AgentTextDeltaTokenRegistry()
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new PiRunLauncher(),
    sessionStore,
    workspacePath,
    agentTextStreamHub: hub,
    agentTextStreamDeltaTokens: tokens,
    agentTextStreamWaitMs: 500,
  })
  const created = await fetch(`${server.url}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Team run' }),
  })
  const session = (await created.json()) as { id: string }
  try {
    await run({
      server,
      hub,
      tokens,
      sessionId: session.id,
      sessionStore,
      close: async () => undefined,
    })
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * The ingest endpoint sits outside the token-in-path scheme by design: these
 * servers run without an apiToken, so `url` is the plain base.
 */
function ingestUrl(server: StartedApiServer): string {
  return `${server.url}${INGEST_PATH}`
}

function postFrames(
  server: StartedApiServer,
  token: string | undefined,
  body: unknown,
): Promise<Response> {
  return fetch(ingestUrl(server), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })
}

test('a frame posted with its own run token reaches the channel the token names', async () => {
  await withHarness(async ({ server, hub, tokens, sessionId }) => {
    const channelId = crypto.randomUUID()
    hub.openChannel(channelId, sessionId)
    const token = tokens.issue({ channelId, runId: 'run-1' })

    const response = await postFrames(server, token, {
      channelId,
      frames: [
        {
          type: 'delta',
          replyId: 'dispatch-1',
          channel: 'text',
          text: 'Kestrel',
          producerSequence: 0,
        },
      ],
    })

    assert.equal(response.status, 202)
    const page = hub.read(channelId, 0)
    assert.ok(page)
    assert.deepEqual(
      page.frames.map((frame) => (frame.type === 'delta' ? frame.text : frame.type)),
      ['Kestrel'],
    )
  })
})

test('a token is refused for a channel it does not name, and says nothing about the token', async () => {
  await withHarness(async ({ server, hub, tokens, sessionId }) => {
    const granted = crypto.randomUUID()
    const other = crypto.randomUUID()
    hub.openChannel(granted, sessionId)
    hub.openChannel(other, sessionId)
    const token = tokens.issue({ channelId: granted, runId: 'run-1' })

    const response = await postFrames(server, token, {
      channelId: other,
      frames: [{ type: 'delta', replyId: 'd', channel: 'text', text: 'leak' }],
    })

    assert.equal(response.status, 403)
    const body = await response.text()
    assert.equal(body.includes(token), false, 'the refusal echoed the token')
    // Nothing reached the channel the token did not name.
    assert.deepEqual(hub.read(other, 0)?.frames ?? [], [])
  })
})

test('an unknown token is refused without confirming anything about it', async () => {
  await withHarness(async ({ server, hub, sessionId }) => {
    const channelId = crypto.randomUUID()
    hub.openChannel(channelId, sessionId)
    const invented = crypto.randomBytes(32).toString('base64url')

    const response = await postFrames(server, invented, {
      channelId,
      frames: [{ type: 'delta', replyId: 'd', channel: 'text', text: 'leak' }],
    })

    assert.equal(response.status, 403)
    assert.equal((await response.text()).includes(invented), false)
    assert.deepEqual(hub.read(channelId, 0)?.frames ?? [], [])
  })
})

test('a token stops working once its run is over', async () => {
  await withHarness(async ({ server, hub, tokens, sessionId }) => {
    const channelId = crypto.randomUUID()
    hub.openChannel(channelId, sessionId)
    const token = tokens.issue({ channelId, runId: 'run-1' })
    tokens.revokeByRun('run-1')

    const response = await postFrames(server, token, {
      channelId,
      frames: [{ type: 'delta', replyId: 'd', channel: 'text', text: 'late' }],
    })

    assert.equal(response.status, 403)
    assert.deepEqual(hub.read(channelId, 0)?.frames ?? [], [])
  })
})

test('a real task reaching a terminal state stops its own credential working', async () => {
  // The test above proves the registry honours a revocation. It calls
  // `revokeByRun` itself, so it says nothing about who calls it in production
  // — and "nothing" is the failure worth catching here: if the terminal
  // subscription is never made, every credential a run was given keeps working
  // for the life of the process, and the run is long gone.
  //
  // So nothing here is simulated except the child. The credential is minted by
  // the launch runtime, through the same real hub and real token registry the
  // endpoint authorizes against; the run is a real task record in a real
  // `FileSystemSessionStore`; and it reaches `done` through the store's own
  // compare-and-set, which is what production uses. The only assertion is what
  // the endpoint says before and after.
  await withHarness(async ({ server, hub, tokens, sessionId, sessionStore }) => {
    const runtime = createAgentTextStreamLaunchRuntime({
      hub,
      tokens,
      endpoint: { url: ingestUrl(server) },
      assignmentLifecycle: sessionStore,
    })
    try {
      const task = await sessionStore.createTaskRecord(sessionId, {
        workflowId: 'wf-1',
        brief: 'Exercise terminal revocation.',
        targetKind: 'team-chat',
        teamId: 'line-team',
      })
      assert.ok(task, 'the fixture needs a real task record')

      const plan = runtime.port.grant({
        sessionId,
        runId: task.runId,
        targetKind: 'team-chat',
      })
      assert.ok(plan, 'a Team launch must be granted a channel')
      const channelId = plan.env[AGENT_TEXT_STREAM_CHANNEL_ENV]
      const token = plan.env[AGENT_TEXT_STREAM_TOKEN_ENV]
      assert.ok(channelId)
      assert.ok(token)

      const whileRunning = await postFrames(server, token, {
        channelId,
        frames: [
          {
            type: 'delta',
            replyId: 'dispatch-1',
            channel: 'text',
            text: 'Kestrel',
            producerSequence: 0,
          },
        ],
      })
      assert.equal(
        whileRunning.status,
        202,
        'the credential has to work first, or its later refusal proves nothing',
      )

      await sessionStore.compareAndSetTaskRecord(sessionId, task.id, ['queued'], {
        status: 'running',
      })
      const finished = await sessionStore.compareAndSetTaskRecord(
        sessionId,
        task.id,
        ['running'],
        { status: 'done' },
      )
      assert.ok(finished?.updated, 'the task must actually reach a terminal state')

      const afterTerminal = await postFrames(server, token, {
        channelId,
        frames: [
          {
            type: 'delta',
            replyId: 'dispatch-1',
            channel: 'text',
            text: 'late',
            producerSequence: 1,
          },
        ],
      })
      assert.equal(
        afterTerminal.status,
        403,
        'a run that is over must not still have a working credential',
      )
      assert.equal(
        (await afterTerminal.text()).includes(token),
        false,
        'the refusal echoed the token',
      )
      assert.equal(
        hub.isOpen(channelId),
        false,
        'the run is over, so its channel is closed rather than left serving',
      )
      // A closed channel keeps what it already held, so a subscriber can drain
      // the tail. What must not be there is the frame posted afterwards.
      assert.deepEqual(
        hub
          .read(channelId, 0)
          ?.frames.map((frame) => (frame.type === 'delta' ? frame.text : frame.type)) ??
          [],
        ['Kestrel'],
        'the refused frame must not have joined the ones the run really sent',
      )
    } finally {
      runtime.dispose()
    }
  })
})

test('a token offered in the query string is not accepted as a credential', async () => {
  await withHarness(async ({ server, hub, tokens, sessionId }) => {
    const channelId = crypto.randomUUID()
    hub.openChannel(channelId, sessionId)
    const token = tokens.issue({ channelId, runId: 'run-1' })

    const response = await fetch(
      `${ingestUrl(server)}?token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channelId,
          frames: [
            { type: 'delta', replyId: 'd', channel: 'text', text: 'leak' },
          ],
        }),
      },
    )

    assert.notEqual(response.status, 202)
    assert.deepEqual(hub.read(channelId, 0)?.frames ?? [], [])
  })
})

test('an oversized batch is refused rather than published', async () => {
  await withHarness(async ({ server, hub, tokens, sessionId }) => {
    const channelId = crypto.randomUUID()
    hub.openChannel(channelId, sessionId)
    const token = tokens.issue({ channelId, runId: 'run-1' })

    const response = await postFrames(server, token, {
      channelId,
      frames: [
        {
          type: 'delta',
          replyId: 'd',
          channel: 'text',
          text: 'x'.repeat(2_000_000),
        },
      ],
    })

    assert.equal(response.status, 413)
    assert.deepEqual(hub.read(channelId, 0)?.frames ?? [], [])
  })
})

test('a mis-shaped frame is refused instead of being coerced into the channel', async () => {
  await withHarness(async ({ server, hub, tokens, sessionId }) => {
    const channelId = crypto.randomUUID()
    hub.openChannel(channelId, sessionId)
    const token = tokens.issue({ channelId, runId: 'run-1' })

    const response = await postFrames(server, token, {
      channelId,
      frames: [{ type: 'delta', replyId: 'd', channel: 'text' }],
    })

    assert.equal(response.status, 400)
    assert.deepEqual(hub.read(channelId, 0)?.frames ?? [], [])
  })
})
