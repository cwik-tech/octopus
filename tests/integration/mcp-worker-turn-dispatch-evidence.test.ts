/**
 * The undispatched claim has to survive the parent worker bridge.
 *
 * A Team member with MCP tools does not run its own adapter. `codex`, `claude`
 * and `kimi-cli` are in `CLI_HOST_TOOL_BRIDGE_PROVIDERS`, so their turn runs in
 * the parent and comes back over HTTP — and 80 of the 94 bundled personas pin
 * `codex` or `claude`. Team preflight now lets a Team boot past one of those
 * pins when the CLI is missing, on the promise that the refusal which follows
 * becomes a model-choice offer. That promise is only kept if `dispatched: false`
 * crosses this boundary: `deriveExecutionToolEffectEvidence` reads anything
 * else as `unknown`, and unknown refuses the retry.
 *
 * This drives the real route, the real client and the real policy, so the whole
 * bridge is exercised rather than one end of it.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { handleMcpWorkerTurnRoute } from '../../server/routes/mcp-worker-turn.js'
import {
  McpWorkerTurnService,
  McpWorkerTurnServiceError,
} from '../../services/mcp-worker-turn-service.js'
import { McpAgentToolService } from '../../services/mcp-agent-tool-service.js'
import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type { BuiltinAgentToolAdapter } from '../../domains/mcp/builtin-agent-tool-adapter.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import {
  McpWorkerTurnClientError,
  providerErrorFromWorkerFailure,
  runMcpWorkerTurn,
} from '../../domains/mcp/mcp-worker-turn-client.js'
import {
  MCP_WORKER_TURN_URL_ENV,
  MCP_WORKER_WORKFLOW_STEP_ID_ENV,
} from '../../domains/mcp/mcp-worker-turn.js'
import {
  RUNTIME_ASSIGNMENT_ID_ENV,
  RUNTIME_RUN_ID_ENV,
  RUNTIME_SESSION_ID_ENV,
} from '../../domains/runtime/runtime-paths.js'
import {
  ProviderError,
  usageLimitResetAt,
} from '../../domains/provider/provider-error.js'
import { describeSpeakerFailure } from '../../services/agent-chat-service.js'
import { classifyDispatchFailure } from '../../domains/agent-execution/agent-runner.js'
import {
  deriveExecutionToolEffectEvidence,
  evaluateModelChoiceEligibility,
} from '../../contracts/model-choice.js'

function environmentFor(port: number): NodeJS.ProcessEnv {
  return {
    [MCP_WORKER_TURN_URL_ENV]: `http://127.0.0.1:${port}/worker-turn`,
    [RUNTIME_SESSION_ID_ENV]: '11111111-1111-4111-8111-111111111111',
    [RUNTIME_RUN_ID_ENV]: '22222222-2222-4222-8222-222222222222',
    [RUNTIME_ASSIGNMENT_ID_ENV]: 'child-33333333-3333-4333-8333-333333333333',
    TEAM_RUNTIME_TASK_ID: '22222222-2222-4222-8222-222222222222',
    TEAM_RUNTIME_PROCESS_IDENTITY: '44444444-4444-4444-8444-444444444444',
    TEAM_RUNTIME_WORKFLOW_ID: 'research-workflow',
    TEAM_RUNTIME_WORKFLOW_STEP_ID: 'research-step',
  }
}

test('a parent turn that was refused before dispatch says so to the child', async () => {
  const server = http.createServer((req, res) => {
    void handleMcpWorkerTurnRoute({
      req,
      res,
      service: {
        runTurn: async () => {
          // What the parent produces when a tool-enabled `codex` agent's CLI is
          // absent: the adapter refused at the spawn, having sent nothing.
          throw new McpWorkerTurnServiceError(
            'execution_failed',
            false,
            'provider_failed',
            'configuration',
            undefined,
            undefined,
            false,
          )
        },
      },
    })
  })
  await listen(server)
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  try {
    const thrown = await runMcpWorkerTurn({
      options: {
        agentName: 'research-critic',
        model: 'gpt-5',
        thinking: 'medium',
        systemPrompt: 'Critique the draft.',
        userMessage: 'Here is the draft.',
      },
      provider: 'codex',
      environment: environmentFor(address.port),
    }).then(
      () => undefined,
      (error: unknown) => error,
    )

    assert.ok(
      thrown instanceof McpWorkerTurnClientError,
      `expected a worker client error, got ${String(thrown)}`,
    )
    assert.equal(thrown.providerKind, 'configuration')

    const rebuilt = providerErrorFromWorkerFailure(thrown, 'codex')
    assert.ok(rebuilt instanceof ProviderError)
    assert.equal(rebuilt.kind, 'configuration')
    // The field the whole deferral rests on.
    assert.equal(rebuilt.dispatched, false)

    // And it has to still be there after the run log records it, because the
    // evaluator reads the log and not the exception.
    const failure = classifyDispatchFailure(rebuilt)
    assert.equal(failure.dispatched, false)
    assert.equal(
      deriveExecutionToolEffectEvidence({
        failurePhase: failure.phase,
        executedToolCallCount: 0,
        ...(failure.dispatched === undefined ? {} : { dispatched: failure.dispatched }),
      }),
      'none-observed',
    )

    // The point of all of it: the user is asked, rather than being shown a
    // failed run that explains nothing.
    assert.deepEqual(
      evaluateModelChoiceEligibility({
        failureKind: failure.providerKind ?? failure.serviceCode,
        failedChoice: { provider: 'codex', model: 'gpt-5' },
        remainingSameModelRetries: 0,
        toolEffectEvidence: 'none-observed',
        appDefault: {
          status: 'available',
          provider: 'openrouter',
          model: 'openai/gpt-4o-mini',
        },
      }),
      {
        eligible: true,
        reason: 'missing-credential',
        proposedDefault: {
          provider: 'openrouter',
          model: 'openai/gpt-4o-mini',
        },
      },
    )
  } finally {
    await close(server)
  }
})

test('a parent turn that reported nothing about dispatch stays unknown', async () => {
  // Unknown must keep refusing the retry. A failure that reached the provider
  // could have run a tool, and repeating it is not safe on a guess.
  const server = http.createServer((req, res) => {
    void handleMcpWorkerTurnRoute({
      req,
      res,
      service: {
        runTurn: async () => {
          throw new McpWorkerTurnServiceError(
            'execution_failed',
            false,
            'provider_failed',
            'authentication',
          )
        },
      },
    })
  })
  await listen(server)
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  try {
    const thrown = await runMcpWorkerTurn({
      options: {
        agentName: 'research-critic',
        model: 'gpt-5',
        thinking: 'medium',
        systemPrompt: 'Critique the draft.',
        userMessage: 'Here is the draft.',
      },
      provider: 'codex',
      environment: environmentFor(address.port),
    }).then(
      () => undefined,
      (error: unknown) => error,
    )

    assert.ok(thrown instanceof McpWorkerTurnClientError)
    const rebuilt = providerErrorFromWorkerFailure(thrown, 'codex')
    assert.ok(rebuilt instanceof ProviderError)
    assert.equal(rebuilt.dispatched, undefined)
    assert.equal(classifyDispatchFailure(rebuilt).dispatched, undefined)
    assert.equal(
      deriveExecutionToolEffectEvidence({
        failurePhase: 'provider-request',
        executedToolCallCount: 0,
      }),
      'unknown',
    )
  } finally {
    await close(server)
  }
})

test('a worker that claims dispatch never happened in any other words is not believed', async () => {
  // The boundary reads one value and one only. A truthy, absent, or
  // string-shaped `dispatched` is unknown, which blocks the offer.
  for (const claimed of [true, 'false', 0, null, undefined] as const) {
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: 'MCP worker turn failed',
        code: 'execution_failed',
        retryable: false,
        providerCode: 'provider_failed',
        providerKind: 'configuration',
        ...(claimed === undefined ? {} : { dispatched: claimed }),
      }))
    })
    await listen(server)
    const address = server.address()
    assert.ok(address && typeof address !== 'string')

    try {
      const thrown = await runMcpWorkerTurn({
        options: {
          agentName: 'research-critic',
          model: 'gpt-5',
          thinking: 'medium',
          systemPrompt: 'Critique the draft.',
          userMessage: 'Here is the draft.',
        },
        provider: 'codex',
        environment: environmentFor(address.port),
      }).then(
        () => undefined,
        (error: unknown) => error,
      )

      assert.ok(thrown instanceof McpWorkerTurnClientError)
      const rebuilt = providerErrorFromWorkerFailure(thrown, 'codex')
      assert.ok(rebuilt instanceof ProviderError)
      assert.equal(
        rebuilt.dispatched,
        undefined,
        `dispatched: ${JSON.stringify(claimed)} must not read as proven absence`,
      )
    } finally {
      await close(server)
    }
  }
})

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

/**
 * The same claim, but nothing between the adapter and the child is substituted.
 *
 * Every assertion above starts from a `McpWorkerTurnServiceError` that already
 * carries `dispatched: false`, so both hops that have to *produce* it are
 * skipped: `McpAgentToolService` copying the adapter's claim into its
 * diagnostics, and `McpWorkerTurnService` copying those diagnostics onto the
 * worker error. Either line can be deleted with the tests above still green.
 *
 * Here the only replaced boundary is the CLI adapter itself — which is the
 * thing being simulated, a `codex` binary that is not installed — and the real
 * `McpAgentToolService` and real `McpWorkerTurnService` carry its refusal from
 * there to the far end of the transport.
 */
test('an absent CLI refusing before dispatch reaches the child through the real services', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-worker-undispatched-'),
  )
  const workspacePath = path.join(directory, 'workspace')
  const identity = {
    sessionId: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    assignmentId: '33333333-3333-4333-8333-333333333333',
    taskId: '44444444-4444-4444-8444-444444444444',
    processIdentity: '55555555-5555-4555-8555-555555555555',
    workflowId: 'team-boot-workflow',
    workflowStepId: 'critique',
  }
  const scheduledAgent = {
    agentPath: 'agents/research-critic',
    provider: 'codex',
    model: 'gpt-5',
    supportState: 'supported',
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, identity)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })
  const resolutionPath = path.join(location.runPath, 'mcp-resolution.json')
  fs.writeFileSync(resolutionPath, JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    workflowId: identity.workflowId,
    scheduledAgentPaths: [scheduledAgent.agentPath],
    scheduledAgents: [scheduledAgent],
    authorization: { state: 'non-authoritative', brokerRechecksAtCallTime: true },
    workflowRequirements: [],
    steps: [{
      stepId: identity.workflowStepId,
      scheduledAgentPaths: [scheduledAgent.agentPath],
      scheduledAgents: [scheduledAgent],
      effectiveRequirements: [],
      matches: [],
    }],
    warnings: [],
  }), { mode: 0o444 })

  const clientManager = new McpClientManager()
  const mcpSettings = new McpSettingsService({
    storagePath: path.join(directory, 'mcps.json'),
    clientManager,
  })
  const leases = new McpRunLeaseStore()
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: mcpSettings,
    clientManager: mcpSettings.getBrokerClientManager(),
    grantResolver: () => false,
    leaseResolver: (context) => leases.resolve(context),
  })
  const providerSettings = new ProviderSettingsService({
    storagePath: path.join(directory, 'providers.json'),
  })
  // The turn has to reach the provider at all: a turn with no tools takes the
  // ordinary direct route and never enters this lane
  // (`services/mcp-agent-tool-service.ts:532`). One built-in owned by this
  // Agent is the smallest thing that puts it on the bridge.
  let spawnAttempts = 0
  const agentToolService = new McpAgentToolService({
    broker,
    leaseStore: leases,
    providerSettingsService: providerSettings,
    // `codex` is in `CLI_HOST_TOOL_BRIDGE_PROVIDERS`, which is the whole reason
    // the claim has to cross a process boundary at all.
    providerSupportResolver: ({ provider }) => ({
      provider,
      state: 'supported',
      mode: 'host-tool-bridge',
    }),
    builtinAgentTools: [criticNoteTool(scheduledAgent.agentPath)],
    cliProviderExecutor: async () => {
      spawnAttempts += 1
      // Verbatim the refusal `providers/codex.ts:285-295` raises on ENOENT.
      throw new ProviderError({
        provider: 'codex',
        message:
          "Provider 'codex' requires 'codex' CLI but it was not found on PATH. " +
          'Install it with: npm i -g @openai/codex',
        kind: 'configuration',
        retryable: false,
        dispatched: false,
      })
    },
  })
  const service = new McpWorkerTurnService({
    workspacePath,
    sessionStore: {
      async getTaskRecord() {
        return {
          id: identity.taskId,
          sessionId: identity.sessionId,
          runId: identity.runId,
          assignmentId: identity.assignmentId,
          workflowId: identity.workflowId,
          processIdentity: identity.processIdentity,
          status: 'running',
          runPath: location.runPath,
          mcpResolutionPath: resolutionPath,
        } as never
      },
      ownsTaskProcess: () => false,
    },
    authorityResolver: {
      async authorize() {
        return {
          taskId: identity.taskId,
          workflowId: identity.workflowId,
          runPath: location.runPath,
          assignmentPath: await fs.promises.realpath(location.assignmentPath),
          mcpResolutionPath: resolutionPath,
        }
      },
    },
    agentToolService,
  })

  const server = http.createServer((req, res) => {
    void handleMcpWorkerTurnRoute({ req, res, service })
  })
  await listen(server)
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  try {
    const thrown = await runMcpWorkerTurn({
      options: {
        agentName: 'research-critic',
        model: scheduledAgent.model,
        thinking: 'medium',
        systemPrompt: 'Critique the draft.',
        userMessage: 'Here is the draft.',
      },
      provider: scheduledAgent.provider,
      environment: {
        [MCP_WORKER_TURN_URL_ENV]: `http://127.0.0.1:${address.port}/worker-turn`,
        [RUNTIME_SESSION_ID_ENV]: identity.sessionId,
        [RUNTIME_RUN_ID_ENV]: identity.runId,
        [RUNTIME_ASSIGNMENT_ID_ENV]: identity.assignmentId,
        [MCP_WORKER_WORKFLOW_STEP_ID_ENV]: identity.workflowStepId,
        TEAM_RUNTIME_TASK_ID: identity.taskId,
        TEAM_RUNTIME_PROCESS_IDENTITY: identity.processIdentity,
        TEAM_RUNTIME_WORKFLOW_ID: identity.workflowId,
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    )

    // The turn really did take the bridge lane and really did reach the
    // adapter. Without this a `no-tools` turn would satisfy nothing below.
    assert.equal(spawnAttempts, 1)
    assert.ok(
      thrown instanceof McpWorkerTurnClientError,
      `expected a worker client error, got ${String(thrown)}`,
    )
    assert.equal(thrown.providerKind, 'configuration')
    assert.equal(thrown.retryable, false)
    // The one field the deferral rests on, produced rather than handed in.
    assert.equal(thrown.dispatched, false)

    const rebuilt = providerErrorFromWorkerFailure(thrown, 'codex')
    assert.ok(rebuilt instanceof ProviderError)
    assert.equal(rebuilt.dispatched, false)

    const failure = classifyDispatchFailure(rebuilt)
    assert.equal(failure.dispatched, false)
    assert.equal(
      deriveExecutionToolEffectEvidence({
        failurePhase: failure.phase,
        executedToolCallCount: 0,
        ...(failure.dispatched === undefined
          ? {}
          : { dispatched: failure.dispatched }),
      }),
      'none-observed',
    )
    assert.equal(
      evaluateModelChoiceEligibility({
        failureKind: failure.providerKind ?? failure.serviceCode,
        failedChoice: {
          provider: scheduledAgent.provider,
          model: scheduledAgent.model,
        },
        remainingSameModelRetries: 0,
        toolEffectEvidence: 'none-observed',
        appDefault: {
          status: 'available',
          provider: 'openrouter',
          model: 'openai/gpt-4o-mini',
        },
      }).eligible,
      true,
    )
  } finally {
    await close(server)
    fs.chmodSync(resolutionPath, 0o644)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * A usage limit's reset has to survive the parent-to-child process boundary.
 *
 * A Team member's turn runs in the parent, so the provider's sentence — and
 * the clock and zone that make it a moment — exist only on that side. The
 * child is what records the failure, so a reset that stops here is one no
 * health view can ever expire on.
 *
 * Everything below the provider call is real: the agent-tool service that
 * resolves the instant, the worker service that maps it, the route that
 * serializes it, and the client that reads it back. Only the provider itself
 * is replaced, because that is the one thing a test must not call.
 */
test('a usage limit reset reaches the child as a moment, through the real services', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-worker-usage-limit-'),
  )
  const workspacePath = path.join(directory, 'workspace')
  const identity = {
    sessionId: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    assignmentId: '33333333-3333-4333-8333-333333333333',
    taskId: '44444444-4444-4444-8444-444444444444',
    processIdentity: '55555555-5555-4555-8555-555555555555',
    workflowId: 'team-boot-workflow',
    workflowStepId: 'critique',
  }
  const scheduledAgent = {
    agentPath: 'agents/research-critic',
    provider: 'codex',
    model: 'gpt-5',
    supportState: 'supported',
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, identity)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })
  const resolutionPath = path.join(location.runPath, 'mcp-resolution.json')
  fs.writeFileSync(resolutionPath, JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    workflowId: identity.workflowId,
    scheduledAgentPaths: [scheduledAgent.agentPath],
    scheduledAgents: [scheduledAgent],
    authorization: { state: 'non-authoritative', brokerRechecksAtCallTime: true },
    workflowRequirements: [],
    steps: [{
      stepId: identity.workflowStepId,
      scheduledAgentPaths: [scheduledAgent.agentPath],
      scheduledAgents: [scheduledAgent],
      effectiveRequirements: [],
      matches: [],
    }],
    warnings: [],
  }), { mode: 0o444 })

  const clientManager = new McpClientManager()
  const mcpSettings = new McpSettingsService({
    storagePath: path.join(directory, 'mcps.json'),
    clientManager,
  })
  const leases = new McpRunLeaseStore()
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: mcpSettings,
    clientManager: mcpSettings.getBrokerClientManager(),
    grantResolver: () => false,
    leaseResolver: (context) => leases.resolve(context),
  })
  const providerSettings = new ProviderSettingsService({
    storagePath: path.join(directory, 'providers.json'),
  })
  const agentToolService = new McpAgentToolService({
    broker,
    leaseStore: leases,
    providerSettingsService: providerSettings,
    providerSupportResolver: ({ provider }) => ({
      provider,
      state: 'supported',
      mode: 'host-tool-bridge',
    }),
    builtinAgentTools: [criticNoteTool(scheduledAgent.agentPath)],
    // The provider's own words, as Codex writes them. The year it states is
    // what makes the moment unambiguous without a clock this test controls.
    cliProviderExecutor: async () => {
      throw new ProviderError({
        provider: 'codex',
        message:
          "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage " +
          'to purchase more credits or try again at Sep 20, 2026 1:00 AM UTC.',
        kind: 'usage_limit',
        retryable: false,
      })
    },
  })
  const service = new McpWorkerTurnService({
    workspacePath,
    sessionStore: {
      async getTaskRecord() {
        return {
          id: identity.taskId,
          sessionId: identity.sessionId,
          runId: identity.runId,
          assignmentId: identity.assignmentId,
          workflowId: identity.workflowId,
          processIdentity: identity.processIdentity,
          status: 'running',
          runPath: location.runPath,
          mcpResolutionPath: resolutionPath,
        } as never
      },
      ownsTaskProcess: () => false,
    },
    authorityResolver: {
      async authorize() {
        return {
          taskId: identity.taskId,
          workflowId: identity.workflowId,
          runPath: location.runPath,
          assignmentPath: await fs.promises.realpath(location.assignmentPath),
          mcpResolutionPath: resolutionPath,
        }
      },
    },
    agentToolService,
  })

  const server = http.createServer((req, res) => {
    void handleMcpWorkerTurnRoute({ req, res, service })
  })
  await listen(server)
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  try {
    const thrown = await runMcpWorkerTurn({
      options: {
        agentName: 'research-critic',
        model: scheduledAgent.model,
        thinking: 'medium',
        systemPrompt: 'Critique the draft.',
        userMessage: 'Here is the draft.',
      },
      provider: scheduledAgent.provider,
      environment: {
        [MCP_WORKER_TURN_URL_ENV]: `http://127.0.0.1:${address.port}/worker-turn`,
        [RUNTIME_SESSION_ID_ENV]: identity.sessionId,
        [RUNTIME_RUN_ID_ENV]: identity.runId,
        [RUNTIME_ASSIGNMENT_ID_ENV]: identity.assignmentId,
        [MCP_WORKER_WORKFLOW_STEP_ID_ENV]: identity.workflowStepId,
        TEAM_RUNTIME_TASK_ID: identity.taskId,
        TEAM_RUNTIME_PROCESS_IDENTITY: identity.processIdentity,
        TEAM_RUNTIME_WORKFLOW_ID: identity.workflowId,
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    )

    assert.ok(
      thrown instanceof McpWorkerTurnClientError,
      `expected a worker client error, got ${String(thrown)}`,
    )
    assert.equal(thrown.providerKind, 'usage_limit')
    assert.equal(thrown.resetsAtInstant, '2026-09-20T01:00:00.000Z')

    // And it is a moment by the time the child holds a provider failure,
    // without anything on this side re-reading the parent's sentence.
    const rebuilt = providerErrorFromWorkerFailure(thrown, 'codex')
    assert.ok(rebuilt instanceof ProviderError)
    assert.equal(
      usageLimitResetAt(rebuilt, new Date('2026-09-19T20:00:00.000Z')),
      '2026-09-20T01:00:00.000Z',
    )

    // The journal's record of that failure is what health expires on, so the
    // moment has to reach the identity the child writes down.
    assert.equal(
      describeSpeakerFailure(rebuilt, {
        provider: 'codex',
        model: scheduledAgent.model,
      }).failure.resetsAt,
      '2026-09-20T01:00:00.000Z',
    )
  } finally {
    await close(server)
    fs.chmodSync(resolutionPath, 0o644)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/** One built-in the critic owns, so its turn has a tool and takes the bridge. */
function criticNoteTool(agentPath: string): BuiltinAgentToolAdapter {
  const namespacedName = 'critique.note'
  return {
    name: namespacedName,
    tool: {
      serverId: 'builtin.critique',
      serverName: 'Critique',
      toolName: 'note',
      namespacedName,
      description: 'Records one critique note.',
      inputSchema: {
        type: 'object',
        properties: { note: { type: 'string' } },
        required: ['note'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      risk: 'read-only',
      effect: serialCapabilityEffect('read-only'),
      requiresApproval: false,
    },
    isEnabledForAgent: (candidate) => candidate === agentPath,
    execute: async () => ({
      output: { ok: true },
      content: JSON.stringify({ ok: true }),
      isError: false,
    }),
  }
}
