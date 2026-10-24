/**
 * One turn id, one answer, whatever arrives while it is running.
 *
 * A client that retries — a double-click, a flaky link, a reconnecting socket —
 * sends the same turn id again. The window that matters is narrow and it is the
 * one that actually happens: both requests read the transcript before either
 * wrote to it, so both concluded they were starting a new turn. Two provider
 * calls and two answers published under one identity is exactly what
 * idempotency exists to prevent, and the caller cannot tell which answer it
 * got.
 *
 * The refusal has to say the right thing too. `turn_id_reused` means the caller
 * sent a *different* request under a used id, which is a caller bug; a
 * duplicate of the same request is not that, and telling a retrying client it
 * made a mistake is how a real duplicate gets debugged as one.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { ChatMessage } from '../../contracts/sessions.js'
import { initProviders } from '../../providers/index.js'
import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startDeterministicOpenAiServer } from '../electron/support/deterministic-openai-server.js'

initProviders()

const CASE_TIMEOUT_MS = 20_000

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

/** A response body, narrowed rather than asserted. */
function record(value: unknown): Record<string, unknown> {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    `expected an object, saw ${JSON.stringify(value)}`,
  )
  return { ...value }
}

/**
 * A latch that something else opens.
 *
 * Every wait in this test is on a fact somebody announces, never on a
 * duration: the schedule below is the whole point, and a sleep would make it a
 * guess.
 */
function latch() {
  let open: () => void = () => undefined
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open: () => open() }
}

/**
 * The real store, with two transcript appends put in a chosen order.
 *
 * Nothing is replaced: every append is the real one, against the real file,
 * under the real lock. What changes is only *when* two of them run, and that
 * is the whole of the race — one request having read the transcript and not
 * yet written to it while another writes. The window is microseconds wide and
 * cannot be reached by starting requests at different times.
 *
 * The first append is held *before* it writes and the second is held *after*,
 * so the request that arrived first is the one that finds a line already
 * there. That order is what separates adopting the durable line from refusing
 * on sight: an implementation that refuses would hand the answer to the other
 * request, and the statuses are asserted per request rather than as a set.
 */
function storeWithScheduledAppends(workspacePath: string) {
  const firstReached = latch()
  const firstMayWrite = latch()
  const secondWrote = latch()
  const secondMayReturn = latch()
  // Keyed on the turn under test, not on a call counter. The server does other
  // work on startup and during a turn, and any of it appending first would
  // shift a counter-based schedule onto the wrong requests — which is a flake
  // that looks like a product defect.
  let watched: string | undefined
  let seen = 0

  class ScheduledSessionStore extends FileSystemSessionStore {
    override async appendChatMessageIfAbsent(
      id: string,
      message: ChatMessage,
    ): Promise<
      'appended' | 'already-present' | 'conflict' | 'unknown-session' | 'invalid-message'
    > {
      const scheduled =
        message.role === 'user' && message.turnId === watched && watched !== undefined
      if (!scheduled) return super.appendChatMessageIfAbsent(id, message)
      seen += 1
      if (seen === 1) {
        firstReached.open()
        await firstMayWrite.opened
        return super.appendChatMessageIfAbsent(id, message)
      }
      if (seen === 2) {
        const outcome = await super.appendChatMessageIfAbsent(id, message)
        secondWrote.open()
        await secondMayReturn.opened
        return outcome
      }
      return super.appendChatMessageIfAbsent(id, message)
    }
  }

  return {
    store: new ScheduledSessionStore(workspacePath),
    /** Schedule the two user appends of this turn, and nothing else. */
    watch: (turnId: string) => {
      watched = turnId
    },
    firstReached: firstReached.opened,
    letFirstWrite: firstMayWrite.open,
    secondWrote: secondWrote.opened,
    letSecondReturn: secondMayReturn.open,
  }
}

test(
  'two requests for one turn produce one answer and one named refusal',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-duplicate-')),
    )
    const workspacePath = path.join(directory, 'workspace')
    const projectRoot = path.join(directory, 'project')
    fs.mkdirSync(workspacePath, { recursive: true })
    fs.mkdirSync(path.join(projectRoot, 'agents'), { recursive: true })

    const previousKey = process.env.OPENAI_API_KEY
    const previousBaseUrl = process.env.OPENAI_BASE_URL
    const previousGeneratorUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
    process.env.OPENAI_API_KEY = 'duplicate-key'

    const provider = await startDeterministicOpenAiServer({
      script: [{ text: decision('the only answer') }],
      blockResponsesStartingAt: 1,
    })
    process.env.OPENAI_BASE_URL = provider.baseUrl
    process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = `${provider.baseUrl}/chat/completions`

    const scheduled = storeWithScheduledAppends(workspacePath)
    let server: StartedApiServer | undefined
    try {
      server = await startApiServer({
        store: new FileSystemRunStore(workspacePath),
        launcher: new PiRunLauncher(),
        sessionStore: scheduled.store,
        repoRootPath: projectRoot,
        workspacePath,
      })

      const created = await fetch(`${server.url}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'duplicate typing' }),
      })
      const sessionId = record(await created.json())['id']
      assert.ok(typeof sessionId === 'string')

      const turnId = randomUUID()
      scheduled.watch(turnId)
      const send = () =>
        fetch(`${server?.url}/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: 'say it once',
            provider: 'openai',
            model: 'test-model',
            turnId,
          }),
        })

      // The first request has read the transcript and is about to write.
      const early = send()
      await scheduled.firstReached

      // The second reads the same empty transcript and writes. Both believe
      // they are starting this turn.
      const late = send()
      await scheduled.secondWrote

      // Now the first writes, into a turn whose message already exists. It has
      // to adopt that line and go on to claim the turn.
      //
      // Raced against its own response rather than simply awaited: a build
      // that refuses on sight answers the first request immediately and never
      // reaches the model, and waiting for a request that will never arrive
      // would hang instead of failing.
      scheduled.letFirstWrite()
      assert.equal(
        await Promise.race([
          provider.waitForRequest().then(() => 'provider'),
          early.then(() => 'early-response'),
        ]),
        'provider',
        'the request that found a line already there must adopt it and run the ' +
          'turn, not refuse on the strength of the transcript',
      )

      // Only then does the second finish its write and try to claim a turn
      // somebody else is already running.
      scheduled.letSecondReturn()
      provider.releaseBlockedResponses()
      const [earlyResponse, lateResponse] = await Promise.all([early, late])

      // Exactly one answer and exactly one refusal, before anything about
      // which request got which.
      assert.deepEqual(
        [earlyResponse.status, lateResponse.status].sort((left, right) => left - right),
        [201, 409],
        'one request answers the turn and the other is refused',
      )
      // And then per request, not as a set: refusing on sight would produce the
      // same pair of statuses with the roles swapped.
      assert.equal(
        earlyResponse.status,
        201,
        'the request that adopted the durable line is the one that answered',
      )
      const refusedBody = record(await lateResponse.clone().json())
      assert.equal(
        lateResponse.status,
        409,
        `the loser was answered ${lateResponse.status}: ${JSON.stringify(refusedBody)}`,
      )
      assert.equal(
        refusedBody['code'],
        'turn_in_progress',
        `the refusal named the wrong thing: ${JSON.stringify(refusedBody)}`,
      )

      assert.equal(provider.requestCount(), 1, 'one turn asked the model once')
      const listed = record(
        await fetch(`${server.url}/sessions/${sessionId}/messages`).then(
          (response) => response.json(),
        ),
      )
      const messages = listed['messages']
      assert.ok(Array.isArray(messages))
      assert.deepEqual(
        messages.map((message) => record(message)['role']),
        ['user', 'assistant'],
        'one question and one answer are on disk',
      )
      // Adopted, not re-minted: the answer names the line that is durable.
      const answered = record(await earlyResponse.json())
      assert.deepEqual(record(answered['user'])['createdAt'], record(messages[0])['createdAt'])
    } finally {
      scheduled.letFirstWrite()
      scheduled.letSecondReturn()
      provider.releaseBlockedResponses()
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
  },
)

test(
  'a different request under a used turn id is still a reused identity',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // The other half of the same window. Adopting whatever is durable would
    // answer this caller with a turn it never asked for, so adoption is
    // conditional on the durable line recording *this* request — and when it
    // does not, the refusal has to say the id was reused, because that is a
    // caller bug rather than a retry.
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-reused-')),
    )
    const workspacePath = path.join(directory, 'workspace')
    const projectRoot = path.join(directory, 'project')
    fs.mkdirSync(workspacePath, { recursive: true })
    fs.mkdirSync(path.join(projectRoot, 'agents'), { recursive: true })

    const previousKey = process.env.OPENAI_API_KEY
    const previousBaseUrl = process.env.OPENAI_BASE_URL
    const previousGeneratorUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
    process.env.OPENAI_API_KEY = 'reused-key'

    const provider = await startDeterministicOpenAiServer({
      script: [{ text: decision('the answer to the other question') }],
      blockResponsesStartingAt: 1,
    })
    process.env.OPENAI_BASE_URL = provider.baseUrl
    process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = `${provider.baseUrl}/chat/completions`

    const scheduled = storeWithScheduledAppends(workspacePath)
    let server: StartedApiServer | undefined
    try {
      server = await startApiServer({
        store: new FileSystemRunStore(workspacePath),
        launcher: new PiRunLauncher(),
        sessionStore: scheduled.store,
        repoRootPath: projectRoot,
        workspacePath,
      })

      const created = await fetch(`${server.url}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'reused identity' }),
      })
      const sessionId = record(await created.json())['id']
      assert.ok(typeof sessionId === 'string')

      const turnId = randomUUID()
      scheduled.watch(turnId)
      const send = (text: string) =>
        fetch(`${server?.url}/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            provider: 'openai',
            model: 'test-model',
            turnId,
          }),
        })

      const early = send('one thing')
      await scheduled.firstReached
      const late = send('a different thing')
      await scheduled.secondWrote

      scheduled.letFirstWrite()
      const earlyResponse = await early
      assert.equal(earlyResponse.status, 409)
      assert.equal(
        record(await earlyResponse.json())['code'],
        'turn_id_reused',
        'a caller that sent something else under this id is told so',
      )

      scheduled.letSecondReturn()
      await provider.waitForRequest()
      provider.releaseBlockedResponses()
      const lateResponse = await late
      assert.equal(
        lateResponse.status,
        201,
        'and the request that actually owns the turn is unaffected',
      )
      assert.equal(provider.requestCount(), 1)
    } finally {
      scheduled.letFirstWrite()
      scheduled.letSecondReturn()
      provider.releaseBlockedResponses()
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
  },
)

test(
  'a build with no journal still refuses the duplicate it can see',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // Journalling can be switched off, and then there is no start barrier to
    // settle who owns a turn. The transcript is the only authority left, so
    // this is the one place a durable line may decide — and it must, because
    // otherwise a retry buys a second provider call and a late `turn_corrupt`
    // that describes nothing that went wrong.
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-nojournal-')),
    )
    const workspacePath = path.join(directory, 'workspace')
    const projectRoot = path.join(directory, 'project')
    fs.mkdirSync(workspacePath, { recursive: true })
    fs.mkdirSync(path.join(projectRoot, 'agents'), { recursive: true })

    const previousKey = process.env.OPENAI_API_KEY
    const previousBaseUrl = process.env.OPENAI_BASE_URL
    const previousGeneratorUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
    const previousJournal = process.env.PIPELINE_DURABLE_JOURNAL
    process.env.OPENAI_API_KEY = 'nojournal-key'
    process.env.PIPELINE_DURABLE_JOURNAL = 'disabled'

    const provider = await startDeterministicOpenAiServer({
      script: [{ text: decision('the only answer') }],
      blockResponsesStartingAt: 1,
    })
    process.env.OPENAI_BASE_URL = provider.baseUrl
    process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = `${provider.baseUrl}/chat/completions`

    const scheduled = storeWithScheduledAppends(workspacePath)
    let server: StartedApiServer | undefined
    try {
      server = await startApiServer({
        store: new FileSystemRunStore(workspacePath),
        launcher: new PiRunLauncher(),
        sessionStore: scheduled.store,
        repoRootPath: projectRoot,
        workspacePath,
      })

      const created = await fetch(`${server.url}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'no journal' }),
      })
      const sessionId = record(await created.json())['id']
      assert.ok(typeof sessionId === 'string')

      const turnId = randomUUID()
      scheduled.watch(turnId)
      const send = () =>
        fetch(`${server?.url}/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: 'say it once',
            provider: 'openai',
            model: 'test-model',
            turnId,
          }),
        })

      const early = send()
      await scheduled.firstReached
      const late = send()
      await scheduled.secondWrote

      // The first request now writes into a turn whose line is already there.
      // With no journal there is no start barrier to settle ownership, so the
      // transcript is the only authority left and this request has to refuse.
      //
      // Raced against the provider rather than simply awaited. A build that
      // adopts the durable line goes on to call the model, and the request
      // that actually wrote the line is still parked inside its own append —
      // so nothing would answer, and this case would spend its whole timeout
      // proving nothing. The race turns that into a named failure.
      scheduled.letFirstWrite()
      assert.equal(
        await Promise.race([
          early.then(() => 'refused'),
          provider.waitForRequest().then(() => 'provider'),
        ]),
        'refused',
        'with no journal to decide who owns the turn, the duplicate must be ' +
          'refused rather than sent to the model a second time',
      )
      const earlyResponse = await early

      scheduled.letSecondReturn()
      await provider.waitForRequest()
      provider.releaseBlockedResponses()
      const lateResponse = await late

      // Sorted, because which of the two wrote first is the interleave's
      // business; that exactly one was answered and exactly one was refused is
      // the contract.
      assert.deepEqual(
        [earlyResponse.status, lateResponse.status].sort((left, right) => left - right),
        [201, 409],
        'one request answers the turn and the other is refused',
      )
      const refused = earlyResponse.status === 409 ? earlyResponse : lateResponse
      const refusedBody = record(await refused.json())
      assert.equal(
        refusedBody['code'],
        'turn_in_progress',
        `the refusal named the wrong thing: ${JSON.stringify(refusedBody)}`,
      )
      assert.equal(provider.requestCount(), 1, 'one turn asked the model once')

      const listed = record(
        await fetch(`${server.url}/sessions/${sessionId}/messages`).then(
          (response) => response.json(),
        ),
      )
      const messages = listed['messages']
      assert.ok(Array.isArray(messages))
      assert.deepEqual(
        messages.map((message) => record(message)['role']),
        ['user', 'assistant'],
        'one question and one answer are on disk',
      )

      // No journal exists to hold this turn, which is the point of the case.
      assert.equal(
        fs.existsSync(
          path.join(workspacePath, 'sessions', sessionId, '.conversation-activities'),
        ),
        false,
      )
    } finally {
      scheduled.letFirstWrite()
      scheduled.letSecondReturn()
      provider.releaseBlockedResponses()
      await server?.close()
      await provider.close()
      if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = previousBaseUrl
      if (previousGeneratorUrl === undefined) {
        delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
      } else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousGeneratorUrl
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousKey
      if (previousJournal === undefined) delete process.env.PIPELINE_DURABLE_JOURNAL
      else process.env.PIPELINE_DURABLE_JOURNAL = previousJournal
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a build with no journal refuses a duplicate after the user line is durable',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // This is the wider and more ordinary duplicate window: the first request
    // has persisted the user's line and reached the provider before the retry
    // arrives. With no lifecycle journal there is no durable fact that can
    // distinguish that live request from a crashed one, so proceeding would
    // fail open and send the same logical turn to the provider twice.
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-nojournal-durable-')),
    )
    const workspacePath = path.join(directory, 'workspace')
    const projectRoot = path.join(directory, 'project')
    fs.mkdirSync(workspacePath, { recursive: true })
    fs.mkdirSync(path.join(projectRoot, 'agents'), { recursive: true })

    const previousKey = process.env.OPENAI_API_KEY
    const previousBaseUrl = process.env.OPENAI_BASE_URL
    const previousGeneratorUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
    const previousJournal = process.env.PIPELINE_DURABLE_JOURNAL
    process.env.OPENAI_API_KEY = 'nojournal-durable-key'
    process.env.PIPELINE_DURABLE_JOURNAL = 'disabled'

    const provider = await startDeterministicOpenAiServer({
      script: [{ text: decision('the only answer') }],
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
        body: JSON.stringify({ title: 'no journal durable duplicate' }),
      })
      const sessionId = record(await created.json())['id']
      assert.ok(typeof sessionId === 'string')

      const turnId = randomUUID()
      const send = () =>
        fetch(`${server?.url}/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: 'say it once',
            provider: 'openai',
            model: 'test-model',
            turnId,
          }),
        })

      const first = send()
      await provider.waitForRequest(1)
      const duplicate = send()

      assert.equal(
        await Promise.race([
          duplicate.then(() => 'refused'),
          provider.waitForRequest(2).then(() => 'provider'),
        ]),
        'refused',
        'the persisted user line must fail closed without sending a second request',
      )
      const duplicateResponse = await duplicate
      assert.equal(duplicateResponse.status, 409)
      assert.equal(
        record(await duplicateResponse.json())['code'],
        'turn_in_progress',
      )
      assert.equal(provider.requestCount(), 1)

      provider.releaseBlockedResponses()
      assert.equal((await first).status, 201)
    } finally {
      provider.releaseBlockedResponses()
      await server?.close()
      await provider.close()
      if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = previousBaseUrl
      if (previousGeneratorUrl === undefined) {
        delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
      } else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousGeneratorUrl
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousKey
      if (previousJournal === undefined) delete process.env.PIPELINE_DURABLE_JOURNAL
      else process.env.PIPELINE_DURABLE_JOURNAL = previousJournal
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
