import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'

import {
  runProviderToolLoop,
  ProviderToolLoopError,
  type ProviderToolLoopToolMessage,
  type ProviderToolDefinition,
} from '../../domains/provider/provider-tool-loop.js'
import type { CapabilityDispatchEvent } from '../../contracts/capability-dispatch.js'
import type { McpJsonObject } from '../../contracts/mcp.js'
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
import { ResearchWebCapabilityDispatchGateway } from '../../services/research-web-capability-adapter.js'
import { ResearchWebToolService } from '../../services/research-web-tool-service.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'

const SOURCE_LATENCY_MS = 250

test('a provider turn of three research acquisitions overlaps and beats the sequential wall time', async (context) => {
  const harness = await createProviderFanoutHarness(context)
  const parallel = await runResearchTurn(harness, 'parallel', {
    urls: ['par/1.html', 'par/2.html', 'par/3.html'],
  })
  const sequential = await runResearchTurn(harness, 'sequential', {
    urls: ['seq/1.html', 'seq/2.html', 'seq/3.html'],
    maxConcurrentToolCalls: 1,
  })

  assert.deepEqual(
    parallel.messages.map((message) => message.toolCallId),
    ['parallel-call-1', 'parallel-call-2', 'parallel-call-3'],
    'tool messages must follow call order',
  )
  assert.deepEqual(
    sequential.messages.map((message) => message.toolCallId),
    ['sequential-call-1', 'sequential-call-2', 'sequential-call-3'],
  )
  for (let index = 0; index < 3; index += 1) {
    const parallelOutput = parallel.outputs[index]!
    const sequentialOutput = sequential.outputs[index]!
    assert.equal(parallelOutput.ok, true, JSON.stringify(parallelOutput))
    assert.equal(sequentialOutput.ok, true, JSON.stringify(sequentialOutput))
    assert.equal(parallelOutput.method, 'direct-http')
    assert.equal(parallelOutput.text, sequentialOutput.text)
    assert.equal(parallelOutput.title, sequentialOutput.title)
  }
  assert.ok(
    parallel.trace.indexOf('start:parallel-call-2') <
      parallel.trace.indexOf('settle:parallel-call-1'),
    `expected concurrent research calls to overlap, observed: ${parallel.trace.join(',')}`,
  )
  assert.ok(
    sequential.trace.indexOf('start:sequential-call-2') >
      sequential.trace.indexOf('settle:sequential-call-1'),
    `expected the pool-1 twin to serialize, observed: ${sequential.trace.join(',')}`,
  )
  assert.ok(
    parallel.elapsedMs < sequential.elapsedMs * 0.75,
    `expected the parallel turn (${parallel.elapsedMs.toFixed(0)}ms) to beat three sequential acquisitions (${sequential.elapsedMs.toFixed(0)}ms)`,
  )
})

test('a provider turn of three searches overlaps with exact sequential output parity', async (context) => {
  const harness = await createProviderFanoutHarness(context)
  const inputs = [1, 2, 3].map((index) => ({
    action: 'search',
    query: `deterministic search ${index}`,
    maximumResults: 1,
  }))
  const parallel = await runResearchInputs(harness, 'search-parallel', {
    inputs,
  })
  const sequential = await runResearchInputs(harness, 'search-sequential', {
    inputs,
    maxConcurrentToolCalls: 1,
  })

  assert.deepEqual(
    parallel.messages.map((message) => message.toolCallId),
    ['search-parallel-call-1', 'search-parallel-call-2', 'search-parallel-call-3'],
  )
  assert.deepEqual(parallel.outputs, sequential.outputs)
  assert.ok(
    parallel.trace.indexOf('start:search-parallel-call-2') <
      parallel.trace.indexOf('settle:search-parallel-call-1'),
    `expected concurrent searches to overlap, observed: ${parallel.trace.join(',')}`,
  )
  assert.ok(
    sequential.trace.indexOf('start:search-sequential-call-2') >
      sequential.trace.indexOf('settle:search-sequential-call-1'),
    `expected the pool-1 search twin to serialize, observed: ${sequential.trace.join(',')}`,
  )
  assert.ok(
    parallel.elapsedMs < sequential.elapsedMs * 0.75,
    `expected parallel searches (${parallel.elapsedMs.toFixed(0)}ms) to beat sequential searches (${sequential.elapsedMs.toFixed(0)}ms)`,
  )
})

test('a routine domain failure in a parallel research turn keeps its siblings', async (context) => {
  const harness = await createProviderFanoutHarness(context)
  const turn = await runResearchTurn(harness, 'failure', {
    urls: ['missing.html', 'good.html'],
  })

  assert.equal(turn.messages.length, 2)
  assert.deepEqual(
    turn.messages.map((message) => message.toolCallId),
    ['failure-call-1', 'failure-call-2'],
  )
  assert.equal(turn.messages[0]!.isError, true)
  assert.equal(turn.outputs[0]!.ok, false)
  assert.equal(turn.outputs[0]!.error?.code, 'not_found')
  assert.equal(turn.messages[1]!.isError, false)
  assert.equal(turn.outputs[1]!.ok, true, JSON.stringify(turn.outputs[1]))
  assert.equal(turn.outputs[1]!.method, 'direct-http')
  assert.equal(turn.result.text, 'research complete')
})

test('a timeout failure in a parallel research turn aborts in-flight siblings and fails the turn', async (context) => {
  const harness = await createProviderFanoutHarness(context)
  const stalledUrl = harness.urlFor('stalled.html')
  const slowUrl = harness.urlFor('slow.html')
  await harness.prepareTurnScope('timeout')

  await assert.rejects(
    runProviderToolLoop({
      messages: [
        { role: 'system', content: 'Acquire sources.' },
        { role: 'user', content: 'Acquire both sources.' },
      ],
      tools: [harness.toolDefinition],
      toolTimeoutMs: 600,
      adapter: {
        complete: async (request) => {
          if (request.messages.some((message) => message.role === 'tool')) {
            return { content: 'research complete', toolCalls: [] }
          }
          return {
            content: null,
            toolCalls: [
              {
                id: 'timeout-call-1',
                name: harness.toolDefinition.name,
                arguments: { action: 'acquire', url: stalledUrl },
              },
              {
                id: 'timeout-call-2',
                name: harness.toolDefinition.name,
                arguments: { action: 'acquire', url: slowUrl },
              },
            ],
          }
        },
      },
      executeTool: (call, executionContext) =>
        harness.dispatch({
          turnLabel: 'timeout',
          toolCallId: call.id,
          input: call.arguments,
          signal: executionContext.signal,
        }).then((result) => result.providerResult),
    }),
    (error: unknown) =>
      error instanceof ProviderToolLoopError && error.code === 'timeout',
    'the stalled acquisition must fail the turn with a timeout',
  )
  await harness.settleInFlightDispatches()
  assert.equal(
    harness.slowResponsesCompleted,
    0,
    'the in-flight sibling must be aborted before its slow source responds',
  )
})

interface ProviderFanoutHarness {
  readonly toolDefinition: ProviderToolDefinition
  readonly slowResponsesCompleted: number
  urlFor(relativePath: string): string
  prepareTurnScope(turnLabel: string): Promise<void>
  settleInFlightDispatches(): Promise<void>
  dispatch(input: {
    readonly turnLabel: string
    readonly toolCallId: string
    readonly input: McpJsonObject
    readonly signal: AbortSignal
  }): Promise<{
    readonly output: ResearchWebToolOutput
    readonly providerResult: { content: string; isError: boolean }
  }>
}

interface ResearchTurnResult {
  readonly messages: readonly ProviderToolLoopToolMessage[]
  readonly outputs: readonly ResearchWebToolOutput[]
  readonly trace: readonly string[]
  readonly elapsedMs: number
  readonly result: { readonly text: string }
}

async function runResearchTurn(
  harness: ProviderFanoutHarness,
  turnLabel: string,
  options: {
    readonly urls: readonly string[]
    readonly maxConcurrentToolCalls?: number
  },
): Promise<ResearchTurnResult> {
  return runResearchInputs(harness, turnLabel, {
    inputs: options.urls.map((url) => ({ action: 'acquire', url: harness.urlFor(url) })),
    ...(options.maxConcurrentToolCalls === undefined
      ? {}
      : { maxConcurrentToolCalls: options.maxConcurrentToolCalls }),
  })
}

async function runResearchInputs(
  harness: ProviderFanoutHarness,
  turnLabel: string,
  options: {
    readonly inputs: readonly McpJsonObject[]
    readonly maxConcurrentToolCalls?: number
  },
): Promise<ResearchTurnResult> {
  const trace: string[] = []
  const outputs: ResearchWebToolOutput[] = []
  const startedAt = performance.now()
  await harness.prepareTurnScope(turnLabel)
  const result = await runProviderToolLoop({
    messages: [
      { role: 'system', content: 'Acquire sources.' },
      { role: 'user', content: 'Acquire every requested source.' },
    ],
    tools: [harness.toolDefinition],
    ...(options.maxConcurrentToolCalls === undefined
      ? {}
      : { maxConcurrentToolCalls: options.maxConcurrentToolCalls }),
    adapter: {
      complete: async (request) => {
        if (request.messages.some((message) => message.role === 'tool')) {
          return { content: 'research complete', toolCalls: [] }
        }
        return {
          content: null,
          toolCalls: options.inputs.map((input, index) => ({
            id: `${turnLabel}-call-${index + 1}`,
            name: harness.toolDefinition.name,
            arguments: input,
          })),
        }
      },
    },
    executeTool: async (call, executionContext) => {
      trace.push(`start:${call.id}`)
      const dispatched = await harness.dispatch({
        turnLabel,
        toolCallId: call.id,
        input: call.arguments,
        signal: executionContext.signal,
      })
      trace.push(`settle:${call.id}`)
      outputs[Number(call.id.slice(`${turnLabel}-call-`.length)) - 1] =
        dispatched.output
      return dispatched.providerResult
    },
  })
  const toolMessages = result.messages.filter(
    (message): message is ProviderToolLoopToolMessage => message.role === 'tool',
  )
  return {
    messages: toolMessages,
    outputs,
    trace,
    elapsedMs: performance.now() - startedAt,
    result: { text: result.text ?? '' },
  }
}

async function createProviderFanoutHarness(context: {
  after(callback: () => Promise<unknown> | unknown): unknown
}): Promise<ProviderFanoutHarness> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'research-provider-fanout-')),
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

  let slowResponsesCompleted = 0
  const server = http.createServer((request, response) => {
    const url = request.url ?? ''
    const letter = /\/([1-3])\.html$/u.exec(url)?.[1]
    if (url === '/search') {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const query = /"query":"([^"]+)"/u.exec(
          Buffer.concat(chunks).toString('utf8'),
        )?.[1] ?? 'unknown'
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({
            results: [{
              title: `Result for ${query}`,
              url: `https://example.com/${encodeURIComponent(query)}`,
              text: `Deterministic evidence for ${query}.`,
              score: 0.9,
            }],
          }))
        }, SOURCE_LATENCY_MS)
      })
      return
    }
    if (url.endsWith('/stalled.html')) {
      request.on('close', () => response.destroy())
      return
    }
    if (url.endsWith('/slow.html')) {
      const timer = setTimeout(() => {
        slowResponsesCompleted += 1
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(sourceDocument('slow', 'This slow source responds long after the turn deadline.'))
      }, 5_000)
      request.on('close', () => clearTimeout(timer))
      return
    }
    if (url.endsWith('/missing.html')) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html><body><h1>Not found</h1></body></html>')
      return
    }
    if (url.endsWith('/good.html')) {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(sourceDocument('good', 'This surviving sibling carries usable evidence for the research turn.'))
      }, SOURCE_LATENCY_MS)
      return
    }
    if (letter) {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(sourceDocument(`letter-${letter}`, `This provider fan-out evidence page ${letter} carries enough independent prose for the acquisition quality gate.`))
      }, SOURCE_LATENCY_MS)
      return
    }
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('unexpected fixture request')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`

  const service = new ResearchWebToolService({
    workspacePath,
    repoRootPath,
    settings: new AcquisitionSettingsService({
      environment: { EXA_API_KEY: 'test-exa-key' },
      providerEndpoints: { exa: `${baseUrl}/search` },
    }),
    allowHttpLocalhost: true,
  })
  const events: CapabilityDispatchEvent[] = []
  const gateway = new ResearchWebCapabilityDispatchGateway({
    service,
    dispatcher: createCapabilityTestDispatcher(events),
  })
  // The provider loop abandons in-flight dispatches when a parallel segment
  // fails; they keep settling for a few milliseconds afterwards. Track them
  // so the timeout test can await settlement before its after-hook cleanup,
  // instead of racing the abandoned dispatches' activity writes against
  // `fs.rm` (observed as ENOTEMPTY during teardown).
  const inFlightDispatches = new Set<Promise<unknown>>()
  const brokerContextFor = (turnLabel: string): McpBrokerRequestContext & {
    readonly activityScopeId: string
  } => ({
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: `request-${turnLabel}`,
    leaseId: 'lease-provider-fanout',
    sessionId: 'session-provider-fanout',
    runId: 'run-provider-fanout',
    assignmentId: `assignment-${turnLabel}`,
    activityScopeId: `lane-${turnLabel}`,
    agentPath,
  })

  return {
    toolDefinition: {
      name: service.tool.namespacedName,
      description: service.tool.description ?? 'Research web acquisition.',
      inputSchema: service.tool.inputSchema,
      effect: service.tool.effect,
    },
    get slowResponsesCompleted() {
      return slowResponsesCompleted
    },
    urlFor: (relativePath) => `${baseUrl}/${relativePath}`,
    prepareTurnScope: async (turnLabel) => {
      const location = buildSessionRunAssignmentLocation(
        workspacePath,
        brokerContextFor(turnLabel),
      )
      assert.ok(location)
      await fs.mkdir(location.assignmentPath, { recursive: true })
    },
    settleInFlightDispatches: () =>
      Promise.allSettled([...inFlightDispatches]).then(() => undefined),
    dispatch: async ({ turnLabel, toolCallId, input, signal }) => {
      const brokerContext = brokerContextFor(turnLabel)
      const execution = gateway.execute({
        context: brokerContext,
        authority: { kind: 'mcp-lease', leaseId: brokerContext.leaseId },
        source: {
          kind: 'builtin',
          id: RESEARCH_WEB_SERVER_ID,
          version: String(RESEARCH_WEB_TOOL_CONTRACT_VERSION),
        },
        toolCallId,
        input,
        signal,
      })
      inFlightDispatches.add(execution)
      void execution
        .catch(() => undefined)
        .finally(() => inFlightDispatches.delete(execution))
      const output = await execution
      return {
        output,
        providerResult: { content: JSON.stringify(output), isError: !output.ok },
      }
    },
  }
}

function sourceDocument(title: string, prose: string): string {
  return [
    `<!doctype html><html><head><title>${title}</title></head><body>`,
    `<main><h1>${title}</h1><p>${prose} The content is deterministic per source `,
    `so concurrent and sequential turns can be compared byte for byte.</p></main></body></html>`,
  ].join('')
}
