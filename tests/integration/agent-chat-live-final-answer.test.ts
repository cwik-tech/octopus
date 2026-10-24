/**
 * Live final-answer streaming for an agent chat turn on the native tool loop.
 *
 * Owner decision 2026-09-27 (streaming/DESIGN.md R1-R10): a chat turn on an API
 * connection keeps `create_file` and still streams its answer as the provider
 * produces it, while a tool-capable round stays buffered so planning prose is
 * never shown.
 *
 * Nothing between the chat entry point and the socket is stood in for. The turn
 * enters through `runSessionAgentChatTurn` with the collaborators
 * `agentChatTurnWiring` assembles in production, and reaches a real
 * `McpAgentToolService` over a real `McpParentBroker` (no external servers), a
 * real `ProviderSettingsService` connection validated against the fake
 * provider, the real OpenAI Chat Completions tool adapter inside the real
 * `runProviderToolLoop`, real HTTP to a local fake provider, the real
 * `create_file` tool writing through the capability dispatcher, a
 * `FileSystemSessionStore`, an `AgentTextStreamHub`, and the workspace
 * execution-journal registry built the way `server/composition.ts:530-547`
 * builds it, so each turn's agent-turn record is written to the assignment's
 * journal file on disk.
 *
 * The fake provider decides the answer's shape from the request, never the
 * other way round: a request that offers tools (and does not forbid them) is a
 * tool-capable round, and a request that offers none or sends
 * `tool_choice: "none"` is the final answering request (R4). Each is answered
 * as JSON or as SSE according to its own `stream` flag, so the script holds
 * whichever way the loop asks.
 *
 * Every test here fails on 7289fc48, which sends each round with
 * `stream: false` and publishes the answering round's text as one delta.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { MAX_PROVIDER_ROUNDS } from '../../contracts/agent-questions.js'
import type { AgentTextStreamFrame } from '../../contracts/agent-text-stream.js'
import type { ChatMessage, SessionSummary } from '../../contracts/sessions.js'
import {
  EXECUTION_JOURNAL_DIRECTORY_NAME,
  EXECUTION_JOURNAL_FILENAME,
} from '../../core/execution-journal.js'
import { RUN_PRIVATE_RUNTIME_DIRECTORY_NAME } from '../../core/run-assignment-location.js'
import { parseWebEvidenceRolloutConfig } from '../../domains/browser/web-evidence-rollout.js'
import type { WebEvidenceValidationInput } from '../../domains/browser/web-evidence-validation-journal.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { createMcpProviderSupportResolver } from '../../domains/mcp/mcp-provider-support.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import {
  AgentTextStreamHub,
  type AgentTextStreamWaitResult,
} from '../../domains/runtime/agent-text-stream-hub.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { createFileToolModule } from '../../server/tools/create-file.js'
import { researchWebToolModule } from '../../server/tools/research-web.js'
import {
  buildToolRegistry,
  providerAgentTools,
  type ToolModule,
  type ToolModuleOptions,
} from '../../server/tools/tool-registry.js'
import { AcquisitionSettingsService } from '../../services/acquisition-settings-service.js'
import { runSessionAgentChatTurn } from '../../services/agent-chat-service.js'
import { agentChatTurnWiring } from '../../services/agent-chat-turn-wiring.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { CapabilityDispatchRuntime } from '../../services/capability-dispatch-runtime.js'
import { startWorkspaceExecutionJournal } from '../../services/execution-journal-tenant-pin.js'
import {
  McpAgentToolService,
  type McpAgentToolServiceWebEvidence,
} from '../../services/mcp-agent-tool-service.js'
import {
  McpSettingsService,
  type McpSecretCodec,
} from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { ResearchWebToolService } from '../../services/research-web-tool-service.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import {
  startFakeChatCompletionsServer,
  type FakeChatCompletionsRequest,
  type FakeChatCompletionsServer,
  type FakeChatCompletionsToolCall,
  type FakeChatCompletionsTurn,
} from '../support/fake-chat-completions-server.js'

const MODEL = 'fake/live-answer'
const AGENT_NAME = 'answerer'

const CODEC: McpSecretCodec = {
  encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
}

/** A tool-capable round's own answer. It is never what the user is shown. */
const DRAFT = 'DRAFT-FROM-THE-TOOL-CAPABLE-ROUND.'

// ---------------------------------------------------------------------------
// Request shapes. Decided from the request body, so they hold whichever way
// the loop sends a round.

function offersTools(request: FakeChatCompletionsRequest): boolean {
  return request.toolCount > 0 && request.body.tool_choice !== 'none'
}

function carriesToolResult(request: FakeChatCompletionsRequest): boolean {
  const messages = request.body.messages
  return (
    Array.isArray(messages) &&
    messages.some(
      (message: unknown) =>
        typeof message === 'object' &&
        message !== null &&
        'role' in message &&
        message.role === 'tool',
    )
  )
}

const isFirstToolRound = (request: FakeChatCompletionsRequest): boolean =>
  offersTools(request) && !carriesToolResult(request)
const isLaterToolRound = (request: FakeChatCompletionsRequest): boolean =>
  offersTools(request) && carriesToolResult(request)
/** R4: the answer comes from a request that cannot call tools. */
const isFinalRequest = (request: FakeChatCompletionsRequest): boolean =>
  !offersTools(request)

function createFileCall(filename: string, content: string): FakeChatCompletionsToolCall {
  return {
    id: `call-${filename}`,
    name: 'create_file',
    arguments: { filename, content },
  }
}

// ---------------------------------------------------------------------------
// Harness.

interface Harness {
  readonly server: FakeChatCompletionsServer
  readonly hub: AgentTextStreamHub
  readonly workspacePath: string
  readonly sessionId: string
  runTurn(input: {
    readonly turnId: string
    readonly text?: string
  }): ReturnType<typeof runSessionAgentChatTurn>
  close(): Promise<void>
}

async function startHarness(options: {
  readonly script: readonly FakeChatCompletionsTurn[]
  readonly agentName?: string
  /** The persona's `tools:` line, which is what enables Research Web. */
  readonly agentTools?: string
  /** Register the real Research Web tool module beside `create_file`. */
  readonly researchWeb?: boolean
  readonly webEvidence?: McpAgentToolServiceWebEvidence
  /**
   * The kind the connection is saved as. An Ollama connection is saved the
   * way AI Providers settings saves one: the server's root as its base URL,
   * and no key.
   */
  readonly connectionKind?: 'openai-compatible' | 'ollama'
}): Promise<Harness> {
  const agentName = options.agentName ?? AGENT_NAME
  // Real paths: `create_file` refuses an assignment reached through a symlink,
  // and the macOS temp directory is one.
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'chat-live-final-answer-')),
  )
  const workspacePath = path.join(root, 'workspace')
  const projectRoot = path.join(root, 'project')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'agents'), { recursive: true })

  const server = await startFakeChatCompletionsServer({
    script: options.script,
    models: [MODEL],
  })

  // The native tool loop needs a key; this connection has one, and is
  // validated against the fake provider the way AI Providers settings does.
  const providerSettings = new ProviderSettingsService({
    storagePath: path.join(root, 'providers.json'),
    secretCodec: CODEC,
  })
  const connection = await providerSettings.saveConnection(
    options.connectionKind === 'ollama'
      ? { kind: 'ollama', name: 'Local Ollama', baseUrl: server.url, enabled: true }
      : {
          kind: 'openai-compatible',
          name: 'Live answer loopback',
          baseUrl: `${server.url}/v1`,
          apiKey: 'live-answer-secret',
          enabled: true,
        },
  )
  const validated = await providerSettings.validateConnection(connection.id)
  assert.equal(validated.status, 'connected', 'the fake provider must validate as a connection')
  await providerSettings.setModelEnabled(connection.id, MODEL, true)
  const provider = configuredProviderName(connection.id)

  const agentDir = path.join(projectRoot, 'agents', agentName)
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, `${agentName}.md`),
    [
      '---',
      `name: ${agentName}`,
      'description: Live final-answer probe.',
      'tier: execution',
      `provider: ${provider}`,
      `model: ${MODEL}`,
      'thinking: low',
      ...(options.agentTools ? [`tools: ${options.agentTools}`] : []),
      '---',
      '',
      '# Answerer',
      '',
      'Answer the question.',
      '',
    ].join('\n'),
    'utf8',
  )

  // The execution journal, as server/composition.ts:530-547 builds it: the
  // workspace's tenant pin is reconciled first, then one registry is opened
  // over the workspace in the resolved mode. With it, agentChatTurnWiring
  // gives each turn the real agent-turn recorder
  // (services/agent-chat-turn-wiring.ts:91-112).
  const journalOptions = await startWorkspaceExecutionJournal({ workspacePath })
  assert.equal(
    journalOptions.mode,
    'authoritative',
    'the workspace journals agent turns, as the default configuration does',
  )
  const executionJournalRegistry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: journalOptions.tenantId,
    mode: journalOptions.mode,
  })

  // Mirrors server/composition.ts: the capability runtime journals through the
  // registry (:649-666), the broker has no MCP servers registered and resolves
  // durable dispatch through the same registry (:772-785), and the service
  // gets the built-in tool registry and the real support resolver (:823-836).
  const manager = new McpClientManager()
  const mcpSettings = new McpSettingsService({
    storagePath: path.join(root, 'mcps.json'),
    secretCodec: CODEC,
    clientManager: manager,
  })
  const leases = new McpRunLeaseStore()
  const dispatchRuntime = new CapabilityDispatchRuntime({
    workspacePath,
    leaseResolver: (context) => leases.resolve(context),
    runtimeAuthority: {
      authorize: async () => {
        throw new Error('A chat tool call is authorized by its MCP lease.')
      },
    },
    executionJournalRegistry,
  })
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: mcpSettings,
    clientManager: mcpSettings.getBrokerClientManager(),
    grantResolver: ({ context, serverId }) =>
      mcpSettings.isAgentGranted(context.agentPath, serverId),
    leaseResolver: (context) => leases.resolve(context),
    capabilityEvidence: dispatchRuntime.evidencePort,
    durable: (input) => executionJournalRegistry.resolve(input),
  })
  const toolModules: ToolModule[] = [createFileToolModule]
  let moduleOptions: ToolModuleOptions | undefined
  if (options.researchWeb) {
    // The one permitted stand-in on this path is the far end of Research Web
    // acquisition. A real acquire reaches a public site and, past the direct
    // HTTP rung, a managed browser or a paid cloud/reader provider, none of
    // which a test can reach or pay for. So the source page is served on
    // loopback, reached through the acquirer's own test-mode allowance
    // (`allowHttpLocalhost`, which production sets when NODE_ENV is test,
    // server/tools/research-web.ts:237), and the service has no browser and an
    // empty provider environment, so direct HTTP is the whole ladder. The tool
    // module, the capability dispatch gateway, acquisition, quality checks and
    // the observation store are the real ones.
    const acquisitionSettings = new AcquisitionSettingsService({ environment: {} })
    toolModules.push(researchWebToolModule)
    moduleOptions = {
      'research-web': {
        settingsService: acquisitionSettings,
        toolService: new ResearchWebToolService({
          workspacePath,
          repoRootPath: projectRoot,
          settings: acquisitionSettings,
          allowHttpLocalhost: true,
        }),
      },
    }
  }
  const mcpAgentToolService = new McpAgentToolService({
    broker,
    leaseStore: leases,
    providerSettingsService: providerSettings,
    providerSupportResolver: createMcpProviderSupportResolver(providerSettings),
    builtinAgentTools: providerAgentTools(
      buildToolRegistry(
        {
          workspacePath,
          repoRootPath: projectRoot,
          capabilityDispatcher: dispatchRuntime.dispatcher,
          ...(moduleOptions ? { moduleOptions } : {}),
        },
        toolModules,
      ),
    ),
    ...(options.webEvidence ? { webEvidence: options.webEvidence } : {}),
  })

  const store = new FileSystemSessionStore(workspacePath)
  // server/composition.ts:586-596 binds the session store to the registry.
  store.useExecutionJournalRegistry(executionJournalRegistry)
  const session = await store.createSession({ title: 'Live final answer' })
  const summary: SessionSummary = {
    id: session.id,
    title: 'Live final answer',
    status: 'active',
    activityType: 'chat',
    createdAt: '2026-09-27T09:00:00.000Z',
    updatedAt: '2026-09-27T09:00:00.000Z',
  }
  const hub = new AgentTextStreamHub()
  const wiring = agentChatTurnWiring({
    workspacePath,
    mcpAgentToolService,
    agentTextStreamHub: hub,
    executionJournalRegistry,
  })

  return {
    server,
    hub,
    workspacePath,
    sessionId: session.id,
    runTurn: (input) =>
      runSessionAgentChatTurn({
        sessionId: session.id,
        session: summary,
        sessionStore: store,
        repoRootPath: projectRoot,
        text: input.text ?? 'Write the notes, then tell me the answer.',
        agentNames: [agentName],
        turnId: input.turnId,
        ...wiring,
      }),
    close: async () => {
      await server.close().catch(() => undefined)
      // The runtime drains before the registry closes, the order
      // server/composition.ts:670-679 registers them in.
      await dispatchRuntime.close().catch(() => undefined)
      await executionJournalRegistry.close().catch(() => undefined)
      await mcpSettings.closeAll().catch(() => undefined)
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// Frames.

type DeltaFrame = Extract<AgentTextStreamFrame, { type: 'delta' }>

function isTextDelta(frame: AgentTextStreamFrame): frame is DeltaFrame {
  return frame.type === 'delta' && frame.channel === 'text'
}

function isTerminal(frame: AgentTextStreamFrame): boolean {
  return frame.type === 'final' || frame.type === 'error'
}

function streamedTexts(frames: readonly AgentTextStreamFrame[]): string[] {
  return frames.filter(isTextDelta).map((frame) => frame.text)
}

function framesOf(hub: AgentTextStreamHub, turnId: string): readonly AgentTextStreamFrame[] {
  const page = hub.read(turnId, 0)
  assert.ok(page, 'the turn channel must still be readable')
  return page.frames
}

/**
 * The channel's frames at the first moment `accept` holds.
 *
 * Captured inside the hub's own notification, synchronously with the publish
 * that satisfied it, so no later frame can reach the snapshot. `opened` must be
 * the hub's wait for this channel, registered before the turn starts.
 */
function snapshotWhen(
  hub: AgentTextStreamHub,
  channelId: string,
  opened: Promise<AgentTextStreamWaitResult>,
  accept: (frames: readonly AgentTextStreamFrame[]) => boolean,
  signal: AbortSignal,
): Promise<readonly AgentTextStreamFrame[]> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => {}
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      unsubscribe()
      reject(new Error('the test ended before the hub showed the expected frames'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const check = (): void => {
      if (settled) return
      const frames = hub.read(channelId, 0)?.frames ?? []
      if (!accept(frames)) return
      settled = true
      unsubscribe()
      signal.removeEventListener('abort', onAbort)
      resolve([...frames])
    }
    opened.then(
      (result) => {
        if (result !== 'opened') {
          settled = true
          reject(new Error(`the turn channel was never opened: ${result}`))
          return
        }
        unsubscribe = hub.subscribe(channelId, check)
        check()
      },
      (error: unknown) => {
        settled = true
        reject(error)
      },
    )
  })
}

async function savedReply(harness: Harness, turnId: string): Promise<ChatMessage> {
  // Read back through a store built fresh over the same workspace, the way the
  // transcript is read after a reload.
  const messages = await new FileSystemSessionStore(harness.workspacePath)
    .listChatMessages(harness.sessionId)
  const reply = messages.find(
    (message) => message.role === 'assistant' && message.turnId === turnId,
  )
  assert.ok(reply, `the reply for ${turnId} must be persisted`)
  return reply
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The `usage` of every `agent.turn.prepared` event in the reply's assignment
 * journal, read from the file on disk the way an operator report reads it
 * (tests/integration/agent-turn-journal-api.test.ts:316-336 reads the same
 * file).
 */
function persistedPreparedUsage(
  harness: Harness,
  turnId: string,
  assignmentId: string,
): unknown[] {
  return agentTurnPayloads(harness, turnId, assignmentId, 'agent.turn.prepared')
    .map((payload) => payload.usage)
}

/** The assignment journal file's raw text, as it is on disk. */
function journalText(harness: Harness, turnId: string, assignmentId: string): string {
  const location = buildSessionRunAssignmentLocation(harness.workspacePath, {
    sessionId: harness.sessionId,
    runId: turnId,
    assignmentId,
  })
  assert.ok(location, 'the reply names a valid assignment')
  return fs.readFileSync(
    path.join(
      location.assignmentPath,
      RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
      EXECUTION_JOURNAL_DIRECTORY_NAME,
      EXECUTION_JOURNAL_FILENAME,
    ),
    'utf8',
  )
}

/** The payload of every agent-turn event of one type in the reply's journal. */
function agentTurnPayloads(
  harness: Harness,
  turnId: string,
  assignmentId: string,
  type: string,
): Record<string, unknown>[] {
  const events: unknown[] = journalText(harness, turnId, assignmentId)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): unknown => JSON.parse(line))
  return events
    .filter(isRecord)
    .filter((event) => event.streamKind === 'agent.turn' && event.type === type)
    .map((event) => (isRecord(event.payload) ? event.payload : {}))
}

/**
 * The live path was active: more than one text delta, all before the terminal.
 *
 * Asserted by every test that checks a property of the streamed answer. Without
 * it those checks could pass because nothing streamed at all, which is what
 * 7289fc48 does.
 */
function assertStreamedLive(
  frames: readonly AgentTextStreamFrame[],
  label: string,
): string[] {
  const texts = streamedTexts(frames)
  assert.ok(
    texts.length > 1,
    `${label}: the answer must reach the hub as more than one delta as the provider streams it; ` +
      `got ${texts.length} delta(s): ${JSON.stringify(texts.map((text) => text.slice(0, 80)))}`,
  )
  const terminalIndex = frames.findIndex(isTerminal)
  const lastDeltaIndex = frames.map((frame) => isTextDelta(frame)).lastIndexOf(true)
  assert.ok(
    terminalIndex > lastDeltaIndex,
    `${label}: every delta must precede the reply's terminal frame`,
  )
  return texts
}

/**
 * Rejects when the turn does, and otherwise never settles.
 *
 * Raced against a hub wait, so a turn that throws before the hub shows
 * anything fails the test with its own error; the extra handler keeps a later
 * rejection from going unhandled.
 */
function rejectionOf(turn: Promise<unknown>): Promise<never> {
  const failure = turn.then(
    () => new Promise<never>(() => {}),
    (error: unknown) => {
      throw error
    },
  )
  failure.catch(() => undefined)
  return failure
}

// ---------------------------------------------------------------------------
// (a) R1, R3, R4: arrival timing, proved with a server-side gate.

test(
  'R1: the first streamed chunk reaches the chat hub while the provider still holds the rest of the answer',
  { timeout: 60_000 },
  async (t) => {
    const FIRST = 'The answer '
    const CHUNKS = [FIRST, 'is forty', '-two.']
    let releaseRest: () => void = () => {}
    const restHeld = new Promise<void>((resolve) => {
      releaseRest = resolve
    })
    // Whatever happens, the fake provider is never left holding a response.
    t.signal.addEventListener('abort', () => releaseRest(), { once: true })

    const harness = await startHarness({
      script: [
        { match: isFirstToolRound, toolCalls: [createFileCall('notes.md', '# Notes\n')] },
        { match: isLaterToolRound, content: DRAFT },
        // The first chunk goes out; the second, third and the terminal chunk
        // wait for the test.
        { match: isFinalRequest, deltas: CHUNKS, deltaGates: [Promise.resolve(), restHeld] },
      ],
    })
    const turnId = randomUUID()
    let turn: ReturnType<typeof harness.runTurn> | undefined
    try {
      const opened = harness.hub.waitForChannel(turnId, harness.sessionId, {
        timeoutMs: 60_000,
      })
      // Taken once the shown text is no longer a proper prefix of the first
      // chunk (so a chunk split into several deltas still counts as one), or
      // the reply has closed.
      const firstText = snapshotWhen(
        harness.hub,
        turnId,
        opened,
        (frames) => {
          const shown = streamedTexts(frames).join('')
          return (
            frames.some(isTerminal) ||
            (shown.length > 0 && (shown.length >= FIRST.length || !FIRST.startsWith(shown)))
          )
        },
        t.signal,
      )
      let turnSettled = false
      turn = harness.runTurn({ turnId })
      void turn.then(
        () => {
          turnSettled = true
        },
        () => {
          turnSettled = true
        },
      )

      const atFirstText = await Promise.race([firstText, rejectionOf(turn)])
      assert.equal(
        streamedTexts(atFirstText).join(''),
        FIRST,
        'while the provider holds the rest of its answer, the chat shows exactly the first streamed chunk',
      )
      assert.equal(
        atFirstText.some(isTerminal),
        false,
        'the reply is not closed while its answer is still arriving',
      )
      assert.equal(turnSettled, false, 'the turn is still running while the provider holds its answer')

      releaseRest()
      const result = await turn

      const frames = framesOf(harness.hub, turnId)
      const texts = assertStreamedLive(frames, 'R1')
      const answer = CHUNKS.join('')
      assert.equal(texts.join(''), answer, 'the hub ends with the complete answer')
      const terminal = frames.find(isTerminal)
      assert.ok(
        terminal?.type === 'final' && terminal.reason === 'completed',
        `the reply closes with a completed final frame: ${JSON.stringify(terminal)}`,
      )

      // R3: what the user watched is what is kept.
      const reply = await savedReply(harness, turnId)
      assert.equal(reply.text, answer, 'the saved reply equals the concatenated deltas')
      assert.equal(result.meta.replies[0]?.fallback, false)
      for (const text of [...texts, reply.text]) {
        assert.equal(text.includes(DRAFT), false, 'the tool-capable round\'s own text is never shown or kept')
      }

      // create_file really ran, inside this turn's assignment.
      assert.ok(
        reply.delivery?.artifacts.some((artifact) => artifact.path === 'files/notes.md'),
        `the reply delivers the created file: ${JSON.stringify(reply.delivery)}`,
      )
      const assignmentId = reply.execution?.assignmentId
      assert.ok(assignmentId, 'the reply points at its assignment')
      const location = buildSessionRunAssignmentLocation(harness.workspacePath, {
        sessionId: harness.sessionId,
        runId: turnId,
        assignmentId,
      })
      assert.ok(location)
      assert.equal(
        fs.readFileSync(path.join(location.assignmentPath, 'files', 'notes.md'), 'utf8'),
        '# Notes\n',
      )

      // R4: the streamed request is the answering round's request, with tools
      // unavailable and streaming on.
      const answering = harness.server.requests.filter(isLaterToolRound).at(-1)
      const final = harness.server.requests.find(isFinalRequest)
      assert.ok(answering && final, 'both the answering round and the final request were sent')
      assert.equal(final.stream, true, 'the final request streams')
      assert.equal(final.model, answering.model)
      assert.deepEqual(final.body.messages, answering.body.messages)
      assert.deepEqual(final.body.reasoning_effort, answering.body.reasoning_effort)
    } finally {
      releaseRest()
      await turn?.catch(() => undefined)
      await harness.close()
    }
  },
)

// ---------------------------------------------------------------------------
// (b) R2: a buffered tool-capable round with prose and tool calls publishes
// nothing.

test(
  'R2: a buffered tool-capable round that returns prose together with tool calls publishes none of that prose',
  { timeout: 60_000 },
  async () => {
    const PLANNING = ['PLANNING: I will first ', 'write the notes file.']
    const CHUNKS = ['Done: ', 'notes are attached.']
    const harness = await startHarness({
      script: [
        // Prose and a tool call in the same round. The tool-capable request
        // does not ask to stream, so the round arrives as one message with
        // both.
        {
          match: isFirstToolRound,
          deltas: PLANNING,
          toolCalls: [createFileCall('plan.md', '# Plan\n')],
        },
        { match: isLaterToolRound, content: DRAFT },
        { match: isFinalRequest, deltas: CHUNKS },
      ],
    })
    const turnId = randomUUID()
    try {
      await harness.runTurn({ turnId })

      const frames = framesOf(harness.hub, turnId)
      const texts = assertStreamedLive(frames, 'R2')
      const reply = await savedReply(harness, turnId)
      assert.equal(texts.join(''), CHUNKS.join(''))
      assert.equal(reply.text, CHUNKS.join(''))

      // The hub keeps every frame of this short turn, so this is every
      // publication the round could have made, at any point during it.
      assert.deepEqual(
        frames.filter((frame) => JSON.stringify(frame).includes('PLANNING')),
        [],
        'no frame carries the tool-capable round\'s prose',
      )
      assert.equal(reply.text.includes('PLANNING'), false, 'the saved reply carries none of it')
    } finally {
      await harness.close()
    }
  },
)

// ---------------------------------------------------------------------------
// (c) R5: reserved finalization. The last slot of the round budget belongs to
// the streamed, tool-free answer.

/** How the fake provider saw one request, for comparing whole sequences. */
function requestKind(request: FakeChatCompletionsRequest): string {
  if (offersTools(request)) return 'tool-capable'
  return request.stream ? 'tool-free, streamed' : 'tool-free, not streamed'
}

test(
  'R5: tool-capable rounds use at most MAX_PROVIDER_ROUNDS - 1 requests, and the last slot of the budget is always the streamed tool-free answer',
  { timeout: 60_000 },
  async () => {
    const CHUNKS = ['Seven files ', 'are attached.']
    const harness = await startHarness({
      script: [
        // The provider asks for create_file in every tool-capable round, so it
        // never decides to answer by itself. Tool-capable request k (1-based)
        // reports prompt 100 + k and completion k. The eighth exists only for a
        // loop that offers tools in the last slot; the contract never reaches
        // it.
        ...Array.from({ length: MAX_PROVIDER_ROUNDS }, (_, index): FakeChatCompletionsTurn => ({
          match: offersTools,
          toolCalls: [createFileCall(`part-${index + 1}.md`, `# Part ${index + 1}\n`)],
          usage: { promptTokens: 100 + index + 1, completionTokens: index + 1 },
        })),
        { match: isFinalRequest, deltas: CHUNKS, usage: { promptTokens: 1000, completionTokens: 50 } },
      ],
    })
    const turnId = randomUUID()
    try {
      await harness.runTurn({ turnId })

      assert.deepEqual(
        harness.server.requests.map(requestKind),
        [
          ...Array.from({ length: MAX_PROVIDER_ROUNDS - 1 }, () => 'tool-capable'),
          'tool-free, streamed',
        ],
        `exactly ${MAX_PROVIDER_ROUNDS} requests reach the provider: ` +
          `${MAX_PROVIDER_ROUNDS - 1} tool-capable rounds, then the streamed tool-free answer in the reserved last slot`,
      )

      const frames = framesOf(harness.hub, turnId)
      const texts = assertStreamedLive(frames, 'R5')
      assert.equal(texts.join(''), CHUNKS.join(''))

      // The turn's usage, as the prepared record persisted it. Worked out by
      // hand from the script above, over the seven tool-capable requests
      // (k = 1..7) and the final one:
      //   input  = (101 + 102 + ... + 107) + 1000 = 728 + 1000 = 1728
      //   output = (1 + 2 + ... + 7) + 50         =  28 +   50 =   78
      //   total  = 1728 + 78                                   = 1806
      const reply = await savedReply(harness, turnId)
      const assignmentId = reply.execution?.assignmentId
      assert.ok(assignmentId, 'the reply points at its assignment')
      assert.deepEqual(
        persistedPreparedUsage(harness, turnId, assignmentId),
        [{ inputTokens: 1728, outputTokens: 78, totalTokens: 1806 }],
        'one prepared record, whose usage counts every request the turn sent, the final one included',
      )
    } finally {
      await harness.close()
    }
  },
)

// ---------------------------------------------------------------------------
// (d) R6: the response byte bound covers the whole streamed body.

test(
  'R6: a streamed final answer larger than the response bound fails the turn, though every frame is small',
  { timeout: 60_000 },
  async () => {
    // 16 KiB per frame, 2 MiB + 128 KiB in total: over the adapter's default
    // 2 MiB response bound only when the frames are counted together.
    const FRAME = 'x'.repeat(16 * 1024)
    const frameCount = 136
    const harness = await startHarness({
      script: [
        { match: offersTools, content: DRAFT },
        { match: isFinalRequest, deltas: Array.from({ length: frameCount }, () => FRAME) },
      ],
    })
    const turnId = randomUUID()
    try {
      const result = await harness.runTurn({ turnId })

      // Without the streamed final request the oversize body is never asked
      // for, and the bound on it is untested.
      assert.deepEqual(
        harness.server.requests.map(requestKind),
        ['tool-capable', 'tool-free, streamed'],
        'R6: the answer is asked for as a streamed, tool-free final request',
      )
      assert.equal(
        result.meta.replies[0]?.fallback,
        true,
        'an oversize streamed answer is a provider failure, as for any other round',
      )
      const frames = framesOf(harness.hub, turnId)
      const terminal = frames.find(isTerminal)
      assert.equal(terminal?.type, 'error', 'the reply closes as an error, not as a completed answer')
      const reply = await savedReply(harness, turnId)
      assert.equal(reply.text.includes(FRAME.slice(0, 64)), false, 'no part of the oversize answer is kept')
    } finally {
      await harness.close()
    }
  },
)

// ---------------------------------------------------------------------------
// (e) R8: shadow telemetry compares the complete displayed answer.

/**
 * The page Research Web acquires, on loopback. See the stand-in note in
 * `startHarness`: this replaces the public site at the far end of acquisition
 * and nothing else.
 */
async function startSourcePage(): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end([
      '<!doctype html><html><head><title>Washtenaw Dairy</title></head><body><main>',
      '<h1>Washtenaw Dairy</h1><p>Washtenaw Dairy makes ice cream in Ann Arbor. ',
      'The dairy has sold hand-dipped ice cream and fresh donuts from its shop on ',
      'Ashley Street for decades, and its seasonal flavours change through the year. ',
      'This page carries enough prose to pass acquisition without a browser fallback.</p>',
      '</main></body></html>',
    ].join(''))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    url: `http://127.0.0.1:${address.port}/washtenaw`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

test(
  'R8: shadow web-evidence telemetry compares the complete streamed answer, not its first delta',
  { timeout: 60_000 },
  async () => {
    const source = await startSourcePage()
    const CHUNKS = [
      'Washtenaw Dairy makes ice cream in Ann Arbor ',
      `([source](${source.url})).`,
    ]
    const captured: WebEvidenceValidationInput[] = []
    let harness: Harness | undefined
    try {
      harness = await startHarness({
        agentName: 'web-researcher',
        agentTools: 'research_web',
        researchWeb: true,
        // The same public port the service-level shadow tests capture through
        // (tests/integration/mcp-cli-agent-tool-service.test.ts:1491-1504).
        webEvidence: {
          config: parseWebEvidenceRolloutConfig({ links: 'shadow' }),
          resolveRecorder: async () => ({
            recordValidation: async (input) => {
              captured.push(input)
            },
            release: async () => undefined,
          }),
        },
        script: [
          {
            match: isFirstToolRound,
            toolCalls: [
              { id: 'call-acquire', name: 'research_web', arguments: { action: 'acquire', url: source.url } },
            ],
          },
          { match: isLaterToolRound, content: DRAFT },
          { match: isFinalRequest, deltas: CHUNKS },
        ],
      })
      const turnId = randomUUID()
      await harness.runTurn({ turnId, text: 'Who makes ice cream in Ann Arbor?' })

      const frames = framesOf(harness.hub, turnId)
      const texts = assertStreamedLive(frames, 'R8')
      assert.equal(texts.join(''), CHUNKS.join(''), 'shadow mode shows the candidate as it streams')

      assert.deepEqual(
        captured.map((record) => ({
          mode: record.mode,
          observedUrlCount: record.observedUrlCount,
          displayedDiffersFromCandidate: record.displayedDiffersFromCandidate,
        })),
        [{ mode: 'shadow', observedUrlCount: 1, displayedDiffersFromCandidate: false }],
        'one shadow record for the turn, over the one acquired source; the display stream ' +
          'showed the whole candidate, so the metric must not report a difference',
      )
    } finally {
      await harness?.close()
      await source.close()
    }
  },
)

// ---------------------------------------------------------------------------
// (f) R6: a failure inside the streamed final request is classified the way
// every other provider failure is, keeps the provider's prose out of the chat,
// and closes the provider connection.

/**
 * Provider wording that must stay behind. Each failure message below carries
 * it, as real providers put account names and key fragments in their prose.
 */
const PROSE_MARKER = 'org-PROSE-7Q41'

function errorFrame(error: Readonly<Record<string, unknown>>): string {
  return `data: ${JSON.stringify({ error })}\n\n`
}

/** Journal fields a failure's classification is read from. */
function classificationOf(failure: unknown): Record<string, unknown> {
  assert.ok(isRecord(failure), `the failed turn records its failure: ${JSON.stringify(failure)}`)
  return {
    serviceCode: failure.serviceCode,
    providerKind: failure.providerKind,
    providerCode: failure.providerCode,
    httpStatus: failure.httpStatus,
    retryable: failure.retryable,
  }
}

/**
 * Runs a turn whose final request fails as `failure` describes, and returns
 * what the chat, the journal and the provider saw.
 */
async function runFailingFinalRequest(
  failure: NonNullable<FakeChatCompletionsTurn['streamFailure']>,
): Promise<{
  readonly classification: Record<string, unknown>
  readonly replyText: string
  readonly frames: readonly AgentTextStreamFrame[]
  readonly journal: string
  readonly finalClosedByClient: boolean
  readonly requestKinds: readonly string[]
}> {
  const harness = await startHarness({
    script: [
      { match: isFirstToolRound, toolCalls: [createFileCall('notes.md', '# Notes\n')] },
      { match: isLaterToolRound, content: DRAFT },
      { match: isFinalRequest, deltas: ['The answer ', 'starts here'], streamFailure: failure },
    ],
  })
  const turnId = randomUUID()
  try {
    const result = await harness.runTurn({ turnId })
    assert.equal(result.meta.replies[0]?.fallback, true, 'the failed final request fails the reply')

    // One more request to the same server, on a new connection, before the
    // connection of the final request is inspected. A client that closed that
    // connection did so before the turn returned, so its FIN or reset is read
    // before this request's bytes are.
    const sentinel = await fetch(`${harness.server.url}/v1/models`)
    await sentinel.text()
    const finalIndex = harness.server.requests.findIndex(isFinalRequest)
    assert.notEqual(finalIndex, -1, 'the final request was sent')

    const reply = await savedReply(harness, turnId)
    const assignmentId = reply.execution?.assignmentId
    assert.ok(assignmentId, 'the reply points at its assignment')
    const failed = agentTurnPayloads(harness, turnId, assignmentId, 'agent.turn.failed')
    assert.equal(failed.length, 1, 'one failed record for the turn')
    return {
      classification: classificationOf(failed[0]?.failure),
      replyText: reply.text,
      frames: framesOf(harness.hub, turnId),
      journal: journalText(harness, turnId, assignmentId),
      finalClosedByClient: harness.server.closedByClient(finalIndex),
      requestKinds: harness.server.requests.map(requestKind),
    }
  } finally {
    await harness.close()
  }
}

function assertNoProviderProse(outcome: {
  readonly replyText: string
  readonly frames: readonly AgentTextStreamFrame[]
  readonly journal: string
}): void {
  assert.equal(outcome.replyText.includes(PROSE_MARKER), false, 'the saved reply carries no provider prose')
  assert.equal(
    JSON.stringify(outcome.frames).includes(PROSE_MARKER),
    false,
    'no chat frame, the error frame included, carries provider prose',
  )
  assert.equal(outcome.journal.includes(PROSE_MARKER), false, 'the journal carries no provider prose')
}

const STREAMED_PROVIDER_ERRORS = [
  {
    label: 'an exhausted quota is billing, and not retryable',
    error: {
      message: `You exceeded your current quota, please check your plan and billing details. Organization ${PROSE_MARKER}.`,
      type: 'insufficient_quota',
      code: 'insufficient_quota',
    },
    classification: {
      serviceCode: 'provider_failed',
      providerKind: 'billing',
      providerCode: 'insufficient_quota',
      httpStatus: undefined,
      retryable: false,
    },
  },
  {
    label: 'a rejected key is authentication, and not retryable',
    error: {
      message: `Incorrect API key provided: sk-${PROSE_MARKER}. You can find your API key in your account settings.`,
      type: 'invalid_request_error',
      code: 'invalid_api_key',
    },
    classification: {
      serviceCode: 'provider_failed',
      providerKind: 'authentication',
      providerCode: 'invalid_api_key',
      httpStatus: undefined,
      retryable: false,
    },
  },
  {
    label: 'a rate limit stays retryable',
    error: {
      message: `Rate limit reached for requests in organization ${PROSE_MARKER}. Please try again later.`,
      type: 'requests',
      code: 'rate_limit_exceeded',
    },
    classification: {
      serviceCode: 'provider_failed',
      providerKind: 'rate_limit',
      providerCode: 'rate_limit_exceeded',
      httpStatus: undefined,
      retryable: true,
    },
  },
] as const

for (const scenario of STREAMED_PROVIDER_ERRORS) {
  test(
    `R6: an error frame under HTTP 200 on the final request keeps its classification (${scenario.label}), keeps its prose out, and closes the connection`,
    { timeout: 60_000 },
    async () => {
      // The provider sends part of the answer, then the error, and keeps the
      // response open, so only the client can close the connection.
      const outcome = await runFailingFinalRequest({
        bytes: errorFrame(scenario.error),
        then: 'hold',
      })

      assert.deepEqual(
        outcome.requestKinds,
        ['tool-capable', 'tool-capable', 'tool-free, streamed'],
        'the error arrived on the streamed tool-free final request',
      )
      assert.deepEqual(
        outcome.classification,
        scenario.classification,
        'the recorded failure is the shared provider classification of the streamed error',
      )
      assertNoProviderProse(outcome)
      const terminal = outcome.frames.find(isTerminal)
      assert.equal(terminal?.type, 'error', 'the reply closes as an error')
      assert.equal(
        outcome.finalClosedByClient,
        true,
        'the client closed the connection of the failed final request',
      )
    },
  )
}

test(
  'R6: a malformed frame on the final request is a sanitized retryable failure, and the connection is closed',
  { timeout: 60_000 },
  async () => {
    const outcome = await runFailingFinalRequest({
      bytes: `data: {"choices":[{"delta":{"content":"${PROSE_MARKER}"\n\n`,
      then: 'hold',
    })

    assert.deepEqual(outcome.classification, {
      serviceCode: 'provider_failed',
      providerKind: undefined,
      providerCode: undefined,
      httpStatus: undefined,
      retryable: true,
    })
    assertNoProviderProse(outcome)
    assert.equal(
      outcome.finalClosedByClient,
      true,
      'the client closed the connection of the failed final request',
    )
  },
)

test(
  'R6: a final stream that ends part-way through a frame is a sanitized retryable failure',
  { timeout: 60_000 },
  async () => {
    const outcome = await runFailingFinalRequest({
      bytes: `data: {"choices":[{"delta":{"content":"${PROSE_MARKER}`,
      then: 'end',
    })

    assert.deepEqual(outcome.classification, {
      serviceCode: 'provider_failed',
      providerKind: undefined,
      providerCode: undefined,
      httpStatus: undefined,
      retryable: true,
    })
    assertNoProviderProse(outcome)
  },
)

// ---------------------------------------------------------------------------
// (g) R6: truncation of the streamed final request.

test(
  'R6: a streamed final answer that stops at its token limit closes as truncated, and no answer is kept',
  { timeout: 60_000 },
  async () => {
    const CHUNKS = ['The answer ', 'beg']
    const harness = await startHarness({
      script: [
        { match: isFirstToolRound, toolCalls: [createFileCall('notes.md', '# Notes\n')] },
        { match: isLaterToolRound, content: DRAFT },
        { match: isFinalRequest, deltas: CHUNKS, finishReason: 'length' },
      ],
    })
    const turnId = randomUUID()
    try {
      const result = await harness.runTurn({ turnId })

      assert.deepEqual(
        harness.server.requests.map(requestKind),
        ['tool-capable', 'tool-capable', 'tool-free, streamed'],
      )
      const frames = framesOf(harness.hub, turnId)
      const texts = assertStreamedLive(frames, 'truncation')
      assert.equal(texts.join(''), CHUNKS.join(''), 'the partial answer was shown as it arrived')
      const terminal = frames.find(isTerminal)
      assert.ok(
        terminal?.type === 'final' && terminal.reason === 'truncated',
        `the reply closes as truncated, not completed: ${JSON.stringify(terminal)}`,
      )

      assert.equal(result.meta.replies[0]?.fallback, true, 'a truncated answer is not an answer')
      const reply = await savedReply(harness, turnId)
      assert.equal(reply.text.includes(CHUNKS.join('')), false, 'the partial answer is not kept as the reply')
      const assignmentId = reply.execution?.assignmentId
      assert.ok(assignmentId, 'the reply points at its assignment')
      assert.deepEqual(
        agentTurnPayloads(harness, turnId, assignmentId, 'agent.turn.failed')
          .map((payload) => classificationOf(payload.failure).serviceCode),
        ['provider_truncated'],
        'the journal records the truncation under its own code',
      )
    } finally {
      await harness.close()
    }
  },
)

// ---------------------------------------------------------------------------
// (h) Owner decision 2026-09-27: an explicitly configured Ollama connection
// keeps the buffered route. Ollama's OpenAI-compatible endpoint has no
// `tool_choice`, so a tool-free final request cannot forbid tools there.

test(
  'Ollama: a configured Ollama connection keeps one buffered request per round and shows the answering round whole',
  { timeout: 60_000 },
  async () => {
    const ANSWER = 'The notes are written; the answer is forty-two.'
    const harness = await startHarness({
      connectionKind: 'ollama',
      script: [
        { match: isFirstToolRound, toolCalls: [createFileCall('notes.md', '# Notes\n')] },
        { match: isLaterToolRound, content: ANSWER },
        // Reached only by a route that sends a tool-free final request.
        { match: isFinalRequest, deltas: ['NOT-', 'ASKED'] },
      ],
    })
    const turnId = randomUUID()
    try {
      const result = await harness.runTurn({ turnId })

      assert.deepEqual(
        harness.server.requests.map((request) => ({
          tool_choice: request.body.tool_choice,
          stream: request.stream,
        })),
        [
          { tool_choice: 'auto', stream: false },
          { tool_choice: 'auto', stream: false },
        ],
        'one buffered, tool-capable request per round, and no tool-free final request',
      )

      const frames = framesOf(harness.hub, turnId)
      assert.deepEqual(streamedTexts(frames), [ANSWER], 'the answering round is shown whole, once')
      const terminal = frames.find(isTerminal)
      assert.ok(
        terminal?.type === 'final' && terminal.reason === 'completed',
        `the reply closes completed: ${JSON.stringify(terminal)}`,
      )
      assert.equal(result.meta.replies[0]?.fallback, false)
      const reply = await savedReply(harness, turnId)
      assert.equal(reply.text, ANSWER)
      assert.ok(
        reply.delivery?.artifacts.some((artifact) => artifact.path === 'files/notes.md'),
        `the reply delivers the created file: ${JSON.stringify(reply.delivery)}`,
      )
    } finally {
      await harness.close()
    }
  },
)
