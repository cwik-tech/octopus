/**
 * What a workflow Agent step's *end* record says about settings that stopped
 * applying.
 *
 * Two different things can drop an Agent's settings, and only one of them was
 * being written down. An approved switch drops them before the turn starts, and
 * the workflow runner records that on the dispatch record every event carries.
 * The route the turn then takes can drop more — the native MCP tool loop builds
 * a request of model, messages, tools and tool choice and nothing else, so it
 * applies none of them — and `runAgent` returns that decision on its result.
 * The Team dispatcher unions the two onto its end record
 * (`domains/agent-execution/agent-runner.ts:2235-2244`). The workflow
 * dispatcher did not, so a step that ran with its settings silently inert
 * finished with nothing on record about it.
 *
 * Driven through the whole chain rather than any part of it: a real workflow
 * through `runWorkflowOutcome`, a real Agent step, a real worker-turn endpoint
 * over loopback HTTP, a real `McpAgentToolService` deciding the lane from the
 * provider's support mode, a real stdio MCP server really granted to that
 * Agent, and a real loopback tool loop answering. An earlier attempt at this
 * stubbed the runner's `runAgentImpl` seam and handed it invented drops, which
 * proves the record can carry a value — never the question — and nothing about
 * whether a real route's decision reaches it.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { McpAgentToolService } from '../../services/mcp-agent-tool-service.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { McpWorkerTurnService } from '../../services/mcp-worker-turn-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { PROCESS_IDENTITY_ARGUMENT } from '../../domains/sessions/task-process-supervisor.js'
import { MCP_WORKFLOW_RESOLUTION_VERSION } from '../../domains/mcp/mcp-workflow-preflight.js'
import { handleMcpWorkerTurnRoute } from '../../server/routes/mcp-worker-turn.js'
import {
  MCP_WORKER_TURN_URL_ENV,
  MCP_WORKER_WORKFLOW_STEP_ID_ENV,
} from '../../domains/mcp/mcp-worker-turn.js'
import {
  RUNTIME_ASSIGNMENT_ID_ENV,
  RUNTIME_RUN_ID_ENV,
  RUNTIME_SESSION_ID_ENV,
} from '../../domains/runtime/runtime-paths.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { initProviders } from '../../providers/index.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import { createMcpProviderSupportResolver } from '../../domains/mcp/mcp-provider-support.js'
import { setRuntimeApprovedModelChoice } from '../../domains/provider/approved-model-choice.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { runWorkflowOutcome } from '../../workflows/runner.js'
import { FileSystemWorkflowStateStore } from '../../workflows/workflow-state-store.js'
import { createWorkflowModelChoiceEvaluator } from '../../services/workflow-model-choice-evaluator.js'
import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'

initProviders()

const repoRoot = process.cwd()
const MCP_FIXTURE_PATH = path.join(repoRoot, 'tests', 'fixtures', 'mcp', 'stdio-server.mjs')
const SERVER_ID = 'step-tools'
/** Must match `agents/${agentName}`, which is how the worker request names it. */
const AGENT_NAME = 'optionswriter'

const WORKFLOW_ID = 'step-drop-workflow'
const STEP_ID = 'write'

/**
 * The settings this Agent declares.
 *
 * Both are ones the native tool loop cannot apply, so both are what the lane
 * has to report. They are also ones the *file* can legitimately carry, so the
 * turn is a valid one rather than a refusal.
 */
const ROUTE_ONLY_OPTIONS = { max_tokens: 256, temperature: 0.4 }

/** The capability the stdio fixture serves, as the seal describes it. */
const REQUIREMENT = {
  capability: 'marker.echo',
  // An array, which the seal's own parser requires.
  access: ['read'],
  necessity: 'optional',
} as const

function writeFixture(
  workspace: string,
  pair: { provider: string; model: string },
  providerOptions: Readonly<Record<string, unknown>>,
): {
  templatePath: string
  teamPath: string
} {
  const teamPath = path.join(workspace, 'teams', 'lonely-writer')
  const agentDir = path.join(workspace, 'agents', AGENT_NAME)
  fs.mkdirSync(teamPath, { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, `${AGENT_NAME}.md`),
    [
      '---',
      // Its own pair, so the settings under test are unambiguously the
      // Agent's own rather than anything inherited.
      `provider: ${pair.provider}`,
      `model: ${pair.model}`,
      'thinking: low',
      `provider_options: '${JSON.stringify(providerOptions)}'`,
      '---',
      '',
      'Write the requested draft.',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(teamPath, 'team.yaml'),
    [
      'team:',
      '  name: lonely-writer',
      '  description: One writer',
      '  version: 0.1.0',
      'workspace:',
      '  path: ./workspace',
      '  watch: false',
      'workflow:',
      '  entry_level: execute',
      '  invocation_modes:',
      '    - user',
      '    - team',
      '  output_contract:',
      '    completion_artifact: final-draft.md',
      'agents:',
      `  - name: ${AGENT_NAME}`,
      '    type: agent',
      '    role: Writer',
      '    tier: strategic',
      `    agent_file: ../../agents/${AGENT_NAME}/${AGENT_NAME}.md`,
      '    produces:',
      '      - path: final-draft.md',
      'levels:',
      '  - id: execute',
      '    name: Execute',
      '    order: 0',
      '    agents:',
      `      - ${AGENT_NAME}`,
      '    stage:',
      '      type: pipeline',
      '      config:',
      '        output:',
      '          format: final-draft.md',
      '          user_review: false',
      '',
    ].join('\n'),
  )
  const templatePath = path.join(workspace, 'agent-step.yaml')
  fs.writeFileSync(
    templatePath,
    [
      'workflow:',
      `  id: ${WORKFLOW_ID}`,
      '  steps:',
      `    - id: ${STEP_ID}`,
      '      type: agent',
      '      stage_type: pipeline',
      '      team: lonely-writer',
      `      agent: ${AGENT_NAME}`,
      '      input_artifact: incoming-brief.md',
      '      result_artifact: final-draft.md',
      '  output:',
      `    from_step: ${STEP_ID}`,
      '    artifact: final-draft.md',
      '',
    ].join('\n'),
  )
  return { templatePath, teamPath }
}

function readRunLog(workspace: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (entry.name !== 'agent-runs.jsonl') continue
      for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
        if (line.trim()) records.push(JSON.parse(line) as Record<string, unknown>)
      }
    }
  }
  // Walked from the workspace root: a run in the session layout writes its log
  // under `sessions/<id>/runs/<id>/assignments/<id>/logs`, not under a
  // top-level `assignments` directory.
  walk(workspace)
  return records
}

interface Harness {
  readonly workspace: string
  /**
   * Start the process a continuation runs under.
   *
   * A granted record is refused unless its process identity and its execution
   * attempt are the same value (`domains/sessions/session-normalizers.ts:69-77`),
   * and that identity has to belong to a process that is actually alive — so a
   * continuation gets its own child rather than reusing the failed attempt's.
   */
  beginContinuation(attemptId: string): Promise<number>
  readonly sessionStore: FileSystemSessionStore
  readonly session: { readonly id: string }
  readonly task: NonNullable<
    Awaited<ReturnType<FileSystemSessionStore['createTaskRecord']>>
  >
  readonly processIdentity: string
  readonly identity: {
    readonly sessionId: string
    readonly assignmentId: string
    readonly taskId: string
  }
  /** The run this workflow belongs to, which its child steps hang off. */
  readonly assignmentLocation: NonNullable<
    ReturnType<typeof buildSessionRunAssignmentLocation>
  >
  readonly templatePath: string
  readonly teamPath: string
  cleanup(): Promise<void>
}

/**
 * The whole parent side, real.
 *
 * A granted stdio server, because without one `runTurn` answers `no-tools`
 * before either lane is chosen and the settings question never arises. A
 * provider whose support mode names the native loop, because that is the lane
 * that applies nothing and therefore the one with something to report. And a
 * loopback tool loop, so the turn genuinely answers and an `end` record is
 * genuinely written.
 */
interface HarnessOptions {
  /** What the Agent's own file declares. */
  readonly providerOptions: Readonly<Record<string, unknown>>
  /** Set an approved retry for this step, from the pinned pair to the running one. */
  readonly approveRetry?: boolean
}

async function makeHarness(options: HarnessOptions): Promise<Harness> {
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-step-drops-')),
  )
  const codec = {
    encrypt: (value: string) => Buffer.from(value, 'utf8').toString('base64'),
    decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8'),
  }
  const manager = new McpClientManager({
    connectTimeoutMs: 5_000,
    requestTimeoutMs: 10_000,
    closeTimeoutMs: 1_000,
  })
  const settings = new McpSettingsService({
    storagePath: path.join(workspace, 'mcps.json'),
    secretCodec: codec,
    clientManager: manager,
  })
  await settings.saveServer({
    id: SERVER_ID,
    name: 'Step tools',
    capabilityAliases: [{ capability: 'marker.echo', access: 'read' }],
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [MCP_FIXTURE_PATH],
      cwd: repoRoot,
      secretEnvironment: {
        MCP_FIXTURE_CALLS_PATH: {
          operation: 'replace',
          value: path.join(workspace, 'calls.jsonl'),
        },
      },
    },
  })
  await settings.validateServer(SERVER_ID, { stdioTrustAcknowledged: true })
  await settings.setAgentGrant(`agents/${AGENT_NAME}`, SERVER_ID, true)

  const leases = new McpRunLeaseStore()
  const providerSettings = new ProviderSettingsService({
    storagePath: path.join(workspace, 'providers.json'),
    secretCodec: codec,
  })

  const providerFixture = await startOpenAiToolLoopFixture(repoRoot)
  /** Created for the approved-retry case only, and removed once sealed. */
  const openConnection = async (name: string): Promise<string> => {
    const created = await providerSettings.saveConnection({
      kind: 'openai-compatible',
      name,
      baseUrl: `${providerFixture.url}/v1`,
      apiKey: 'step-secret',
      enabled: true,
    })
    await providerSettings.validateConnection(created.id)
    await providerSettings.setModelEnabled(created.id, 'fixture/tool-loop', true)
    return created.id
  }
  let server: http.Server | undefined
  let taskProcess: ChildProcess | undefined
  let continuationProcess: ChildProcess | undefined
  let identity:
    | {
        sessionId: string
        runId: string
        assignmentId: string
        taskId: string
        processIdentity: string
      }
    | undefined
  try {
    // The pair that runs. For the approved-retry case this is the application
    // default the approval moves to; otherwise it is the Agent's own.
    const runningConnectionId = await openConnection('Step loopback')
    // The Agent's original connection, where a retry is being proved. It is
    // real while the run is sealed against it and removed afterwards, so the
    // first attempt is refused for the reason a real missing connection is —
    // `providers/configured-provider.ts:88-101` — rather than because a model
    // name was chosen to look unreachable.
    const originalConnectionId = options.approveRetry
      ? await openConnection('Step original')
      : runningConnectionId

    // The durable world, real: the session store issues the identity, writes
    // the seal into the task record and owns the run and assignment paths, and
    // the worker turn service is given no authority resolver so it uses the one
    // production builds. A stubbed store here would bypass the boundary this
    // regression is supposed to cross.
    const sessionStore = new FileSystemSessionStore(workspace)
    const session = await sessionStore.createSession({
      title: 'Workflow step dropped options',
    })
    const scheduledAgent = {
      agentPath: `agents/${AGENT_NAME}`,
      provider: `connection:${runningConnectionId}`,
      model: 'fixture/tool-loop',
      supportState: 'supported' as const,
    }
    // Only the pair this Agent was scheduled with. A substituted pair must
    // reach the tool service through the approved-retry boundary; pre-sealing
    // it would let the request past without that boundary ever being asked,
    // and the case would pass with authorization removed entirely.
    const sealedPair = options.approveRetry
      ? { ...scheduledAgent, provider: `connection:${originalConnectionId}` }
      : scheduledAgent
    const scheduledAgents = [sealedPair]
    const task = await sessionStore.createTaskRecord(session.id, {
      workflowId: WORKFLOW_ID,
      brief: 'Draft a recommendation.',
      mcpResolution: {
        version: MCP_WORKFLOW_RESOLUTION_VERSION,
        generatedAt: '2026-09-09T12:00:00.000Z',
        workflowId: WORKFLOW_ID,
        scheduledAgentPaths: [scheduledAgent.agentPath],
        scheduledAgents,
        authorization: {
          state: 'non-authoritative' as const,
          brokerRechecksAtCallTime: true as const,
        },
        workflowRequirements: [REQUIREMENT],
        steps: [
          {
            stepId: STEP_ID,
            scheduledAgentPaths: [scheduledAgent.agentPath],
            scheduledAgents,
            effectiveRequirements: [REQUIREMENT],
            // One optional requirement the granted server satisfies. With no
            // match the turn answers `provider-no-tools` before either lane is
            // chosen, and a turn with no tools has no settings to report.
            matches: [
              {
                ...REQUIREMENT,
                candidates: [
                  {
                    serverId: SERVER_ID,
                    serverName: 'Step tools',
                    agentPath: sealedPair.agentPath,
                    // The pair this step was sealed with, which is what the
                    // seal's own scheduled set contains.
                    provider: sealedPair.provider,
                    state: 'supported' as const,
                  },
                ],
                // Optional requirements have no owner; a required one would
                // have to name the canonical owner the seal derives.
                owner: null,
              },
            ],
          },
        ],
        warnings: [],
      },
    })
    assert.ok(task?.assignmentId && task.assignmentPath && task.runPath)

    // A live process, because a task record's process identity is checked
    // against one before its authority is granted.
    const processIdentity = randomUUID()
    taskProcess = spawn(
      process.execPath,
      [
        '-e',
        'setInterval(() => undefined, 1_000)',
        '--',
        `${PROCESS_IDENTITY_ARGUMENT}${processIdentity}`,
      ],
      { stdio: 'ignore' },
    )
    const spawned = taskProcess
    await new Promise<void>((resolve, reject) => {
      spawned.once('spawn', resolve)
      spawned.once('error', reject)
    })
    const running = await sessionStore.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['queued'],
      {
        status: 'running',
        processIdentity,
        executionAttemptId: 'attempt-one',
        ownerInstanceId: sessionStore.getInstanceId(),
        pid: spawned.pid,
      },
    )
    assert.equal(running?.updated, true)
    const deadline = Date.now() + 3_000
    while (!sessionStore.hasValidTaskProcessIdentity(running.task)) {
      assert.ok(Date.now() < deadline, 'the task process identity never appeared')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    const runId = path.basename(task.runPath)
    const location = buildSessionRunAssignmentLocation(workspace, {
      sessionId: session.id,
      runId,
      assignmentId: task.assignmentId,
    })
    assert.ok(location)

    const { templatePath, teamPath } = writeFixture(
      workspace,
      { provider: sealedPair.provider, model: sealedPair.model },
      options.providerOptions,
    )

    const agentToolService = new McpAgentToolService({
      broker: new McpParentBroker({
        lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
        settingsService: settings,
        clientManager: settings.getBrokerClientManager(),
        grantResolver: ({ context, serverId }) =>
          settings.isAgentGranted(context.agentPath, serverId),
        leaseResolver: (context) => leases.resolve(context),
      }),
      leaseStore: leases,
      providerSettingsService: providerSettings,
      // The real resolver, the same one the worker service is given. A fixture
      // that answered `supported` for every pair would send an unusable one
      // into MCP execution and turn a pre-dispatch refusal into a generic
      // failure — which is exactly what naming a model "unreachable" did.
      providerSupportResolver: createMcpProviderSupportResolver(providerSettings),
    })

    const service = new McpWorkerTurnService({
      workspacePath: workspace,
      sessionStore,
      // The real resolver production builds, over this fixture's own provider
      // settings. Without one, `approvedPairCanUseTools` answers false and a
      // legitimately approved pair would reach no optional server — so the
      // route would have nothing to drop and the case would prove the wrong
      // thing.
      providerSupportResolver: createMcpProviderSupportResolver(providerSettings),
      agentToolService,
    })

    // Sealed and recorded against the original; now it is gone. The direct
    // adapter refuses a missing connection before it builds a request, which
    // is the eligible failure an offer is earned from, and the support
    // resolver reports it unavailable for MCP the same way.
    if (options.approveRetry) {
      await providerSettings.deleteConnection(originalConnectionId)
      // Chosen through the service, and *after* the deletion. Deleting a
      // connection refreshes the runtime default from settings, so a value
      // planted beforehand is replaced by the unset one — and an evaluator
      // with no application default has nothing to offer.
      await providerSettings.setDefaultModel({
        provider: scheduledAgent.provider,
        model: scheduledAgent.model,
      })
    }
    // The runner resolves a pair through this registry, so it must hold exactly
    // the connections that still exist.
    setConfiguredProviderConnections([
      {
        id: runningConnectionId,
        kind: 'openai-compatible',
        name: 'Step loopback',
        baseUrl: `${providerFixture.url}/v1`,
        apiKey: 'step-secret',
      },
    ])

    identity = {
      sessionId: session.id,
      runId,
      assignmentId: task.assignmentId,
      taskId: task.id,
      processIdentity,
    }

    server = http.createServer((req, res) => {
      void handleMcpWorkerTurnRoute({ req, res, service })
    })
    const listening = server
    await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve))
    const address = listening.address()
    assert.ok(address && typeof address !== 'string')

    // The runner builds its child environment from `process.env`, so this is
    // how a real child would be told where its parent is listening.
    const environment: Record<string, string> = {
      [MCP_WORKER_TURN_URL_ENV]: `http://127.0.0.1:${address.port}/private-worker`,
      [RUNTIME_SESSION_ID_ENV]: identity.sessionId,
      [RUNTIME_RUN_ID_ENV]: identity.runId,
      [RUNTIME_ASSIGNMENT_ID_ENV]: identity.assignmentId,
      [MCP_WORKER_WORKFLOW_STEP_ID_ENV]: STEP_ID,
      TEAM_RUNTIME_TASK_ID: identity.taskId,
      TEAM_RUNTIME_PROCESS_IDENTITY: identity.processIdentity,
      TEAM_RUNTIME_WORKFLOW_ID: WORKFLOW_ID,
    }
    const previous = new Map<string, string | undefined>()
    for (const [name, value] of Object.entries(environment)) {
      previous.set(name, process.env[name])
      process.env[name] = value
    }

    const spawnIdentityProcess = async (marker: string): Promise<ChildProcess> => {
      const child = spawn(
        process.execPath,
        ['-e', 'setInterval(() => undefined, 1_000)', '--', `${PROCESS_IDENTITY_ARGUMENT}${marker}`],
        { stdio: 'ignore' },
      )
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      return child
    }

    return {
      workspace,
      beginContinuation: async (attemptId: string) => {
        const child = await spawnIdentityProcess(attemptId)
        continuationProcess = child
        process.env.TEAM_RUNTIME_PROCESS_IDENTITY = attemptId
        assert.ok(child.pid, 'the continuation process reported no pid')
        return child.pid
      },
      sessionStore,
      session,
      task,
      processIdentity,
      identity,
      assignmentLocation: location,
      templatePath,
      teamPath,
      cleanup: async () => {
        // Restored here rather than by each caller: environment variables left
        // pointing at a deleted workspace outlive this test.
        for (const [name, value] of previous) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
        setRuntimeApprovedModelChoice(undefined)
        setRuntimeDefaultModelState(undefined)
        setConfiguredProviderConnections([])
        for (const child of [spawned, continuationProcess]) {
          if (!child || child.exitCode !== null || child.signalCode !== null) continue
          const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
          child.kill('SIGKILL')
          await exited
        }
        await new Promise<void>((resolve) => listening.close(() => resolve()))
        await providerFixture.close().catch(() => undefined)
        await manager.closeAll?.().catch(() => undefined)
        fs.rmSync(workspace, { recursive: true, force: true })
      },
    }
  } catch (error) {
    // Past this point the fixture owns a running MCP server, a running
    // loopback provider and possibly a listening socket, and the caller has no
    // `finally` yet.
    setRuntimeApprovedModelChoice(undefined)
    setRuntimeDefaultModelState(undefined)
    setConfiguredProviderConnections([])
    taskProcess?.kill('SIGKILL')
    continuationProcess?.kill('SIGKILL')
    const opened = server
    if (opened) await new Promise<void>((resolve) => opened.close(() => resolve()))
    await providerFixture.close().catch(() => undefined)
    await manager.closeAll?.().catch(() => undefined)
    fs.rmSync(workspace, { recursive: true, force: true })
    throw error
  }
}

test('a workflow step records the settings its route did not apply', async () => {
  const harness = await makeHarness({ providerOptions: ROUTE_ONLY_OPTIONS })
  try {
    const outcome = await runWorkflowOutcome({
      workflowEntry: {
        name: WORKFLOW_ID,
        template_path: harness.templatePath,
      },
      teamRegistry: new Map([
        [
          'lonely-writer',
          {
            name: 'lonely-writer',
            type: 'team',
            team_path: harness.teamPath,
            output_artifact: 'final-draft.md',
          },
        ],
      ]),
      brief: 'Draft a recommendation.',
      workspacePath: harness.workspace,
      spawnDepth: 0,
      // The root run is this workflow's own assignment inside the run, which
      // the durable projection checks against the location above.
      rootSessionId: harness.identity.assignmentId,
      parentSessionId: harness.identity.assignmentId,
      taskId: harness.identity.taskId,
      productSessionId: harness.identity.sessionId,
      persistenceMode: 'required' as const,
      executionAttemptId: 'attempt-one',
      // Passed explicitly, because the runner derives a step's own assignment
      // path from the environment while the durable projection derives the
      // expected one from this. Left out, the two disagree and the step fails
      // its child identity contract before any of this is reached.
      assignmentLocation: harness.assignmentLocation,
    })

    assert.equal(outcome.kind, 'terminal', JSON.stringify(outcome))
    if (outcome.kind !== 'terminal') return
    assert.equal(outcome.result.status, 'completed', JSON.stringify(outcome.result))

    const records = readRunLog(harness.workspace)
    // This Agent's own dispatch, named rather than taken as the first end
    // record: a run with more than one step would otherwise be asserted about
    // by position.
    const ended = records.find(
      (entry) =>
        entry.event === 'end' &&
        entry.agent_name === AGENT_NAME &&
        entry.logical_invocation_id === STEP_ID &&
        entry.dispatch_id === `${STEP_ID}#1#${AGENT_NAME}`,
    )
    assert.ok(ended, `no end record for this dispatch: ${JSON.stringify(records)}`)
    assert.equal(ended.status, 'completed', JSON.stringify(ended))
    // The start record keeps saying what it said: this adds an account, it does
    // not move one.
    const started = records.find(
      (entry) => entry.event === 'start' && entry.dispatch_id === ended.dispatch_id,
    )
    assert.ok(started, 'the dispatch wrote no start record')
    assert.equal(started.status, 'active', JSON.stringify(started))
    // The route applied none of them, and only the route can say so: the
    // request body this lane builds carries no settings at all, so their
    // absence from it looks the same whether they were dropped or ignored.
    assert.deepEqual(
      ended.dropped_provider_options,
      ['max_tokens', 'temperature'],
      `the step's end record does not say what its route dropped: ${JSON.stringify(ended)}`,
    )
  } finally {
    await harness.cleanup()
  }
})

/**
 * Both sources at once, which neither existing case exercises.
 *
 * An approved retry moves this step onto a different model, and that switch
 * re-evaluates the Agent's settings against the pair that will actually run:
 * `thinking_budget` is Anthropic's, so a connection with no such field drops
 * it before the turn starts. The turn then takes the native tool loop, which
 * applies nothing, so `max_tokens` — which survived the switch — is dropped by
 * the route.
 *
 * The union is already implemented, so this is not offered as a Red. It is the
 * coverage the route-only case could not give: removing either source from the
 * union is shown below to fail it.
 */
test('a step that switches models and then applies none of the survivors names both', async () => {
  const harness = await makeHarness({
    // `thinking_budget` is Anthropic's, so the switch onto this connection
    // drops it; `max_tokens` survives that and is then dropped by the route,
    // which applies nothing. Both sources end up non-empty.
    providerOptions: { max_tokens: 256, thinking_budget: 2_048 },
    approveRetry: true,
  })
  const common = {
    workflowEntry: { name: WORKFLOW_ID, template_path: harness.templatePath },
    teamRegistry: new Map([
      [
        'lonely-writer',
        {
          name: 'lonely-writer',
          type: 'team' as const,
          team_path: harness.teamPath,
          output_artifact: 'final-draft.md',
        },
      ],
    ]),
    brief: 'Draft a recommendation.',
    workspacePath: harness.workspace,
    spawnDepth: 0,
    rootSessionId: harness.identity.assignmentId,
    parentSessionId: harness.identity.assignmentId,
    taskId: harness.identity.taskId,
    productSessionId: harness.identity.sessionId,
    persistenceMode: 'required' as const,
    assignmentLocation: harness.assignmentLocation,
    modelChoiceEvaluator: createWorkflowModelChoiceEvaluator(),
  }
  try {
    // Earned, not planted: the pinned pair cannot run, so the step stops and
    // asks.
    const waiting = await runWorkflowOutcome({
      ...common,
      executionAttemptId: 'attempt-one',
    })
    assert.equal(waiting.kind, 'awaiting_model_choice', JSON.stringify(waiting))
    if (waiting.kind !== 'awaiting_model_choice') return

    const store = new FileSystemWorkflowStateStore(
      harness.assignmentLocation.assignmentPath,
    )
    const approved = await store.approveModelChoice({
      expectedRevision: waiting.workflowRevision,
      offerId: waiting.offer.offerId,
    })
    // The continuation the queue would claim, with the admission id the worker
    // service fences the substituted pair against.
    const continuationAdmissionRequestId = randomUUID()
    const continuationAttemptId = randomUUID()
    await store.claimModelChoiceContinuation({
      expectedRevision: approved.revision,
      stepId: STEP_ID,
      expectedOwnerExecutionAttemptId: approved.ownerExecutionAttemptId,
      nextExecutionAttemptId: continuationAttemptId,
      continuationAdmissionRequestId,
    })
    // And the granted record that continuation runs under. Written here
    // because no queue is running, in exactly the shape the queue writes.
    const continuationPid = await harness.beginContinuation(continuationAttemptId)
    const running = await harness.sessionStore.compareAndSetTaskRecord(
      harness.session.id,
      harness.task.id,
      ['running'],
      {
        status: 'running',
        // The same value for both, which is what a granted record requires.
        processIdentity: continuationAttemptId,
        executionAttemptId: continuationAttemptId,
        // The record has to name the process that carries the marker, or the
        // authority checks the previous attempt's process against it.
        pid: continuationPid,
        ownerInstanceId: harness.sessionStore.getInstanceId(),
        admission: {
          version: 1 as const,
          requestId: continuationAdmissionRequestId,
          order: '2',
          requestedAt: '2026-09-09T12:00:01.000Z',
          executionKind: 'continuation' as const,
          source: 'model_choice' as const,
          expectedExecutionAttemptId: 'attempt-one',
          phase: 'granted' as const,
          grantId: 'grant-1',
          ownerEpoch: '1',
          grantedAt: '2026-09-09T12:00:02.000Z',
          executionAttemptId: continuationAttemptId,
        },
      },
    )
    assert.equal(running?.updated, true)
    const continuationDeadline = Date.now() + 3_000
    while (!harness.sessionStore.hasValidTaskProcessIdentity(running.task)) {
      assert.ok(
        Date.now() < continuationDeadline,
        'the continuation process identity never appeared',
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    // Nothing is planted here. The runner publishes the durable step's own
    // approved choice around the dispatch (`workflows/runner.ts:2181-2182`),
    // and seeding it from the fixture would hide a broken publication path.
    const outcome = await runWorkflowOutcome({
      ...common,
      executionAttemptId: continuationAttemptId,
      recoveryMode: true,
    })
    assert.equal(outcome.kind, 'terminal', JSON.stringify(outcome))
    if (outcome.kind !== 'terminal') return
    assert.equal(outcome.result.status, 'completed', JSON.stringify(outcome.result))

    const records = readRunLog(harness.workspace)
    const attempts = records.filter((entry) => entry.agent_name === AGENT_NAME)
    // The approved attempt, named by how its pair was chosen rather than by
    // position: the first attempt is on this Agent's own explicit pair, and
    // only the continuation runs on a user-approved retry.
    const started = attempts.find(
      (entry) =>
        entry.event === 'start' &&
        (entry.model_selection as { reason?: unknown } | undefined)?.reason ===
          'user-approved-retry',
    )
    assert.ok(started, `no approved-retry start: ${JSON.stringify(attempts)}`)
    // The pre-switch disclosure is unchanged: the start names what the switch
    // dropped, because the route had not answered yet.
    assert.deepEqual(
      started.dropped_provider_options,
      ['thinking_budget'],
      `the start lost its own disclosure: ${JSON.stringify(started)}`,
    )

    const ended = attempts.find(
      (entry) => entry.event === 'end' && entry.dispatch_id === started.dispatch_id,
    )
    assert.ok(ended, `no end record for that attempt: ${JSON.stringify(attempts)}`)
    assert.equal(ended.status, 'completed', JSON.stringify(ended))
    // One set for one attempt: what the switch dropped and what the route
    // dropped, once each and in a stable order.
    assert.deepEqual(
      ended.dropped_provider_options,
      ['max_tokens', 'thinking_budget'],
      `the completed attempt does not name both sources: ${JSON.stringify(ended)}`,
    )
  } finally {
    await harness.cleanup()
  }
})
