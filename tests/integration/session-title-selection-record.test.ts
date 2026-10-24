/**
 * Which model named a session, and where that model came from.
 *
 * Titling runs on the one application default and recorded nothing about it. So
 * a chat whose Agent deliberately runs on model A could quietly call
 * app-default B, and neither the session nor its history said B had been used
 * at all. §4.3 gives every model use an account of itself; this is the one that
 * had none.
 *
 * The record is session-owned rather than hung off the turn request, because
 * the turn request is written before the reply and two of titling's four
 * callers have no chat turn at all — a schedule owns a fire, a Team launch owns
 * an admitted task. It is appended, never rewritten, so a later attempt on a
 * changed default sits beside the earlier one instead of replacing it.
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
import { sessionActivityClaimsSchema } from '../../contracts/session-activity.js'
import { runSessionAgentChatTurn } from '../../services/agent-chat-service.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import {
  generateSessionTitle,
  UNTITLED_SESSION_TITLE,
} from '../../domains/sessions/session-title.js'
import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'
import type { AgentTextStreamInput } from '../../contracts/agent-text-stream.js'

initProviders()

/** What the Agent's own file names. Never what titling runs on. */
const AGENT_MODEL = 'agent-chosen-model'
/** The one application default, which the title helper inherits. */
const DEFAULT_MODEL = 'app-default-model'
/** A model a person picked for one turn, with no Agent involved. */
const AD_HOC_MODEL = 'ad-hoc-user-model'
/** A phrase only this Agent's persona carries, so its own turn is identifiable. */
const AGENT_PERSONA_MARKER = 'PERSONA-MARKER-title-selection-reviewer'
/**
 * A phrase only the title helper's system prompt carries
 * (`domains/sessions/session-title.ts`), so the title turn is identifiable.
 *
 * Callers are told apart by what they say, never by the model they name: the
 * model is the behaviour under test, so using it as identity would make every
 * assertion circular.
 */
const TITLE_PROMPT_MARKER = 'session title that summarizes'

interface Harness {
  readonly sessionId: string
  readonly session: SessionSummary
  readonly repoRootPath: string
  readonly workspacePath: string
  readonly metadataPath: string
  readonly store: FileSystemSessionStore
  cleanup(): void
}

async function makeHarness(): Promise<Harness> {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'session-title-selection-')),
  )
  const repoRootPath = path.join(directory, 'project')
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(path.join(repoRootPath, 'agents'), { recursive: true })
  fs.mkdirSync(workspacePath, { recursive: true })
  const store = new FileSystemSessionStore(workspacePath)
  // Untitled, so this turn is actually eligible to be titled.
  const session = await store.createSession({ title: UNTITLED_SESSION_TITLE })
  return {
    sessionId: session.id,
    session,
    repoRootPath,
    workspacePath,
    metadataPath: path.join(workspacePath, 'sessions', session.id, 'session.json'),
    store,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  }
}

/** An Agent that names its own pair, so its reply cannot be confused with the default. */
function writeExplicitAgent(
  repoRootPath: string,
  name: string,
  provider: string,
  model: string,
): void {
  const directory = path.join(repoRootPath, 'agents', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      `provider: ${provider}`,
      `model: ${model}`,
      'thinking: low',
      '---',
      '',
      AGENT_PERSONA_MARKER,
      '',
    ].join('\n'),
    'utf8',
  )
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
 * The only endpoint this turn may reach.
 *
 * Serves both callers whatever model they name — a caller that asked for the
 * wrong one still has to be answered and recorded, or a regression would show
 * up as a timeout instead of as the wrong model. Which caller made a request is
 * read from what it said, not from what it asked for.
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
      // Armed at the title request, after required publication and its title
      // selection record. The later title write and ownership cleanup may fail.
      if (isTitleTurn) onTitleRequest?.()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        model,
        choices: [{
          message: {
            role: 'assistant',
            content: isTitleTurn
              ? 'Reviewing The Supply Agreement Draft'
              : 'A complete answer.',
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
      name: 'Title selection provider',
      baseUrl: `${provider.url}/v1`,
      apiKey: 'title-selection-key',
    },
  ])
  try {
    return await run(`connection:${connectionId}`)
  } finally {
    setConfiguredProviderConnections([])
  }
}

test('a selected-agent turn records which model named the session, and that it was the default', async () => {
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
      writeExplicitAgent(harness.repoRootPath, 'reviewer', providerName, AGENT_MODEL)
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: DEFAULT_MODEL,
      })

      const result = await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: harness.session,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'Review the attached supply agreement.',
        agentNames: ['reviewer'],
        turnId,
      })

      // Each caller separately, identified by what it said rather than by the
      // model it named — the model is the thing under test.
      assert.deepEqual(
        provider.modelsMatching(AGENT_PERSONA_MARKER),
        [AGENT_MODEL],
        `the Agent did not run on its own pair: ${JSON.stringify(provider.models())}`,
      )
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

      // What the session now says about that. Read back from the store rather
      // than from the call's return value, because durability is the point.
      const reloaded = await harness.store.getSession(harness.sessionId)
      assert.ok(reloaded)
      const attempts = reloaded.titleAttempts ?? []
      assert.equal(attempts.length, 1, JSON.stringify(attempts))
      const attempt = attempts[0]
      assert.ok(attempt)
      // A turn that titled successfully reports no failure reason. Saying both
      // "this worked" and "the session could not be titled" tells a reader two
      // contradictory things about the same turn.
      assert.equal(result.meta.titleFallback, false, JSON.stringify(result.meta))
      assert.equal(result.meta.titleReason, undefined, JSON.stringify(result.meta))
      assert.equal(result.meta.titleModel, DEFAULT_MODEL, JSON.stringify(result.meta))
      assert.equal(attempt.operation, 'selected-agent-chat')
      assert.equal(attempt.owner, turnId, 'the attempt is owned by the turn that caused it')
      assert.ok(attempt.attemptId, 'and carries an identity of its own')
      assert.deepEqual(attempt.selection, {
        provider: providerName,
        model: DEFAULT_MODEL,
        source: 'app-default',
        reason: 'agent-default',
        caller: 'title',
      }, JSON.stringify(attempt.selection))
    })
  } finally {
    setRuntimeDefaultModelState(undefined)
    await provider.close()
    harness.cleanup()
  }
})

test('a title keeps an explicit ad hoc choice, and does not fall back to the default', async () => {
  // The other half of the ownership rule. Removing the *named Agent's* pair
  // from titling must not also throw away a model a person deliberately picked
  // for this turn: there is no Agent here, so that choice is the only thing
  // anyone chose, and replacing it with the application default would discard
  // a real decision rather than stop reporting a borrowed one.
  const harness = await makeHarness()
  const provider = await startRecordingProvider()
  const turnId = randomUUID()
  try {
    await withConfiguredProvider(provider, async (providerName) => {
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: DEFAULT_MODEL,
      })

      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: harness.session,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'Review the attached supply agreement.',
        // No Agents at all, and a model chosen for this turn.
        agentNames: [],
        provider: providerName,
        model: AD_HOC_MODEL,
        turnId,
      })

      assert.deepEqual(
        provider.modelsMatching(TITLE_PROMPT_MARKER),
        [AD_HOC_MODEL],
        `the title discarded an explicit ad hoc choice: ${JSON.stringify(provider.models())}`,
      )

      const reloaded = await harness.store.getSession(harness.sessionId)
      assert.ok(reloaded)
      const attempt = (reloaded.titleAttempts ?? [])[0]
      assert.ok(attempt, JSON.stringify(reloaded.titleAttempts))
      assert.equal(attempt.operation, 'session-chat')
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

test('a title that cannot be saved does not fail a reply already published', async () => {
  // Titling is a convenience laid over a conversation that has already
  // finished. The Agent has answered, its reply is durable, and the turn is
  // recorded complete before a title is even asked for — so a fault in that
  // optional work must cost the title and nothing else.
  //
  // Replacing the shared lock directory with a file faults both title saving
  // and the later ownership cleanup. Required publication is already durable:
  // the answer must return, and the unreleased claim must remain visible.
  const harness = await makeHarness()
  const locksPath = path.join(harness.workspacePath, 'sessions', '.locks')
  const provider = await startRecordingProvider(() => {
    fs.rmSync(locksPath, { recursive: true, force: true })
    fs.writeFileSync(locksPath, '')
  })
  const turnId = randomUUID()
  try {
    await withConfiguredProvider(provider, async (providerName) => {
      writeExplicitAgent(harness.repoRootPath, 'reviewer', providerName, AGENT_MODEL)
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: DEFAULT_MODEL,
      })

      const result = await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: harness.session,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'Review the attached supply agreement.',
        agentNames: ['reviewer'],
        turnId,
      })

      // The answer the user was waiting for came back.
      assert.equal(result.replies.length, 1, JSON.stringify(result))
      assert.match(result.replies[0]?.text ?? '', /A complete answer\./)
      // The Agent ran on its own pair, and the title did reach the provider on
      // the default — the record was taken before the send, which is the point.
      assert.deepEqual(provider.modelsMatching(AGENT_PERSONA_MARKER), [AGENT_MODEL])
      assert.deepEqual(provider.modelsMatching(TITLE_PROMPT_MARKER), [DEFAULT_MODEL])
      // The session comes back as it stands — still untitled, and carrying the
      // record of the model that was about to name it. Asserting the summary
      // were simply absent would enshrine the missing notice: a person would
      // see no account of a model that really was used.
      assert.ok(result.session, JSON.stringify(result))
      assert.equal(result.session.title, UNTITLED_SESSION_TITLE)
      const attempts = result.session.titleAttempts ?? []
      assert.equal(attempts.length, 1, JSON.stringify(attempts))
      assert.equal(attempts[0]?.owner, turnId)
      assert.equal(attempts[0]?.selection.model, DEFAULT_MODEL)
      assert.equal(attempts[0]?.selection.source, 'app-default')
      assertChatClaimIsRetained(harness)
    })
  } finally {
    setRuntimeDefaultModelState(undefined)
    await provider.close()
    harness.cleanup()
  }
})

test('a title whose selection cannot be recorded is never dispatched', async () => {
  // The other side of the same rule, before the send rather than after it. An
  // owner that cannot take the record declines, and no model is used at all —
  // a model used with no account of it is what this whole capability removes.
  const provider = await startRecordingProvider()
  try {
    await withConfiguredProvider(provider, async (providerName) => {
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: DEFAULT_MODEL,
      })

      const result = await generateSessionTitle({
        session: {
          id: 'session-declining-record',
          title: UNTITLED_SESSION_TITLE,
          status: 'active',
          activityType: 'chat',
          createdAt: '2026-09-09T00:00:00.000Z',
          updatedAt: '2026-09-09T00:00:00.000Z',
        },
        history: [
          {
            id: 'user-message',
            role: 'user',
            text: 'Review the attached supply agreement.',
            createdAt: '2026-09-09T00:00:00.000Z',
          },
        ],
        onSelected: async () => false,
      })

      assert.equal(result.title, null)
      assert.equal(result.fallback, true)
      assert.match(result.reason ?? '', /could not be recorded/)
      assert.deepEqual(provider.models(), [])
    })
  } finally {
    setRuntimeDefaultModelState(undefined)
    await provider.close()
  }
})

/**
 * Arms a filesystem fault once this turn's reply is actually durable.
 *
 * Through the hub's own public path — wait for the channel, subscribe, read the
 * retained frames — rather than by overriding anything. The terminal frame is
 * published only after the assistant message has been persisted
 * (`services/agent-chat-service.ts:840-859`), so seeing it is how a fault can be
 * armed at that exact moment: after the answer is safe, and before anything
 * optional runs.
 */
async function armOnDurableReply(
  hub: AgentTextStreamHub,
  turnId: string,
  sessionId: string,
  arm: () => void,
): Promise<() => void> {
  const opened = await hub.waitForChannel(turnId, sessionId, { timeoutMs: 10_000 })
  assert.equal(opened, 'opened', 'the turn should have opened its text channel')
  let cursor = 0
  let armed = false
  const check = () => {
    if (armed) return
    const page = hub.read(turnId, cursor)
    if (!page) return
    cursor = page.nextCursor
    if (page.frames.some((frame) => frame.type === 'final' || frame.type === 'error')) {
      armed = true
      arm()
    }
  }
  const unsubscribe = hub.subscribe(turnId, check)
  // The frame may already be retained by the time this subscribes.
  check()
  return unsubscribe
}

function assertChatClaimIsRetained(harness: Harness): void {
  const claimsPath = path.join(path.dirname(harness.metadataPath), 'activity-claims.json')
  const raw: unknown = JSON.parse(fs.readFileSync(claimsPath, 'utf8'))
  const claims = sessionActivityClaimsSchema.parse(raw)
  assert.equal(claims.length, 1, 'failed cleanup must retain the published chat ownership')
  assert.equal(claims[0]?.kind, 'chat')
  assert.equal(claims[0]?.ownerLaunchId, harness.store.getInstanceId())
  assert.equal(claims[0]?.processId, process.pid)
}

test('a selection that cannot be recorded stops the title, and keeps the reply', async () => {
  // The store side of the same boundary, through the real store rather than
  // through the helper's callback. Nothing may be dispatched for a title that
  // could not be recorded, and the answer already published stays published.
  // This shared-lock fault also prevents cleanup; its exact claim is retained.
  const harness = await makeHarness()
  const locksPath = path.join(harness.workspacePath, 'sessions', '.locks')
  const provider = await startRecordingProvider()
  const turnId = randomUUID()
  const hub = new AgentTextStreamHub()
  let unsubscribe: (() => void) | undefined
  try {
    await withConfiguredProvider(provider, async (providerName) => {
      writeExplicitAgent(harness.repoRootPath, 'reviewer', providerName, AGENT_MODEL)
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: DEFAULT_MODEL,
      })

      const arming = armOnDurableReply(hub, turnId, harness.sessionId, () => {
        fs.rmSync(locksPath, { recursive: true, force: true })
        fs.writeFileSync(locksPath, '')
      })

      const result = await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: harness.session,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'Review the attached supply agreement.',
        agentNames: ['reviewer'],
        turnId,
        textStreamHub: hub,
      })
      unsubscribe = await arming

      assert.equal(result.replies.length, 1, JSON.stringify(result))
      assert.match(result.replies[0]?.text ?? '', /A complete answer\./)
      // The Agent's own turn happened; the title's never did.
      assert.deepEqual(provider.modelsMatching(AGENT_PERSONA_MARKER), [AGENT_MODEL])
      assert.deepEqual(provider.modelsMatching(TITLE_PROMPT_MARKER), [])
      assertChatClaimIsRetained(harness)
    })
  } finally {
    unsubscribe?.()
    setRuntimeDefaultModelState(undefined)
    await provider.close()
    harness.cleanup()
  }
})
