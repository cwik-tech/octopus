/**
 * Phase 4 outer acceptance journey: one selected-agent turn is one publication.
 *
 * A selected-agent turn already leaves per-reply evidence: each reply gets its
 * own assignment and its own `agent.turn` stream. What it has never had is a
 * conversation-level record of the turn as a whole — the thing an operator
 * starts from. Two speakers answering one question produce two unrelated
 * assignment journals and nothing that says they were the same turn, so there
 * is no path from "the user asked this" to "these are the two replies and here
 * is where each one's execution lives".
 *
 * This journey proves the whole Phase 4 capability through the loopback API:
 * a two-speaker turn publishes one aggregate `conversation.turn` lifecycle,
 * that lifecycle names every reply and links each one to the assignment that
 * executed it, the links survive a process restart, both links resolve to the
 * `agent.turn` evidence they point at, and replaying the turn returns the
 * stored answers without disturbing the aggregate.
 *
 * `agent.turn` stays the execution authority throughout. The aggregate holds
 * identities and links, never a copy of what an assignment recorded.
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

const MODEL_ID = 'fixture/duet'

/**
 * Sentinels. Each is unique enough that finding it under the conversation
 * activity proves prose crossed the content boundary.
 */
const PROMPT_SENTINEL = 'zzq-linkage-prompt-3d81ca'
const ALPHA_SENTINEL = 'zzq-linkage-alpha-7b20fe'
const BETA_SENTINEL = 'zzq-linkage-beta-15c4dd'
const PROVIDER_API_KEY = 'zzq-linkage-key-9ae03f'

/** Markers written into each agent's prompt so the fixture can tell them apart. */
const ALPHA_MARKER = 'MARKER-ALPHA-LINKAGE'
const BETA_MARKER = 'MARKER-BETA-LINKAGE'

interface LoopbackProvider {
  readonly url: string
  readonly completionRequests: number
  close(): Promise<void>
}

/**
 * An OpenAI-compatible endpoint that answers each speaker with its own prose.
 *
 * Request-aware in both directions: the configured provider asks for
 * `stream: true` and reads SSE, while the tool-loop adapter posts a
 * non-streaming request and parses JSON. Which speaker is asking is read from
 * the marker its system prompt carries, because ordering alone would answer the
 * wrong speaker as soon as one of them makes two requests.
 */
async function startDuetProvider(): Promise<LoopbackProvider> {
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
    if (!url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    completionRequests += 1
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const answer = body.includes(BETA_MARKER)
        ? `${BETA_SENTINEL} beta has answered.`
        : `${ALPHA_SENTINEL} alpha has answered.`
      const streaming = /"stream"\s*:\s*true/.test(body)
      if (!streaming) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            model: MODEL_ID,
            choices: [
              {
                message: { role: 'assistant', content: answer },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
        )
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      res.write(
        `data: ${JSON.stringify({
          id: 'duet-1',
          object: 'chat.completion.chunk',
          model: MODEL_ID,
          choices: [{ index: 0, delta: { content: answer }, finish_reason: null }],
        })}\n\n`,
      )
      res.write(
        `data: ${JSON.stringify({
          id: 'duet-1',
          object: 'chat.completion.chunk',
          model: MODEL_ID,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
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

function writeAgent(
  repoRoot: string,
  name: string,
  marker: string,
  provider: string,
): void {
  const directory = path.join(repoRoot, 'agents', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      'tier: strategic',
      `provider: ${provider}`,
      `model: ${MODEL_ID}`,
      'thinking: low',
      '---',
      '',
      `# ${name}`,
      '',
      `${marker}`,
      '',
      'Answer the question in one sentence.',
      '',
    ].join('\n'),
    'utf8',
  )
}

interface TranscriptMessage {
  readonly id: string
  readonly role: string
  readonly text: string
  readonly turnId?: string
  readonly execution?: { readonly runId: string; readonly assignmentId: string }
  readonly conversation?: {
    readonly conversationId: string
    readonly activityId: string
    readonly turnId: string
  }
}

interface AgentChatTurnResponse {
  readonly user: TranscriptMessage
  readonly replies: readonly TranscriptMessage[]
  readonly replayed?: boolean
}

interface ConversationTurnReport {
  readonly turnId: string
  readonly activityId: string
  readonly state: string
  readonly surface?: string
  readonly expectedResponseCount?: number
  readonly assistantMessageIds: readonly string[]
  readonly assignments?: readonly {
    readonly assignmentId: string
    readonly assistantMessageId: string
  }[]
}

interface ConversationJournalReport {
  readonly turns: readonly ConversationTurnReport[]
}

interface AgentTurnReport {
  readonly assignmentId: string
  readonly turnId: string
  readonly state: string
  readonly assistantMessageId?: string
}

interface AssignmentInspectionReport {
  readonly kind: string
  readonly agentTurns?: readonly AgentTurnReport[]
}

/** Every regular file below one conversation activity's journal directory. */
function activityDurableFiles(
  workspacePath: string,
  sessionId: string,
): readonly string[] {
  const root = path.join(
    workspacePath,
    'sessions',
    sessionId,
    '.conversation-activities',
  )
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root)
    .map((activityId) =>
      path.join(activityId, '.runtime', 'execution-journal'),
    )
    .flatMap((relative) => {
      const directory = path.join(root, relative)
      if (!fs.existsSync(directory)) return []
      return fs
        .readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name))
    })
}

function conversationEventTypes(
  workspacePath: string,
  sessionId: string,
  activityId: string,
): readonly string[] {
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
  if (!fs.existsSync(journalPath)) return []
  return fs
    .readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as { type: string }).type)
}

test('a two-speaker selected-agent turn publishes one linked conversation turn', async () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-agent-linkage-')),
  )
  const repoRootPath = path.join(directory, 'project')
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(repoRootPath, { recursive: true })
  fs.mkdirSync(workspacePath, { recursive: true })

  const provider = await startDuetProvider()
  const providerSettingsService = new ProviderSettingsService({
    storagePath: path.join(directory, 'provider-settings.json'),
    secretCodec: base64Codec,
  })
  const connection = await providerSettingsService.saveConnection({
    kind: 'openai-compatible',
    name: 'Duet loopback',
    baseUrl: `${provider.url}/v1`,
    apiKey: PROVIDER_API_KEY,
    enabled: true,
  })
  const validated = await providerSettingsService.validateConnection(connection.id)
  assert.equal(validated.status, 'connected')
  await providerSettingsService.setModelEnabled(connection.id, MODEL_ID, true)
  const providerName = configuredProviderName(connection.id)
  writeAgent(repoRootPath, 'alpha-scout', ALPHA_MARKER, providerName)
  writeAgent(repoRootPath, 'beta-scout', BETA_MARKER, providerName)

  const startServer = (): Promise<StartedApiServer> =>
    startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher: new PiRunLauncher(),
      sessionStore: new FileSystemSessionStore(workspacePath),
      repoRootPath,
      workspacePath,
      providerSettingsService,
    })

  let server: StartedApiServer | undefined
  try {
    server = await startServer()

    const sessionResponse = await fetch(`${server.url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Two speakers' }),
    })
    assert.equal(sessionResponse.status, 201)
    const sessionId = (await sessionResponse.json() as { id: string }).id

    const turnId = randomUUID()
    const request = {
      text: `What should we do? ${PROMPT_SENTINEL}`,
      agentNames: ['alpha-scout', 'beta-scout'],
      turnId,
    }
    const chatResponse = await fetch(
      `${server.url}/sessions/${sessionId}/agent-chat/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      },
    )
    assert.equal(chatResponse.status, 201, await chatResponse.clone().text())
    const turn = await chatResponse.json() as AgentChatTurnResponse

    // 1. Two speakers answered, and each reply names the assignment that ran it
    //    and the conversation activity that published it.
    assert.equal(turn.replies.length, 2, 'both speakers replied')
    const [alphaReply, betaReply] = turn.replies
    assert.ok(alphaReply && betaReply)
    assert.ok(alphaReply.text.includes(ALPHA_SENTINEL))
    assert.ok(betaReply.text.includes(BETA_SENTINEL))
    for (const reply of [alphaReply, betaReply]) {
      assert.equal(reply.execution?.runId, turnId)
      assert.ok(reply.execution?.assignmentId, 'the reply names its assignment')
      assert.deepEqual(
        reply.conversation,
        { conversationId: sessionId, activityId: turnId, turnId },
        'the reply names the conversation activity that published it',
      )
    }
    assert.notEqual(
      alphaReply.execution?.assignmentId,
      betaReply.execution?.assignmentId,
      'each speaker executes on its own assignment',
    )

    // 2. One turn is one activity, and its lifecycle is complete and in order.
    assert.deepEqual(
      conversationEventTypes(workspacePath, sessionId, turnId),
      [
        'conversation.turn.started',
        'conversation.turn.prepared',
        'conversation.turn.completed',
      ],
      'the aggregate records a full lifecycle for the two-speaker turn',
    )

    // 3. The aggregate is evidence, never content.
    const durableBytes = activityDurableFiles(workspacePath, sessionId)
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('')
    for (const sentinel of [
      PROMPT_SENTINEL,
      ALPHA_SENTINEL,
      BETA_SENTINEL,
      PROVIDER_API_KEY,
    ]) {
      assert.equal(
        durableBytes.includes(sentinel),
        false,
        `${sentinel} was written into the conversation activity`,
      )
    }

    // Restart the process. Links are durable, not in-memory state.
    await server.close()
    server = await startServer()

    // 4. Conversation inspection reports the turn with both replies and both
    //    assignment links, paired to the reply each one produced.
    const conversationResponse = await fetch(
      `${server.url}/execution-journals/conversation/run-session/${sessionId}`,
    )
    assert.equal(
      conversationResponse.status,
      200,
      await conversationResponse.clone().text(),
    )
    const conversationText = await conversationResponse.text()
    for (const sentinel of [PROMPT_SENTINEL, ALPHA_SENTINEL, BETA_SENTINEL]) {
      assert.equal(
        conversationText.includes(sentinel),
        false,
        `conversation inspection must not return ${sentinel}`,
      )
    }
    const report = JSON.parse(conversationText) as ConversationJournalReport
    const aggregate = report.turns.find((candidate) => candidate.turnId === turnId)
    assert.ok(aggregate, 'the conversation report names the selected-agent turn')
    assert.equal(aggregate.state, 'completed')
    assert.equal(aggregate.surface, 'run-selected-agents')
    assert.equal(aggregate.expectedResponseCount, 2)
    assert.deepEqual(
      aggregate.assistantMessageIds,
      [alphaReply.id, betaReply.id],
      'the aggregate names both replies, in the order they were published',
    )
    assert.deepEqual(
      aggregate.assignments,
      [
        {
          assignmentId: alphaReply.execution?.assignmentId,
          assistantMessageId: alphaReply.id,
        },
        {
          assignmentId: betaReply.execution?.assignmentId,
          assistantMessageId: betaReply.id,
        },
      ],
      'each reply is linked to the assignment that executed it',
    )

    // 5. Both links resolve: following one reaches that reply's own execution
    //    evidence, which stays the authority for what the speaker did.
    for (const link of aggregate.assignments ?? []) {
      const assignmentResponse: Response = await fetch(
        `${server.url}/execution-journals/${sessionId}/${turnId}/${link.assignmentId}`,
      )
      assert.equal(
        assignmentResponse.status,
        200,
        `link to ${link.assignmentId} does not resolve`,
      )
      const assignment =
        await assignmentResponse.json() as AssignmentInspectionReport
      assert.equal(assignment.kind, 'report')
      const agentTurn = assignment.agentTurns?.[0]
      assert.ok(agentTurn, 'the linked assignment holds its own agent turn')
      assert.equal(agentTurn.turnId, turnId)
      assert.equal(agentTurn.state, 'completed')
      assert.equal(
        agentTurn.assistantMessageId,
        link.assistantMessageId,
        'the link pairs the assignment with the reply it actually produced',
      )
    }

    // 6. Replaying the same turn returns the stored replies without a second
    //    provider call, and leaves the aggregate exactly as it was.
    const requestsBeforeReplay = provider.completionRequests
    const replayResponse = await fetch(
      `${server.url}/sessions/${sessionId}/agent-chat/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      },
    )
    assert.equal(replayResponse.status, 200, await replayResponse.clone().text())
    const replayed = await replayResponse.json() as AgentChatTurnResponse
    assert.equal(replayed.replayed, true)
    assert.deepEqual(
      replayed.replies.map((reply) => reply.id),
      [alphaReply.id, betaReply.id],
      'a replay returns the stored replies',
    )
    assert.equal(
      provider.completionRequests,
      requestsBeforeReplay,
      'a replay must not call the provider again',
    )
    assert.deepEqual(
      conversationEventTypes(workspacePath, sessionId, turnId),
      [
        'conversation.turn.started',
        'conversation.turn.prepared',
        'conversation.turn.completed',
      ],
      'a replay must not append a second lifecycle',
    )

    const transcript = await fetch(
      `${server.url}/sessions/${sessionId}/messages`,
    ).then(
      (response) => response.json() as Promise<{
        messages: readonly TranscriptMessage[]
      }>,
    )
    assert.deepEqual(
      transcript.messages.map((message) => message.id),
      [turn.user.id, alphaReply.id, betaReply.id],
      'a replay must not duplicate transcript content',
    )
  } finally {
    await server?.close()
    await provider.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
