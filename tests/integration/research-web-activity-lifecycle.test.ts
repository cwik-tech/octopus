import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { McpBrokerRequestContext } from '../../contracts/mcp.js'
import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { AcquisitionSettingsService } from '../../services/acquisition-settings-service.js'
import { ResearchWebToolService } from '../../services/research-web-tool-service.js'

/**
 * A research step has to be visible while it is still running.
 *
 * The activity journal used to be written once, after the call finished, which
 * is why a turn could search and read for half a minute with nothing to show
 * for it. These tests hold the external boundary open and read the journal
 * while the call is still in flight.
 */

test('a search in flight is journalled as running and replaced in place when it finishes', async (context) => {
  const setup = await createResearchService(context, 'activity-lifecycle-search')
  const provider = await startHeldSearchProvider()
  context.after(() => provider.close())
  const service = setup.service(provider.url)

  const call = service.execute(setup.context, 'call-search', {
    action: 'search',
    query: 'held query',
  })
  await provider.requestReceived

  const inFlight = await service.listSession(setup.context.sessionId)
  assert.equal(inFlight.length, 1)
  assert.equal(inFlight[0]?.state, 'running')
  assert.equal(inFlight[0]?.action, 'search')
  assert.equal(inFlight[0]?.toolCallId, 'call-search')
  const activityId = inFlight[0]?.activityId
  assert.ok(activityId)

  provider.release()
  const output = await call
  assert.equal(output.ok, true, JSON.stringify(output))

  const settled = await service.listSession(setup.context.sessionId)
  assert.equal(settled.length, 1, 'the running row is replaced, not duplicated')
  assert.equal(settled[0]?.activityId, activityId)
  assert.equal(settled[0]?.state, 'completed')
  assert.equal(settled[0]?.resultCount, 1)
  assert.deepEqual(settled[0]?.searchProviders, ['exa'])
})

test('an acquisition in flight names the page it is reading', async (context) => {
  const setup = await createResearchService(context, 'activity-lifecycle-acquire')
  const source = await startHeldSourceServer()
  context.after(() => source.close())
  const service = setup.service('http://127.0.0.1:1/unused-search')

  const call = service.execute(setup.context, 'call-acquire', {
    action: 'acquire',
    url: source.url,
  })
  await source.requestReceived

  const inFlight = await service.listSession(setup.context.sessionId)
  assert.equal(inFlight.length, 1)
  assert.equal(inFlight[0]?.state, 'running')
  assert.equal(inFlight[0]?.action, 'acquire')
  assert.equal(inFlight[0]?.requestedUrl, source.url)

  source.release()
  const output = await call
  assert.equal(output.ok, true, JSON.stringify(output))

  const settled = await service.listSession(setup.context.sessionId)
  assert.equal(settled.length, 1)
  assert.equal(settled[0]?.state, 'completed')
  assert.equal(settled[0]?.canonicalUrl, source.url)
  assert.equal(settled[0]?.title, 'Held Source')
})

test('a second call is visible as running while the first one is still held', async (context) => {
  // The old reservation held its queue slot for the whole call, so a running
  // row written through it could not appear until the previous call ended.
  const setup = await createResearchService(context, 'activity-lifecycle-parallel')
  const provider = await startHeldSearchProvider()
  context.after(() => provider.close())
  const service = setup.service(provider.url)

  const first = service.execute(
    { ...setup.context, providerCallOrdinal: 0 },
    'call-first',
    { action: 'search', query: 'held query' },
  )
  await provider.requestReceived
  const second = service.execute(
    { ...setup.context, providerCallOrdinal: 1 },
    'call-second',
    { action: 'search', query: 'second held query' },
  )
  await provider.secondRequestReceived

  const inFlight = await service.listSession(setup.context.sessionId)
  assert.deepEqual(
    inFlight.map((entry) => entry.toolCallId),
    ['call-first', 'call-second'],
  )
  assert.deepEqual(inFlight.map((entry) => entry.state), ['running', 'running'])

  provider.release()
  const [firstOutput, secondOutput] = await Promise.all([first, second])
  assert.equal(firstOutput.ok, true)
  assert.equal(secondOutput.ok, true)

  const settled = await service.listSession(setup.context.sessionId)
  assert.deepEqual(
    settled.map((entry) => entry.toolCallId),
    ['call-first', 'call-second'],
  )
  assert.deepEqual(settled.map((entry) => entry.state), ['completed', 'completed'])
})

test('a cancelled call turns its own row terminal rather than adding one', async (context) => {
  const setup = await createResearchService(context, 'activity-lifecycle-cancel')
  const provider = await startHeldSearchProvider()
  context.after(() => provider.close())
  const service = setup.service(provider.url)

  const controller = new AbortController()
  const call = service.execute(
    setup.context,
    'call-cancelled',
    { action: 'search', query: 'held query' },
    controller.signal,
  )
  await provider.requestReceived

  const inFlight = await service.listSession(setup.context.sessionId)
  assert.equal(inFlight.length, 1)
  const activityId = inFlight[0]?.activityId

  controller.abort()
  const output = await call
  assert.equal(output.ok, false)

  const settled = await service.listSession(setup.context.sessionId)
  assert.equal(settled.length, 1)
  assert.equal(settled[0]?.activityId, activityId)
  assert.equal(settled[0]?.state, 'cancelled')
  provider.release()
})

test('a journal that cannot be written does not fail the research call', async (context) => {
  // The journal is a diagnostic and a UI surface, not the tool's product. It
  // used to be written only after the call, so a write failure could not cost
  // the user their research; publishing a row up front must not change that.
  const setup = await createResearchService(context, 'activity-lifecycle-unwritable')
  const source = await startHeldSourceServer()
  context.after(() => source.close())
  // A directory where the journal file belongs, so the atomic replace fails
  // while the assignment scope around it stays valid.
  await fs.mkdir(setup.activityFilePath, { recursive: true })
  await fs.writeFile(path.join(setup.activityFilePath, 'occupied'), 'x')
  const service = setup.service('http://127.0.0.1:1/unused-search')
  source.release()

  const output = await service.execute(setup.context, 'call-acquire', {
    action: 'acquire',
    url: source.url,
  })
  assert.equal(output.ok, true, JSON.stringify(output))
  assert.equal(output.canonicalUrl, source.url)
})

async function createResearchService(
  context: { after(fn: () => unknown): void },
  name: string,
): Promise<{
  readonly context: McpBrokerRequestContext & { readonly activityScopeId: string }
  readonly activityFilePath: string
  service(searchUrl: string): ResearchWebToolService
}> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`)),
  )
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const agentPath = 'agents/researcher'
  await fs.mkdir(path.join(repoRootPath, agentPath), { recursive: true })
  await fs.writeFile(
    path.join(repoRootPath, agentPath, 'researcher.md'),
    ['---', 'name: researcher', 'tools: read, research_web', '---', '', '# Researcher', ''].join('\n'),
  )
  const requestContext = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: `request-${name}`,
    leaseId: `lease-${name}`,
    sessionId: `session-${name}`,
    runId: `run-${name}`,
    assignmentId: `assignment-${name}`,
    activityScopeId: `lane-${name}`,
    agentPath,
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, requestContext)
  assert.ok(location)
  await fs.mkdir(location.assignmentPath, { recursive: true })
  return {
    context: requestContext,
    activityFilePath: path.join(
      workspacePath,
      'sessions',
      requestContext.sessionId,
      'research-acquisition.json',
    ),
    service: (searchUrl) => new ResearchWebToolService({
      workspacePath,
      repoRootPath,
      allowHttpLocalhost: true,
      settings: new AcquisitionSettingsService({
        environment: { EXA_API_KEY: 'test-exa-key' },
        providerEndpoints: { exa: searchUrl },
      }),
    }),
  }
}

/** A search provider that answers only when the test says so. */
async function startHeldSearchProvider(): Promise<{
  readonly url: string
  readonly requestReceived: Promise<void>
  readonly secondRequestReceived: Promise<void>
  release(): void
  close(): Promise<void>
}> {
  let announceFirst: (() => void) | undefined
  const requestReceived = new Promise<void>((resolve) => { announceFirst = resolve })
  let announceSecond: (() => void) | undefined
  const secondRequestReceived = new Promise<void>((resolve) => { announceSecond = resolve })
  let release: (() => void) | undefined
  const released = new Promise<void>((resolve) => { release = resolve })
  let seen = 0
  const server = http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      seen += 1
      if (seen === 1) announceFirst?.()
      else announceSecond?.()
      void released.then(() => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          results: [{
            title: 'Held result',
            url: 'https://example.com/held',
            text: 'Deterministic local search evidence.',
            score: 0.9,
          }],
        }))
      })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}/search`,
    requestReceived,
    secondRequestReceived,
    release: () => release?.(),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

/** A source page that answers only when the test says so. */
async function startHeldSourceServer(): Promise<{
  readonly url: string
  readonly requestReceived: Promise<void>
  release(): void
  close(): Promise<void>
}> {
  let announce: (() => void) | undefined
  const requestReceived = new Promise<void>((resolve) => { announce = resolve })
  let release: (() => void) | undefined
  const released = new Promise<void>((resolve) => { release = resolve })
  const server = http.createServer((request, response) => {
    request.resume()
    announce?.()
    void released.then(() => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><title>Held Source</title></head>
        <body><main><h1>Held Source</h1><p>
        This local source page carries enough directly observed evidence for the
        researcher to cite it without relying on a search snippet, and it stays
        open until the test releases it.
        </p></main></body></html>`)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}/held-source`,
    requestReceived,
    release: () => release?.(),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}
