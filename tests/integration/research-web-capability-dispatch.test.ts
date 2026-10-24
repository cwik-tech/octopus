import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { CapabilityDispatchEvent } from '../../contracts/capability-dispatch.js'
import { CapabilityDispatcher } from '../../core/capability-dispatcher.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'
import { CapabilityInvocationBindings } from '../../core/capability-invocation-bindings.js'
import {
  RESEARCH_WEB_SERVER_ID,
  RESEARCH_WEB_TOOL_CONTRACT_VERSION,
  SOURCE_OBSERVATION_RECEIPT_VERSION,
} from '../../domains/acquisition/acquisition-types.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerRequestContext,
} from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { AcquisitionSettingsService } from '../../services/acquisition-settings-service.js'
import { ResearchWebCapabilityDispatchGateway } from '../../services/research-web-capability-adapter.js'
import { ResearchWebToolService } from '../../services/research-web-tool-service.js'

test('governed research acquisition retains its real receipt, activity, and evidence', async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'governed-research-web-')),
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
  const executionContext: McpBrokerRequestContext & {
    readonly activityScopeId: string
  } = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-real-acquisition',
    leaseId: 'lease-real-acquisition',
    sessionId: 'session-real-acquisition',
    runId: 'run-real-acquisition',
    assignmentId: 'assignment-real-acquisition',
    activityScopeId: 'lane-real-acquisition',
    agentPath,
  }
  const location = buildSessionRunAssignmentLocation(
    workspacePath,
    executionContext,
  )
  assert.ok(location)
  await fs.mkdir(location.assignmentPath, { recursive: true })
  const sourceServer = await startSourceServer()
  context.after(() => sourceServer.close())
  const service = new ResearchWebToolService({
    workspacePath,
    repoRootPath,
    settings: new AcquisitionSettingsService({ environment: {} }),
    allowHttpLocalhost: true,
  })
  const events: CapabilityDispatchEvent[] = []
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
        reserve: async () => ({ reservationId: 'unexpected-reservation' }),
        settle: async () => ({ costTracked: false, budgetOverrun: false }),
        release: async () => undefined,
      },
      evidence: {
        append: async (event) => {
          events.push(event)
        },
      },
      scheduler: new PerAuthorityCapabilityExecutionScheduler(),
      clock: { now: Date.now },
      ids: {
        nextAttemptId: () => {
          attempt += 1
          return `real-research-attempt-${attempt}`
        },
      },
    }),
  })

  const output = await gateway.execute({
    context: executionContext,
    authority: {
      kind: 'mcp-lease',
      leaseId: executionContext.leaseId,
    },
    source: {
      kind: 'builtin',
      id: RESEARCH_WEB_SERVER_ID,
      version: String(RESEARCH_WEB_TOOL_CONTRACT_VERSION),
    },
    toolCallId: 'call-real-acquisition',
    input: { action: 'acquire', url: sourceServer.url },
  })

  assert.equal(output.ok, true, JSON.stringify(output))
  assert.equal(output.method, 'direct-http')
  assert.equal(output.canonicalUrl, sourceServer.url)
  assert.match(output.text ?? '', /governed acquisition retains this evidence/u)
  assert.ok(output.observationReceipt)
  const receiptPath = path.join(
    location.assignmentPath,
    output.observationReceipt.relativePath,
  )
  const receipt: unknown = JSON.parse(await fs.readFile(receiptPath, 'utf8'))
  assert.equal(isReceiptIdentity(receipt, output.observationReceipt.receiptId), true)
  const activity = await service.listSession(executionContext.sessionId)
  assert.equal(activity.length, 1)
  assert.equal(activity[0]?.toolCallId, 'call-real-acquisition')
  assert.equal(activity[0]?.state, 'completed')
  assert.equal(
    activity[0]?.observationReceipt?.receiptId,
    output.observationReceipt.receiptId,
  )
  assert.deepEqual(events.map((event) => event.type), [
    'capability.dispatch.requested',
    'capability.dispatch.started',
    'capability.dispatch.completed',
  ])
})

async function startSourceServer(): Promise<{
  readonly url: string
  close(): Promise<void>
}> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end([
      '<!doctype html><html><head><title>Governed source</title></head><body>',
      '<main><h1>Governed source</h1><p>',
      'A governed acquisition retains this evidence, its source receipt, and its activity ',
      'record after execution crosses the kernel dispatcher. This local source contains ',
      'enough independent prose for the quality gate to accept it without a browser fallback.',
      '</p></main></body></html>',
    ].join(''))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}/source`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

function isReceiptIdentity(value: unknown, receiptId: string): boolean {
  return isRecord(value) &&
    value.schemaVersion === SOURCE_OBSERVATION_RECEIPT_VERSION &&
    value.receiptId === receiptId &&
    value.quality === 'usable'
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
