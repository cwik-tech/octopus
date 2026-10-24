/**
 * Phase 1 outer acceptance journey: an ordinary Receptionist turn is durable.
 *
 * Selected-agent chat already has this (`agent.turn` on an assignment journal).
 * An ordinary Run Receptionist turn has no assignment, so it reaches the
 * process journal composition and uses none of it: `POST /sessions/:id/messages`
 * calls `runOrchestratorMessageService` with no registry and no request abort
 * (server/routes/sessions.ts:271-293), and the transcript append is a plain
 * `fs.appendFile` with no uniqueness check and no fsync
 * (domains/sessions/session-store.ts:662-679).
 *
 * This journey proves the whole Phase 1 capability through the loopback API:
 * one provider request, a durable `started -> prepared -> completed` lifecycle
 * on a bounded per-turn activity journal, transcript content that survives a
 * process restart, a replay of the same `turnId` that returns the stored answer
 * without calling the provider again, and a journal that contains no prose.
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
import { createRunPlan } from '../../domains/run-orchestrator/orchestrator.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import type { ChatMessage } from '../../contracts/sessions.js'

initProviders()

/**
 * Sentinels. Each is unique enough that finding it anywhere in `journal.jsonl`
 * proves prose crossed the content boundary. The prompt sentinel rides in the
 * user's text; the reply sentinel is the model's prose answer; the system
 * sentinel stands in for the request body the provider was sent.
 */
const PROMPT_SENTINEL = 'zzq-prompt-sentinel-8f31d2'
const REPLY_SENTINEL = 'zzq-reply-sentinel-4a77be'
const API_KEY_SENTINEL = 'zzq-api-key-sentinel-c019fa'

/**
 * The Receptionist resolves its credential through `readApiKey`, which only
 * knows the env-var providers (domains/provider/model-client.ts:31-38). `openai`
 * is therefore the provider that exercises the real HTTP path here; its
 * endpoint is intercepted below and never reached.
 */
const OPENAI_HOST = 'api.openai.com'

/** The receptionist asks for a structured decision; only `message` is prose. */
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

interface Harness {
  readonly workspacePath: string
  readonly projectRoot: string
  readonly directory: string
  /** One entry per provider request the Receptionist actually made. */
  readonly providerRequests: string[]
  /**
   * The lifecycle already durable at the moment of each provider request.
   *
   * This is what makes the ordering guarantee observable from outside: if the
   * provider is reached before `started` is on disk, the entry for that call is
   * empty, and no amount of after-the-fact event ordering would reveal it.
   */
  readonly journalAtProviderCall: string[][]
  /** Holds the provider's response so a second writer can act mid-turn. */
  readonly provider: {
    park(): Promise<void>
    release(): void
  }
  startServer(): Promise<StartedApiServer>
  cleanup(): Promise<void>
}

/**
 * Intercept only the LM Studio endpoint, the way the agent-chat API journey
 * does. The test's own calls to the API server must keep working, so anything
 * else is delegated to the real fetch. The receptionist asks for a structured
 * decision, so the terminal frame carries the decision object as its content.
 */
function makeHarness(prefix: string): Harness {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  const projectRoot = path.join(directory, 'project')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'agents'), { recursive: true })

  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = API_KEY_SENTINEL

  const providerRequests: string[] = []
  const journalAtProviderCall: string[][] = []
  /**
   * A gate the test can hold the provider at.
   *
   * Not a fault injected into the product — the fixture simply takes its time,
   * which is something a provider does. Holding the turn there is what lets a
   * second writer change the run plan underneath it, and the plan compare-and-set
   * is the real place a Phase 1 turn fails after it has recorded that it
   * started.
   */
  let openGate: () => void = () => undefined
  let held: Promise<void> | undefined
  let signalParked: () => void = () => undefined
  const provider = {
    park(): Promise<void> {
      const parked = new Promise<void>((resolve) => {
        signalParked = resolve
      })
      held = new Promise<void>((resolve) => {
        openGate = resolve
      })
      return parked
    },
    release(): void {
      const open = openGate
      held = undefined
      open()
    },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes(OPENAI_HOST)) {
      return originalFetch(input, init)
    }
    providerRequests.push(typeof init?.body === 'string' ? init.body : '')
    journalAtProviderCall.push(durableTurnEventTypes(workspacePath))
    if (held) {
      signalParked()
      await held
    }
    const answer = decision(`${REPLY_SENTINEL} here is my answer`)
    const frames = [
      JSON.stringify({
        model: 'test-model',
        choices: [{ delta: { content: answer }, finish_reason: null }],
      }),
      JSON.stringify({
        model: 'test-model',
        choices: [{ delta: {}, finish_reason: 'stop' }],
      }),
      '[DONE]',
    ]
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`data: ${frame}\n\n`))
        }
        controller.close()
      },
    })
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof globalThis.fetch

  return {
    directory,
    workspacePath,
    projectRoot,
    provider,
    providerRequests,
    journalAtProviderCall,
    startServer: async () =>
      startApiServer({
        store: new FileSystemRunStore(workspacePath),
        launcher: new PiRunLauncher(),
        sessionStore: new FileSystemSessionStore(workspacePath),
        repoRootPath: projectRoot,
        workspacePath,
      }),
    cleanup: async () => {
      globalThis.fetch = originalFetch
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousKey
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }
}

async function createSession(url: string): Promise<string> {
  const response = await fetch(`${url}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Receptionist observability' }),
  })
  assert.equal(response.status, 201, await response.clone().text())
  return (await response.json() as { id: string }).id
}

async function postTurn(
  url: string,
  sessionId: string,
  harness: Harness,
  text: string,
  turnId: string,
): Promise<Response> {
  return fetch(`${url}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      provider: "openai",
      model: 'test-model',
      turnId,
    }),
  })
}

async function listMessages(url: string, sessionId: string): Promise<ChatMessage[]> {
  const response = await fetch(`${url}/sessions/${sessionId}/messages`)
  assert.equal(response.status, 200)
  return (await response.json() as { messages: ChatMessage[] }).messages
}

/**
 * Every conversation turn event durable anywhere in the workspace, right now.
 *
 * Read straight off disk rather than through the registry, because the point is
 * what a crashing process would have left behind, not what a live handle
 * believes.
 */
function durableTurnEventTypes(workspacePath: string): string[] {
  const sessionsRoot = path.join(workspacePath, 'sessions')
  if (!fs.existsSync(sessionsRoot)) return []
  const types: string[] = []
  for (const sessionId of fs.readdirSync(sessionsRoot)) {
    const activitiesRoot = path.join(
      sessionsRoot,
      sessionId,
      '.conversation-activities',
    )
    if (!fs.existsSync(activitiesRoot)) continue
    for (const activityId of fs.readdirSync(activitiesRoot)) {
      const journalPath = path.join(
        activitiesRoot,
        activityId,
        '.runtime',
        'execution-journal',
        'journal.jsonl',
      )
      if (!fs.existsSync(journalPath)) continue
      for (const line of fs.readFileSync(journalPath, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        try {
          types.push((JSON.parse(line) as { type: string }).type)
        } catch {
          // A torn tail is not this helper's problem.
        }
      }
    }
  }
  return types
}

/** Every conversation activity journal below one session, in discovery order. */
function activityJournalFiles(workspacePath: string, sessionId: string): string[] {
  const root = path.join(workspacePath, 'sessions', sessionId, '.conversation-activities')
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root)
    .map((activityId) =>
      path.join(root, activityId, '.runtime', 'execution-journal', 'journal.jsonl'),
    )
    .filter((candidate) => fs.existsSync(candidate))
}

/**
 * Every regular file this activity's journal directory holds.
 *
 * The journal file is not the only durable thing under it: there is a
 * manifest, and whatever sidecars or projections the runtime keeps beside it.
 * A leak into any of them is as permanent as one in the journal, so the proof
 * has to read the directory rather than the one file everyone thinks of.
 */
function activityJournalDirectoryFiles(
  workspacePath: string,
  sessionId: string,
): { readonly directory: string; readonly files: readonly string[] } {
  const root = path.join(workspacePath, 'sessions', sessionId, '.conversation-activities')
  const activityIds = fs.existsSync(root) ? fs.readdirSync(root) : []
  const directories = activityIds
    .map((activityId) => path.join(root, activityId, '.runtime', 'execution-journal'))
    .filter((candidate) => fs.existsSync(candidate))
  assert.equal(directories.length, 1, 'one turn writes exactly one journal directory')
  const directory = directories[0] as string
  const files = fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
  return { directory, files }
}

interface TurnResponse {
  readonly user: ChatMessage
  readonly messages: readonly ChatMessage[]
  readonly replayed?: boolean
}

test('an ordinary Receptionist turn is durable, inspectable, and replay-safe', async () => {
  const harness = makeHarness('conversation-turn-outer-')
  let server: StartedApiServer | undefined
  try {
    server = await harness.startServer()
    const sessionId = await createSession(server.url)
    const turnId = randomUUID()

    const response = await postTurn(
      server.url,
      sessionId,
      harness,
      `Please help me. ${PROMPT_SENTINEL}`,
      turnId,
    )
    assert.equal(response.status, 201, await response.clone().text())
    const turn = await response.json() as TurnResponse
    assert.equal(turn.messages[0]!.text.includes(REPLY_SENTINEL), true)
    assert.equal(
      harness.providerRequests.length,
      1,
      'the turn must reach the provider exactly once',
    )
    // The barrier: nothing may reach the provider until the turn's start is
    // durable, or a crash could leave a provider call no record accounts for.
    assert.deepEqual(
      harness.journalAtProviderCall[0],
      ['conversation.turn.started'],
      'started must already be on disk when the provider is called',
    )

    // The turn is published: exactly one user line and one assistant line, and
    // the assistant line points at the conversation activity that produced it.
    const afterTurn = await listMessages(server.url, sessionId)
    assert.equal(afterTurn.length, 2)
    assert.equal(afterTurn[0]?.role, 'user')
    assert.equal(afterTurn[1]?.role, 'assistant')
    assert.equal(afterTurn[0]?.turnId, turnId, 'the user line carries its turn id')
    assert.equal(afterTurn[1]?.turnId, turnId, 'the assistant line carries its turn id')

    // A bounded per-turn activity journal exists, and it records the full
    // lifecycle in order. One turn is one activity.
    const journals = activityJournalFiles(harness.workspacePath, sessionId)
    assert.equal(journals.length, 1, 'one turn writes exactly one activity journal')
    const journalPath = journals[0] as string
    const raw = fs.readFileSync(journalPath, 'utf8')
    const events = raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { type: string; scopeKind: string })
    assert.deepEqual(
      events.map((event) => event.type),
      [
        'conversation.turn.started',
        'conversation.turn.prepared',
        'conversation.turn.completed',
      ],
      'started must precede the provider call, prepared must precede the assistant append, and the terminal must follow it',
    )
    assert.equal(events[0]?.scopeKind, 'conversation')

    // The journal is evidence, never content — and so is everything beside it.
    const durable = activityJournalDirectoryFiles(harness.workspacePath, sessionId)
    const names = durable.files.map((file) => path.basename(file)).sort()
    assert.ok(
      names.includes('manifest.json') && names.includes('journal.jsonl'),
      `the journal directory is missing what it must hold: ${names.join(', ')}`,
    )
    const durableBytes = durable.files
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('')
    for (const sentinel of [PROMPT_SENTINEL, REPLY_SENTINEL, API_KEY_SENTINEL]) {
      assert.equal(
        durableBytes.includes(sentinel),
        false,
        `${sentinel} was written somewhere under ${durable.directory}; the ` +
          `directory holds ${names.join(', ')}`,
      )
    }

    // Restart the process. Content is reloadable and the lifecycle survives.
    await server.close()
    server = await harness.startServer()

    const afterRestart = await listMessages(server.url, sessionId)
    assert.deepEqual(
      afterRestart.map((message) => message.id),
      afterTurn.map((message) => message.id),
      'the transcript is unchanged by a restart',
    )

    // Operator inspection reports the turn without returning any content.
    const report = await fetch(
      `${server.url}/execution-journals/conversation/run-session/${sessionId}`,
    )
    assert.equal(report.status, 200, await report.clone().text())
    assert.equal(report.headers.get('cache-control'), 'no-store')
    const reportText = await report.text()
    for (const sentinel of [PROMPT_SENTINEL, REPLY_SENTINEL, API_KEY_SENTINEL]) {
      assert.equal(
        reportText.includes(sentinel),
        false,
        `inspection must not return ${sentinel}`,
      )
    }
    const body = JSON.parse(reportText) as {
      turns: { turnId: string; state: string; assistantMessageIds: string[] }[]
    }
    const summary = body.turns.find((candidate) => candidate.turnId === turnId)
    assert.ok(summary, 'the report names the turn')
    assert.equal(summary.state, 'completed')
    assert.deepEqual(summary.assistantMessageIds, [afterTurn[1]?.id])

    // Replaying the same turn id with the same request returns the stored
    // result. No second provider call, no duplicate transcript line.
    const replay = await postTurn(
      server.url,
      sessionId,
      harness,
      `Please help me. ${PROMPT_SENTINEL}`,
      turnId,
    )
    assert.equal(
      replay.status,
      200,
      'an exact replay is a 200 on every dispatch branch',
    )
    const replayed = await replay.json() as TurnResponse
    assert.equal(replayed.replayed, true, 'a replay is observable in the body')
    assert.equal(replayed.messages[0]!.id, afterTurn[1]?.id)
    assert.equal(
      harness.providerRequests.length,
      1,
      'a replay must not call the provider again',
    )
    assert.deepEqual(
      (await listMessages(server.url, sessionId)).map((message) => message.id),
      afterTurn.map((message) => message.id),
      'a replay must not duplicate transcript content',
    )
  } finally {
    await server?.close()
    await harness.cleanup()
  }
})

test('reusing a turn id with a different request fails closed', async () => {
  const harness = makeHarness('conversation-turn-fingerprint-')
  let server: StartedApiServer | undefined
  try {
    server = await harness.startServer()
    const sessionId = await createSession(server.url)
    const turnId = randomUUID()

    const first = await postTurn(server.url, sessionId, harness, 'first question', turnId)
    assert.equal(first.status, 201, await first.clone().text())
    const requestsAfterFirst = harness.providerRequests.length

    const conflicting = await postTurn(
      server.url,
      sessionId,
      harness,
      'a completely different question',
      turnId,
    )
    assert.equal(conflicting.status, 409, 'a reused turn id with new content is a conflict')
    assert.equal(
      harness.providerRequests.length,
      requestsAfterFirst,
      'a conflict must not reach the provider',
    )
    assert.equal(
      (await listMessages(server.url, sessionId)).length,
      2,
      'a conflict must not write a second user message',
    )
  } finally {
    await server?.close()
    await harness.cleanup()
  }
})

/**
 * Truncate one turn's journal to the first `keep` events, simulating a process
 * that died partway through the lifecycle.
 */
function truncateActivityJournal(
  workspacePath: string,
  sessionId: string,
  activityId: string,
  keep: number,
): void {
  const journalPath = path.join(
    workspacePath,
    'sessions',
    sessionId,
    '.conversation-activities',
    activityId,
    '.runtime',
    'execution-journal',
    'journal.jsonl',
  )
  const lines = fs
    .readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
  const kept = lines.slice(0, keep)
  // An empty journal is an empty file. Writing a lone newline instead leaves a
  // blank record, which reads as corruption rather than as "nothing happened".
  fs.writeFileSync(journalPath, kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf8')
}

function removeTranscriptLine(
  workspacePath: string,
  sessionId: string,
  predicate: (message: ChatMessage) => boolean,
): void {
  const chatPath = path.join(workspacePath, 'sessions', sessionId, 'chat.jsonl')
  const kept = fs
    .readFileSync(chatPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((line) => !predicate(JSON.parse(line) as ChatMessage))
  fs.writeFileSync(chatPath, kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf8')
}

test('a turn that started and never replied is left unresolved, not retried', async () => {
  const harness = makeHarness('conversation-turn-started-only-')
  let server: StartedApiServer | undefined
  try {
    server = await harness.startServer()
    const sessionId = await createSession(server.url)
    const turnId = randomUUID()

    const first = await postTurn(server.url, sessionId, harness, 'hello there', turnId)
    assert.equal(first.status, 201, await first.clone().text())

    // Crash after the provider was asked but before anything was published:
    // the start is durable, the reply is not.
    await server.close()
    truncateActivityJournal(harness.workspacePath, sessionId, turnId, 1)
    removeTranscriptLine(
      harness.workspacePath,
      sessionId,
      (message) => message.role === 'assistant',
    )
    server = await harness.startServer()

    const requestsBefore = harness.providerRequests.length
    const retry = await postTurn(server.url, sessionId, harness, 'hello there', turnId)
    assert.equal(
      retry.status,
      409,
      'an ambiguous provider outcome is refused, not guessed',
    )
    assert.equal(
      (await retry.json() as { error?: string }).error,
      'provider_outcome_unknown',
    )
    assert.equal(
      harness.providerRequests.length,
      requestsBefore,
      'a started-only turn must never be automatically retried',
    )
  } finally {
    await server?.close()
    await harness.cleanup()
  }
})

test('a durable reply with no terminal is reconciled without calling the provider', async () => {
  const harness = makeHarness('conversation-turn-no-terminal-')
  let server: StartedApiServer | undefined
  try {
    server = await harness.startServer()
    const sessionId = await createSession(server.url)
    const turnId = randomUUID()

    const first = await postTurn(server.url, sessionId, harness, 'reconcile me', turnId)
    assert.equal(first.status, 201, await first.clone().text())
    const original = await first.json() as TurnResponse

    // Crash between publishing the reply and recording the terminal.
    await server.close()
    truncateActivityJournal(harness.workspacePath, sessionId, turnId, 2)
    server = await harness.startServer()

    const requestsBefore = harness.providerRequests.length
    const retry = await postTurn(server.url, sessionId, harness, 'reconcile me', turnId)
    assert.equal(retry.status, 200, await retry.clone().text())
    const replayed = await retry.json() as TurnResponse
    assert.equal(replayed.replayed, true)
    assert.equal(replayed.messages[0]!.id, original.messages[0]!.id)
    assert.equal(
      harness.providerRequests.length,
      requestsBefore,
      'the durable transcript already proves publication',
    )

    // The window is closed rather than merely tolerated.
    const report = await fetch(
      `${server.url}/execution-journals/conversation/run-session/${sessionId}`,
    )
    const body = await report.json() as { turns: { turnId: string; state: string }[] }
    assert.equal(
      body.turns.find((turn) => turn.turnId === turnId)?.state,
      'completed',
      'reconciliation rebuilds the terminal from what is already durable',
    )
  } finally {
    await server?.close()
    await harness.cleanup()
  }
})

test('simultaneous duplicate requests cannot both begin', async () => {
  const harness = makeHarness('conversation-turn-concurrent-')
  let server: StartedApiServer | undefined
  try {
    server = await harness.startServer()
    const sessionId = await createSession(server.url)
    const turnId = randomUUID()

    const [first, second] = await Promise.all([
      postTurn(server.url, sessionId, harness, 'race me', turnId),
      postTurn(server.url, sessionId, harness, 'race me', turnId),
    ])

    const statuses = [first.status, second.status].sort()
    assert.equal(
      statuses.filter((status) => status === 201).length >= 1,
      true,
      'at least one request must succeed',
    )
    assert.equal(
      harness.providerRequests.length,
      1,
      'one turn identity means one provider call',
    )

    const messages = await listMessages(server.url, sessionId)
    assert.equal(
      messages.filter((message) => message.role === 'user').length,
      1,
      'a duplicate must not write a second user message',
    )
    assert.equal(
      messages.filter((message) => message.role === 'assistant').length,
      1,
    )
  } finally {
    await server?.close()
    await harness.cleanup()
  }
})

test('a failure before the provider is reached is recorded, not left unresolved', async () => {
  const harness = makeHarness('conversation-turn-pre-provider-')
  let server: StartedApiServer | undefined
  try {
    server = await harness.startServer()
    const sessionId = await createSession(server.url)
    const turnId = randomUUID()

    // Delete the session's directory out from under the turn. The user message
    // append then reports an unknown session, which happens well before
    // anything is sent to a provider.
    const first = await postTurn(server.url, sessionId, harness, 'first', randomUUID())
    assert.equal(first.status, 201, await first.clone().text())
    const requestsBefore = harness.providerRequests.length

    fs.rmSync(path.join(harness.workspacePath, 'sessions', sessionId), {
      recursive: true,
      force: true,
    })

    const failed = await postTurn(server.url, sessionId, harness, 'second', turnId)
    assert.notEqual(failed.status, 201, 'a turn that cannot publish must not report success')
    assert.equal(
      harness.providerRequests.length,
      requestsBefore,
      'nothing was sent, so the outcome is knowable',
    )
  } finally {
    await server?.close()
    await harness.cleanup()
  }
})

test('a user message written before the start barrier resumes and invokes once', async () => {
  const harness = makeHarness('conversation-turn-resume-')
  let server: StartedApiServer | undefined
  try {
    server = await harness.startServer()
    const sessionId = await createSession(server.url)
    const turnId = randomUUID()

    const first = await postTurn(server.url, sessionId, harness, 'resume me', turnId)
    assert.equal(first.status, 201, await first.clone().text())

    // The window the plan says must recover: the user's message is durable,
    // nothing else is. Crash there.
    await server.close()
    truncateActivityJournal(harness.workspacePath, sessionId, turnId, 0)
    removeTranscriptLine(
      harness.workspacePath,
      sessionId,
      (message) => message.role === 'assistant',
    )
    server = await harness.startServer()

    const requestsBefore = harness.providerRequests.length
    const retry = await postTurn(server.url, sessionId, harness, 'resume me', turnId)
    assert.equal(
      retry.status,
      201,
      `the turn must resume, not collide with itself: ${await retry.clone().text()}`,
    )
    assert.equal(
      harness.providerRequests.length,
      requestsBefore + 1,
      'invoke once — the provider had not run, so it runs now',
    )

    const messages = await listMessages(server.url, sessionId)
    assert.equal(
      messages.filter((message) => message.role === 'user').length,
      1,
      'the stored user message is adopted, not duplicated',
    )
    assert.equal(
      messages.filter((message) => message.role === 'assistant').length,
      1,
    )
  } finally {
    await server?.close()
    await harness.cleanup()
  }
})

test('a reply computed but never persisted reports that, not an unknown provider', async () => {
  const harness = makeHarness('conversation-turn-reply-lost-')
  let server: StartedApiServer | undefined
  try {
    server = await harness.startServer()
    const sessionId = await createSession(server.url)
    const turnId = randomUUID()

    const first = await postTurn(server.url, sessionId, harness, 'lose my reply', turnId)
    assert.equal(first.status, 201, await first.clone().text())

    // Prepared is durable, the assistant line is not: the response was computed
    // and its text is gone. That is a different fact from "the provider may not
    // have run", and an operator has to be told which one happened.
    await server.close()
    truncateActivityJournal(harness.workspacePath, sessionId, turnId, 2)
    removeTranscriptLine(
      harness.workspacePath,
      sessionId,
      (message) => message.role === 'assistant',
    )
    server = await harness.startServer()

    const retry = await postTurn(server.url, sessionId, harness, 'lose my reply', turnId)
    assert.equal(retry.status, 409)
    assert.equal(
      (await retry.json() as { error?: string }).error,
      'reply_not_persisted',
    )
  } finally {
    await server?.close()
    await harness.cleanup()
  }
})

/** One activity's events, in order, with their payloads. */
function readActivityEvents(
  journalPath: string,
): { type: string; payload: Record<string, unknown> }[] {
  return fs
    .readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const event: unknown = JSON.parse(line)
      const record =
        typeof event === 'object' && event !== null && !Array.isArray(event)
          ? (event as { type?: unknown; payload?: unknown })
          : {}
      const payload = record.payload
      return {
        type: typeof record.type === 'string' ? record.type : '',
        payload:
          typeof payload === 'object' && payload !== null && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : {},
      }
    })
}

test('a turn posted without a turn id is still observable', async () => {
  const harness = makeHarness('conversation-turn-server-minted-')
  let server: StartedApiServer | undefined
  try {
    server = await harness.startServer()
    const sessionId = await createSession(server.url)

    // An existing caller that predates turn identities. Journaling must not
    // depend on the client having been updated: "ordinary Receptionist turns
    // are observable" is false if it only holds for callers that opt in.
    const response = await fetch(`${server.url}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: `No turn id here. ${PROMPT_SENTINEL}`,
        provider: 'openai',
        model: 'test-model',
      }),
    })
    assert.equal(response.status, 201, await response.clone().text())
    assert.equal(harness.providerRequests.length, 1)

    const messages = await listMessages(server.url, sessionId)
    assert.equal(messages.length, 2)
    const user = messages[0]
    const assistant = messages[1]

    // A stable identity minted at the server boundary, carried by both lines.
    assert.ok(user?.turnId, 'the server minted a turn identity')
    assert.equal(assistant?.turnId, user?.turnId)
    assert.equal(user?.schemaVersion, 2, 'and wrote v2 transcript lines')
    assert.equal(assistant?.schemaVersion, 2)
    assert.equal(assistant?.conversation?.turnId, user?.turnId)

    // The same lifecycle any other turn gets.
    const journals = activityJournalFiles(harness.workspacePath, sessionId)
    assert.equal(journals.length, 1)
    const events = readActivityEvents(journals[0] as string)
    assert.deepEqual(
      events.map((event) => event.type),
      [
        'conversation.turn.started',
        'conversation.turn.prepared',
        'conversation.turn.completed',
      ],
    )
    // Who minted the identity is part of what a turn records. An operator
    // reading this journal has to be able to tell a turn the caller named from
    // one this server named on its behalf — the replay semantics differ, and a
    // record that says `client` for both cannot distinguish them.
    assert.equal(
      events[0]?.payload.origin,
      'server',
      'a turn the server named records that it named it',
    )
  } finally {
    await server?.close()
    await harness.cleanup()
  }
})

test('a turn the caller named records that the caller named it', async () => {
  const harness = makeHarness('conversation-turn-client-minted-')
  let server: StartedApiServer | undefined
  try {
    server = await harness.startServer()
    const sessionId = await createSession(server.url)
    const turnId = randomUUID()

    const response = await postTurn(
      server.url,
      sessionId,
      harness,
      `Named by the caller. ${PROMPT_SENTINEL}`,
      turnId,
    )
    assert.equal(response.status, 201, await response.clone().text())

    const journals = activityJournalFiles(harness.workspacePath, sessionId)
    assert.equal(journals.length, 1)
    const events = readActivityEvents(journals[0] as string)
    assert.equal(events[0]?.type, 'conversation.turn.started')
    assert.equal(events[0]?.payload.origin, 'client')
  } finally {
    await server?.close()
    await harness.cleanup()
  }
})


test('a turn that fails after starting records a terminal, and its replay refuses', async () => {
  const harness = makeHarness('conversation-turn-failed-')
  let server: StartedApiServer | undefined
  try {
    server = await harness.startServer()
    const sessionId = await createSession(server.url)
    const turnId = randomUUID()

    // One ordinary turn first, so the session has a run plan the next turn will
    // revise from.
    const opening = await postTurn(
      server.url,
      sessionId,
      harness,
      'establish a plan',
      randomUUID(),
    )
    assert.equal(opening.status, 201, await opening.clone().text())
    const runPlanPath = path.join(
      harness.workspacePath,
      'sessions',
      sessionId,
      'run-plan.json',
    )
    assert.equal(fs.existsSync(runPlanPath), true)

    // Hold the next turn at the provider and take the plan away underneath it
    // through the real filesystem. When it comes back, the plan it revised from
    // is gone, the compare-and-set has nothing to compare against, and it
    // refuses — which is the failure Phase 1 actually has after the start
    // barrier.
    const parked = harness.provider.park()
    const failing = postTurn(server.url, sessionId, harness, 'fail me', turnId)
    await parked
    fs.rmSync(runPlanPath)
    harness.provider.release()

    const response = await failing
    assert.notEqual(response.status, 201, 'a turn that published nothing is not a success')
    const requestsAfterFailure = harness.providerRequests.length
    assert.equal(
      requestsAfterFailure,
      2,
      'the turn did reach the provider — everything before that point is a ' +
        'read that swallows its own errors, so there is no honest zero here',
    )

    // Started, then finished, in that order. A lifecycle that stops at
    // `started` is indistinguishable from a crash, and an operator cannot tell
    // a turn that failed from one that is still running.
    const journals = activityJournalFiles(harness.workspacePath, sessionId).filter(
      (journalPath) => journalPath.includes(turnId),
    )
    assert.equal(journals.length, 1)
    const events = readActivityEvents(journals[0] as string)
    assert.deepEqual(
      events.map((event) => event.type),
      ['conversation.turn.started', 'conversation.turn.failed'],
      'the turn recorded how it ended, not just that it began',
    )
    assert.equal(
      (events[1]?.payload.failure as { code?: unknown } | undefined)?.code,
      'plan_conflict',
      'and recorded which failure it was',
    )

    // The replay reports the durable outcome rather than trying again: a turn
    // that failed is an answer, and re-running it would be a second turn
    // wearing the first one's identity.
    const replay = await postTurn(server.url, sessionId, harness, 'fail me', turnId)
    assert.equal(replay.status, 409)
    assert.equal(
      (await replay.clone().json() as { error?: string }).error,
      'turn_failed',
    )
    assert.equal(
      harness.providerRequests.length,
      requestsAfterFailure,
      'and the replay sent nothing, so no second attempt was made',
    )
  } finally {
    await server?.close()
    await harness.cleanup()
  }
})
