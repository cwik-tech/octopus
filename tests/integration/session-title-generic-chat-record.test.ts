/**
 * Which model named a session that has no Agent in it at all.
 *
 * The run chat's front desk owns no persona, so under master §7 D1 naming its
 * session runs on the one application default — and said nothing about it. The
 * selected-Agent path now records that; this is the same rule for the setup
 * assistant, which `dispatchSessionMessage` reaches through its
 * coordinator/workflow route rather than through the selected-Agent one.
 *
 * Two things are different here and both matter. This surface may carry a model
 * a person picked for one turn, and that is a real decision the title keeps
 * rather than discarding; and the legacy `codex/default` pair the composer can
 * still send means *app default*, so forwarding it would both call a model
 * nobody selected and record a placeholder as somebody's choice.
 *
 * And a generic turn does not always have a turn id. When it does not, the
 * attempt is owned by the user message that is actually on disk, so the page
 * has something to join the notice to.
 *
 * Driven through the real service, a real `FileSystemSessionStore` and an owned
 * local provider, because what is being proved is which model was actually
 * asked and what was actually written to disk.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { initProviders } from '../../providers/index.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import type { SessionSummary } from '../../contracts/sessions.js'
import { runSessionMessageTurn } from '../../services/session-service.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { UNTITLED_SESSION_TITLE } from '../../domains/sessions/session-title.js'
import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'

initProviders()

/** The one application default. Nothing on this surface may quietly replace it. */
const DEFAULT_MODEL = 'app-default-model'
/** A model a person picked for one turn, with no Agent involved. */
const AD_HOC_MODEL = 'ad-hoc-user-model'
/**
 * Phrases only one caller's own system prompt carries, so each turn is
 * identified by what it said rather than by the model it asked for. The model
 * is the behaviour under test, so using it as identity would make every
 * assertion circular.
 */
const CHAT_PROMPT_MARKER = 'run setup assistant'
const TITLE_PROMPT_MARKER = 'session title that summarizes'
const GENERATED_TITLE = 'Reviewing The Supply Agreement Draft'
const QUESTION = 'Review the attached supply agreement.'

interface Harness {
  readonly sessionId: string
  readonly session: SessionSummary
  readonly workspacePath: string
  readonly metadataPath: string
  readonly locksPath: string
  readonly store: FileSystemSessionStore
  cleanup(): void
}

async function makeHarness(): Promise<Harness> {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'session-title-generic-chat-')),
  )
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(workspacePath, { recursive: true })
  const store = new FileSystemSessionStore(workspacePath)
  // Untitled, so this turn is actually eligible to name it.
  const session = await store.createSession({ title: UNTITLED_SESSION_TITLE })
  return {
    sessionId: session.id,
    session,
    workspacePath,
    metadataPath: path.join(workspacePath, 'sessions', session.id, 'session.json'),
    locksPath: path.join(workspacePath, 'sessions', '.locks'),
    store,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  }
}

interface RecordingProvider {
  readonly url: string
  /** Every model this turn asked for, in order. */
  models(): string[]
  /** The models named by requests carrying `marker`, in order. */
  modelsMatching(marker: string): string[]
  close(): Promise<void>
}

/**
 * The only endpoint these turns may reach.
 *
 * Serves both callers whatever model they name — a caller that asked for the
 * wrong one still has to be answered and recorded, or a regression would show
 * up as a timeout instead of as the wrong model.
 */
async function startRecordingProvider(
  onTitleRequest?: () => void,
): Promise<RecordingProvider> {
  const requests: Array<{ model: string; body: string }> = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.once('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let model = ''
      try {
        model = String((JSON.parse(body) as { model?: unknown }).model ?? '')
      } catch {
        model = ''
      }
      requests.push({ model, body })
      const isTitleTurn = body.includes(TITLE_PROMPT_MARKER)
      // Armed at the moment the title is requested, so everything this turn
      // writes has already taken and released its lock.
      if (isTitleTurn) onTitleRequest?.()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        model,
        choices: [{
          message: {
            role: 'assistant',
            content: isTitleTurn
              ? GENERATED_TITLE
              // The front desk answers with a structured decision, not prose.
              : JSON.stringify({
                  message: 'A complete answer.',
                  selectionAction: 'clear',
                  workflowId: null,
                  launchIntent: 'none',
                  deepResearchPlanAction: 'keep',
                  deepResearchMissingInputs: [],
                }),
          },
        }],
        usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    models: () => requests.map((entry) => entry.model),
    modelsMatching: (marker: string) =>
      requests.filter((entry) => entry.body.includes(marker)).map((entry) => entry.model),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    }),
  }
}

async function withConfiguredProvider<T>(
  provider: RecordingProvider,
  run: (providerName: string) => Promise<T>,
): Promise<T> {
  const connectionId = randomUUID()
  setConfiguredProviderConnections([
    {
      id: connectionId,
      kind: 'openai-compatible',
      name: 'Generic chat title provider',
      baseUrl: `${provider.url}/v1`,
      apiKey: 'generic-chat-title-key',
    },
  ])
  try {
    return await run(`connection:${connectionId}`)
  } finally {
    setConfiguredProviderConnections([])
  }
}

interface IsolatedCodexCli {
  /** One line per time the `codex` binary was actually executed. */
  invocations(): string[]
}

/**
 * Makes the Codex CLI reachable only as an owned fake, and counts its use.
 *
 * The sentinel pair `codex/default` means *app default* in this codebase, so a
 * caller that forwards it reaches `providers/codex.ts:260`, which spawns
 * `codex` from `PATH`. On a developer machine that is the real, authenticated
 * CLI — so an owned HTTP fixture alone does not keep this case local when the
 * routing is wrong. The adapter's own path builder is what decides here, and
 * `PIPELINE_CLI_PATH_FALLBACK=0` removes its fallback directories
 * (`core/cli-path.ts`), leaving the fake as the only `codex` in existence for
 * the duration. `CODEX_HOME` is redirected so no real credential is read or
 * copied, and the interpreter is pinned rather than looked up, because `PATH`
 * no longer holds one.
 *
 * The real resolver and the real provider adapter stay in place: what is being
 * proved is which of them the title reaches, so replacing either would answer a
 * different question.
 *
 * The fake is a `/bin/sh` script rather than a Node one. Its interpreter is then
 * an absolute path that needs nothing from `PATH`, and the invocation it records
 * cannot be lost to the script's own startup — a fake that crashes before
 * writing its log would report zero invocations for a call that really happened,
 * which is the one mistake this evidence must not be able to make. It answers
 * with real Codex JSONL, so a wrong route completes normally rather than failing
 * for some incidental reason: driven directly, the adapter reads back
 * `Named By The Fake Codex CLI` on model `default`.
 */
async function withIsolatedCodexCli<T>(
  run: (cli: IsolatedCodexCli) => Promise<T>,
): Promise<T> {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'generic-chat-fake-codex-')),
  )
  const binDirectory = path.join(directory, 'bin')
  const invocationLog = path.join(directory, 'invocations.log')
  const codexHome = path.join(directory, 'codex-home')
  fs.mkdirSync(binDirectory, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  const jsonl = [
    JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'Named By The Fake Codex CLI' },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 4, cached_input_tokens: 0, output_tokens: 4 },
    }),
  ].join('\n')
  const answerPath = path.join(directory, 'answer.jsonl')
  fs.writeFileSync(answerPath, `${jsonl}\n`, 'utf8')
  fs.writeFileSync(
    path.join(binDirectory, 'codex'),
    [
      '#!/bin/sh',
      // Recorded first, so an invocation is evidence even if everything after
      // it fails.
      `echo "$@" >> ${JSON.stringify(invocationLog)}`,
      // Absolute, because `PATH` now holds only this directory.
      `/bin/cat ${JSON.stringify(answerPath)}`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )

  const original = {
    PATH: process.env.PATH,
    PIPELINE_CLI_PATH_FALLBACK: process.env.PIPELINE_CLI_PATH_FALLBACK,
    CODEX_HOME: process.env.CODEX_HOME,
  }
  process.env.PATH = binDirectory
  process.env.PIPELINE_CLI_PATH_FALLBACK = '0'
  process.env.CODEX_HOME = codexHome
  try {
    return await run({
      invocations: () =>
        fs.existsSync(invocationLog)
          ? fs.readFileSync(invocationLog, 'utf8').split('\n').filter(Boolean)
          : [],
    })
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

/** Everything `runSessionMessageTurn` needs that this capability does not vary. */
function turnInput(harness: Harness) {
  return {
    sessionId: harness.sessionId,
    session: harness.session,
    sessionStore: harness.store,
    text: QUESTION,
    workflows: [],
    workflowEntries: [],
  }
}

test('a generic chat turn records the model that named it, before that model is used', async () => {
  const harness = await makeHarness()
  // Read at the moment the title request reaches the provider, so "recorded
  // before the send" is proved where it matters. Reading only after the call
  // returns could not tell that apart from a record written afterwards.
  let historyAtSend: unknown
  const provider = await startRecordingProvider(() => {
    historyAtSend = (
      JSON.parse(fs.readFileSync(harness.metadataPath, 'utf8')) as {
        titleAttempts?: unknown
      }
    ).titleAttempts
  })
  const turnId = randomUUID()
  try {
    await withConfiguredProvider(provider, async (providerName) => {
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: DEFAULT_MODEL,
      })

      const result = await runSessionMessageTurn({ ...turnInput(harness), turnId })

      assert.deepEqual(
        provider.modelsMatching(TITLE_PROMPT_MARKER),
        [DEFAULT_MODEL],
        `the title did not run on the application default: ${JSON.stringify(provider.models())}`,
      )

      // The entry was already on disk when the request went out.
      assert.ok(Array.isArray(historyAtSend), JSON.stringify(historyAtSend))
      assert.equal(historyAtSend.length, 1, JSON.stringify(historyAtSend))
      assert.deepEqual(
        (historyAtSend[0] as { selection?: unknown }).selection,
        {
          provider: providerName,
          model: DEFAULT_MODEL,
          source: 'app-default',
          reason: 'agent-default',
          caller: 'title',
        },
        JSON.stringify(historyAtSend[0]),
      )

      // What the session now says. Read back from the store rather than from
      // the call's return value, because durability is the point.
      const reloaded = await harness.store.getSession(harness.sessionId)
      assert.ok(reloaded)
      const attempts = reloaded.titleAttempts ?? []
      assert.equal(attempts.length, 1, JSON.stringify(attempts))
      const attempt = attempts[0]
      assert.ok(attempt)
      assert.equal(attempt.operation, 'session-chat')
      assert.equal(attempt.owner, turnId, 'the attempt is owned by the turn that caused it')
      assert.ok(attempt.attemptId, 'and carries an identity of its own')
      assert.deepEqual(attempt.selection, {
        provider: providerName,
        model: DEFAULT_MODEL,
        source: 'app-default',
        reason: 'agent-default',
        caller: 'title',
      }, JSON.stringify(attempt.selection))

      // A turn that titled successfully reports no failure reason.
      assert.equal(result.session?.title, GENERATED_TITLE, JSON.stringify(result.session))
      assert.equal(result.meta.titleModel, DEFAULT_MODEL, JSON.stringify(result.meta))
      assert.equal(result.meta.titleFallback, false, JSON.stringify(result.meta))
      assert.equal(result.meta.titleReason, undefined, JSON.stringify(result.meta))
    })
  } finally {
    setRuntimeDefaultModelState(undefined)
    await provider.close()
    harness.cleanup()
  }
})

test('a turn with no id is owned by the message the user actually sent', async () => {
  // Generic chat does not always mint a turn id. The owner is then the
  // persisted user message, because a record whose owner is on nothing the page
  // holds is a record with no notice — the page would have nothing to join.
  const harness = await makeHarness()
  const provider = await startRecordingProvider()
  try {
    await withConfiguredProvider(provider, async (providerName) => {
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: DEFAULT_MODEL,
      })

      const result = await runSessionMessageTurn(turnInput(harness))

      assert.equal(result.user.turnId, undefined, 'this turn really has no id')
      const reloaded = await harness.store.getSession(harness.sessionId)
      assert.ok(reloaded)
      const attempt = (reloaded.titleAttempts ?? [])[0]
      assert.ok(attempt, JSON.stringify(reloaded.titleAttempts))
      assert.equal(attempt.operation, 'session-chat')
      assert.equal(attempt.owner, result.user.id)

      // And that owner names a line the transcript really holds, so the notice
      // has somewhere to go rather than pointing at an id nobody can see.
      const messages = await harness.store.listChatMessages(harness.sessionId)
      assert.ok(
        messages.some((message) => message.id === attempt.owner && message.role === 'user'),
        JSON.stringify(messages.map((message) => ({ id: message.id, role: message.role }))),
      )
    })
  } finally {
    setRuntimeDefaultModelState(undefined)
    await provider.close()
    harness.cleanup()
  }
})

test('an explicit ad hoc pair is what names the session, and is recorded as the user’s', async () => {
  // There is no Agent on this surface, so a model a person picked for this one
  // turn is the only thing anyone chose. Replacing it with the application
  // default would discard a real decision rather than stop reporting a
  // borrowed one.
  const harness = await makeHarness()
  const provider = await startRecordingProvider()
  try {
    await withConfiguredProvider(provider, async (providerName) => {
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: DEFAULT_MODEL,
      })

      await runSessionMessageTurn({
        ...turnInput(harness),
        provider: providerName,
        model: AD_HOC_MODEL,
      })

      assert.deepEqual(
        provider.modelsMatching(CHAT_PROMPT_MARKER),
        [AD_HOC_MODEL],
        JSON.stringify(provider.models()),
      )
      assert.deepEqual(
        provider.modelsMatching(TITLE_PROMPT_MARKER),
        [AD_HOC_MODEL],
        `the title discarded an explicit ad hoc choice: ${JSON.stringify(provider.models())}`,
      )

      const reloaded = await harness.store.getSession(harness.sessionId)
      assert.ok(reloaded)
      const attempt = (reloaded.titleAttempts ?? [])[0]
      assert.ok(attempt, JSON.stringify(reloaded.titleAttempts))
      assert.deepEqual(attempt.selection, {
        provider: providerName,
        model: AD_HOC_MODEL,
        source: 'user',
        reason: 'explicit-user-choice',
        caller: 'title',
      }, JSON.stringify(attempt.selection))
    })
  } finally {
    setRuntimeDefaultModelState(undefined)
    await provider.close()
    harness.cleanup()
  }
})

test('the legacy default placeholder names the app default, and nobody’s choice', { timeout: 30_000 }, async () => {
  // The composer may still send `codex/default`. That pair has one meaning in
  // this codebase — app-default mode — so forwarding it as a chosen pair would
  // both reach for a model nobody selected and record a placeholder as a
  // person's decision. Provenance is read from what the surface resolved, never
  // inferred from the fact that two strings arrived.
  const harness = await makeHarness()
  const provider = await startRecordingProvider()
  try {
    await withIsolatedCodexCli(async (cli) => {
      await withConfiguredProvider(provider, async (providerName) => {
        setRuntimeDefaultModelState({
          status: 'available',
          provider: providerName,
          model: DEFAULT_MODEL,
        })

        await runSessionMessageTurn({
          ...turnInput(harness),
          provider: 'codex',
          model: 'default',
        })

        // Nothing reached the CLI at all. This is the assertion that says the
        // placeholder was read as app-default mode rather than as a provider
        // name; the model assertions below say which model that resolved to.
        assert.deepEqual(cli.invocations(), [], 'the title spawned the Codex CLI')
        assert.deepEqual(
          provider.modelsMatching(TITLE_PROMPT_MARKER),
          [DEFAULT_MODEL],
          `the title reached for the placeholder: ${JSON.stringify(provider.models())}`,
        )

        const reloaded = await harness.store.getSession(harness.sessionId)
        assert.ok(reloaded)
        const attempt = (reloaded.titleAttempts ?? [])[0]
        assert.ok(attempt, JSON.stringify(reloaded.titleAttempts))
        assert.deepEqual(attempt.selection, {
          provider: providerName,
          model: DEFAULT_MODEL,
          source: 'app-default',
          reason: 'agent-default',
          caller: 'title',
        }, JSON.stringify(attempt.selection))
      })
    })
  } finally {
    setRuntimeDefaultModelState(undefined)
    await provider.close()
    harness.cleanup()
  }
})

test('a title that could not be saved still returns the record of the model that tried', async () => {
  // Titling is a convenience laid over a reply that is already durable. A fault
  // in it costs the title and nothing else — and the attempt it already
  // recorded still has to come back, or a person would see no account of a
  // model that really was used, which is the whole point of recording it.
  const harness = await makeHarness()
  const provider = await startRecordingProvider(() => {
    // The session lock lives outside the session directory, so replacing the
    // directory that holds it with a file is a fault only the title write can
    // hit. Armed at the moment the title is requested: by then every other
    // write this turn makes has finished.
    fs.rmSync(harness.locksPath, { recursive: true, force: true })
    fs.writeFileSync(harness.locksPath, '')
  })
  const turnId = randomUUID()
  try {
    await withConfiguredProvider(provider, async (providerName) => {
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: DEFAULT_MODEL,
      })

      const result = await runSessionMessageTurn({ ...turnInput(harness), turnId })

      // The answer the user was waiting for came back.
      assert.match(result.assistant.text, /A complete answer\./)
      // The record was taken before the send, which is why the title did reach
      // the provider on the default at all.
      assert.deepEqual(provider.modelsMatching(TITLE_PROMPT_MARKER), [DEFAULT_MODEL])
      // The session comes back as it stands — still untitled, and carrying the
      // record of the model that was about to name it.
      assert.ok(result.session, JSON.stringify(result))
      assert.equal(result.session.title, UNTITLED_SESSION_TITLE)
      const attempts = result.session.titleAttempts ?? []
      assert.equal(attempts.length, 1, JSON.stringify(attempts))
      assert.equal(attempts[0]?.owner, turnId)
      assert.equal(attempts[0]?.selection.model, DEFAULT_MODEL)
      assert.equal(attempts[0]?.selection.source, 'app-default')
    })
  } finally {
    setRuntimeDefaultModelState(undefined)
    await provider.close()
    harness.cleanup()
  }
})

test('a selection that cannot be recorded stops the title, and keeps the reply', async () => {
  // The other side of the same rule, before the send rather than after it. A
  // session that cannot take the record declines the call, and no model is used
  // at all — a model used with no account of it is what this removes.
  //
  // The fault is armed through the hub's own public path once the reply is
  // actually durable: the terminal frame is published by `textStream.close`,
  // which runs after the assistant message has been appended and before any of
  // the optional title work.
  const harness = await makeHarness()
  const provider = await startRecordingProvider()
  const channelId = randomUUID()
  const hub = new AgentTextStreamHub()
  let unsubscribe: (() => void) | undefined
  try {
    await withConfiguredProvider(provider, async (providerName) => {
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: DEFAULT_MODEL,
      })

      const arming = armOnDurableReply(hub, channelId, harness.sessionId, () => {
        fs.rmSync(harness.locksPath, { recursive: true, force: true })
        fs.writeFileSync(harness.locksPath, '')
      })

      const result = await runSessionMessageTurn({
        ...turnInput(harness),
        turnId: randomUUID(),
        streamChannelId: channelId,
        textStreamHub: hub,
      })
      unsubscribe = await arming

      assert.match(result.assistant.text, /A complete answer\./)
      // The chat's own turn happened; the title's never did.
      assert.deepEqual(provider.modelsMatching(CHAT_PROMPT_MARKER), [DEFAULT_MODEL])
      assert.deepEqual(provider.modelsMatching(TITLE_PROMPT_MARKER), [])
    })
  } finally {
    unsubscribe?.()
    setRuntimeDefaultModelState(undefined)
    await provider.close()
    harness.cleanup()
  }
})

test('a cancellation after the reply is durable starts no title request', async () => {
  // Cancelling is the user going away, and this service documents that on its
  // `signal`. The primary call already honours it. Optional work that begins
  // *after* the answer is durable must honour it too: a request nobody is
  // waiting for is one nobody asked for, and starting a fresh title call then
  // spends a model on an abandoned turn.
  //
  // The already-completed primary lifecycle is a separate question and is not
  // touched here — the reply stays exactly as published.
  const harness = await makeHarness()
  const provider = await startRecordingProvider()
  const channelId = randomUUID()
  const hub = new AgentTextStreamHub()
  const cancellation = new AbortController()
  let unsubscribe: (() => void) | undefined
  try {
    await withConfiguredProvider(provider, async (providerName) => {
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: DEFAULT_MODEL,
      })

      // Aborted at the retained terminal frame, which is published once the
      // assistant message is on disk and before any optional work runs.
      const arming = armOnDurableReply(hub, channelId, harness.sessionId, () => {
        cancellation.abort()
      })

      const result = await runSessionMessageTurn({
        ...turnInput(harness),
        turnId: randomUUID(),
        streamChannelId: channelId,
        textStreamHub: hub,
        signal: cancellation.signal,
      })
      unsubscribe = await arming

      // The answer that was already published stands, in the returned turn and
      // on disk.
      assert.match(result.assistant.text, /A complete answer\./)
      const messages = await harness.store.listChatMessages(harness.sessionId)
      assert.ok(
        messages.some(
          (message) => message.role === 'assistant' && /A complete answer\./.test(message.text),
        ),
        JSON.stringify(messages.map((message) => message.role)),
      )
      // And nothing was spent naming a session nobody is waiting for.
      assert.deepEqual(provider.modelsMatching(CHAT_PROMPT_MARKER), [DEFAULT_MODEL])
      assert.deepEqual(
        provider.modelsMatching(TITLE_PROMPT_MARKER),
        [],
        `a cancelled turn still asked for a title: ${JSON.stringify(provider.models())}`,
      )
      // And nothing claims a model was about to name it. The record says what
      // really was about to be used; a cancelled turn was about to use nothing.
      const reloaded = await harness.store.getSession(harness.sessionId)
      assert.ok(reloaded)
      assert.deepEqual(reloaded.titleAttempts ?? [], [], JSON.stringify(reloaded.titleAttempts))
    })
  } finally {
    unsubscribe?.()
    setRuntimeDefaultModelState(undefined)
    await provider.close()
    harness.cleanup()
  }
})

/**
 * Arms a filesystem fault once this turn's reply is actually durable.
 *
 * Through the hub's own public path — wait for the channel, subscribe, read the
 * retained frames — rather than by overriding anything.
 */
async function armOnDurableReply(
  hub: AgentTextStreamHub,
  channelId: string,
  sessionId: string,
  arm: () => void,
): Promise<() => void> {
  const opened = await hub.waitForChannel(channelId, sessionId, { timeoutMs: 10_000 })
  assert.equal(opened, 'opened', 'the turn should have opened its text channel')
  let cursor = 0
  let armed = false
  const check = () => {
    if (armed) return
    const page = hub.read(channelId, cursor)
    if (!page) return
    cursor = page.nextCursor
    if (page.frames.some((frame) => frame.type === 'final' || frame.type === 'error')) {
      armed = true
      arm()
    }
  }
  const unsubscribe = hub.subscribe(channelId, check)
  // The frame may already be retained by the time this subscribes.
  check()
  return unsubscribe
}
