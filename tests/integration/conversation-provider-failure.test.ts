/**
 * A turn whose provider throws is a turn that ended, and the journal has to say
 * so.
 *
 * `started` is written before the provider is reached, and that is the whole
 * point of the barrier: a crash between the two leaves a record that an
 * operator reads as "the provider may have run, nobody knows". But an exception
 * the server *caught* is not that. The process is alive, it saw the failure,
 * and it knows no reply was ever prepared. Leaving `started` standing there
 * turns a known failure into a permanent ambiguity, and the caller's retry is
 * refused with `provider_outcome_unknown` — a diagnosis of a window that never
 * happened.
 *
 * The other half is the boundary. Once preparation is durable the turn has
 * named a reply, and a failure after that must *not* be given a terminal: the
 * crash-window diagnosis for a reply that was computed and lost is
 * `reply_not_persisted`, and a `failed` written over it would replace a precise
 * fact with a vague one.
 *
 * The provider fault is injected at the network boundary, where the product
 * already decides what to do with it: `callOpenAICompatible` rethrows an
 * abort-named transport error and converts everything else into a fallback
 * result, so an abort-named rejection is the transport failure that actually
 * reaches the turn as an exception. The client is still connected throughout —
 * a cancelled turn is a different outcome, recorded elsewhere.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import type { ChatMessage } from '../../contracts/sessions.js'
import { initProviders } from '../../providers/index.js'
import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

initProviders()

const CASE_TIMEOUT_MS = 20_000
const OPENAI_HOST = 'api.openai.com'

/**
 * A string that could only have come from the failure itself.
 *
 * The turn's failure identity is an allowlisted code; the transport's own words
 * are not part of it. Finding this anywhere under the activity would mean a
 * provider message reached a record that is kept forever.
 */
const FAILURE_SENTINEL = 'zzq-provider-failure-sentinel-6b41ce'

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

/** The transport error the product is written to rethrow rather than absorb. */
function abortNamedTransportFailure(): Error {
  const error = new Error(`the connection went away: ${FAILURE_SENTINEL}`)
  error.name = 'AbortError'
  return error
}

function activityDirectory(
  workspacePath: string,
  sessionId: string,
  activityId: string,
): string {
  return path.join(
    workspacePath,
    'sessions',
    sessionId,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    activityId,
  )
}

/** One activity's events, in order, with their payloads. */
function activityEvents(
  workspacePath: string,
  sessionId: string,
  activityId: string,
): { type: string; payload: Record<string, unknown> }[] {
  const journalPath = path.join(
    activityDirectory(workspacePath, sessionId, activityId),
    '.runtime',
    'execution-journal',
    'journal.jsonl',
  )
  if (!fs.existsSync(journalPath)) return []
  return fs
    .readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      // Guarded rather than asserted: these are bytes off a file, and a cast
      // would let a malformed journal read as an empty list of events, which is
      // exactly the answer that makes this test pass for nothing.
      const parsed: unknown = JSON.parse(line)
      assert.ok(
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
        `a journal line is not an object: ${line}`,
      )
      const type = Reflect.get(parsed, 'type')
      assert.equal(typeof type, 'string', `a journal line has no type: ${line}`)
      assert.ok(typeof type === 'string')
      const payload: unknown = Reflect.get(parsed, 'payload')
      return {
        type,
        payload:
          typeof payload === 'object' && payload !== null && !Array.isArray(payload)
            ? { ...payload }
            : {},
      }
    })
}

/** Every regular file under the activity, so a leak into a sidecar counts. */
function activityFileBytes(
  workspacePath: string,
  sessionId: string,
  activityId: string,
): string {
  const root = activityDirectory(workspacePath, sessionId, activityId)
  const contents: string[] = []
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(entryPath)
      else if (entry.isFile()) contents.push(fs.readFileSync(entryPath, 'utf8'))
    }
  }
  walk(root)
  return contents.join('\n')
}

interface Harness {
  readonly workspacePath: string
  readonly projectRoot: string
  readonly directory: string
  readonly providerRequests: number[]
  startServer(sessionStore?: FileSystemSessionStore): Promise<StartedApiServer>
  cleanup(): void
}

/**
 * A workspace, a project, and a replaced provider transport.
 *
 * Only the provider host is intercepted; the test's own calls to the loopback
 * API server go to the real `fetch`, so the journey stays a real HTTP journey.
 */
function makeHarness(
  prefix: string,
  respond: (requestNumber: number) => Promise<Response>,
): Harness {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  const projectRoot = path.join(directory, 'project')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'agents'), { recursive: true })

  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'provider-failure-key'

  const providerRequests: number[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes(OPENAI_HOST)) return originalFetch(input, init)
    providerRequests.push(providerRequests.length + 1)
    return respond(providerRequests.length)
  }) as typeof globalThis.fetch

  return {
    directory,
    workspacePath,
    projectRoot,
    providerRequests,
    startServer: async (sessionStore?: FileSystemSessionStore) =>
      startApiServer({
        store: new FileSystemRunStore(workspacePath),
        launcher: new PiRunLauncher(),
        sessionStore: sessionStore ?? new FileSystemSessionStore(workspacePath),
        repoRootPath: projectRoot,
        workspacePath,
      }),
    cleanup: () => {
      globalThis.fetch = originalFetch
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousKey
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }
}

/** A streamed structured decision, the way the receptionist asks for one. */
function answeringResponse(message: string): Response {
  const frames = [
    JSON.stringify({
      model: 'test-model',
      choices: [{ delta: { content: decision(message) }, finish_reason: null }],
    }),
    JSON.stringify({
      model: 'test-model',
      choices: [{ delta: {}, finish_reason: 'stop' }],
    }),
    '[DONE]',
  ]
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

async function createSession(url: string, title: string): Promise<string> {
  const response = await fetch(`${url}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  assert.equal(response.status, 201, await response.clone().text())
  return (await response.json() as { id: string }).id
}

function postTurn(
  url: string,
  sessionId: string,
  text: string,
  turnId: string,
): Promise<Response> {
  return fetch(`${url}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, provider: 'openai', model: 'test-model', turnId }),
  })
}

async function listMessages(url: string, sessionId: string): Promise<ChatMessage[]> {
  const response = await fetch(`${url}/sessions/${sessionId}/messages`)
  const body = await response.json() as { messages?: ChatMessage[] }
  return body.messages ?? []
}

test(
  'a provider failure the server caught is recorded as failed, not left unresolved',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const harness = makeHarness('conversation-provider-throw-', async () => {
      throw abortNamedTransportFailure()
    })
    let server: StartedApiServer | undefined
    try {
      server = await harness.startServer()
      const sessionId = await createSession(server.url, 'provider failure')
      const turnId = randomUUID()

      const response = await postTurn(server.url, sessionId, 'answer me', turnId)
      assert.equal(response.ok, false, 'the caller is told the turn did not work')
      assert.equal(harness.providerRequests.length, 1, 'the provider was reached once')

      const events = activityEvents(harness.workspacePath, sessionId, turnId)
      assert.deepEqual(
        events.map((event) => event.type),
        ['conversation.turn.started', 'conversation.turn.failed'],
        'a caught provider failure ends the turn instead of leaving it started',
      )
      assert.deepEqual(
        events[1]?.payload['failure'],
        { code: 'provider_failed', phase: 'provider' },
        'the failure is named by an allowlisted identity',
      )
      assert.equal(
        activityFileBytes(harness.workspacePath, sessionId, turnId).includes(
          FAILURE_SENTINEL,
        ),
        false,
        'the transport’s own words never reach a record kept forever',
      )

      const messages = await listMessages(server.url, sessionId)
      assert.deepEqual(
        messages.map((message) => message.role),
        ['user'],
        'the question is durable and no answer was invented',
      )
    } finally {
      await server?.close()
      harness.cleanup()
    }
  },
)

test(
  'a reply that could not be published stays prepared, so a retry says the reply was lost',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // The boundary on the rule above. Preparation named a reply, so the turn is
    // past the window a `failed` terminal describes; recording one here would
    // overwrite `reply_not_persisted` — the precise diagnosis — with a vague one.
    const harness = makeHarness('conversation-publish-fault-', async () =>
      answeringResponse('this answer never lands'),
    )
    let server: StartedApiServer | undefined
    try {
      /** The real store, with the assistant line refused by the disk. */
      class FailsToPublishStore extends FileSystemSessionStore {
        override async appendChatMessageIfAbsent(
          id: string,
          message: ChatMessage,
        ): Promise<
          'appended' | 'already-present' | 'conflict' | 'unknown-session' | 'invalid-message'
        > {
          if (message.role === 'assistant') {
            throw Object.assign(new Error('EIO: the transcript could not be written'), {
              code: 'EIO',
            })
          }
          return super.appendChatMessageIfAbsent(id, message)
        }
      }

      server = await harness.startServer(new FailsToPublishStore(harness.workspacePath))
      const sessionId = await createSession(server.url, 'publication fault')
      const turnId = randomUUID()

      const response = await postTurn(server.url, sessionId, 'lose my reply', turnId)
      assert.equal(response.ok, false)

      assert.deepEqual(
        activityEvents(harness.workspacePath, sessionId, turnId).map(
          (event) => event.type,
        ),
        ['conversation.turn.started', 'conversation.turn.prepared'],
        'a turn that named a reply keeps its unresolved preparation',
      )

      // And the crash-window diagnosis is still the precise one.
      await server.close()
      server = await harness.startServer()
      const retry = await postTurn(server.url, sessionId, 'lose my reply', turnId)
      assert.equal(retry.status, 409)
      assert.equal(
        (await retry.json() as { error?: string }).error,
        'reply_not_persisted',
      )
    } finally {
      await server?.close()
      harness.cleanup()
    }
  },
)
