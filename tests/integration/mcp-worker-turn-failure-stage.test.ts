/**
 * Where a parent worker turn failed, when the parent reported no category.
 *
 * A child whose worker turn fails with no service code reads only "Parent
 * worker turn failed.", and its failure record only
 * `provider-request/dispatch_failed`. That covers five different things: the
 * child could not build its own request, its endpoint was not a loopback
 * worker URL, the connection failed, the parent answered with a status and no
 * code, or the parent's answer could not be read. The A7 desktop batch hit one
 * of them three times in 1 to 2 ms and no record could say which.
 *
 * So the client error carries a closed stage, a transport failure carries only
 * a Node error code from a closed list (anything else is `other`), and a
 * status failure only the status. The child's failure record stores that and
 * nothing else: no URL, no path token, no header, no body and no message text.
 * The sentence a person reads is unchanged.
 *
 * Each case is a real failure: a request the child's own contract refuses, a
 * URL that is not loopback, a closed loopback port, the real route refusing a
 * request without a code, and a 200 whose body is not a worker answer.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import type { AgentRunOptions } from '../../core/types.js'
import { classifyDispatchFailure, runAgent } from '../../domains/agent-execution/agent-runner.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpEvidenceStore } from '../../domains/mcp/mcp-evidence-store.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import {
  MCP_WORKER_TURN_URL_ENV,
  MCP_WORKER_WORKFLOW_STEP_ID_ENV,
} from '../../domains/mcp/mcp-worker-turn.js'
import {
  McpWorkerTurnClientError,
  runMcpWorkerTurn,
} from '../../domains/mcp/mcp-worker-turn-client.js'
import {
  RUNTIME_ASSIGNMENT_ID_ENV,
  RUNTIME_RUN_ID_ENV,
  RUNTIME_SESSION_ID_ENV,
} from '../../domains/runtime/runtime-paths.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { handleMcpWorkerTurnRoute } from '../../server/routes/mcp-worker-turn.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { McpAgentToolService } from '../../services/mcp-agent-tool-service.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { McpWorkerTurnService } from '../../services/mcp-worker-turn-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'

const UNCHANGED_MESSAGE = 'Parent worker turn failed.'

/** The settings an Agent turn crosses the boundary with. */
function turnOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    agentName: 'packaged-smoke-worker',
    provider: 'connection:fixtureconnection',
    model: 'fake/app-default',
    thinking: 'low',
    systemPrompt: 'You are the packaged runtime smoke worker.',
    userMessage: 'Produce the scheduled report.',
    ...overrides,
  }
}

/** A worker environment as a Team child has it, aimed at `url`. */
function workerEnvironment(url: string): NodeJS.ProcessEnv {
  return {
    [MCP_WORKER_TURN_URL_ENV]: url,
    [MCP_WORKER_WORKFLOW_STEP_ID_ENV]: 'write',
    [RUNTIME_SESSION_ID_ENV]: randomUUID(),
    [RUNTIME_RUN_ID_ENV]: 'run-one',
    [RUNTIME_ASSIGNMENT_ID_ENV]: 'child-one',
    TEAM_RUNTIME_TASK_ID: 'task-one',
    TEAM_RUNTIME_PROCESS_IDENTITY: 'process-one',
    TEAM_RUNTIME_WORKFLOW_ID: 'packaged-smoke',
  }
}

async function listen(t: TestContext, handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => {
    // A refused upload can leave its connection open; close waits for every
    // connection, so they are ended first.
    server.close(() => resolve())
    server.closeAllConnections()
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}/private-worker`
}

/** A loopback worker URL on a port that was listening and is now closed. */
async function closedLoopbackUrl(): Promise<string> {
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${address.port}/private-worker`
}

/** The real route, over a real worker-turn service it never reaches for these requests. */
async function realRouteUrl(t: TestContext): Promise<string> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-turn-stage-'))
  const codec = {
    encrypt: (value: string) => Buffer.from(value, 'utf8').toString('base64'),
    decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8'),
  }
  const clientManager = new McpClientManager({ connectTimeoutMs: 1_000, requestTimeoutMs: 1_000, closeTimeoutMs: 1_000 })
  t.after(async () => {
    await clientManager.closeAll?.()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const workspacePath = path.join(directory, 'workspace')
  const mcpSettings = new McpSettingsService({
    storagePath: path.join(directory, 'mcps.json'), secretCodec: codec, clientManager,
  })
  const leases = new McpRunLeaseStore()
  const service = new McpWorkerTurnService({
    workspacePath,
    sessionStore: new FileSystemSessionStore(workspacePath),
    agentToolService: new McpAgentToolService({
      broker: new McpParentBroker({
        lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
        settingsService: mcpSettings,
        clientManager: mcpSettings.getBrokerClientManager(),
        grantResolver: ({ context, serverId }) => mcpSettings.isAgentGranted(context.agentPath, serverId),
        leaseResolver: (context) => leases.resolve(context),
        evidenceStoreFactory: (scope) => new McpEvidenceStore({ workspacePath, ...scope }),
      }),
      leaseStore: leases,
      providerSettingsService: new ProviderSettingsService({
        storagePath: path.join(directory, 'providers.json'), secretCodec: codec,
      }),
    }),
  })
  return listen(t, (req, res) => {
    void handleMcpWorkerTurnRoute({ req, res, service })
  })
}

async function refusal(turn: Promise<unknown>): Promise<McpWorkerTurnClientError> {
  try {
    await turn
  } catch (error) {
    assert.ok(error instanceof McpWorkerTurnClientError, String(error))
    return error
  }
  assert.fail('the worker turn did not fail')
}

/** The failure detail the error carries, read without assuming its type exists. */
function detailOf(error: McpWorkerTurnClientError): unknown {
  return Reflect.get(error, 'failureDetail')
}

test('a request the child cannot build is refused at the request stage, before any connection', async (t) => {
  let requests = 0
  const url = await listen(t, (_req, res) => {
    requests += 1
    res.end()
  })

  const error = await refusal(runMcpWorkerTurn({
    options: turnOptions({ systemPrompt: 'x'.repeat(2 * 1_024 * 1_024 + 1) }),
    provider: 'connection:fixtureconnection',
    environment: workerEnvironment(url),
  }))

  assert.equal(error.message, UNCHANGED_MESSAGE)
  assert.deepEqual(detailOf(error), { stage: 'request_invalid' })
  assert.equal(requests, 0)
})

test('a worker URL that is not loopback is refused at the endpoint stage', async () => {
  const error = await refusal(runMcpWorkerTurn({
    options: turnOptions(),
    provider: 'connection:fixtureconnection',
    environment: workerEnvironment('http://192.0.2.1/private-worker'),
  }))

  assert.equal(error.message, UNCHANGED_MESSAGE)
  assert.deepEqual(detailOf(error), { stage: 'endpoint_invalid' })
})

test('a closed loopback port is a transport failure that names only its Node error code', async () => {
  const error = await refusal(runMcpWorkerTurn({
    options: turnOptions(),
    provider: 'connection:fixtureconnection',
    environment: workerEnvironment(await closedLoopbackUrl()),
  }))

  assert.equal(error.message, UNCHANGED_MESSAGE)
  assert.deepEqual(detailOf(error), { stage: 'transport', transportCode: 'ECONNREFUSED' })
})

test('the real route refusing a request without a code is a status failure that names only the status', async (t) => {
  const url = await realRouteUrl(t)

  // Valid for the child (1 MB, under its 2 MiB per prompt), but JSON escapes
  // each control character to six bytes, so the body passes the route's 5 MiB
  // limit and the route refuses it before anything else, with no code.
  const error = await refusal(runMcpWorkerTurn({
    options: turnOptions({ userMessage: '\u0001'.repeat(1_000_000) }),
    provider: 'connection:fixtureconnection',
    environment: workerEnvironment(url),
  }))

  assert.equal(error.message, UNCHANGED_MESSAGE)
  assert.deepEqual(detailOf(error), { stage: 'http_status_without_code', httpStatus: 413 })
})

test('a 200 whose body is not a worker answer is refused at the response stage', async (t) => {
  const url = await listen(t, (req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('this is not a worker answer')
    })
  })

  const error = await refusal(runMcpWorkerTurn({
    options: turnOptions(),
    provider: 'connection:fixtureconnection',
    environment: workerEnvironment(url),
  }))

  assert.equal(error.message, UNCHANGED_MESSAGE)
  assert.deepEqual(detailOf(error), { stage: 'response_invalid' })
})

test('the failure record of a refused turn stores its stage and code, and nothing that names the endpoint or the message', async () => {
  const url = await closedLoopbackUrl()
  let failure: unknown
  try {
    await runAgent({ ...turnOptions(), workerEnvironment: workerEnvironment(url) })
    assert.fail('the turn did not fail')
  } catch (error) {
    failure = classifyDispatchFailure(error)
  }

  assert.deepEqual(failure, {
    phase: 'provider-request',
    serviceCode: 'dispatch_failed',
    retryable: false,
    workerTurn: { stage: 'transport', transportCode: 'ECONNREFUSED' },
  })
  const written = JSON.stringify(failure)
  const port = new URL(url).port
  for (const absent of [port, 'private-worker', '127.0.0.1', 'Parent worker turn', 'fetch failed']) {
    assert.equal(written.includes(absent), false, `the record names ${absent}`)
  }
})
