/**
 * A selected agent's reply must leave durable evidence even when the provider
 * fails before it ever asks for a tool.
 *
 * The user sees a terminal chat response either way, so a turn that produced
 * nothing but a safe failure message and no assignment journal is indistinguish-
 * able from a turn that never started. This journey drives the whole stack:
 * the real API, a real workspace, a real authoritative journal, and a loopback
 * OpenAI-compatible endpoint that answers 503 before any tool call.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import {
  EXECUTION_JOURNAL_DIRECTORY_NAME,
  EXECUTION_JOURNAL_FILENAME,
} from '../../core/execution-journal.js'
import { RUN_PRIVATE_RUNTIME_DIRECTORY_NAME } from '../../core/run-assignment-location.js'

/** Never journaled: it is the credential the loopback endpoint was given. */
const PROVIDER_API_KEY = 'quick-scout-provider-secret-8fc21'
/** Never journaled: it is raw provider prose. */
const PROVIDER_RAW_MESSAGE =
  'Upstream capacity for tenant zeta-9 is exhausted; retry later.'
/** Never journaled: it is the user's prompt. */
const USER_PROMPT =
  'Scout the market for portable espresso makers under 200 euro.'

const MODEL_ID = 'fixture/quick-scout'

interface LoopbackProvider {
  readonly url: string
  readonly completionRequests: number
  close(): Promise<void>
}

/**
 * An OpenAI-compatible endpoint that lists one model and then refuses every
 * completion with a structured 503. The refusal body carries a recognizable
 * provider code and a raw message, so the journal can be checked for both the
 * identity it must keep and the prose it must not.
 */
async function startRefusingProvider(): Promise<LoopbackProvider> {
  let completionRequests = 0
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: MODEL_ID, object: 'model' }],
        }),
      )
      return
    }
    if (url.pathname.endsWith('/chat/completions')) {
      completionRequests += 1
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: PROVIDER_RAW_MESSAGE,
            type: 'service_unavailable',
            code: 'model_overloaded',
          },
        }),
      )
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Loopback provider failed to bind')
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    get completionRequests() {
      return completionRequests
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

const base64Codec = {
  encrypt: (value: string) => Buffer.from(value, 'utf8').toString('base64'),
  decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8'),
}

function writeQuickScoutAgent(
  repoRoot: string,
  provider: string,
  model: string,
): void {
  const directory = path.join(repoRoot, 'agents', 'quick-scout')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, 'quick-scout.md'),
    [
      '---',
      'name: quick-scout',
      'tier: strategic',
      `provider: ${provider}`,
      `model: ${model}`,
      'thinking: low',
      'tools: generate_word',
      '---',
      '',
      '# quick-scout',
      '',
      'Scout a topic and report what the evidence supports.',
      '',
    ].join('\n'),
    'utf8',
  )
}

interface AgentChatReply {
  readonly id: string
  readonly text: string
  readonly execution?: { readonly runId: string; readonly assignmentId: string }
}

interface AgentChatTurnResponse {
  readonly replies: readonly AgentChatReply[]
  readonly meta: { readonly replies: readonly { readonly fallback: boolean }[] }
}

interface AgentTurnReport {
  readonly assignmentId: string
  readonly turnId: string
  readonly replyId: string
  readonly state: string
  readonly route?: string
  readonly assistantMessageId?: string
  readonly failure?: {
    readonly layer: string
    readonly phase: string
    readonly serviceCode: string
    readonly providerKind?: string
    readonly providerCode?: string
    readonly provider?: string
    readonly model?: string
    readonly httpStatus?: number
    readonly retryable: boolean
  }
}

interface InspectionReport {
  readonly kind: string
  readonly unresolved: readonly unknown[]
  readonly agentTurns?: readonly AgentTurnReport[]
}

test('a selected agent turn that fails before any tool call is journaled start to terminal', async () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'agent-turn-journal-api-')),
  )
  const repoRootPath = path.join(directory, 'project')
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(repoRootPath, { recursive: true })
  fs.mkdirSync(workspacePath, { recursive: true })

  const provider = await startRefusingProvider()
  const providerSettingsService = new ProviderSettingsService({
    storagePath: path.join(directory, 'provider-settings.json'),
    secretCodec: base64Codec,
  })
  const connection = await providerSettingsService.saveConnection({
    kind: 'openai-compatible',
    name: 'Refusing loopback',
    baseUrl: `${provider.url}/v1`,
    apiKey: PROVIDER_API_KEY,
    enabled: true,
  })
  const validated = await providerSettingsService.validateConnection(
    connection.id,
  )
  assert.equal(validated.status, 'connected')
  await providerSettingsService.setModelEnabled(connection.id, MODEL_ID, true)
  writeQuickScoutAgent(
    repoRootPath,
    configuredProviderName(connection.id),
    MODEL_ID,
  )

  let server: StartedApiServer | null = null
  try {
    server = await startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher: new PiRunLauncher(),
      sessionStore: new FileSystemSessionStore(workspacePath),
      repoRootPath,
      workspacePath,
      providerSettingsService,
    })

    const sessionResponse = await fetch(`${server.url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Quick Scout' }),
    })
    assert.equal(sessionResponse.status, 201)
    const session = await sessionResponse.json() as { id: string }

    const turnId = randomUUID()
    const chatResponse = await fetch(
      `${server.url}/sessions/${session.id}/agent-chat/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: USER_PROMPT,
          agentNames: ['quick-scout'],
          turnId,
        }),
      },
    )
    assert.equal(chatResponse.status, 201, await chatResponse.clone().text())
    const turn = await chatResponse.json() as AgentChatTurnResponse

    // 1. The user still receives — and keeps — a safe failure reply.
    const reply = turn.replies[0]
    assert.ok(reply, 'the turn produced one reply')
    assert.equal(turn.meta.replies[0]?.fallback, true)
    assert.equal(
      reply.text.includes(PROVIDER_RAW_MESSAGE),
      false,
      'the safe reply does not quote raw provider prose',
    )

    const persisted = await fetch(
      `${server.url}/sessions/${session.id}/messages`,
    ).then((response) => response.json() as Promise<{
      messages: readonly AgentChatReply[]
    }>)
    const persistedReply = persisted.messages.find(
      (message) => message.id === reply.id,
    )
    assert.ok(persistedReply, 'the failure reply is durable in the transcript')

    // 2. The reply points at the evidence without carrying journal state.
    assert.deepEqual(
      reply.execution,
      { runId: turnId, assignmentId: reply.execution?.assignmentId ?? '' },
      'the reply carries its chat run id',
    )
    const assignmentId = reply.execution?.assignmentId
    assert.ok(assignmentId, 'the reply names the assignment that holds its journal')
    assert.deepEqual(
      persistedReply.execution,
      reply.execution,
      'the persisted message carries the same execution reference',
    )

    // 3. The operator surface reports the turn's lifecycle.
    const inspection = await fetch(
      `${server.url}/execution-journals/${session.id}/${turnId}/${assignmentId}`,
    )
    assert.equal(inspection.status, 200, await inspection.clone().text())
    const report = await inspection.json() as InspectionReport
    assert.equal(report.kind, 'report')
    assert.deepEqual(
      report.unresolved,
      [],
      'a provider failure before any tool call dispatches no capability',
    )
    const agentTurn = report.agentTurns?.[0]
    assert.ok(agentTurn, 'the report exposes the agent turn')
    assert.equal(report.agentTurns?.length, 1)
    assert.equal(agentTurn.state, 'failed')
    assert.equal(agentTurn.turnId, turnId)
    assert.equal(agentTurn.assignmentId, assignmentId)
    assert.equal(agentTurn.assistantMessageId, reply.id)

    // 4. The failure keeps a stable, sanitized identity.
    assert.ok(agentTurn.failure, 'a failed turn states why it failed')
    assert.equal(agentTurn.failure.phase, 'provider-request')
    assert.equal(agentTurn.failure.httpStatus, 503)
    assert.equal(agentTurn.failure.retryable, true)
    assert.equal(agentTurn.failure.providerCode, 'model_overloaded')
    assert.ok(
      agentTurn.failure.serviceCode.length > 0,
      'the failure carries a stable service code',
    )
    // Which provider and model the turn was asking. Without these the journal
    // can say a call failed but not whose account it failed against, and a
    // health badge built from these events could only mark everything or
    // nothing.
    assert.equal(
      agentTurn.failure.provider,
      configuredProviderName(connection.id),
    )
    assert.equal(agentTurn.failure.model, MODEL_ID)

    // 5. The journal records start, preparation, and terminal, in that order.
    const journalPath = path.join(
      workspacePath,
      'sessions',
      session.id,
      'runs',
      turnId,
      'assignments',
      assignmentId,
      RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
      EXECUTION_JOURNAL_DIRECTORY_NAME,
      EXECUTION_JOURNAL_FILENAME,
    )
    const journalBytes = fs.readFileSync(journalPath, 'utf8')
    const agentTurnTypes = journalBytes
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { streamKind?: string; type?: string })
      .filter((event) => event.streamKind === 'agent.turn')
      .map((event) => event.type)
    assert.deepEqual(agentTurnTypes, [
      'agent.turn.started',
      'agent.turn.prepared',
      'agent.turn.failed',
    ])

    // 6. Nothing secret, raw, or user-authored reached the journal.
    for (const forbidden of [
      PROVIDER_API_KEY,
      PROVIDER_RAW_MESSAGE,
      USER_PROMPT,
      'authorization',
      'Bearer ',
    ]) {
      assert.equal(
        journalBytes.includes(forbidden),
        false,
        `the journal leaked ${JSON.stringify(forbidden)}`,
      )
    }

    assert.ok(
      provider.completionRequests > 0,
      'the provider was actually asked before the turn failed',
    )
  } finally {
    await server?.close()
    await provider.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
