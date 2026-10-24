import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { handleYoutubeSettingsRoutes } from '../../server/routes/youtube-settings.js'
import { handleYoutubeToolRoute } from '../../server/routes/youtube-tool.js'
import type { RuntimeCapabilityAuthorityPort } from '../../contracts/runtime-capability-authority.js'
import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import { YoutubeSettingsService } from '../../services/youtube-settings-service.js'
import { YoutubeToolService } from '../../services/youtube-tool-service.js'
import { YoutubeCapabilityDispatchGateway } from '../../services/youtube-capability-adapter.js'
import { YOUTUBE_TOOL_CONTRACT_VERSION } from '../../domains/youtube/youtube-types.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'

const secretCodec = {
  encrypt: (value: string) => Buffer.from(`sealed:${value}`).toString('base64'),
  decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8').slice('sealed:'.length),
}

test('YouTube settings routes expose, persist, validate, and reject malformed requests', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-settings-route-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const service = new YoutubeSettingsService({
    storagePath: path.join(directory, 'settings', 'youtube-settings.json'),
    secretCodec,
    environment: {},
    validateGemini: async (config) => {
      assert.equal(config.apiKey, 'route-gemini-secret')
      assert.equal(config.model, 'gemini-3.6-pro')
    },
    listGeminiModels: async (config) => {
      assert.equal(config.apiKey, 'route-gemini-secret')
      return [
        { id: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash' },
        { id: 'gemini-3.6-pro', displayName: 'Gemini 3.6 Pro' },
      ]
    },
  })
  const server = await startServer(async (req, res) => {
    const handled = await handleYoutubeSettingsRoutes({
      req,
      res,
      url: new URL(req.url ?? '/', 'http://127.0.0.1'),
      service,
    })
    if (!handled) sendNotFound(res)
  })
  context.after(() => server.close())

  const candidate = await fetch(`${server.url}/settings/youtube/gemini/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'route-gemini-secret',
      model: 'gemini-3.6-pro',
    }),
  })
  assert.equal(candidate.status, 200)
  assert.deepEqual(await json(candidate), { valid: true })
  assert.equal((await service.snapshot()).geminiApiKeyConfigured, false)
  await assert.rejects(fs.access(path.join(directory, 'settings', 'youtube-settings.json')))

  const initial = await fetch(`${server.url}/settings/youtube`)
  assert.equal(initial.status, 200)
  assert.equal(initial.headers.get('cache-control'), 'no-store')
  assert.equal((await json(initial)).source, 'default')

  const validUpdate = {
    proxyEnabled: false,
    credentialMode: 'api-token',
    proxyHost: 'p.webshare.io',
    proxyPort: 80,
    countries: ['us'],
    username: '',
    apiToken: 'route-secret',
    geminiApiKey: 'route-gemini-secret',
    geminiModel: 'gemini-3.6-pro',
    geminiDailyVideoMinutesLimit: 120,
    geminiConfirmationThresholdMinutes: 30,
    deleteVideosAfterInfoExtraction: true,
  }
  const saved = await fetch(`${server.url}/settings/youtube`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...validUpdate,
      ignored: { legacy: true },
    }),
  })
  assert.equal(saved.status, 200)
  const snapshot = await json(saved)
  assert.equal(snapshot.apiTokenConfigured, true)
  assert.equal('apiToken' in snapshot, false)
  assert.equal('ignored' in snapshot, false)
  assert.equal(snapshot.geminiApiKeyConfigured, true)
  assert.equal('geminiApiKey' in snapshot, false)
  assert.equal(snapshot.geminiModel, 'gemini-3.6-pro')
  assert.equal(snapshot.deleteVideosAfterInfoExtraction, true)

  const models = await fetch(`${server.url}/settings/youtube/gemini/models`)
  assert.equal(models.status, 200)
  assert.equal(models.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await json(models), {
    models: [
      { id: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash' },
      { id: 'gemini-3.6-pro', displayName: 'Gemini 3.6 Pro' },
    ],
  })

  const geminiValidated = await fetch(`${server.url}/settings/youtube/gemini/validate`, {
    method: 'POST',
  })
  assert.equal(geminiValidated.status, 200)
  assert.equal((await json(geminiValidated)).geminiStatus, 'connected')

  const validated = await fetch(`${server.url}/settings/youtube/validate`, { method: 'POST' })
  assert.equal(validated.status, 200)
  assert.equal((await json(validated)).proxyStatus, 'error')

  for (const { body, error } of [
    {
      body: {},
      error: 'YouTube settings request is invalid.',
    },
    {
      body: null,
      error: 'YouTube settings request must be an object.',
    },
    {
      body: { ...validUpdate, proxyPort: '80' },
      error: 'YouTube settings request is invalid.',
    },
  ]) {
    const invalid = await fetch(`${server.url}/settings/youtube`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(invalid.status, 400)
    assert.deepEqual(await json(invalid), { error })
  }

  const malformed = await fetch(`${server.url}/settings/youtube`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: '{',
  })
  assert.equal(malformed.status, 400)
  assert.deepEqual(await json(malformed), {
    error: 'Invalid JSON request body',
  })

  const wrongMethod = await fetch(`${server.url}/settings/youtube`, { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.get('allow'), 'GET, PATCH')
  assert.deepEqual(await json(wrongMethod), { error: 'Method not allowed' })
})

test('YouTube settings GET returns malformed environment configuration as a field error', async (context) => {
  const service = new YoutubeSettingsService({
    environment: { WEBSHARE_PROXY_PORT: 'broken' },
  })
  const server = await startServer(async (req, res) => {
    const handled = await handleYoutubeSettingsRoutes({
      req,
      res,
      url: new URL(req.url ?? '/', 'http://127.0.0.1'),
      service,
    })
    if (!handled) sendNotFound(res)
  })
  context.after(() => server.close())
  const response = await fetch(`${server.url}/settings/youtube`)
  assert.equal(response.status, 200)
  const snapshot = await json(response)
  assert.equal(snapshot.source, 'environment')
  assert.equal(snapshot.proxyStatus, 'error')
  assert.match(String(snapshot.error), /WEBSHARE_PROXY_PORT/)
})

test('private YouTube tool route enforces its HTTP contract and writes through the real service', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-tool-route-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const assignmentPath = path.join(
    workspacePath,
    'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
  )
  await fs.mkdir(assignmentPath, { recursive: true })
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
  })
  const invoker = new YoutubeCapabilityDispatchGateway({
    dispatcher: createCapabilityTestDispatcher(),
    service,
  })
  const authority: RuntimeCapabilityAuthorityPort = {
    authorize: async (claims) => ({
      taskId: claims.taskId,
      workflowId: 'youtube-route-workflow',
      runPath: path.join(workspacePath, 'sessions', 'session-1', 'runs', 'run-1'),
      assignmentPath,
    }),
  }
  const server = await startServer(async (req, res) => {
    await handleYoutubeToolRoute({ req, res, invoker, authority })
  })
  context.after(() => server.close())
  const request = {
    version: YOUTUBE_TOOL_CONTRACT_VERSION,
    context: {
      contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
      requestId: 'request-1',
      leaseId: 'lease-1',
      sessionId: 'session-1',
      runId: 'run-1',
      assignmentId: 'assignment-1',
      taskId: 'task-1',
      processIdentity: 'process-1',
      agentPath: 'agents/youtube-extractor',
    },
    toolCallId: 'call-1',
    input: {
      action: 'write_methodology',
      videoId: 'dQw4w9WgXcQ',
      content: '# Route artifact',
    },
  }
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  assert.equal(response.status, 200)
  assert.equal((await json<{ output: { ok: boolean } }>(response)).output.ok, true)
  assert.equal(
    await fs.readFile(path.join(assignmentPath, 'output', 'methods', 'dQw4w9WgXcQ.md'), 'utf8'),
    '# Route artifact\n',
  )

  const ignoredEnvelopeFields = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...request,
      ignoredEnvelopeField: true,
      context: { ...request.context, ignoredContextField: true },
      input: {
        ...request.input,
        videoId: '9bZkp7q19f0',
        content: '# Ignored envelope fields',
      },
    }),
  })
  assert.equal(ignoredEnvelopeFields.status, 200)

  for (const input of [
    { ...request.input, unsupported: true },
    { ...request.input, fileName: null },
    { ...request.input, chunkIndex: '0' },
  ]) {
    const invalid = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, input }),
    })
    assert.equal(invalid.status, 400)
    assert.deepEqual(await json(invalid), {
      error: 'YouTube tool request is invalid',
    })
  }

  const originDenied = await fetch(server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://example.com',
    },
    body: JSON.stringify(request),
  })
  assert.equal(originDenied.status, 403)
  assert.deepEqual(await json(originDenied), { error: 'Origin not allowed' })
  const wrongMethod = await fetch(server.url)
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.get('allow'), 'POST')
  assert.deepEqual(await json(wrongMethod), { error: 'Method not allowed' })
})

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handler(req, res).catch((error) => {
      res.statusCode = 500
      res.end(error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

async function json<T extends object = Record<string, unknown>>(response: Response): Promise<T> {
  return response.json() as Promise<T>
}

function sendNotFound(response: http.ServerResponse): void {
  response.statusCode = 404
  response.end()
}
