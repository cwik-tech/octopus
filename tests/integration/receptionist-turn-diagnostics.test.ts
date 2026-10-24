/**
 * Phase 2 outer acceptance journey: a retained Receptionist turn explains
 * itself.
 *
 * Phase 1 made an ordinary Run Receptionist turn durable and replay-safe, but
 * its report says only what the lifecycle did: started, prepared, completed,
 * failed, cancelled. An operator reading it cannot answer the questions a
 * support case actually asks — which provider and model were requested, which
 * ones answered, whether the model's structured decision was valid the first
 * time, whether a repair attempt fixed it, whether the reply the user is
 * looking at is a fallback, how long the provider took, how many tokens it
 * billed, and what kind of failure a failed call was.
 *
 * This journey posts six turns through the loopback API against a scripted
 * local HTTP model server — a clean decision with usage, an invalid decision
 * repaired successfully, an invalid decision whose repair also failed, a
 * provider that refused with an HTTP error, a provider that reported the
 * request timed out, and a client that hung up — then restarts the API process
 * and reads one conversation report. Every turn in it must be explainable from the record
 * alone, and none of it may carry the prompt, the reply, the model's invalid
 * output, the provider's error body, its headers, or the API key.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { initProviders } from '../../providers/index.js'
import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

initProviders()

const CASE_TIMEOUT_MS = 60_000

/**
 * Strings that could only have come from content.
 *
 * Each rides in a different place a provider boundary touches, so finding any
 * of them under an activity names which boundary leaked: the user's prompt, the
 * model's prose answer, the model's invalid output, the provider's error body,
 * a response header, and the credential.
 */
const PROMPT_SENTINEL = 'zzq-prompt-sentinel-31a7c0'
const REPLY_SENTINEL = 'zzq-reply-sentinel-77b2e9'
const INVALID_OUTPUT_SENTINEL = 'zzq-invalid-output-sentinel-5c40da'
const FAILURE_BODY_SENTINEL = 'zzq-failure-body-sentinel-9e13bf'
const RESPONSE_HEADER_SENTINEL = 'zzq-response-header-sentinel-2d68ab'
const API_KEY_SENTINEL = 'zzq-api-key-sentinel-4f92cd'

const ALL_SENTINELS = [
  PROMPT_SENTINEL,
  REPLY_SENTINEL,
  INVALID_OUTPUT_SENTINEL,
  FAILURE_BODY_SENTINEL,
  RESPONSE_HEADER_SENTINEL,
  API_KEY_SENTINEL,
] as const

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

/** One scripted answer from the model endpoint, served in order. */
type ScriptedReply =
  | {
      readonly kind: 'stream'
      readonly model: string
      readonly content: string
      readonly usage?: Readonly<Record<string, number>>
    }
  | {
      readonly kind: 'http-error'
      readonly status: number
      readonly body: unknown
    }
  /** Accept the request and never answer it, holding the socket open. */
  | { readonly kind: 'hang' }

interface ScriptedModelServer {
  readonly chatCompletionsUrl: string
  readonly requestCount: () => number
  readonly waitForRequest: (count: number) => Promise<void>
  readonly close: () => Promise<void>
}

/**
 * A local HTTP model server that answers each request from a fixed script.
 *
 * Real HTTP rather than a replaced `fetch`, because half of what this journey
 * observes is transport shaped: a status code, a response header, an error body
 * and a request that never comes back are all facts about a socket, and a
 * substituted function cannot produce them.
 */
async function startScriptedModelServer(
  script: readonly ScriptedReply[],
): Promise<ScriptedModelServer> {
  let requests = 0
  const waiters = new Set<{ count: number; resolve: () => void }>()
  const held = new Set<http.ServerResponse>()

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      requests += 1
      for (const waiter of [...waiters]) {
        if (requests >= waiter.count) {
          waiters.delete(waiter)
          waiter.resolve()
        }
      }
      const reply = script[requests - 1]
      if (!reply) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'script exhausted' } }))
        return
      }
      if (reply.kind === 'hang') {
        held.add(response)
        response.once('close', () => held.delete(response))
        return
      }
      if (reply.kind === 'http-error') {
        response.writeHead(reply.status, {
          'content-type': 'application/json',
          // A header a provider chose. Journals hold no header maps, so this
          // string exists to be looked for and never found.
          'x-provider-trace': RESPONSE_HEADER_SENTINEL,
        })
        response.end(JSON.stringify(reply.body))
        return
      }
      const frames = [
        JSON.stringify({
          model: reply.model,
          choices: [{ delta: { content: reply.content }, finish_reason: null }],
        }),
        JSON.stringify({
          model: reply.model,
          choices: [{ delta: {}, finish_reason: 'stop' }],
          ...(reply.usage ? { usage: reply.usage } : {}),
        }),
        '[DONE]',
      ]
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      for (const frame of frames) response.write(`data: ${frame}\n\n`)
      response.end()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  const port = (address satisfies AddressInfo).port

  return {
    chatCompletionsUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
    requestCount: () => requests,
    waitForRequest: (count) =>
      requests >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.add({ count, resolve })
          }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const response of [...held]) response.destroy()
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}

async function createSession(url: string): Promise<string> {
  const response = await fetch(`${url}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Titled on purpose: an untitled session generates a name with a second
    // provider call, which would consume the script this journey depends on.
    body: JSON.stringify({ title: 'Receptionist diagnostics' }),
  })
  assert.equal(response.status, 201, await response.clone().text())
  const body: unknown = await response.json()
  assert.ok(typeof body === 'object' && body !== null)
  const id = Reflect.get(body, 'id')
  assert.equal(typeof id, 'string')
  assert.ok(typeof id === 'string')
  return id
}

async function postTurn(input: {
  readonly url: string
  readonly sessionId: string
  readonly turnId: string
  readonly text: string
  readonly provider: string
  readonly model: string
  readonly signal?: AbortSignal
}): Promise<Response> {
  return fetch(`${input.url}/sessions/${input.sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: input.text,
      provider: input.provider,
      model: input.model,
      turnId: input.turnId,
    }),
    ...(input.signal ? { signal: input.signal } : {}),
  })
}

/** Every regular file under every activity journal directory in one session. */
function activityJournalBytes(workspacePath: string, sessionId: string): string {
  const root = path.join(
    workspacePath,
    'sessions',
    sessionId,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
  )
  if (!fs.existsSync(root)) return ''
  const parts: string[] = []
  for (const activityId of fs.readdirSync(root)) {
    const directory = path.join(
      root,
      activityId,
      '.runtime',
      'execution-journal',
    )
    if (!fs.existsSync(directory)) continue
    for (const entry of fs.readdirSync(directory, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue
      parts.push(fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
    }
  }
  return parts.join('')
}

/** Event types durable for one turn, straight off disk. */
function activityEventTypes(
  workspacePath: string,
  sessionId: string,
  turnId: string,
): string[] {
  const journalPath = path.join(
    workspacePath,
    'sessions',
    sessionId,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    turnId,
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
      const parsed: unknown = JSON.parse(line)
      assert.ok(typeof parsed === 'object' && parsed !== null)
      const type = Reflect.get(parsed, 'type')
      assert.equal(typeof type, 'string')
      assert.ok(typeof type === 'string')
      return type
    })
}

async function waitFor(
  condition: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${description}`)
}

/** One turn's summary from the conversation report, guarded rather than cast. */
function turnRecord(
  reportBody: unknown,
  turnId: string,
): Record<string, unknown> {
  assert.ok(typeof reportBody === 'object' && reportBody !== null)
  const turns = Reflect.get(reportBody, 'turns')
  assert.ok(Array.isArray(turns), 'the report carries a turns array')
  const found = turns.find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      Reflect.get(candidate, 'turnId') === turnId,
  )
  assert.ok(
    typeof found === 'object' && found !== null,
    `the report names turn ${turnId}`,
  )
  return { ...found }
}

/** A nested diagnostic object, guarded rather than cast. */
function nested(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key]
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    `the turn report carries a ${key} object; it held ${JSON.stringify(value)}`,
  )
  return { ...value }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

test(
  'a retained Receptionist turn reports its provider, decision, timing, usage, and sanitized failure',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'receptionist-diagnostics-')),
    )
    const workspacePath = path.join(directory, 'workspace')
    const projectRoot = path.join(directory, 'project')
    fs.mkdirSync(workspacePath, { recursive: true })
    fs.mkdirSync(path.join(projectRoot, 'agents'), { recursive: true })

    const previousKey = process.env.OPENAI_API_KEY
    const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
    process.env.OPENAI_API_KEY = API_KEY_SENTINEL

    // In request order. Turns B and C each spend two entries because an invalid
    // decision is retried once with a repair instruction.
    const provider = await startScriptedModelServer([
      {
        kind: 'stream',
        model: 'served-model-clean',
        content: decision(`${REPLY_SENTINEL} here is my answer`),
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      },
      {
        kind: 'stream',
        model: 'served-model-invalid-first',
        content: `I cannot answer that. ${INVALID_OUTPUT_SENTINEL}`,
      },
      {
        kind: 'stream',
        model: 'served-model-repaired',
        content: decision(`${REPLY_SENTINEL} repaired answer`),
        usage: { prompt_tokens: 21, completion_tokens: 5, total_tokens: 26 },
      },
      {
        kind: 'stream',
        model: 'served-model-invalid-twice-a',
        content: `still not a decision. ${INVALID_OUTPUT_SENTINEL}`,
      },
      {
        kind: 'stream',
        model: 'served-model-invalid-twice-b',
        content: `still not a decision either. ${INVALID_OUTPUT_SENTINEL}`,
      },
      {
        kind: 'http-error',
        status: 503,
        body: {
          error: {
            message: `upstream capacity exhausted: ${FAILURE_BODY_SENTINEL}`,
            type: 'server_error',
            code: 'overloaded_error',
          },
        },
      },
      {
        kind: 'http-error',
        status: 408,
        body: {
          error: {
            message: `the request timed out upstream: ${FAILURE_BODY_SENTINEL}`,
            type: 'timeout_error',
            code: 'request_timeout',
          },
        },
      },
      { kind: 'hang' },
    ])
    process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.chatCompletionsUrl

    let server: StartedApiServer | undefined
    try {
      server = await startApiServer({
        store: new FileSystemRunStore(workspacePath),
        launcher: new PiRunLauncher(),
        sessionStore: new FileSystemSessionStore(workspacePath),
        repoRootPath: projectRoot,
        workspacePath,
      })
      const sessionId = await createSession(server.url)

      // A. A clean turn. The provider name is requested in mixed case so the
      // report has to distinguish what was asked for from what resolved.
      const cleanTurnId = randomUUID()
      const clean = await postTurn({
        url: server.url,
        sessionId,
        turnId: cleanTurnId,
        text: `What can you do? ${PROMPT_SENTINEL}`,
        provider: 'OpenAI',
        model: 'requested-model-clean',
      })
      assert.equal(clean.status, 201, await clean.clone().text())

      // B. The model's first answer is not a decision; the repair attempt is.
      const repairedTurnId = randomUUID()
      const repaired = await postTurn({
        url: server.url,
        sessionId,
        turnId: repairedTurnId,
        text: `Try again please. ${PROMPT_SENTINEL}`,
        provider: 'openai',
        model: 'requested-model-repaired',
      })
      assert.equal(repaired.status, 201, await repaired.clone().text())

      // C. Neither answer is a decision, so the reply the user sees is a
      // fallback the server wrote.
      const fallbackTurnId = randomUUID()
      const fellBack = await postTurn({
        url: server.url,
        sessionId,
        turnId: fallbackTurnId,
        text: `And again. ${PROMPT_SENTINEL}`,
        provider: 'openai',
        model: 'requested-model-fallback',
      })
      assert.equal(fellBack.status, 201, await fellBack.clone().text())

      // D. The provider answered with an HTTP error carrying its own prose.
      const providerFailureTurnId = randomUUID()
      const providerFailed = await postTurn({
        url: server.url,
        sessionId,
        turnId: providerFailureTurnId,
        text: `Are you there? ${PROMPT_SENTINEL}`,
        provider: 'openai',
        model: 'requested-model-http-error',
      })
      assert.equal(providerFailed.status, 201, await providerFailed.clone().text())

      // E. The provider answered that the request timed out. A wait that
      // elapsed is a different fact from a request that was refused, and the
      // record has to keep them apart.
      const timeoutTurnId = randomUUID()
      const timedOut = await postTurn({
        url: server.url,
        sessionId,
        turnId: timeoutTurnId,
        text: `Still there? ${PROMPT_SENTINEL}`,
        provider: 'openai',
        model: 'requested-model-timeout',
      })
      assert.equal(timedOut.status, 201, await timedOut.clone().text())

      // F. The client hangs up while the provider is still holding.
      const cancelledTurnId = randomUUID()
      const abort = new AbortController()
      const requestsBeforeCancel = provider.requestCount()
      const cancelled = postTurn({
        url: server.url,
        sessionId,
        turnId: cancelledTurnId,
        text: `Never mind. ${PROMPT_SENTINEL}`,
        provider: 'openai',
        model: 'requested-model-cancelled',
        signal: abort.signal,
      }).catch(() => undefined)
      await provider.waitForRequest(requestsBeforeCancel + 1)
      abort.abort()
      await cancelled
      await waitFor(
        () =>
          activityEventTypes(workspacePath, sessionId, cancelledTurnId).some(
            (type) => type.endsWith('.cancelled'),
          ),
        'the cancelled terminal to be durable',
      )

      // The journals are evidence, never content — before and after a restart.
      const bytesBeforeRestart = activityJournalBytes(workspacePath, sessionId)
      for (const sentinel of ALL_SENTINELS) {
        assert.equal(
          bytesBeforeRestart.includes(sentinel),
          false,
          `${sentinel} reached a conversation activity journal`,
        )
      }

      // Restart the API process; the diagnostics are read back off disk.
      await server.close()
      server = await startApiServer({
        store: new FileSystemRunStore(workspacePath),
        launcher: new PiRunLauncher(),
        sessionStore: new FileSystemSessionStore(workspacePath),
        repoRootPath: projectRoot,
        workspacePath,
      })

      const response = await fetch(
        `${server.url}/execution-journals/conversation/run-session/${sessionId}`,
      )
      assert.equal(response.status, 200, await response.clone().text())
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const reportText = await response.text()
      for (const sentinel of ALL_SENTINELS) {
        assert.equal(
          reportText.includes(sentinel),
          false,
          `inspection returned ${sentinel}`,
        )
      }
      const report: unknown = JSON.parse(reportText)

      // A. Requested and resolved provider/model, a valid first decision, no
      // repair, no fallback, safe timing, and validated usage.
      const cleanTurn = turnRecord(report, cleanTurnId)
      assert.equal(cleanTurn.state, 'completed')
      assert.equal(cleanTurn.requestedProvider, 'OpenAI')
      assert.equal(cleanTurn.requestedModel, 'requested-model-clean')
      const cleanDecision = nested(cleanTurn, 'decision')
      assert.deepEqual(cleanDecision, {
        initialValidation: 'valid',
        repair: 'not_needed',
        fallback: 'none',
      })
      const cleanProvider = nested(cleanTurn, 'provider')
      assert.equal(cleanProvider.resolvedProvider, 'openai')
      assert.equal(cleanProvider.resolvedModel, 'served-model-clean')
      assert.equal(cleanProvider.route, 'http')
      assert.equal(cleanProvider.outcome, 'success')
      assert.equal(cleanProvider.failure, undefined)
      assert.deepEqual(nested(cleanProvider, 'usage'), {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
      })
      const cleanTiming = nested(cleanProvider, 'timing')
      assert.equal(
        typeof cleanTiming.providerDurationMs === 'number' &&
          Number.isSafeInteger(cleanTiming.providerDurationMs) &&
          cleanTiming.providerDurationMs >= 0,
        true,
        `timing must be a safe non-negative integer: ${JSON.stringify(cleanTiming)}`,
      )

      // B. The first decision was invalid and the repair fixed it. The model
      // that answered is the one that produced the accepted decision.
      const repairedTurn = turnRecord(report, repairedTurnId)
      assert.equal(repairedTurn.state, 'completed')
      assert.deepEqual(nested(repairedTurn, 'decision'), {
        initialValidation: 'invalid',
        repair: 'valid',
        fallback: 'none',
      })
      const repairedProvider = nested(repairedTurn, 'provider')
      assert.equal(repairedProvider.outcome, 'success')
      assert.equal(repairedProvider.resolvedModel, 'served-model-repaired')
      assert.deepEqual(nested(repairedProvider, 'usage'), {
        inputTokens: 21,
        outputTokens: 5,
        totalTokens: 26,
      })

      // C. Both decisions were invalid, so the published reply is a fallback
      // and the record says which kind.
      const fallbackTurn = turnRecord(report, fallbackTurnId)
      assert.equal(fallbackTurn.state, 'completed')
      assert.deepEqual(nested(fallbackTurn, 'decision'), {
        initialValidation: 'invalid',
        repair: 'invalid',
        fallback: 'invalid_decision',
      })
      assert.equal(nested(fallbackTurn, 'provider').outcome, 'success')

      // D. A provider failure reduced to an allowlisted identity: what kind of
      // failure, where, the HTTP status, the provider's own short code, and
      // whether retrying could help. None of its prose.
      const providerFailureTurn = turnRecord(report, providerFailureTurnId)
      assert.equal(providerFailureTurn.state, 'completed')
      assert.deepEqual(nested(providerFailureTurn, 'decision'), {
        initialValidation: 'provider_failed',
        repair: 'not_needed',
        fallback: 'provider_failed',
      })
      const failedProvider = nested(providerFailureTurn, 'provider')
      assert.equal(failedProvider.outcome, 'provider_failure')
      assert.deepEqual(nested(failedProvider, 'failure'), {
        code: 'http_status',
        phase: 'response',
        providerKind: 'chat-completions',
        providerCode: 'overloaded_error',
        httpStatus: 503,
        retryable: true,
      })

      // E. A wait that elapsed is a timeout, which is a different outcome from
      // a request the provider refused — and retrying it is the right advice.
      const timeoutTurn = turnRecord(report, timeoutTurnId)
      assert.equal(timeoutTurn.state, 'completed')
      assert.equal(timeoutTurn.requestedModel, 'requested-model-timeout')
      assert.deepEqual(nested(timeoutTurn, 'decision'), {
        initialValidation: 'provider_failed',
        repair: 'not_needed',
        fallback: 'provider_failed',
      })
      const timedOutProvider = nested(timeoutTurn, 'provider')
      assert.equal(timedOutProvider.outcome, 'timeout')
      assert.deepEqual(nested(timedOutProvider, 'failure'), {
        code: 'timeout',
        phase: 'response',
        providerKind: 'chat-completions',
        providerCode: 'request_timeout',
        httpStatus: 408,
        retryable: true,
      })

      // F. A cancelled turn still names what it was asking for, and its
      // provider outcome is the user's intent rather than a failure.
      const cancelledTurn = turnRecord(report, cancelledTurnId)
      assert.equal(cancelledTurn.state, 'cancelled')
      assert.equal(cancelledTurn.requestedProvider, 'openai')
      assert.equal(cancelledTurn.requestedModel, 'requested-model-cancelled')
      assert.equal(nested(cancelledTurn, 'provider').outcome, 'cancelled')
    } finally {
      await server?.close()
      await provider.close()
      restoreEnv('OPENAI_API_KEY', previousKey)
      restoreEnv('WORKFLOW_GENERATOR_OPENAI_API_URL', previousUrl)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
