/**
 * A user-approved retry on the application default, over the real HTTP API.
 *
 * The service-level tests can be handed collaborators directly, which is how
 * an approval route that forwarded none of them passed them all. This journey
 * asks the running server instead: the approved attempt has to leave the same
 * durable journal an ordinary turn leaves, and one offer has to authorize
 * exactly one attempt however many keys a second tab invents.
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

/**
 * The agent's own explicit choice: a provider with no credential configured.
 *
 * Deliberately not a loopback that answers `401`. A `401` is a *sent* request,
 * and this build refuses to offer a retry for an attempt that reached the
 * provider — it cannot show that nothing happened. What earns an offer is an
 * adapter refusing before it sends anything, which is what `anthropic` does
 * with no `ANTHROPIC_API_KEY`.
 */
const PINNED_PROVIDER = 'anthropic'
const PINNED_MODEL = 'claude-opus-4-6'
/** The deliberately selected application default. The endpoint answers it. */
const DEFAULT_MODEL = 'fixture/default'
const PROVIDER_API_KEY = 'model-choice-api-secret-4c1f7'
const ANSWER = 'The default model answered.'

interface LoopbackProvider {
  readonly url: string
  readonly completionRequests: readonly string[]
  close(): Promise<void>
}

/**
 * One OpenAI-compatible endpoint serving two models.
 *
 * The pinned model answers `401`, which is a credential failure and therefore
 * both model-specific and provably pre-request — the only shape this build
 * offers a retry for. The default model answers normally, so an approved
 * attempt can actually produce a reply.
 */
async function startTwoModelProvider(): Promise<LoopbackProvider> {
  const completionRequests: string[] = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: DEFAULT_MODEL, object: 'model' }],
      }))
      return
    }
    if (!url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let model = ''
      try {
        model = String(
          (JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            model?: unknown
          }).model ?? '',
        )
      } catch {
        model = ''
      }
      completionRequests.push(model)
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: ANSWER }, index: 0 }],
      })}\n\n`)
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
      })}\n\n`)
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

function writeExplicitAgent(
  repoRoot: string,
  provider: string,
  model: string,
): void {
  const directory = path.join(repoRoot, 'agents', 'reviewer')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, 'reviewer.md'),
    [
      '---',
      'name: reviewer',
      `provider: ${provider}`,
      `model: ${model}`,
      'thinking: low',
      '---',
      '',
      'Review it.',
      '',
    ].join('\n'),
    'utf8',
  )
}

interface OfferSummary {
  readonly offerId: string
  readonly agentName: string
  readonly proposedDefault: { readonly provider: string; readonly model: string }
}

test('an approved retry runs over HTTP with the journals an ordinary turn gets, and one offer authorizes one attempt', async () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'model-choice-api-')),
  )
  const repoRootPath = path.join(directory, 'project')
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(repoRootPath, { recursive: true })
  fs.mkdirSync(workspacePath, { recursive: true })

  const provider = await startTwoModelProvider()
  const providerSettingsService = new ProviderSettingsService({
    storagePath: path.join(directory, 'provider-settings.json'),
    secretCodec: base64Codec,
  })
  let server: StartedApiServer | null = null
  let previousAnthropicKey: string | undefined
  try {
    const connection = await providerSettingsService.saveConnection({
      kind: 'openai-compatible',
      name: 'Two-model loopback',
      baseUrl: `${provider.url}/v1`,
      apiKey: PROVIDER_API_KEY,
      enabled: true,
    })
    const validated = await providerSettingsService.validateConnection(
      connection.id,
    )
    assert.equal(validated.status, 'connected', JSON.stringify(validated))
    await providerSettingsService.setModelEnabled(connection.id, DEFAULT_MODEL, true)
    const providerName = configuredProviderName(connection.id)
    await providerSettingsService.setDefaultModel({
      provider: providerName,
      model: DEFAULT_MODEL,
    })
    writeExplicitAgent(repoRootPath, PINNED_PROVIDER, PINNED_MODEL)
    // No credential for the agent's own provider, so its adapter refuses
    // before sending. The application default has its own key and answers.
    previousAnthropicKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY

    server = await startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher: new PiRunLauncher(),
      sessionStore: new FileSystemSessionStore(workspacePath),
      repoRootPath,
      workspacePath,
      providerSettingsService,
    })

    const session = await fetch(`${server.url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Model choice' }),
    }).then((response) => response.json() as Promise<{ id: string }>)

    const failedTurn = randomUUID()
    const failing = await fetch(
      `${server.url}/sessions/${session.id}/agent-chat/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'Please review this.',
          agentNames: ['reviewer'],
          turnId: failedTurn,
        }),
      },
    )
    assert.equal(failing.status, 201, await failing.clone().text())

    // The offer reaches the client through the transcript it is attached to.
    const transcript = await fetch(
      `${server.url}/sessions/${session.id}/messages`,
    ).then((response) => response.json() as Promise<{
      readonly modelChoices?: readonly OfferSummary[]
    }>)
    const offer = transcript.modelChoices?.[0]
    assert.ok(offer, 'an eligible failure offers the application default')
    assert.equal(offer.agentName, 'reviewer')
    assert.deepEqual(offer.proposedDefault, {
      provider: providerName,
      model: DEFAULT_MODEL,
    })

    const serverUrl = server.url
    const approve = (idempotencyKey: string) =>
      fetch(
        `${serverUrl}/sessions/${session.id}/turns/${failedTurn}/model-choice`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ offerId: offer.offerId, idempotencyKey }),
        },
      )

    const approved = await approve('approval-from-tab-one')
    assert.equal(approved.status, 200, await approved.clone().text())
    const retry = await approved.json() as { readonly turnId: string }

    // The attempt actually reached the default model, and the failed one never
    // reached this endpoint at all.
    assert.deepEqual(provider.completionRequests, [DEFAULT_MODEL])

    // And it left the durable evidence an ordinary turn leaves. This is the
    // assertion a route that forwarded no journals could not satisfy.
    const messages = await fetch(
      `${server.url}/sessions/${session.id}/messages`,
    ).then((response) => response.json() as Promise<{
      readonly messages: readonly {
        readonly id: string
        readonly role: string
        readonly turnId?: string
        readonly execution?: {
          readonly runId: string
          readonly assignmentId: string
        }
      }[]
    }>)
    const retryReply = messages.messages.find(
      (message) =>
        message.role === 'assistant' && message.turnId === retry.turnId,
    )
    assert.ok(retryReply, 'the approved attempt persisted its reply')
    const assignmentId = retryReply.execution?.assignmentId
    assert.ok(assignmentId, 'the approved attempt names its assignment')

    const inspection = await fetch(
      `${server.url}/execution-journals/${session.id}/${retry.turnId}/${assignmentId}`,
    )
    assert.equal(inspection.status, 200, await inspection.clone().text())
    const report = await inspection.json() as {
      readonly kind: string
      readonly agentTurns?: readonly { readonly state: string }[]
    }
    assert.equal(report.kind, 'report')
    assert.equal(
      report.agentTurns?.length,
      1,
      'the approved attempt is journaled like any other agent turn',
    )

    // A second tab invents its own key. The offer is already spent, so it is
    // answered from the attempt that exists rather than starting another.
    const second = await approve('approval-from-tab-two')
    assert.equal(second.status, 200, await second.clone().text())
    assert.deepEqual(await second.json(), { turnId: retry.turnId })
    assert.deepEqual(
      provider.completionRequests,
      [DEFAULT_MODEL],
      'the second approval pays for nothing',
    )

    // The same approval again is answered from the attempt it already started.
    const replay = await approve('approval-from-tab-one')
    assert.equal(replay.status, 200, await replay.clone().text())
    assert.deepEqual(
      await replay.json(),
      { turnId: retry.turnId },
      'a retransmission reports the attempt it replays',
    )
    assert.deepEqual(provider.completionRequests, [DEFAULT_MODEL])
  } finally {
    if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousAnthropicKey
    await server?.close()
    await provider.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
