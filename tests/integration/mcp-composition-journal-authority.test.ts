import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { readExecutionJournal } from '../../core/execution-journal.js'
import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import {
  startOpenAiToolLoopFixture,
  type OpenAiToolLoopFixture,
} from '../support/openai-tool-loop-fixture.js'

/**
 * Branch 1, Package 1b — outer acceptance (J1). One coherent outcome: the
 * production composition supplies durable journal authority to MCP broker
 * dispatch while the effect executes exactly once.
 *
 * Everything here is the existing production path, unchanged: `startApiServer`
 * builds the services, the settings/grant/agent-chat HTTP APIs configure and
 * drive one real provider-to-MCP turn, the real OpenAI-compatible provider
 * fixture issues the tool call, and the real stdio MCP fixture executes it.
 * The chat turn's MCP dispatch runs in the parent process through
 * `McpParentBroker` for the session-layout chat assignment the session store
 * creates per turn.
 *
 * The evidence-view row matrix belongs to the focused inner test, not this
 * outer journey.
 */

const repoRoot = process.cwd()
const stdioFixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'mcp',
  'stdio-server.mjs',
)
const MCP_SERVER_ID = 'journal-authority-fixture'
const EXPECTED_MARKER = 'provider-loop-marker'
const FIXTURE_READY_TIMEOUT_MS = 10_000

test('the composition supplies journal authority to MCP broker dispatch', {
  timeout: 30_000,
}, async (t) => {
  const previousJournalMode = process.env.PIPELINE_DURABLE_JOURNAL
  process.env.PIPELINE_DURABLE_JOURNAL = 'authoritative'
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-composition-journal-')),
  )
  let providerFixture: OpenAiToolLoopFixture | undefined
  let server: StartedApiServer | undefined
  // Registered before any resource is acquired, so cleanup runs even when
  // setup or the server close fails. The nested finally attempts each step
  // in order — server, fixture, directory — without suppressing any error.
  t.after(async () => {
    try {
      if (server) await server.close()
    } finally {
      try {
        if (providerFixture) await providerFixture.close()
      } finally {
        try {
          fs.rmSync(directory, { recursive: true, force: true })
        } finally {
          if (previousJournalMode === undefined) {
            delete process.env.PIPELINE_DURABLE_JOURNAL
          } else {
            process.env.PIPELINE_DURABLE_JOURNAL = previousJournalMode
          }
        }
      }
    }
  })
  const projectRoot = path.join(directory, 'project')
  const workspacePath = path.join(directory, 'workspace')
  const lifecyclePath = path.join(directory, 'mcp-lifecycle.jsonl')
  const callsPath = path.join(directory, 'mcp-calls.jsonl')

  providerFixture = await startOpenAiToolLoopFixture(repoRoot)
  const providerSettingsService = new ProviderSettingsService({
    storagePath: path.join(directory, 'provider-settings.json'),
    secretCodec: base64Codec,
  })
  const providerConnection = await providerSettingsService.saveConnection({
    kind: 'openai-compatible',
    name: 'Tool-loop fixture',
    baseUrl: `${providerFixture.url}/v1`,
    apiKey: 'fixture-provider-secret',
    enabled: true,
  })
  const validatedProvider = await providerSettingsService.validateConnection(
    providerConnection.id,
  )
  assert.equal(validatedProvider.status, 'connected')
  await providerSettingsService.setModelEnabled(
    providerConnection.id,
    'fixture/tool-loop',
    true,
  )
  const provider = configuredProviderName(providerConnection.id)
  createAgent(projectRoot, 'tool-agent', provider, 'fixture/tool-loop')

  const mcpSettingsService = new McpSettingsService({
    storagePath: path.join(directory, 'mcp-settings.json'),
    secretCodec: base64Codec,
    clientManager: new McpClientManager({
      connectTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
      closeTimeoutMs: 1_000,
    }),
  })

  server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new PiRunLauncher(),
    sessionStore: new FileSystemSessionStore(workspacePath),
    repoRootPath: projectRoot,
    workspacePath,
    providerSettingsService,
    mcpSettingsService,
  })

  await createAndValidateMcp(server.url, lifecyclePath, callsPath)
  await waitForLifecycleReady(lifecyclePath, FIXTURE_READY_TIMEOUT_MS)

  const sessionResponse = await fetch(`${server.url}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Journal authority' }),
  })
  assert.equal(sessionResponse.status, 201)
  const sessionId = narrowSessionId(await sessionResponse.json())

  const grantResponse = await fetch(
    `${server.url}/create/agents/tool-agent/mcp-grants`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: MCP_SERVER_ID, enabled: true }),
    },
  )
  assert.equal(grantResponse.status, 200)

  // The real provider-to-MCP turn: the fixture model issues one echo-marker
  // call, the broker dispatches it, the stdio fixture executes it. A
  // successful turn answers 201 (server/routes/sessions.ts:538).
  const chatResponse = await postAgentChat(server.url, sessionId)
  if (chatResponse.status !== 201) {
    const failureBody = await chatResponse.text()
    assert.fail(
      `the agent-chat request must succeed; got ${chatResponse.status}: ${failureBody}`,
    )
  }
  const chatBody: unknown = await chatResponse.json()
  const turn = narrowAgentChatTurn(chatBody)
  assert.ok(
    turn.replyText.includes('provider-consumed:echo-marker'),
    `the provider must consume the MCP result; got: ${turn.replyText}`,
  )
  assert.equal(
    turn.executedToolCallCount,
    1,
    'the turn must execute exactly one MCP tool call',
  )

  // The external effect happened exactly once, through the real stdio
  // transport: one recorded echo-marker call carrying the provider marker.
  const calls = readJsonLines(callsPath)
  const effectCallCount = calls.filter(isExpectedEffectCall).length
  assert.equal(
    effectCallCount,
    1,
    `the MCP effect must execute exactly once; recorded ${calls.length} call(s)`,
  )

  // The acceptance contract: the composition supplied journal authority, so
  // the chat assignment carries the dispatch's canonical stream.
  const assignmentPath = discoverChatAssignmentPath(workspacePath, sessionId)
  const journal = await readExecutionJournal(assignmentPath)
  assert.equal(
    journal.kind,
    'ok',
    'the composition must supply journal authority to MCP broker dispatch, ' +
      `but the chat assignment journal read returned '${journal.kind}'` +
      (journal.kind === 'corrupt' ? ` (${journal.reason})` : '') +
      ' — the broker construction path provides no durable port',
  )
  if (journal.kind !== 'ok') return

  const dispatchTypes = journal.events
    .filter((event) => event.streamKind === 'capability.dispatch')
    .map((event) => event.type)
  for (const barrier of [
    'capability.dispatch.prepared',
    'capability.dispatch.started',
    'capability.dispatch.accepted',
  ]) {
    assert.ok(
      dispatchTypes.includes(barrier),
      `the assignment journal must carry ${barrier} for the broker dispatch; ` +
        `recorded dispatch events: ${JSON.stringify(dispatchTypes)}`,
    )
  }
})

const base64Codec = {
  encrypt(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64')
  },
  decrypt(value: string): string {
    return Buffer.from(value, 'base64').toString('utf8')
  },
}

function createAgent(
  root: string,
  name: string,
  provider: string,
  model: string,
): void {
  const agentDirectory = path.join(root, 'agents', name)
  fs.mkdirSync(agentDirectory, { recursive: true })
  fs.writeFileSync(
    path.join(agentDirectory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      'tier: strategic',
      `provider: ${provider}`,
      `model: ${model}`,
      'thinking: low',
      '---',
      '',
      `# ${name}`,
      '',
      'Use tools when they can provide verifiable evidence.',
      '',
    ].join('\n'),
    'utf8',
  )
}

async function createAndValidateMcp(
  baseUrl: string,
  lifecyclePath: string,
  callsPath: string,
): Promise<void> {
  const created = await fetch(`${baseUrl}/settings/mcps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: MCP_SERVER_ID,
      name: 'Journal authority fixture',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [stdioFixturePath],
        cwd: repoRoot,
        secretEnvironment: {
          MCP_FIXTURE_LIFECYCLE_PATH: {
            operation: 'replace',
            value: lifecyclePath,
          },
          MCP_FIXTURE_CALLS_PATH: {
            operation: 'replace',
            value: callsPath,
          },
        },
      },
    }),
  })
  assert.equal(created.status, 201)
  const validated = await fetch(
    `${baseUrl}/settings/mcps/${MCP_SERVER_ID}/validate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stdioTrustAcknowledged: true }),
    },
  )
  assert.equal(validated.status, 200)
}

function postAgentChat(baseUrl: string, sessionId: string): Promise<Response> {
  return fetch(`${baseUrl}/sessions/${sessionId}/agent-chat/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'Use the available marker tool and return its result.',
      agentNames: ['tool-agent'],
    }),
  })
}

/**
 * One chat message produces one turn, and the session store creates exactly
 * one MCP chat assignment per turn under the session-layout path, so each
 * level holds a single entry; anything else is a harness fault, failed
 * explicitly rather than indexed blindly.
 */
function discoverChatAssignmentPath(
  workspacePath: string,
  sessionId: string,
): string {
  const runsRoot = path.join(workspacePath, 'sessions', sessionId, 'runs')
  const runs = fs.readdirSync(runsRoot)
  const [runId] = runs
  if (runs.length !== 1 || runId === undefined) {
    throw new Error(`one turn must create exactly one run; got ${JSON.stringify(runs)}`)
  }
  const assignmentsRoot = path.join(runsRoot, runId, 'assignments')
  const assignments = fs.readdirSync(assignmentsRoot)
  const [assignmentId] = assignments
  if (assignments.length !== 1 || assignmentId === undefined) {
    throw new Error(
      `one turn must create exactly one chat assignment; got ${JSON.stringify(assignments)}`,
    )
  }
  return path.join(assignmentsRoot, assignmentId)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
}

function narrowSessionId(parsed: unknown): string {
  if (!isRecord(parsed)) {
    throw new Error('the session response body is not an object')
  }
  const id = parsed['id']
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('the session response body is missing a string id')
  }
  return id
}

interface AgentChatTurn {
  readonly replyText: string
  readonly executedToolCallCount?: number
}

function narrowAgentChatTurn(parsed: unknown): AgentChatTurn {
  if (!isRecord(parsed)) {
    throw new Error('the agent-chat response body is not an object')
  }
  const replies = parsed['replies']
  if (!Array.isArray(replies)) {
    throw new Error('the agent-chat response body is missing a replies array')
  }
  const [firstReply] = replies
  if (!isRecord(firstReply)) {
    throw new Error('the chat turn produced no reply object')
  }
  const text = firstReply['text']
  if (typeof text !== 'string') {
    throw new Error('the chat reply is missing a string text')
  }

  let executedToolCallCount: number | undefined
  const meta = parsed['meta']
  if (isRecord(meta) && Array.isArray(meta['replies'])) {
    const [firstMeta] = meta['replies']
    if (isRecord(firstMeta) && isRecord(firstMeta['mcp'])) {
      const executed = firstMeta['mcp']['executedToolCallCount']
      if (typeof executed === 'number' && Number.isFinite(executed)) {
        executedToolCallCount = executed
      }
    }
  }
  return {
    replyText: text,
    ...(executedToolCallCount === undefined ? {} : { executedToolCallCount }),
  }
}

function isExpectedEffectCall(row: unknown): boolean {
  return (
    isRecord(row) &&
    row['tool'] === 'echo-marker' &&
    row['marker'] === EXPECTED_MARKER
  )
}

function readJsonLines(filePath: string): unknown[] {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return []
    throw error
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line)
      return parsed
    })
}

/**
 * The one pre-response readiness signal: the stdio fixture records `ready`
 * once connected. Event-based on the containing directory (the file may not
 * exist yet), bounded by a deadline instead of polling. The re-check after
 * the watcher is installed closes the race between the first check and the
 * registration; `finish` makes resolution and timeout cleanup idempotent.
 */
function waitForLifecycleReady(
  filePath: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ready = (row: unknown) => isRecord(row) && row['event'] === 'ready'
    const satisfied = () => readJsonLines(filePath).some(ready)
    let watcher: fs.FSWatcher | undefined
    let timer: NodeJS.Timeout | undefined
    let settled = false
    const finish = (outcome: () => void) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      watcher?.close()
      outcome()
    }
    const succeed = () => finish(resolve)
    const checkSatisfied = () => {
      if (satisfied()) succeed()
    }
    checkSatisfied()
    if (settled) return
    timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(`Timed out waiting for the MCP fixture ready event (${filePath})`),
        ),
      )
    }, timeoutMs)
    try {
      watcher = fs.watch(path.dirname(filePath), checkSatisfied)
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))))
      return
    }
    // A write that lands between the first check and the watcher registration
    // fires no event; re-check once the watcher exists.
    checkSatisfied()
  })
}
