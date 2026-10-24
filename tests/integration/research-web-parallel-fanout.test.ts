import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'

import {
  hostAuditedParallelReadEffect,
  mayRunConcurrently,
} from '../../contracts/capability-effect.js'
import type { CapabilityDispatchEvent } from '../../contracts/capability-dispatch.js'
import { toMcpJsonObject } from '../../contracts/mcp.js'
import { CapabilityDispatcher } from '../../core/capability-dispatcher.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'
import { CapabilityInvocationBindings } from '../../core/capability-invocation-bindings.js'
import {
  RESEARCH_WEB_SERVER_ID,
  RESEARCH_WEB_TOOL_CONTRACT_VERSION,
  type ResearchWebToolOutput,
} from '../../domains/acquisition/acquisition-types.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerRequestContext,
} from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { AcquisitionSettingsService } from '../../services/acquisition-settings-service.js'
import { toBuiltinCapabilityExecutionContext } from '../../services/builtin-capability-context.js'
import {
  ResearchWebCapabilityAdapter,
  ResearchWebCapabilityDispatchGateway,
} from '../../services/research-web-capability-adapter.js'
import { ResearchWebToolService } from '../../services/research-web-tool-service.js'

interface SourceMarker {
  readonly url: string
  readonly startedAt: number
  readonly endedAt: number
}

const SOURCE_LATENCY_MS = 250

test('research web dispatches in one scope overlap and match sequential results', async (context) => {
  const harness = await createHarness(context)
  const fanInputs = [
    { toolCallId: 'call-fan-a', input: { action: 'acquire', url: harness.sourceUrl('fan', 'a') } },
    { toolCallId: 'call-fan-b', input: { action: 'acquire', url: harness.sourceUrl('fan', 'b') } },
  ]
  const seqInputs = [
    { toolCallId: 'call-seq-a', input: { action: 'acquire', url: harness.sourceUrl('seq', 'a') } },
    { toolCallId: 'call-seq-b', input: { action: 'acquire', url: harness.sourceUrl('seq', 'b') } },
  ]

  const fanStartedAt = performance.now()
  const fanResults = await Promise.all(
    fanInputs.map((entry) => harness.dispatch(entry.toolCallId, entry.input)),
  )
  const fanElapsed = performance.now() - fanStartedAt

  const seqStartedAt = performance.now()
  const seqResults = [
    await harness.dispatch(seqInputs[0]!.toolCallId, seqInputs[0]!.input),
    await harness.dispatch(seqInputs[1]!.toolCallId, seqInputs[1]!.input),
  ]
  const seqElapsed = performance.now() - seqStartedAt

  for (const output of [...fanResults, ...seqResults]) {
    assert.equal(output.ok, true, JSON.stringify(output))
    assert.equal(output.method, 'direct-http')
  }
  for (const [letter, fan, seq] of [
    ['a', fanResults[0]!, seqResults[0]!],
    ['b', fanResults[1]!, seqResults[1]!],
  ] as const) {
    assert.match(fan.text ?? '', new RegExp(`fan-out evidence ${letter}`, 'u'))
    assert.equal(fan.title, seq.title)
    assert.equal(fan.text, seq.text)
    assert.equal(fan.canonicalUrl, harness.sourceUrl('fan', letter))
    assert.equal(seq.canonicalUrl, harness.sourceUrl('seq', letter))
    assert.ok(fan.observationReceipt)
    assert.ok(seq.observationReceipt)
  }

  const fanMarkers = harness.markersFor('fan')
  assert.equal(fanMarkers.length, 2)
  const latestStart = Math.max(...fanMarkers.map((marker) => marker.startedAt))
  const earliestEnd = Math.min(...fanMarkers.map((marker) => marker.endedAt))
  assert.ok(
    latestStart < earliestEnd,
    `expected the two concurrent acquisitions to overlap in time (latest start ${latestStart} vs earliest end ${earliestEnd})`,
  )
  const seqMarkers = harness.markersFor('seq')
  assert.equal(seqMarkers.length, 2)
  assert.ok(
    seqMarkers[0]!.endedAt <= seqMarkers[1]!.startedAt,
    'expected the sequential baseline acquisitions not to overlap',
  )
  assert.ok(
    fanElapsed < seqElapsed,
    `expected the concurrent fan-out (${fanElapsed.toFixed(0)}ms) to beat the sequential baseline (${seqElapsed.toFixed(0)}ms)`,
  )
})

test('research web same-URL concurrent acquisitions both succeed with unique evidence paths', async (context) => {
  const harness = await createHarness(context)
  const sharedUrl = harness.sourceUrl('shared', 'a')

  const [first, second] = await Promise.all([
    harness.dispatch('call-shared-1', { action: 'acquire', url: sharedUrl }),
    harness.dispatch('call-shared-2', { action: 'acquire', url: sharedUrl }),
  ])

  for (const output of [first, second]) {
    assert.equal(output.ok, true, JSON.stringify(output))
    assert.equal(output.method, 'direct-http')
    assert.ok(output.observationReceipt)
  }
  assert.notEqual(
    first.observationReceipt?.relativePath,
    second.observationReceipt?.relativePath,
    'concurrent acquisitions of one URL must not collide on receipt paths',
  )
  assert.notEqual(
    first.observationReceipt?.contentRelativePath,
    second.observationReceipt?.contentRelativePath,
    'concurrent acquisitions of one URL must not collide on content paths',
  )
  assert.equal(
    harness.markersFor('shared').length,
    2,
    'the accepted duplicate-work race fetches the shared URL once per concurrent caller',
  )
})

test('research web effect is the host-audited parallel read singleton at both sites', async (context) => {
  const harness = await createHarness(context)

  assert.equal(mayRunConcurrently(harness.service.tool.effect), true)
  assert.equal(harness.service.tool.effect, hostAuditedParallelReadEffect())

  const executionContext = toBuiltinCapabilityExecutionContext(
    harness.context,
    { kind: 'mcp-lease', leaseId: harness.context.leaseId },
  )
  const adapter = new ResearchWebCapabilityAdapter({
    service: harness.service,
    context: harness.context,
  })
  const prepared = await adapter.prepare({
    context: executionContext,
    invocation: {
      capabilityId: 'research.web',
      source: {
        kind: 'builtin',
        id: RESEARCH_WEB_SERVER_ID,
        version: String(RESEARCH_WEB_TOOL_CONTRACT_VERSION),
      },
      toolCallId: 'call-effect-assertion',
    },
    arguments: toMcpJsonObject({ action: 'acquire', url: harness.sourceUrl('effect', 'a') }),
    canonicalArguments: '',
    argumentDigest: '',
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(prepared.effect, hostAuditedParallelReadEffect())
  assert.equal(mayRunConcurrently(prepared.effect), true)
})

interface ResearchHarness {
  readonly service: ResearchWebToolService
  readonly context: McpBrokerRequestContext & { readonly activityScopeId: string }
  sourceUrl(kind: string, letter: string): string
  markersFor(kind: string): readonly SourceMarker[]
  dispatch(
    toolCallId: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<ResearchWebToolOutput>
}

async function createHarness(context: {
  after(callback: () => Promise<unknown> | unknown): unknown
}): Promise<ResearchHarness> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'research-web-fanout-')),
  )
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const agentPath = 'agents/researcher'
  await fs.mkdir(path.join(repoRootPath, agentPath), { recursive: true })
  await fs.writeFile(
    path.join(repoRootPath, agentPath, 'researcher.md'),
    [
      '---',
      'name: researcher',
      'tools: read, research_web',
      '---',
      '',
      '# Researcher',
      '',
    ].join('\n'),
  )
  const brokerContext: McpBrokerRequestContext & {
    readonly activityScopeId: string
  } = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-fanout',
    leaseId: 'lease-fanout',
    sessionId: 'session-fanout',
    runId: 'run-fanout',
    assignmentId: 'assignment-fanout',
    activityScopeId: 'lane-fanout',
    agentPath,
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, brokerContext)
  assert.ok(location)
  await fs.mkdir(location.assignmentPath, { recursive: true })

  const markers: SourceMarker[] = []
  const server = await startTracedSourceServer(markers)
  context.after(() => server.close())

  const service = new ResearchWebToolService({
    workspacePath,
    repoRootPath,
    settings: new AcquisitionSettingsService({ environment: {} }),
    allowHttpLocalhost: true,
  })
  let attempt = 0
  const gateway = new ResearchWebCapabilityDispatchGateway({
    service,
    dispatcher: new CapabilityDispatcher({
      bindings: new CapabilityInvocationBindings({
        maxActivePerScope: 4,
        maxRetainedPerScope: 16,
      }),
      authority: { authorize: async () => ({ kind: 'allow' }) },
      policy: { evaluate: async () => ({ kind: 'allow' }) },
      budget: {
        preflight: async () => ({ kind: 'not-metered' }),
        reserve: async () => ({ reservationId: 'fanout-reservation' }),
        settle: async () => ({ costTracked: false, budgetOverrun: false }),
        release: async () => undefined,
      },
      evidence: {
        append: async (_event: CapabilityDispatchEvent) => undefined,
      },
      scheduler: new PerAuthorityCapabilityExecutionScheduler(),
      clock: { now: Date.now },
      ids: {
        nextAttemptId: () => {
          attempt += 1
          return `fanout-attempt-${attempt}`
        },
      },
    }),
  })

  return {
    service,
    context: brokerContext,
    sourceUrl: (kind, letter) => `${server.url}/${kind}/${letter}.html`,
    markersFor: (kind) => markers.filter((marker) => marker.url.includes(`/${kind}/`)),
    dispatch: (toolCallId, input) =>
      gateway.execute({
        context: brokerContext,
        authority: { kind: 'mcp-lease', leaseId: brokerContext.leaseId },
        source: {
          kind: 'builtin',
          id: RESEARCH_WEB_SERVER_ID,
          version: String(RESEARCH_WEB_TOOL_CONTRACT_VERSION),
        },
        toolCallId,
        input: toMcpJsonObject(input),
      }),
  }
}

async function startTracedSourceServer(markers: SourceMarker[]): Promise<{
  readonly url: string
  close(): Promise<void>
}> {
  const server = http.createServer((request, response) => {
    const startedAt = performance.now()
    const letter = /\/([ab])\.html$/u.exec(request.url ?? '')?.[1] ?? 'a'
    const timer = setTimeout(() => {
      const endedAt = performance.now()
      markers.push({ url: request.url ?? '', startedAt, endedAt })
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end([
        `<!doctype html><html><head><title>Fan-out source ${letter}</title></head><body>`,
        `<main><h1>Source ${letter}</h1><p>`,
        `This fan-out evidence ${letter} page carries enough independent prose for the `,
        `acquisition quality gate to accept a direct HTTP observation without a browser `,
        `fallback. The content is deterministic per source letter so concurrent and `,
        `sequential acquisitions can be compared byte for byte.`,
        `</p></main></body></html>`,
      ].join(''))
    }, SOURCE_LATENCY_MS)
    request.on('close', () => clearTimeout(timer))
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
