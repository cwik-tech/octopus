import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CapabilityDispatcher } from '../../core/capability-dispatcher.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'
import { CapabilityInvocationBindings } from '../../core/capability-invocation-bindings.js'
import {
  RESEARCH_WEB_SERVER_ID,
  RESEARCH_WEB_TOOL_CONTRACT_VERSION,
} from '../../domains/acquisition/acquisition-types.js'
import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { AcquisitionSettingsService } from '../../services/acquisition-settings-service.js'
import { ResearchWebCapabilityDispatchGateway } from '../../services/research-web-capability-adapter.js'
import { ResearchWebToolService } from '../../services/research-web-tool-service.js'

test('concurrent research activity is persisted in tool-call order', async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'research-activity-order-')),
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
    requestId: 'request-activity-order',
    leaseId: 'lease-activity-order',
    sessionId: 'session-activity-order',
    runId: 'run-activity-order',
    assignmentId: 'assignment-activity-order',
    activityScopeId: 'lane-activity-order',
    agentPath,
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, requestContext)
  assert.ok(location)
  await fs.mkdir(location.assignmentPath, { recursive: true })
  const provider = await startControlledSearchProvider()
  context.after(() => provider.close())
  const service = new ResearchWebToolService({
    workspacePath,
    repoRootPath,
    settings: new AcquisitionSettingsService({
      environment: { EXA_API_KEY: 'test-exa-key' },
      providerEndpoints: { exa: provider.url },
    }),
    now: () => new Date('2026-08-16T12:00:00.000Z'),
  })

  const first = service.execute(requestContext, 'call-slow', {
    action: 'search',
    query: 'slow query',
  })
  await provider.slowRequestReceived
  const second = service.execute(requestContext, 'call-fast', {
    action: 'search',
    query: 'fast query',
  })
  await provider.fastResponseSent
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  provider.completeSlowRequest()
  const [firstOutput, secondOutput] = await Promise.all([first, second])
  assert.equal(firstOutput.ok, true)
  assert.equal(secondOutput.ok, true)

  const activity = await service.listSession(requestContext.sessionId)
  assert.deepEqual(
    activity.map((entry) => entry.toolCallId),
    ['call-slow', 'call-fast'],
  )
})

test('dispatcher gate delay cannot reorder persisted research activity', async (context) => {
  // The reservation is taken inside the service, after each parallel dispatch
  // has independently crossed authorization, policy, and budget gates. Delaying
  // the earlier call's gate makes it reach the service second — the divergence
  // a service-level test cannot observe.
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'research-activity-dispatch-')),
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
  const baseContext = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-dispatch-order',
    leaseId: 'lease-dispatch-order',
    sessionId: 'session-dispatch-order',
    runId: 'run-dispatch-order',
    assignmentId: 'assignment-dispatch-order',
    activityScopeId: 'lane-dispatch-order',
    agentPath,
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, baseContext)
  assert.ok(location)
  await fs.mkdir(location.assignmentPath, { recursive: true })
  const provider = await startImmediateSearchProvider()
  context.after(() => provider.close())

  const service = new ResearchWebToolService({
    workspacePath,
    repoRootPath,
    settings: new AcquisitionSettingsService({
      environment: { EXA_API_KEY: 'test-exa-key' },
      providerEndpoints: { exa: provider.url },
    }),
  })

  let releaseFirstAuthorization: (() => void) | undefined
  const firstAuthorizationHeld = new Promise<void>((resolve) => {
    releaseFirstAuthorization = resolve
  })
  let authorizations = 0
  const gateway = new ResearchWebCapabilityDispatchGateway({
    service,
    dispatcher: new CapabilityDispatcher({
      bindings: new CapabilityInvocationBindings({
        maxActivePerScope: 4,
        maxRetainedPerScope: 16,
      }),
      authority: {
        authorize: async () => {
          authorizations += 1
          if (authorizations === 1) await firstAuthorizationHeld
          return { kind: 'allow' as const }
        },
      },
      policy: { evaluate: async () => ({ kind: 'allow' as const }) },
      budget: {
        preflight: async () => ({ kind: 'not-metered' as const }),
        reserve: async () => ({ reservationId: 'unused' }),
        settle: async () => ({ costTracked: false, budgetOverrun: false }),
        release: async () => undefined,
      },
      evidence: { append: async () => undefined },
      scheduler: new PerAuthorityCapabilityExecutionScheduler(),
      clock: { now: Date.now },
      ids: { nextAttemptId: () => 'dispatch-order-attempt' },
    }),
  })

  const dispatch = (toolCallId: string, ordinal: number) => gateway.execute({
    context: { ...baseContext, providerCallOrdinal: ordinal },
    authority: { kind: 'mcp-lease' as const, leaseId: baseContext.leaseId },
    source: {
      kind: 'builtin' as const,
      id: RESEARCH_WEB_SERVER_ID,
      version: String(RESEARCH_WEB_TOOL_CONTRACT_VERSION),
    },
    toolCallId,
    input: { action: 'search', query: `${toolCallId} query` },
  })

  const first = dispatch('call-first', 0)
  await new Promise<void>((resolve) => setImmediate(resolve))
  const second = dispatch('call-second', 1)
  const secondOutput = await second
  assert.equal(secondOutput.ok, true, JSON.stringify(secondOutput))
  releaseFirstAuthorization?.()
  const firstOutput = await first
  assert.equal(firstOutput.ok, true, JSON.stringify(firstOutput))

  const activity = await service.listSession(baseContext.sessionId)
  assert.deepEqual(
    activity.map((entry) => entry.toolCallId),
    ['call-first', 'call-second'],
  )
  assert.deepEqual(
    activity.map((entry) => entry.providerCallOrdinal),
    [0, 1],
  )
})

async function startImmediateSearchProvider(): Promise<{
  readonly url: string
  close(): Promise<void>
}> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        results: [{
          title: 'Result',
          url: 'https://example.com/result',
          text: 'Result snippet.',
        }],
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Search provider address is unavailable.')
  }
  return {
    url: `http://127.0.0.1:${address.port}/search`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    }),
  }
}

async function startControlledSearchProvider(): Promise<{
  readonly url: string
  readonly slowRequestReceived: Promise<void>
  readonly fastResponseSent: Promise<void>
  completeSlowRequest(): void
  close(): Promise<void>
}> {
  let signalSlowRequest: (() => void) | undefined
  const slowRequestReceived = new Promise<void>((resolve) => {
    signalSlowRequest = resolve
  })
  let signalFastResponse: (() => void) | undefined
  const fastResponseSent = new Promise<void>((resolve) => {
    signalFastResponse = resolve
  })
  let completeSlowRequest: (() => void) | undefined
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const complete = () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          results: [{
            title: body.includes('slow query') ? 'Slow result' : 'Fast result',
            url: body.includes('slow query')
              ? 'https://example.com/slow'
              : 'https://example.com/fast',
            text: 'Deterministic local search evidence.',
            score: 0.9,
          }],
        }))
      }
      if (body.includes('slow query')) {
        completeSlowRequest = complete
        signalSlowRequest?.()
      } else {
        response.once('finish', () => signalFastResponse?.())
        complete()
      }
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
    slowRequestReceived,
    fastResponseSent,
    completeSlowRequest() {
      if (!completeSlowRequest) throw new Error('The slow search request is not pending.')
      completeSlowRequest()
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}
