/**
 * A cancelled turn is cancelled, through the whole path.
 *
 * The claim being tested is not "the service honours an AbortSignal" — that
 * would only prove the last link. It is that a client hanging up reaches the
 * journal: HTTP disconnect, to the route's request abort, to the turn, to a
 * `cancelled` terminal and no published answer.
 *
 * Deterministic by construction: the request goes to a real provider on
 * loopback that holds its response until the test lets go, so the disconnect
 * lands at a known point — after `started` is durable and while the answer is
 * still outstanding.
 *
 * A real server rather than a replaced `fetch`. Swapping the global proves the
 * turn calls whatever `fetch` is bound to, which is a fact about the process;
 * an actual HTTP request that hangs is the thing a client hanging up has to
 * survive.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { initProviders } from '../../providers/index.js'
import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { startDeterministicOpenAiServer } from '../electron/support/deterministic-openai-server.js'

/**
 * Wait until a durable fact appears on disk.
 *
 * Used for one thing only: the terminal the server writes while unwinding a
 * request whose client has already gone. Nothing signals that — the client is
 * the party that left, and the process doing the work is the one under test —
 * so there is no event or promise to await, and a bounded poll of the durable
 * state is what is left. Everything else here waits on the server that knows.
 *
 * The assertion afterwards is about the state, never about how long it took;
 * the bound exists so a broken build fails instead of hanging.
 */
async function waitFor(
  condition: () => boolean,
  { timeoutMs = 20_000, intervalMs = 25 } = {},
): Promise<void> {
  const startedAt = process.hrtime.bigint()
  const limitNs = BigInt(timeoutMs) * 1_000_000n
  while (process.hrtime.bigint() - startedAt < limitNs) {
    if (condition()) return
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs)
    })
  }
}

initProviders()

const OPENAI_HOST = 'api.openai.com'

function decision(message: string): string {
  return JSON.stringify({
    message,
    selectionAction: 'clear',
    workflowId: null,
    launchIntent: 'none',
    deepResearchPlanAction: 'keep',
    deepResearchMissingInputs: [],
  })
}

function activityEvents(
  workspacePath: string,
  sessionId: string,
  activityId: string,
): string[] {
  const journalPath = path.join(
    workspacePath,
    'sessions',
    sessionId,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    activityId,
    '.runtime',
    'execution-journal',
    'journal.jsonl',
  )
  if (!fs.existsSync(journalPath)) return []
  return fs
    .readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line): string => {
      // Guarded, not asserted. These are bytes off a file, and a cast here
      // would let a malformed journal read as an empty list of events — which
      // is exactly the answer that would make this test pass for nothing.
      const parsed: unknown = JSON.parse(line)
      assert.ok(
        typeof parsed === 'object' && parsed !== null,
        `a journal line is not an object: ${line}`,
      )
      const type = Reflect.get(parsed, 'type')
      assert.equal(typeof type, 'string', `a journal line has no type: ${line}`)
      assert.ok(typeof type === 'string')
      return type
    })
}

test('a client that hangs up mid-turn produces a cancelled terminal', async () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-cancel-route-')),
  )
  const workspacePath = path.join(directory, 'workspace')
  const projectRoot = path.join(directory, 'project')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'agents'), { recursive: true })

  const previousKey = process.env.OPENAI_API_KEY
  const previousBaseUrl = process.env.OPENAI_BASE_URL
  const previousGeneratorUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  process.env.OPENAI_API_KEY = 'cancellation-key'

  // Blocked from the first response: the turn reaches the provider, the
  // provider holds, and the client hangs up while it is still holding.
  const provider = await startDeterministicOpenAiServer({
    script: [{ text: decision('too late') }],
    blockResponsesStartingAt: 1,
  })
  process.env.OPENAI_BASE_URL = provider.baseUrl
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = `${provider.baseUrl}/chat/completions`

  let server: StartedApiServer | undefined
  try {
    server = await startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher: new PiRunLauncher(),
      sessionStore: new FileSystemSessionStore(workspacePath),
      repoRootPath: projectRoot,
      workspacePath,
    })

    const created = await fetch(`${server.url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'route cancellation' }),
    })
    // Guarded, not asserted: this is a response body, and a cast here would be
    // a promise about bytes nobody checked.
    const createdBody: unknown = await created.json()
    assert.ok(
      typeof createdBody === 'object' && createdBody !== null,
      'the session create response is an object',
    )
    const sessionId = Reflect.get(createdBody, 'id')
    assert.equal(typeof sessionId, 'string')
    assert.ok(typeof sessionId === 'string')
    const turnId = randomUUID()

    // A real HTTP request, hung up by the client.
    const abort = new AbortController()
    const request = fetch(`${server.url}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'cancel me',
        provider: 'openai',
        model: 'test-model',
        turnId,
      }),
      signal: abort.signal,
    }).catch(() => undefined)

    // The disconnect must land after `started` is durable rather than racing
    // it, so the test waits for the provider to say the request arrived.
    await provider.waitForRequest()
    abort.abort()
    provider.releaseBlockedResponses()
    await request

    // Waiting for the durable fact, not for a duration. The server unwinds
    // asynchronously after the client is gone, so there is something to wait
    // for; what is asserted is the terminal, never how long it took.
    await waitFor(() =>
      activityEvents(workspacePath, sessionId, turnId).some((type) =>
        type.endsWith('.cancelled'),
      ),
    )
    const events = activityEvents(workspacePath, sessionId, turnId)

    assert.deepEqual(
      events,
      ['conversation.turn.started', 'conversation.turn.cancelled'],
      'a client hanging up must reach the journal as a cancellation',
    )

    const listed: unknown = await fetch(
      `${server.url}/sessions/${sessionId}/messages`,
    ).then((response) => response.json())
    assert.ok(typeof listed === 'object' && listed !== null)
    const messages = Reflect.get(listed, 'messages')
    assert.ok(Array.isArray(messages))
    assert.equal(
      messages.filter(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          Reflect.get(message, 'role') === 'assistant',
      ).length,
      0,
      'and no answer was published',
    )
  } finally {
    await server?.close()
    await provider.close()
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = previousBaseUrl
    if (previousGeneratorUrl === undefined) {
      delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
    } else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousGeneratorUrl
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
