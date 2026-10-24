import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'
import { registerProvider } from '../../providers/registry.js'
import { agentChatTurnWiring } from '../../services/agent-chat-turn-wiring.js'
import type { Provider } from '../../providers/types.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import {
  SELECTED_AGENT,
  SELECTED_PACKAGE_MARKERS,
  selectedPackageBlock,
  writeSelectedAgentPackage,
} from '../support/selected-agent-package-fixture.js'

/**
 * That a speaker's connection kind actually reaches the budget.
 *
 * This exists because the wiring shipped dead once. Every hop in the chain is an
 * optional field, so `tsc` stayed green while two option objects — the sessions
 * route literal in `server/route-table.ts` and `sessionDispatchOptions` in
 * `server/routes/sessions.ts` — silently dropped the resolver, and a grep across
 * the files that mention it read like a connected chain. Only running a turn
 * through a real server shows whether it is connected.
 *
 * So this asserts the observable consequence rather than the plumbing: a
 * `connection:<id>` speaker on a local connection must be budgeted against that
 * connection's window, not the generic one.
 */

/**
 * The connection id is minted by `saveConnection`, so the agent fixture and the
 * registered provider can only be written once it is known. An earlier version
 * of this test hardcoded `connection:conn1`, which never matched the minted
 * UUID: `connectionKindFor` returned undefined on the green run, so the test
 * proved the resolver was *called* and nothing about the answer reaching the
 * budget. Since the unknown-kind fallback is now lm-studio's own window, that
 * distinction is invisible unless the id is real.
 */
const PROMPTS: string[] = []

function registerCapturingProvider(name: string): void {
  registerProvider(
    {
      name,
      async execute(options) {
        PROMPTS.push(options.userMessage)
        return {
          text: 'Noted.',
          cost: 0,
          durationMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          contextTokens: 0,
          model: options.model,
        }
      },
    } satisfies Provider,
    { source: 'connection-kind-wiring', trustClass: 'unknown' },
    { replaceExisting: true },
  )
}

function writeAgent(repoRootPath: string, name: string, provider: string): void {
  const directory = path.join(repoRootPath, 'agents', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      `description: ${name} fixture.`,
      'tier: strategic',
      `provider: ${provider}`,
      'model: local-7b',
      'thinking: low',
      '---',
      '',
      `# ${name}`,
      '',
    ].join('\n'),
    'utf8',
  )
}

/** Post one turn to `agentName` and return the prompt the provider received. */
async function promptForConnection(input: {
  readonly kind: 'lm-studio' | 'openrouter'
  readonly agentName: string
}): Promise<string> {
  const fixture = createSchedulerFixture('connection-kind-')
  const storagePath = path.join(fixture.workspacePath, 'provider-settings.json')
  const providerSettingsService = new ProviderSettingsService({ storagePath })
  const saved = await providerSettingsService.saveConnection({
    name: `My ${input.kind} box`,
    kind: input.kind,
    baseUrl: 'http://localhost:1234/v1',
    enabled: true,
  })

  // The real minted id, so the resolver's answer is the connection's own kind.
  const provider = `connection:${saved.id}`
  registerCapturingProvider(provider)
  writeAgent(fixture.repoRootPath, input.agentName, provider)

  let server: StartedApiServer | undefined
  try {
    server = await startApiServer({
      store: new FileSystemRunStore(fixture.workspacePath),
      launcher: {
        async startRun() {
          return { launched: true as const, pid: 0, cwd: '' }
        },
      },
      sessionStore: new FileSystemSessionStore(fixture.workspacePath),
      repoRootPath: fixture.repoRootPath,
      workspacePath: fixture.workspacePath,
      workflowsRegistryPath: fixture.workflowsRegistryPath,
      providerSettingsService,
    })

    const created = await fetch(`${server.url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Connection kind' }),
    })
    const { id } = (await created.json()) as { id: string }

    // Long enough that the two windows cannot render the same thing — a 32k
    // budget admits roughly fifty of these — and no longer, because this test
    // boots a full server twice and the integration suite runs under contention.
    const sessionStore = new FileSystemSessionStore(fixture.workspacePath)
    for (let index = 0; index < 80; index += 1) {
      await sessionStore.appendChatMessage(id, {
        id: `seed-${index}`,
        role: 'user',
        text: `Message ${index}. ${'conversational detail '.repeat(40)}`,
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(),
      })
    }

    PROMPTS.length = 0
    const answered = await fetch(`${server.url}/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Hello.',
        target: { kind: 'agents', agentNames: [input.agentName] },
      }),
    })
    assert.ok(answered.status < 400, `dispatch failed: ${answered.status}`)
    assert.ok(PROMPTS.length > 0, 'the provider was never called')
    return PROMPTS[0] ?? ''
  } finally {
    if (server) await server.close()
    fixture.cleanup()
  }
}

test("a connection's own kind decides the budget its speaker is given", async () => {
  // The observable consequence, not the plumbing: the same session, the same
  // agent, the same message — and a different amount of it reaches the model
  // depending on what kind of connection the speaker routes to. If the resolver
  // is not connected, or its answer is discarded, these two are identical.
  const local = await promptForConnection({ kind: 'lm-studio', agentName: 'localagent' })
  const hosted = await promptForConnection({ kind: 'openrouter', agentName: 'hostedagent' })

  const seen = (prompt: string): number => (prompt.match(/Message \d+\./g) ?? []).length
  assert.ok(
    seen(hosted) > seen(local),
    `a 128k connection saw ${seen(hosted)} messages and a 32k one saw ${seen(local)}; ` +
      "the connection's kind is not reaching the budget",
  )
})

test('the approved-retry path carries the connection kind too', async () => {
  // The retry reaches the turn through `turnWiring` rather than
  // `sessionDispatchOptions`, so it is a second, independent path to the same
  // budget — and it was the only correctly-shaped one while the ordinary path
  // was broken. Asserting the wiring bag itself, because driving a real
  // model-choice approval needs an offer that only a provider failure mints.
  const resolved: string[] = []
  const wiring = agentChatTurnWiring({
    resolveConnectionKind: (provider: string) => {
      resolved.push(provider)
      return provider === 'connection:abc' ? 'lm-studio' : undefined
    },
  })

  assert.ok(
    wiring.resolveConnectionKind,
    'the wiring bag dropped the resolver, so a retry would budget against the generic window',
  )
  assert.equal(wiring.resolveConnectionKind?.('connection:abc'), 'lm-studio')
  assert.deepEqual(resolved, ['connection:abc'])
})

/**
 * A validated OpenAI-compatible endpoint: it lists one chat model, so a saved
 * connection to it becomes `connected`, and it answers every chat request with
 * one streamed reply while keeping the text each request carried.
 */
async function startArchitectModelServer(): Promise<{ url: string; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = []
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fixture-architect' }] }))
      return
    }
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      const parsed: unknown = JSON.parse(body)
      const messages = typeof parsed === 'object' && parsed !== null && 'messages' in parsed && Array.isArray(parsed.messages) ? parsed.messages : []
      requests.push(messages.map((message: unknown) =>
        typeof message === 'object' && message !== null && 'content' in message && typeof message.content === 'string' ? message.content : '').join('\n'))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Answered from the package.' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

test("an Agent Architect on a connection is budgeted by that connection's kind", async () => {
  // The Architect reaches the budget through its own chain: the route table,
  // the resource-architect route, and its service each carry the resolver as an
  // optional field. A dropped hop resolves every connection to the smallest
  // kind's window, so a hosted connection would refuse an ordinary package.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'architect-connection-kind-'))
  const workspacePath = path.join(directory, 'workspace')
  const repoRootPath = path.join(directory, 'project')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(path.join(repoRootPath, 'teams', 'resource-architect'), { recursive: true })
  fs.mkdirSync(path.join(repoRootPath, 'agents', 'resource-architect'), { recursive: true })
  fs.writeFileSync(path.join(repoRootPath, 'teams', 'resource-architect', 'team.yaml'), 'agents:\n  - agent_file: ../../agents/resource-architect/resource-architect.md\n')
  fs.writeFileSync(path.join(repoRootPath, 'agents', 'resource-architect', 'resource-architect.md'), '---\nprovider: openai\nmodel: persona-author\nthinking: medium\n---\n\nHelp the user design Agents and Teams.\n')
  writeSelectedAgentPackage(repoRootPath)
  // 160,000 bytes, about 46k estimated tokens: more than the 27,200 input
  // tokens a 32k local window admits, well inside the 108,800 of a 128k hosted one.
  fs.writeFileSync(path.join(repoRootPath, 'agents', SELECTED_AGENT, 'knowledge', 'archive.md'), 'Evidence. '.repeat(16_000))
  const model = await startArchitectModelServer()
  const providerSettingsService = new ProviderSettingsService({
    storagePath: path.join(workspacePath, 'provider-settings.json'),
    // The desktop keychain is not available here; the key is a fixture value.
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
  })
  const connectionFor = async (kind: 'openai-compatible' | 'lm-studio'): Promise<string> => {
    const saved = await providerSettingsService.saveConnection({ name: `My ${kind} box`, kind, baseUrl: `${model.url}/v1`, apiKey: 'fixture-key', enabled: true })
    const validated = await providerSettingsService.validateConnection(saved.id)
    assert.equal(validated.status, 'connected', `${kind} fixture connection`)
    return `connection:${saved.id}`
  }
  const previousReview = process.env.PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED
  process.env.PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED = 'false'
  let server: StartedApiServer | undefined
  try {
    const hosted = await connectionFor('openai-compatible')
    const local = await connectionFor('lm-studio')
    server = await startApiServer({
      store: new FileSystemRunStore(workspacePath), launcher: new PiRunLauncher(),
      sessionStore: new FileSystemSessionStore(workspacePath), repoRootPath, workspacePath, providerSettingsService,
    })
    const url = server.url
    const turn = async (provider: string): Promise<string> => {
      const jobId = crypto.randomUUID()
      const response = await fetch(`${url}/create/resource-architect/turn`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          jobId, draftId: `draft-${jobId}`, operation: 'conversation', provider, model: 'fixture-architect',
          history: [{ role: 'user', text: 'Explain the exact run order of the Agent I have open.' }],
          currentPlan: null, selectedResource: { kind: 'agent', id: SELECTED_AGENT },
        }),
      })
      assert.equal(response.status, 200)
      const payload: unknown = await response.json()
      assert.ok(typeof payload === 'object' && payload !== null && 'message' in payload && typeof payload.message === 'string')
      return payload.message
    }

    const onLocal = await turn(local)
    const onHosted = await turn(hosted)

    assert.match(onLocal, /The saved package for Agent researcher is about \d+ tokens \(\d+ bytes\), more than the 27200 input tokens/)
    assert.equal(onHosted, 'Answered from the package.', "the hosted connection's Architect answered")
    assert.equal(model.requests.length, 1, 'only the hosted connection was asked')
    assert.ok(selectedPackageBlock(model.requests[0] ?? '')?.includes(SELECTED_PACKAGE_MARKERS.knowledge), 'with the whole package')
  } finally {
    if (previousReview === undefined) delete process.env.PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED
    else process.env.PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED = previousReview
    if (server) await server.close()
    await model.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
