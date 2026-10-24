/**
 * The boundary an approved retry has to cross, and why it could not.
 *
 * `mcp-resolution.json` is sealed at launch and records the pair each Agent was
 * scheduled with. That is the point of it: a worker cannot talk its way into a
 * different model by asking. But an approved model choice is precisely a
 * request to run one attempt on a *different* pair, so the sealed record and
 * the request disagree by design, and `authorize()` refused the retry before
 * any provider saw it.
 *
 * The exception this proves is narrow and is authorized by durable state, never
 * by the request: the workflow's own record must already carry the approval for
 * this step, the task must hold the granted `model_choice` admission that the
 * approval was claimed by, and the pair asked for must be exactly the pair the
 * user was shown. The sealed resolution is never rewritten.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  MCP_WORKER_TURN_CONTRACT_VERSION,
  type McpWorkerTurnRequest,
} from '../../domains/mcp/mcp-worker-turn.js'
import {
  MCP_WORKFLOW_RESOLUTION_VERSION,
  evaluateMcpWorkflowPreflight,
  type McpWorkflowResolutionSnapshot,
} from '../../domains/mcp/mcp-workflow-preflight.js'
import { createMcpProviderSupportResolver } from '../../domains/mcp/mcp-provider-support.js'
import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { prepareDelegatedRuntimeAssignmentAuthority } from '../../domains/run/runtime-assignment-authority.js'
import { buildChildAssignmentLocation } from '../../domains/runtime/runtime-paths.js'
import {
  RUNTIME_PROCESS_IDENTITY_ENV,
  RUNTIME_TASK_ID_ENV,
} from '../../contracts/runtime-capability-authority.js'
import * as http from 'node:http'

import { runAgent } from '../../domains/agent-execution/agent-runner.js'
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
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { PROCESS_IDENTITY_ARGUMENT } from '../../domains/sessions/task-process-supervisor.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpEvidenceStore } from '../../domains/mcp/mcp-evidence-store.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { McpAgentToolService } from '../../services/mcp-agent-tool-service.js'
import {
  McpSettingsService,
  type McpSecretCodec,
} from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import {
  McpWorkerTurnService,
  McpWorkerTurnServiceError,
} from '../../services/mcp-worker-turn-service.js'
import {
  FileSystemWorkflowStateStore,
  hashWorkflowContent,
} from '../../workflows/workflow-state-store.js'
import type { DurableWorkflowState } from '../../workflows/types.js'
import { resolveWorkflowJournalRecorder } from '../../services/workflow-journal-recorder.js'
import {
  ExecutionJournalUnavailableError,
  WorkspaceExecutionJournalRegistry,
} from '../../services/workspace-execution-journal-registry.js'

const AGENT_PATH = 'agents/defaultrecoveryworker'
const OTHER_AGENT_PATH = 'agents/otherworker'
const AGENT_NAME = 'defaultrecoveryworker'
const STEP_ID = 'finalize'
const WORKFLOW_ID = 'recovery-workflow'
const ORIGINAL_PROVIDER = 'connection:absentconnection'
const ORIGINAL_MODEL = 'fake/never-configured'
/**
 * A provider the tool layer really supports.
 *
 * `mcp-provider-support.ts:59-65` treats `openai` as supported, so an
 * authorized turn carries on past support resolution into the real `no-tools`
 * branch (`mcp-agent-tool-service.ts:373-379`) without contacting anything.
 * The Agent's own sealed provider is not configured, so the control below stops
 * at `provider-unsupported` — and the difference between those two answers is
 * exactly what the substitution changed.
 */
const APPROVED_PROVIDER = 'openai'
const APPROVED_MODEL = 'fake/app-default'
/**
 * A provider with no parent-tool-loop adapter.
 *
 * `mcp-provider-support.ts:72` answers `provider_adapter_unavailable` for
 * anything that is neither an OpenAI-compatible provider, a configured
 * connection, nor a CLI bridge. Anthropic is a real provider this build talks
 * to for ordinary turns, which is what makes it the honest example: the pair
 * works, and still cannot reach an MCP server.
 */
const TOOL_INCAPABLE_PROVIDER = 'anthropic'
const ADMISSION_REQUEST_ID = 'continuation-request-1'
/**
 * The attempt that failed, and the one the approval admitted.
 *
 * A model-choice admission is created with `expectedExecutionAttemptId` set to
 * the attempt that stopped (`services/task-queue.ts:1299`), and granted with a
 * new `executionAttemptId`. Modelling both as one value would let an
 * implementation compare the wrong pair and still pass.
 */
const FAILED_ATTEMPT = '44444444-4444-4444-8444-444444444444'
const CONTINUATION_ATTEMPT = '55555555-5555-4555-8555-555555555555'
const CHILD_ASSIGNMENT_ID = 'child-defaultrecoveryworker-1'
const NEXT_STEP_ID = 'publish'
/** A step whose sealed entry carries an *optional* MCP requirement. */
const REQUIRING_STEP_ID = 'gather'
/**
 * A step whose sealed entry carries a *required* match this Agent owned.
 *
 * The distinction is the whole of the rule: an optional capability the run can
 * proceed without is not a reason to refuse a retry a person approved, while a
 * required one the failed pair owned is.
 */
const REQUIRED_OWNER_STEP_ID = 'verify'
/** The one server the required match names. */
const MARKER_SERVER_ID = 'marker-server'

/** The Agent's own pair, sealed at launch and never rewritten. */
function sealedResolution() {
  const scheduledAgents = [
    {
      agentPath: AGENT_PATH,
      provider: ORIGINAL_PROVIDER,
      model: ORIGINAL_MODEL,
      supportState: 'unknown' as const,
    },
    {
      agentPath: OTHER_AGENT_PATH,
      provider: ORIGINAL_PROVIDER,
      model: ORIGINAL_MODEL,
      supportState: 'unknown' as const,
    },
  ]
  return {
    version: MCP_WORKFLOW_RESOLUTION_VERSION,
    generatedAt: '2026-09-06T12:00:00.000Z',
    workflowId: WORKFLOW_ID,
    scheduledAgentPaths: [AGENT_PATH, OTHER_AGENT_PATH],
    scheduledAgents,
    authorization: {
      state: 'non-authoritative' as const,
      brokerRechecksAtCallTime: true as const,
    },
    workflowRequirements: [],
    steps: [
      {
        stepId: STEP_ID,
        scheduledAgentPaths: [AGENT_PATH, OTHER_AGENT_PATH],
        scheduledAgents,
        effectiveRequirements: [],
        matches: [],
      },
      {
        stepId: REQUIRING_STEP_ID,
        scheduledAgentPaths: [AGENT_PATH, OTHER_AGENT_PATH],
        scheduledAgents,
        effectiveRequirements: [
          {
            capability: 'marker.echo',
            access: ['read' as const],
            necessity: 'optional' as const,
          },
        ],
        matches: [
          {
            capability: 'marker.echo',
            access: ['read' as const],
            necessity: 'optional' as const,
            candidates: [],
            owner: null,
          },
        ],
      },
      {
        stepId: REQUIRED_OWNER_STEP_ID,
        scheduledAgentPaths: [AGENT_PATH, OTHER_AGENT_PATH],
        scheduledAgents,
        effectiveRequirements: [
          {
            capability: 'marker.echo',
            access: ['read' as const],
            necessity: 'required' as const,
          },
        ],
        matches: [
          {
            capability: 'marker.echo',
            access: ['read' as const],
            necessity: 'required' as const,
            candidates: [
              {
                serverId: MARKER_SERVER_ID,
                serverName: 'marker',
                agentPath: AGENT_PATH,
                provider: ORIGINAL_PROVIDER,
                state: 'supported' as const,
              },
            ],
            owner: {
              agentPath: AGENT_PATH,
              provider: ORIGINAL_PROVIDER,
            },
          },
        ],
      },
    ],
    warnings: [],
  }
}

/**
 * The admission the queue writes for an approved model choice, granted.
 *
 * `expectedExecutionAttemptId` names the attempt that stopped and
 * `executionAttemptId` the one the approval admitted; they are different
 * values, as `services/task-queue.ts:1299` produces.
 */
const grantedModelChoiceAdmission = {
  version: 1 as const,
  requestId: ADMISSION_REQUEST_ID,
  order: '2',
  requestedAt: '2026-09-06T12:00:01.000Z',
  executionKind: 'continuation' as const,
  source: 'model_choice' as const,
  expectedExecutionAttemptId: FAILED_ATTEMPT,
  phase: 'granted' as const,
  grantId: 'grant-1',
  ownerEpoch: '1',
  grantedAt: '2026-09-06T12:00:02.000Z',
  executionAttemptId: CONTINUATION_ATTEMPT,
}

const APPROVAL = {
  offerId: 'offer-1',
  agentName: AGENT_NAME,
  logicalInvocationId: STEP_ID,
  failedChoice: { provider: ORIGINAL_PROVIDER, model: ORIGINAL_MODEL },
  proposedDefault: { provider: APPROVED_PROVIDER, model: APPROVED_MODEL },
}


/**
 * The source tree, not the compiled one.
 *
 * These tests run from `.tests-dist`, so deriving this from `import.meta.url`
 * points at the build output — where the `.mjs` fixtures, which are never
 * compiled, do not exist. The runner's working directory is the repository.
 */
const repoRoot = process.cwd()
const MCP_FIXTURE_PATH = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'mcp',
  'stdio-server.mjs',
)
const GRANTED_SERVER_ID = 'retry-tools'
const GRANTED_CAPABILITY = 'marker.echo'
const TOOL_LOOP_MODEL = 'fixture/tool-loop'

/**
 * A world with a server the Agent can really reach.
 *
 * Everything here is the real thing: a stdio MCP server the fixture starts, a
 * grant written through the settings service, a provider connection pointing at
 * a loopback endpoint that runs an actual tool loop, and a seal produced by
 * `evaluateMcpWorkflowPreflight` rather than written by hand. That last part
 * matters — a hand-written seal can state a candidate the real preflight would
 * never produce, and then the test proves only that the code agrees with the
 * fixture's opinion.
 *
 * The failed pair is a connection that does not exist, which is how an Agent
 * ends up asking for a retry in the first place.
 */
function grantedServerWorld(input: {
  readonly callsPath: string
  readonly stepId: string
  readonly necessity: 'required' | 'optional'
}): RetryWorldFactory {
  return async ({ mcpSettings, providerSettings }) => {
    const providerFixture = await startOpenAiToolLoopFixture(repoRoot)
    try {
      const connection = await providerSettings.saveConnection({
        kind: 'openai-compatible',
        name: 'Approved retry provider',
        baseUrl: `${providerFixture.url}/v1`,
        apiKey: 'approved-retry-secret',
        enabled: true,
      })
      await providerSettings.validateConnection(connection.id)
      await providerSettings.setModelEnabled(connection.id, TOOL_LOOP_MODEL, true)
      const approvedProvider = configuredProviderName(connection.id)

      await mcpSettings.saveServer({
        id: GRANTED_SERVER_ID,
        name: 'Retry tools',
        capabilityAliases: [{ capability: GRANTED_CAPABILITY, access: 'read' }],
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: [MCP_FIXTURE_PATH],
          cwd: repoRoot,
          secretEnvironment: {
            MCP_FIXTURE_CALLS_PATH: {
              operation: 'replace',
              value: input.callsPath,
            },
          },
        },
      })
      await mcpSettings.validateServer(GRANTED_SERVER_ID, {
        stdioTrustAcknowledged: true,
      })
      // The grant belongs to the Agent, not to a pair. That is the fact the
      // whole capability turns on, so it is written the way production writes
      // it and read back by the same preflight.
      await mcpSettings.setAgentGrant(AGENT_PATH, GRANTED_SERVER_ID, true)

      const scheduled = {
        agentPath: AGENT_PATH,
        provider: ORIGINAL_PROVIDER,
        model: ORIGINAL_MODEL,
        supportState: 'supported' as const,
      }
      const sealed = evaluateMcpWorkflowPreflight({
        workflowId: WORKFLOW_ID,
        generatedAt: '2026-09-06T12:00:00.000Z',
        steps: [
          { stepId: STEP_ID, scheduledAgents: [scheduled] },
          { stepId: NEXT_STEP_ID, scheduledAgents: [scheduled] },
          {
            stepId: input.stepId,
            requirements: [
              {
                capability: GRANTED_CAPABILITY,
                access: 'read',
                necessity: input.necessity,
              },
            ],
            scheduledAgents: [scheduled],
          },
        ],
        servers: [{
          serverId: GRANTED_SERVER_ID,
          serverName: 'Retry tools',
          enabled: true,
          status: 'connected',
          live: true,
          capabilityAliases: [
            { capability: GRANTED_CAPABILITY, access: 'read' },
          ],
        }],
        grants: await mcpSettings.listAgentGrants(),
      }).snapshot

      return {
        sealed,
        approvedPair: {
          provider: approvedProvider,
          model: TOOL_LOOP_MODEL,
        },
        dispose: () => providerFixture.close(),
      }
    } catch (error) {
      await providerFixture.close().catch(() => undefined)
      throw error
    }
  }
}

function readJsonLines(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown)
}

async function startTaskProcess(processIdentity: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      'setInterval(() => undefined, 1_000)',
      '--',
      `${PROCESS_IDENTITY_ARGUMENT}${processIdentity}`,
    ],
    { stdio: 'ignore' },
  )
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  return child
}

async function stopTaskProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await exited
}

async function waitForTaskProcessIdentity(
  sessionStore: FileSystemSessionStore,
  task: NonNullable<Awaited<ReturnType<FileSystemSessionStore['getTaskRecord']>>>,
): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (sessionStore.hasValidTaskProcessIdentity(task)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail('Timed out waiting for the task process identity marker.')
}

interface RetryFixture {
  readonly workspacePath: string
  readonly sessionStore: FileSystemSessionStore
  readonly sessionId: string
  readonly task: NonNullable<
    Awaited<ReturnType<FileSystemSessionStore['createTaskRecord']>>
  >
  readonly stateStore: FileSystemWorkflowStateStore
  /** The settings a test revokes a grant through, mid-run. */
  readonly mcpSettings: McpSettingsService
  readonly advance: (mutate: (draft: DurableWorkflowState) => void) => Promise<void>
  readonly baseRequest: McpWorkerTurnRequest
  readonly observed: Array<{ provider: string; model: string }>
  /**
   * What each admitted turn was actually allowed to reach.
   *
   * Kept apart from `observed` because the pair and the grant answer different
   * questions: the pair says the substitution happened, and this says what the
   * substituted attempt may do. A test that only watched the pair would pass
   * just as happily on a turn granted nothing.
   */
  readonly policies: Array<{
    allowedServerIds: readonly string[]
    requiredServerGroups: readonly (readonly string[])[]
    providerConfig?: Record<string, unknown>
  }>
  readonly makeService: (
    registry?: WorkspaceExecutionJournalRegistry,
  ) => McpWorkerTurnService
  readonly sealedPath: string
  readonly dispose: () => Promise<void>
}

/**
 * One task, standing exactly where the retry's worker request finds it.
 *
 * Parameterised by the step under approval so the requirements case gets its
 * own task rather than reusing one whose step has already finished — a finished
 * step is immutable, and reaching into it to stage another case would be
 * staging a state the product cannot produce.
 */
async function prepareRetryFixture(options: {
  readonly title: string
  readonly stepId: string
  readonly enrolled?: boolean
  /**
   * The world this retry happens in: what the run sealed, and which pair the
   * person approved.
   *
   * Built before the task exists because the sealed record is written when the
   * task record is created, and a world with real MCP servers has to register
   * and grant them before it can describe what the preflight would seal.
   */
  readonly world?: RetryWorldFactory
}): Promise<RetryFixture> {
  // The one identity a granted record may have: `readTaskRecord` refuses any
  // record whose attempt and process identity disagree with its admission
  // (`domains/sessions/session-normalizers.ts:69-77`).
  const processIdentity = CONTINUATION_ATTEMPT
  // Realpath'd: the authority resolver compares resolved run paths by string,
  // and on macOS a `mkdtemp` under /var reaches the store as /private/var.
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-model-choice-retry-')),
  )
  const workspacePath = path.join(directory, 'workspace')
  const codec: McpSecretCodec = {
    encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
    decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
  }
  const clientManager = new McpClientManager({
    connectTimeoutMs: 5_000,
    requestTimeoutMs: 10_000,
    closeTimeoutMs: 1_000,
  })
  const mcpSettings = new McpSettingsService({
    storagePath: path.join(directory, 'mcps.json'),
    secretCodec: codec,
    clientManager,
  })
  const providerSettings = new ProviderSettingsService({
    storagePath: path.join(directory, 'providers.json'),
    secretCodec: codec,
  })
  const services = { clientManager, mcpSettings, providerSettings }

  let world: RetryWorld
  try {
    world = await (options.world ?? defaultRetryWorld)({
      directory,
      ...services,
    })
  } catch (error) {
    await clientManager.closeAll?.().catch(() => undefined)
    fs.rmSync(directory, { recursive: true, force: true })
    throw error
  }

  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: options.title })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: WORKFLOW_ID,
    brief: 'Finalize the note.',
    mcpResolution: world.sealed,
  })
  assert.ok(task?.assignmentId)
  assert.ok(task.assignmentPath)
  assert.ok(task.runPath)

  const taskProcess = await startTaskProcess(processIdentity)
  assert.ok(taskProcess.pid)
  // From here on the fixture owns a live child process. Anything that throws
  // during the rest of setup must still release it, or the test run is held
  // open by a process no `finally` was ever installed for.
  try {
    return await completeRetryFixture({
      options,
      directory,
      workspacePath,
      sessionStore,
      session,
      task,
      taskProcess,
      processIdentity,
      world,
      ...services,
    })
  } catch (error) {
    // The primary failure is what the reader needs; a cleanup that also fails
    // must not replace it.
    await stopTaskProcess(taskProcess).catch(() => undefined)
    await clientManager.closeAll?.().catch(() => undefined)
    try {
      fs.rmSync(directory, { recursive: true, force: true })
    } catch {
      // Already reporting a worse problem.
    }
    throw error
  }
}

interface RetryWorld {
  /** What the run sealed at launch, written into the task record. */
  readonly sealed: McpWorkflowResolutionSnapshot
  /** The pair the person approved, and therefore the pair the retry asks for. */
  readonly approvedPair: { readonly provider: string; readonly model: string }
  /** Released with the fixture, for a world that owns a process or a socket. */
  readonly dispose?: () => Promise<void> | void
}

type RetryWorldFactory = (input: {
  readonly directory: string
  readonly clientManager: McpClientManager
  readonly mcpSettings: McpSettingsService
  readonly providerSettings: ProviderSettingsService
}) => Promise<RetryWorld>

/**
 * The scoped-approval world: a hand-written seal and no live servers at all.
 *
 * Deliberately synthetic. These cases are about which durable facts admit a
 * substitution, and a seal written by hand states them without a real server's
 * behaviour standing between the assertion and the rule.
 */
const defaultRetryWorld: RetryWorldFactory = async () => ({
  sealed: sealedResolution(),
  approvedPair: { provider: APPROVED_PROVIDER, model: APPROVED_MODEL },
})

async function completeRetryFixture(input: {
  readonly options: { readonly stepId: string; readonly enrolled?: boolean }
  readonly directory: string
  readonly workspacePath: string
  readonly sessionStore: FileSystemSessionStore
  readonly session: { readonly id: string }
  readonly task: NonNullable<
    Awaited<ReturnType<FileSystemSessionStore['createTaskRecord']>>
  >
  readonly taskProcess: ChildProcess
  readonly processIdentity: string
  readonly world: RetryWorld
  readonly clientManager: McpClientManager
  readonly mcpSettings: McpSettingsService
  readonly providerSettings: ProviderSettingsService
}): Promise<RetryFixture> {
  const { directory, options, processIdentity, session, sessionStore, task, taskProcess, workspacePath } = input
  assert.ok(task.assignmentId)
  assert.ok(task.assignmentPath)
  assert.ok(task.runPath)
  const running = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'running',
      processIdentity,
      executionAttemptId: CONTINUATION_ATTEMPT,
      ownerInstanceId: sessionStore.getInstanceId(),
      pid: taskProcess.pid,
      admission: grantedModelChoiceAdmission,
    },
  )
  assert.equal(running?.updated, true)
  await waitForTaskProcessIdentity(sessionStore, running.task)

  const registry = options.enrolled
    ? new WorkspaceExecutionJournalRegistry({
        workspacePath,
        tenantId: 'local',
        mode: 'authoritative',
      })
    : undefined
  try {
    return await buildRetryFixture({ ...input, registry })
  } catch (error) {
    // The registry owns handles too, so a failure after it is opened must
    // release it as well as the child process — without replacing the failure
    // being reported.
    await Promise.resolve(registry?.close?.()).catch(() => undefined)
    throw error
  }
}

async function buildRetryFixture(input: {
  readonly options: { readonly stepId: string; readonly enrolled?: boolean }
  readonly directory: string
  readonly workspacePath: string
  readonly sessionStore: FileSystemSessionStore
  readonly session: { readonly id: string }
  readonly task: NonNullable<
    Awaited<ReturnType<FileSystemSessionStore['createTaskRecord']>>
  >
  readonly taskProcess: ChildProcess
  readonly processIdentity: string
  readonly registry: WorkspaceExecutionJournalRegistry | undefined
  readonly world: RetryWorld
  readonly clientManager: McpClientManager
  readonly mcpSettings: McpSettingsService
  readonly providerSettings: ProviderSettingsService
}): Promise<RetryFixture> {
  const { clientManager, directory, mcpSettings, options, processIdentity, providerSettings, registry, session, sessionStore, task, taskProcess, workspacePath, world } = input
  assert.ok(task.assignmentId)
  assert.ok(task.assignmentPath)
  assert.ok(task.runPath)
  const journalOptions = await resolveWorkflowJournalRecorder({
    ...(registry ? { registry } : {}),
    task,
    requestId: `retry-fixture-${task.id}`,
    processIdentity,
  })
  const stateStore = new FileSystemWorkflowStateStore(
    task.assignmentPath,
    journalOptions,
  )
  await stateStore.initialize({
    manifest: {
      taskId: task.id,
      sessionId: session.id,
      rootRunId: task.runId,
      workflowId: WORKFLOW_ID,
      workflowDefinitionHash: hashWorkflowContent('recovery:v1'),
      briefHash: hashWorkflowContent(task.brief),
      teamDefinitionHashes: {
        'recovery-team': hashWorkflowContent('recovery-team:v1'),
      },
      runtimeVersion: 'workflow-runtime-v1',
    },
    executionAttemptId: CONTINUATION_ATTEMPT,
    steps: [
      {
        stepId: STEP_ID,
        stepIndex: 0,
        stepType: 'agent',
        team: 'recovery-team',
        definitionHash: hashWorkflowContent('finalize:v1'),
        recoveryPolicy: 'manual',
        childRunId: 'child-run',
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'final.md',
        requestedResultType: 'artifact:final.md',
      },
      {
        stepId: NEXT_STEP_ID,
        stepIndex: 1,
        stepType: 'agent',
        team: 'recovery-team',
        definitionHash: hashWorkflowContent('publish:v1'),
        recoveryPolicy: 'manual',
        inputArtifact: 'final.md',
        resultArtifact: 'published.md',
        requestedResultType: 'artifact:published.md',
      },
      {
        stepId: REQUIRING_STEP_ID,
        stepIndex: 2,
        stepType: 'agent',
        team: 'recovery-team',
        definitionHash: hashWorkflowContent('gather:v1'),
        recoveryPolicy: 'manual',
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'gathered.md',
        requestedResultType: 'artifact:gathered.md',
      },
      // The step with a *required* capability. It has to exist here as well as
      // in the seal: the approval is written onto a workflow step, and a step
      // the state does not contain silently receives no approval — which a
      // refusal test would then pass for entirely the wrong reason.
      {
        stepId: REQUIRED_OWNER_STEP_ID,
        stepIndex: 3,
        stepType: 'agent',
        team: 'recovery-team',
        definitionHash: hashWorkflowContent('verify:v1'),
        recoveryPolicy: 'manual',
        inputArtifact: 'gathered.md',
        resultArtifact: 'verified.md',
        requestedResultType: 'artifact:verified.md',
      },
    ],
  })
  const advance = async (
    mutate: (draft: DurableWorkflowState) => void,
  ): Promise<void> => {
    const snapshot = await stateStore.requireSnapshot()
    await stateStore.update({
      expectedRevision: snapshot.state.revision,
      executionAttemptId: CONTINUATION_ATTEMPT,
      mutate,
    })
  }

  // Exactly the state the run is in when the worker request arrives: the
  // continuation has claimed ownership, and `runWorkflowAgentStep` has
  // relaunched the step (`workflows/runner.ts:2112-2121`) — running, one more
  // attempt than the one that failed, named as the current step — while it
  // still carries the approval it inherited and the receipt for the admission
  // that claimed it.
  await advance((draft) => {
    const step = draft.steps.find((entry) => entry.stepId === options.stepId)
    if (!step) return
    step.approvedModelChoice = {
      ...APPROVAL,
      proposedDefault: world.approvedPair,
      logicalInvocationId: options.stepId,
    }
    step.modelChoiceContinuationAdmissionRequestId = ADMISSION_REQUEST_ID
    step.status = 'launching'
    step.attemptCount = 2
    step.startedAt = '2026-09-06T12:00:05.000Z'
    draft.status = 'running'
    draft.currentStepId = options.stepId
  })
  await advance((draft) => {
    const step = draft.steps.find((entry) => entry.stepId === options.stepId)
    if (step) step.status = 'running'
  })

  // The real delegation an agent step performs: `runWorkflowAgentStep` creates
  // a child assignment and derives a credential for it
  // (`workflows/runner.ts:484-504`), and the worker request is made with that
  // child identity. The canonical workflow state stays at the root task
  // assignment, so an implementation that read the requesting assignment's own
  // directory would find nothing.
  const rootLocation = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: session.id,
    runId: task.runId,
    assignmentId: task.assignmentId,
  })
  assert.ok(rootLocation)
  const childLocation = buildChildAssignmentLocation(
    workspacePath,
    rootLocation,
    CHILD_ASSIGNMENT_ID,
  )
  assert.ok(childLocation)
  fs.mkdirSync(childLocation.assignmentPath, { recursive: true })
  const delegated = await prepareDelegatedRuntimeAssignmentAuthority({
    workspacePath,
    parentLocation: rootLocation,
    childLocation,
    environment: {
      [RUNTIME_TASK_ID_ENV]: task.id,
      [RUNTIME_PROCESS_IDENTITY_ENV]: processIdentity,
    },
  })
  assert.ok(delegated)
  assert.notEqual(delegated.processIdentity, processIdentity)

  // The real agent-tool service, wired as production wires it, over the same
  // settings the world was built in. A world that granted no servers resolves
  // as `no-tools` before any network call; a world that granted one reaches it.
  const leases = new McpRunLeaseStore()
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: mcpSettings,
    clientManager: mcpSettings.getBrokerClientManager(),
    grantResolver: ({ context, serverId }) =>
      mcpSettings.isAgentGranted(context.agentPath, serverId),
    leaseResolver: (context) => leases.resolve(context),
    evidenceStoreFactory: (scope) => new McpEvidenceStore({ workspacePath, ...scope }),
  })
  const agentToolService = new McpAgentToolService({
    broker,
    leaseStore: leases,
    providerSettingsService: providerSettings,
  })
  const observed: Array<{ provider: string; model: string }> = []
  const policies: RetryFixture['policies'] = []
  const makeService = (
    journalRegistry?: WorkspaceExecutionJournalRegistry,
  ): McpWorkerTurnService =>
    new McpWorkerTurnService({
      workspacePath,
      sessionStore,
      // The real resolver production builds (`server/composition.ts:460-462`),
      // over this fixture's own provider settings. Whether a provider can drive
      // the parent tool loop is its answer to give, not the test's.
      providerSupportResolver: createMcpProviderSupportResolver(
        providerSettings,
      ),
      agentToolService: {
        runTurn: (input) => {
          observed.push({ provider: input.provider, model: input.model })
          policies.push({
            allowedServerIds: input.allowedServerIds ?? [],
            requiredServerGroups: input.requiredServerGroups ?? [],
            ...(input.providerConfig
              ? { providerConfig: { ...input.providerConfig } }
              : {}),
          })
          return agentToolService.runTurn(input)
        },
      },
      ...(journalRegistry ? { executionJournalRegistry: journalRegistry } : {}),
    })

  return {
    workspacePath,
    sessionStore,
    sessionId: session.id,
    task,
    stateStore,
    mcpSettings,
    advance,
    observed,
    policies,
    makeService,
    sealedPath: path.join(task.runPath, 'mcp-resolution.json'),
    baseRequest: {
      version: MCP_WORKER_TURN_CONTRACT_VERSION,
      sessionId: session.id,
      runId: task.runId,
      assignmentId: CHILD_ASSIGNMENT_ID,
      taskId: task.id,
      processIdentity: delegated.processIdentity,
      workflowId: WORKFLOW_ID,
      workflowStepId: options.stepId,
      agentPath: AGENT_PATH,
      provider: world.approvedPair.provider,
      model: world.approvedPair.model,
      thinking: 'low',
      systemPrompt: 'Default recovery worker.',
      userMessage: 'Finalize the note.',
    },
    /**
     * Releases everything, then reports the first thing that went wrong.
     *
     * Every step runs even if an earlier one throws, or a failing process kill
     * would strand the registry and the workspace. And a failure here is still
     * a failure: swallowing it would hide a leak, while letting it escape
     * first would replace the test's own error with it.
     */
    dispose: async () => {
      let failure: unknown
      const release = async (step: () => Promise<unknown> | unknown) => {
        try {
          await step()
        } catch (error) {
          failure ??= error
        }
      }
      await release(() => stopTaskProcess(taskProcess))
      await release(() => world.dispose?.())
      await release(() => clientManager.closeAll?.())
      await release(() => registry?.close?.())
      await release(() => fs.rmSync(directory, { recursive: true, force: true }))
      if (failure !== undefined) throw failure
    },
  }
}

const refusal = (error: unknown): boolean =>
  error instanceof McpWorkerTurnServiceError && error.code === 'unauthorized'

test('an approved model-choice retry is authorized against durable state, not the request', {
  timeout: 30_000,
}, async () => {
  const fixture = await prepareRetryFixture({
    title: 'Model choice retry',
    stepId: STEP_ID,
  })
  const { advance, baseRequest, observed, sessionStore, task } = fixture
  const service = fixture.makeService()
  try {
    const sealedBefore = fs.readFileSync(fixture.sealedPath, 'utf8')

    // ── A control, so the assertions below cannot be blamed on the fixture ──
    // The same delegated identity asking for the Agent's own sealed pair is
    // authorized. Whatever governs the approved pair is therefore the model
    // choice itself, not the workspace, the credential, or the task record.
    // Reaching the agent-tool boundary at all is the evidence: a refused turn
    // throws before it. The Agent's own sealed provider is not configured, so
    // the real service stops at provider support.
    const sealedPairResponse = await service.runTurn({
      ...baseRequest,
      provider: ORIGINAL_PROVIDER,
      model: ORIGINAL_MODEL,
    })
    assert.equal(sealedPairResponse.kind, 'provider-unsupported')
    assert.deepEqual(observed, [
      { provider: ORIGINAL_PROVIDER, model: ORIGINAL_MODEL },
    ])
    observed.length = 0

    // ── The approved retry runs, on exactly the approved pair ──────────────
    // The approved pair is supported, so this one carries on into the real
    // no-tools branch. Two different answers from one boundary, and the only
    // difference between them is the substitution.
    const response = await service.runTurn(baseRequest)
    assert.equal(response.kind, 'no-tools')
    assert.deepEqual(observed, [
      { provider: APPROVED_PROVIDER, model: APPROVED_MODEL },
    ])

    // ── And the sealed record is still exactly what launch wrote ───────────
    assert.equal(fs.readFileSync(fixture.sealedPath, 'utf8'), sealedBefore)

    // ── Negatives: each is the same request minus one fact ─────────────────
    await assert.rejects(
      service.runTurn({ ...baseRequest, model: 'fake/some-other-model' }),
      refusal,
      'a pair the user was never shown is not covered by the approval',
    )
    await assert.rejects(
      service.runTurn({ ...baseRequest, provider: 'connection:elsewhere' }),
      refusal,
      'a provider the user was never shown is not covered either',
    )
    await assert.rejects(
      service.runTurn({ ...baseRequest, workflowStepId: 'draft' }),
      refusal,
      'the approval belongs to one step',
    )
    await assert.rejects(
      service.runTurn({ ...baseRequest, agentPath: 'agents/someoneelse' }),
      refusal,
      'the approval belongs to one Agent',
    )

    // The admission is what makes this attempt the approved continuation. A
    // task readmitted for any other reason is running ordinarily again.
    const rescinded = await sessionStore.compareAndSetTaskRecord(
      fixture.sessionId,
      task.id,
      ['running'],
      {
        admission: {
          ...grantedModelChoiceAdmission,
          order: '3',
          executionKind: 'recovery',
          source: 'manual_resume',
          grantId: 'grant-2',
        },
      },
    )
    assert.equal(rescinded?.updated, true)
    await assert.rejects(
      service.runTurn(baseRequest),
      refusal,
      'without a granted model-choice admission there is no continuation to authorize',
    )
    const restored = await sessionStore.compareAndSetTaskRecord(
      fixture.sessionId,
      task.id,
      ['running'],
      { admission: grantedModelChoiceAdmission },
    )
    assert.equal(restored?.updated, true)

    // The receipt on the step must be the receipt of the admission in hand.
    // The store forbids rewriting a recorded receipt — rightly — so this varies
    // the admission instead: a different continuation, same everything else.
    const otherRequestId = await sessionStore.compareAndSetTaskRecord(
      fixture.sessionId,
      task.id,
      ['running'],
      {
        admission: {
          ...grantedModelChoiceAdmission,
          requestId: 'another-continuation-request',
        },
      },
    )
    assert.equal(otherRequestId?.updated, true)
    await assert.rejects(
      service.runTurn(baseRequest),
      refusal,
      'the step must carry the receipt of the admission being used',
    )

    // Source alone: a continuation admitted for some other reason is not the
    // one a person approved, even with everything else identical.
    const otherSource = await sessionStore.compareAndSetTaskRecord(
      fixture.sessionId,
      task.id,
      ['running'],
      { admission: { ...grantedModelChoiceAdmission, source: 'manual_resume' } },
    )
    assert.equal(otherSource?.updated, true)
    await assert.rejects(
      service.runTurn(baseRequest),
      refusal,
      'only a model-choice admission authorizes a model-choice continuation',
    )

    // A continuation has to displace an attempt. One naming none, or naming
    // the attempt it granted, is carrying nothing forward.
    for (const displaced of [undefined, CONTINUATION_ATTEMPT]) {
      const noDisplacement = await sessionStore.compareAndSetTaskRecord(
        fixture.sessionId,
        task.id,
        ['running'],
        {
          admission: {
            ...grantedModelChoiceAdmission,
            expectedExecutionAttemptId: displaced ?? null,
          },
        },
      )
      assert.equal(noDisplacement?.updated, true)
      await assert.rejects(
        service.runTurn(baseRequest),
        refusal,
        'a continuation must name the attempt it displaced',
      )
    }
    const reinstated = await sessionStore.compareAndSetTaskRecord(
      fixture.sessionId,
      task.id,
      ['running'],
      { admission: grantedModelChoiceAdmission },
    )
    assert.equal(reinstated?.updated, true)

    // Another Agent the sealed record does accept for this step. The approval
    // names one Agent, so the sealed roster alone is not permission.
    await assert.rejects(
      service.runTurn({ ...baseRequest, agentPath: OTHER_AGENT_PATH }),
      refusal,
      'a sealed Agent that is not the approved one is still not covered',
    )

    // The substitution is only ever for the pair that failed. An approval whose
    // failed pair is not the one this Agent was sealed with is not about it.
    await advance((draft) => {
      const step = draft.steps.find((entry) => entry.stepId === STEP_ID)
      if (step?.approvedModelChoice) {
        step.approvedModelChoice = {
          ...step.approvedModelChoice,
          failedChoice: { provider: ORIGINAL_PROVIDER, model: 'fake/other' },
        }
      }
    })
    await assert.rejects(
      service.runTurn(baseRequest),
      refusal,
      'the approval must be about the pair this Agent was sealed with',
    )
    await advance((draft) => {
      const step = draft.steps.find((entry) => entry.stepId === STEP_ID)
      if (step?.approvedModelChoice) {
        step.approvedModelChoice = {
          ...step.approvedModelChoice,
          failedChoice: { ...APPROVAL.failedChoice },
        }
      }
    })

    // Consent is per invocation. An approval that names another one does not
    // cover this attempt, however well the pair matches.
    await advance((draft) => {
      const step = draft.steps.find((entry) => entry.stepId === STEP_ID)
      if (step?.approvedModelChoice) {
        step.approvedModelChoice = {
          ...step.approvedModelChoice,
          logicalInvocationId: NEXT_STEP_ID,
        }
      }
    })
    await assert.rejects(
      service.runTurn(baseRequest),
      refusal,
      'the approval names the invocation it covers',
    )
    await advance((draft) => {
      const step = draft.steps.find((entry) => entry.stepId === STEP_ID)
      if (step?.approvedModelChoice) {
        step.approvedModelChoice = {
          ...step.approvedModelChoice,
          logicalInvocationId: STEP_ID,
        }
      }
    })

    // ── Moved on, while the step itself is still running ────────────────────
    // Isolates "not the attempt being made" from "the attempt is over".
    await advance((draft) => {
      draft.currentStepId = NEXT_STEP_ID
    })
    await assert.rejects(
      service.runTurn(baseRequest),
      refusal,
      'the workflow has moved on, so this is not the attempt that was approved',
    )

    // ── Then the attempt ends ──────────────────────────────────────────────
    // The record keeps the approval and the receipt as history. If those alone
    // were enough, the same still-running task could replay the substitution on
    // a later turn nobody agreed to.
    await advance((draft) => {
      draft.currentStepId = STEP_ID
    })
    await advance((draft) => {
      const step = draft.steps.find((entry) => entry.stepId === STEP_ID)
      if (!step) return
      step.status = 'completed'
      step.completedAt = '2026-09-06T12:00:09.000Z'
      step.artifact = {
        childRunId: 'child-run',
        relativePath: 'final.md',
        sha256: 'ab'.repeat(32),
        byteLength: 12,
      }
    })
    await assert.rejects(
      service.runTurn(baseRequest),
      refusal,
      'a finished step keeps its approval as history, not as a live permission',
    )
  } finally {
    await fixture.dispose()
  }
})

test('an enrolled run is authorized from its journal, not from a stale projection', {
  timeout: 30_000,
}, async () => {
  const fixture = await prepareRetryFixture({
    title: 'Model choice retry, enrolled',
    stepId: STEP_ID,
    enrolled: true,
  })
  try {
    // `workflow-state.json` is a projection. Rewrite it to say the approval was
    // never given: a reader that trusts the projection now refuses, and one
    // that rebuilds from the journal is unmoved.
    const statePath = fixture.stateStore.paths.statePath
    const projected = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      revision: number
      steps: Array<Record<string, unknown>>
    }
    const currentRevision = projected.revision
    for (const step of projected.steps) {
      delete step.approvedModelChoice
      delete step.modelChoiceContinuationAdmissionRequestId
    }
    // Behind as well as wrong: a projection that still claims the current
    // revision is indistinguishable from the truth, and the point here is that
    // the journal is what decides when they disagree.
    projected.revision = 0
    fs.writeFileSync(statePath, JSON.stringify(projected))
    assert.ok(currentRevision > 0)

    // First, without the registry: the reader sees only the stale projection,
    // and the stale projection no longer carries the approval. This is the
    // wiring's own mutation proof — remove it and the decision changes.
    await assert.rejects(
      fixture.makeService().runTurn(fixture.baseRequest),
      refusal,
      'without the journal registry the stale projection decides, and refuses',
    )
    assert.deepEqual(fixture.observed, [])

    // A caller that gave up is not a caller that was refused, and the two must
    // not arrive as the same answer.
    //
    // Cancelled *in flight*, not before the call: `JournalOpenAttempt.join`
    // deliberately ignores an already-aborted caller
    // (`workspace-execution-journal-registry.ts:310-314`), so a pre-aborted
    // signal never reaches the opener. Starting the open, then aborting, is
    // what actually exercises caller signal -> registry budget -> service.
    const cancellationSentinel = new Error('journal-open-cancelled-sentinel')
    let openerReached = (): void => undefined
    const openerStarted = new Promise<void>((resolve) => {
      openerReached = resolve
    })
    const abortedRegistry = new WorkspaceExecutionJournalRegistry({
      workspacePath: fixture.workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
      journalOpener: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(cancellationSentinel),
            { once: true },
          )
          openerReached()
        }),
    })
    try {
      const cancelled = new AbortController()
      const pending = fixture
        .makeService(abortedRegistry)
        .runTurn(fixture.baseRequest, cancelled.signal)
      await openerStarted
      cancelled.abort()
      await assert.rejects(
        pending,
        // The registry wraps an opener failure as
        // `ExecutionJournalUnavailableError` with the original as its cause, so
        // the sentinel is identified exactly through that chain — and never as
        // a refusal.
        (error: unknown) =>
          error instanceof ExecutionJournalUnavailableError &&
          error.cause === cancellationSentinel,
        'cancellation is reported as cancellation, not as a refusal',
      )
      assert.deepEqual(fixture.observed, [])
    } finally {
      await abortedRegistry.close?.()
    }

    // Then with it: the same stale projection, and the journal decides instead.
    const enrolledRegistry = new WorkspaceExecutionJournalRegistry({
      workspacePath: fixture.workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const withJournal = fixture.makeService(enrolledRegistry)
      const response = await withJournal.runTurn(fixture.baseRequest)
      assert.equal(response.kind, 'no-tools')
      assert.deepEqual(fixture.observed, [
        { provider: APPROVED_PROVIDER, model: APPROVED_MODEL },
      ])
    } finally {
      await enrolledRegistry.close?.()
    }
  } finally {
    await fixture.dispose()
  }
})

test('an approved retry runs on a step whose only requirement is optional', {
  timeout: 30_000,
}, async () => {
  // Phase 3 refused any step that declared a requirement at all, on the
  // grounds that substituting the provider would reuse another provider's
  // grants. It would not: the grants are filtered by the *requesting*
  // provider, so a substituted retry is granted what the new provider is
  // entitled to and nothing else — which here is nothing, because the sealed
  // record names no candidate for it.
  //
  // An optional capability the run can proceed without is therefore not a
  // reason to refuse a retry a person approved. Refusing it left an approved
  // decision permanently unexecutable.
  const fixture = await prepareRetryFixture({
    title: 'Model choice retry with an optional requirement',
    stepId: REQUIRING_STEP_ID,
  })
  const service = fixture.makeService()
  try {
    await service.runTurn(fixture.baseRequest)

    // The turn ran, and it ran on the pair the person approved.
    assert.deepEqual(fixture.observed, [
      { provider: APPROVED_PROVIDER, model: APPROVED_MODEL },
    ])
  } finally {
    await fixture.dispose()
  }
})

test('an approved retry reaches the MCP server the Agent itself was granted', {
  timeout: 60_000,
}, async () => {
  // Phase 5A refused this step outright, reasoning that the sealed record named
  // the *failed* pair as the only one that could reach the server. Reading the
  // preflight falsifies that: a candidate exists because the **Agent** holds an
  // enabled grant for the server (`mcp-workflow-preflight.ts:191-194`,
  // `:232-247`). The provider on a candidate records which pair was scheduled;
  // it does not gate the grant. Changing an Agent's model does not change which
  // servers that Agent may reach.
  //
  // What does have to be re-established for a substituted pair is narrower:
  // whether the new provider can drive the parent tool loop at all.
  //
  // The evidence is the server's own record of being called, with the broker's
  // grant recheck in the path — not a policy object naming a server id.
  const callsDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'approved-retry-calls-'),
  )
  const callsPath = path.join(callsDirectory, 'calls.jsonl')
  const fixture = await prepareRetryFixture({
    title: 'Approved retry over a granted MCP server',
    stepId: REQUIRED_OWNER_STEP_ID,
    world: grantedServerWorld({
      callsPath,
      stepId: REQUIRED_OWNER_STEP_ID,
      necessity: 'required',
    }),
  })
  const service = fixture.makeService()
  try {
    const response = await service.runTurn(fixture.baseRequest)

    assert.equal(response.kind, 'completed')
    assert.deepEqual(
      fixture.observed,
      [fixture.baseRequest].map((request) => ({
        provider: request.provider,
        model: request.model,
      })),
      'the turn ran on the pair the person approved',
    )
    assert.deepEqual(
      fixture.policies,
      [{
        allowedServerIds: [GRANTED_SERVER_ID],
        requiredServerGroups: [[GRANTED_SERVER_ID]],
      }],
      'the approved pair is granted what the Agent is granted, and the required capability stays required',
    )
    assert.equal(
      readJsonLines(callsPath).length,
      1,
      'the substituted attempt actually called the server the Agent was granted',
    )
  } finally {
    await fixture.dispose()
    fs.rmSync(callsDirectory, { recursive: true, force: true })
  }
})

test('a grant revoked before an approved retry stops it reaching the server', {
  timeout: 60_000,
}, async () => {
  // The grant is the Agent's, so taking it away takes it away from the retry
  // too. The approval is not a second source of permission: it decides which
  // model runs, never what that model may reach.
  const callsDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'approved-retry-revoked-'),
  )
  const callsPath = path.join(callsDirectory, 'calls.jsonl')
  const fixture = await prepareRetryFixture({
    title: 'Approved retry after the grant is revoked',
    stepId: REQUIRED_OWNER_STEP_ID,
    world: grantedServerWorld({
      callsPath,
      stepId: REQUIRED_OWNER_STEP_ID,
      necessity: 'required',
    }),
  })
  const service = fixture.makeService()
  try {
    await fixture.mcpSettings.setAgentGrant(
      AGENT_PATH,
      GRANTED_SERVER_ID,
      false,
    )

    // The seal still names the server — it is a record of launch, not of now —
    // so the turn is still authorized and still carries the required group.
    // The broker is what refuses, at call time, which is where a revocation
    // has to be honoured for it to mean anything.
    await assert.rejects(
      service.runTurn(fixture.baseRequest),
      (error: unknown) =>
        error instanceof McpWorkerTurnServiceError &&
        error.code === 'execution_failed',
    )
    assert.equal(
      readJsonLines(callsPath).length,
      0,
      'a revoked grant reaches the server no more for a retry than for anything else',
    )
  } finally {
    await fixture.dispose()
    fs.rmSync(callsDirectory, { recursive: true, force: true })
  }
})

test('an approved retry is refused when the approved provider cannot drive MCP at all', {
  timeout: 30_000,
}, async () => {
  // The case the refusal is actually for, and the only one left. This step
  // needs its server, this Agent owns that requirement, and the pair the person
  // approved has no adapter that can run the parent tool loop
  // (`mcp-provider-support.ts:72` — an unknown provider is
  // `provider_adapter_unavailable`). Compatibility cannot be established, which
  // is a narrower reason to refuse than "a requirement exists".
  const fixture = await prepareRetryFixture({
    title: 'Model choice retry onto a provider without MCP support',
    stepId: REQUIRED_OWNER_STEP_ID,
    world: async () => ({
      sealed: sealedResolution(),
      approvedPair: {
        provider: TOOL_INCAPABLE_PROVIDER,
        model: APPROVED_MODEL,
      },
    }),
  })
  const service = fixture.makeService()
  try {
    await assert.rejects(
      service.runTurn(fixture.baseRequest),
      refusal,
      'a required capability this Agent owns blocks a pair that can reach no server',
    )
    assert.deepEqual(fixture.observed, [])
  } finally {
    await fixture.dispose()
  }
})

test('a seal whose ownership disagrees with its candidates is unreadable, not substitutable', {
  timeout: 30_000,
}, async () => {
  // Why the substitution needs no guard for "owns a required capability but
  // reaches no server for it": that state cannot arrive. The seal is a file on
  // disk, so the case worth asking about is an edited one — a required match
  // this Agent is recorded as owning, whose candidates name somebody else.
  // `readSealedResolution` derives the canonical owner from the candidates and
  // refuses any record whose stored owner disagrees, so the request never
  // reaches the approved-retry policy at all.
  //
  // Recorded because a branch was written for that case and then removed. This
  // is the evidence that removing it was right rather than convenient.
  const fixture = await prepareRetryFixture({
    title: 'Approved retry against a required capability with no server',
    stepId: REQUIRED_OWNER_STEP_ID,
    world: async () => {
      const sealed = sealedResolution()
      const step = sealed.steps.find(
        (candidate) => candidate.stepId === REQUIRED_OWNER_STEP_ID,
      )
      const match = step?.matches[0]
      if (!match) throw new Error('the fixture seal lost its required match')
      return {
        sealed: {
          ...sealed,
          steps: sealed.steps.map((candidate) =>
            candidate.stepId === REQUIRED_OWNER_STEP_ID
              ? {
                  ...candidate,
                  matches: [{
                    ...match,
                    candidates: match.candidates.map((entry) => ({
                      ...entry,
                      agentPath: OTHER_AGENT_PATH,
                    })),
                  }],
                }
              : candidate,
          ),
        },
        approvedPair: { provider: APPROVED_PROVIDER, model: APPROVED_MODEL },
      }
    },
  })
  const service = fixture.makeService()
  try {
    await assert.rejects(
      service.runTurn(fixture.baseRequest),
      (error: unknown) =>
        error instanceof McpWorkerTurnServiceError &&
        error.code === 'resolution_invalid',
      'an edited seal is refused as unreadable before any substitution is considered',
    )
    assert.deepEqual(fixture.observed, [])
    assert.deepEqual(fixture.policies, [])
  } finally {
    await fixture.dispose()
  }
})

test('a provider without MCP support still runs a retry whose only requirement is optional', {
  timeout: 30_000,
}, async () => {
  // The refusal is scoped to what the run actually depends on. Nothing here is
  // required, so a pair that can reach no server runs anyway with none — which
  // is what it was entitled to before the substitution too.
  const fixture = await prepareRetryFixture({
    title: 'Optional requirement onto a provider without MCP support',
    stepId: REQUIRING_STEP_ID,
    world: async () => ({
      sealed: sealedResolution(),
      approvedPair: {
        provider: TOOL_INCAPABLE_PROVIDER,
        model: APPROVED_MODEL,
      },
    }),
  })
  const service = fixture.makeService()
  try {
    await service.runTurn(fixture.baseRequest)

    assert.deepEqual(fixture.policies, [
      { allowedServerIds: [], requiredServerGroups: [] },
    ])
  } finally {
    await fixture.dispose()
  }
})


test('an Agent’s settings cross the real worker route, and the answer comes back to its caller', {
  timeout: 60_000,
}, async () => {
  // The whole journey, with nothing internal substituted: `runAgent` serializes
  // the Agent's settings, the production Zod route validates them, the parent
  // authorizes the turn from durable state, the real agent-tool service picks a
  // lane and runs it against a really granted MCP server and a real loopback
  // provider, and the lane's account of what it did not apply comes back to the
  // caller that owns the durable record.
  //
  // Each half of that has failed on its own during this work: the child sent a
  // field the real route refused with 400, and the caller discarded the answer
  // the route returned. One journey holds both.
  //
  // The approved pair is a configured connection, so the lane is the native
  // tool loop — whose request body carries no settings at all. Every setting
  // the child sent is therefore one that did not apply.
  const callsDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'worker-options-'),
  )
  const callsPath = path.join(callsDirectory, 'calls.jsonl')
  const fixture = await prepareRetryFixture({
    title: 'Worker option transport',
    stepId: REQUIRED_OWNER_STEP_ID,
    world: grantedServerWorld({
      callsPath,
      stepId: REQUIRED_OWNER_STEP_ID,
      necessity: 'required',
    }),
  })
  const service = fixture.makeService()
  const server = http.createServer((req, res) => {
    void handleMcpWorkerTurnRoute({ req, res, service })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const outputPath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'worker-options-run-')),
  )
  try {
    const result = await runAgent({
      agentName: AGENT_NAME,
      provider: fixture.baseRequest.provider,
      model: fixture.baseRequest.model,
      thinking: fixture.baseRequest.thinking,
      systemPrompt: fixture.baseRequest.systemPrompt,
      userMessage: fixture.baseRequest.userMessage,
      timeoutMinutes: 2,
      sessionId: fixture.sessionId,
      outputPath,
      providerConfig: { max_tokens: 4_096, temperature: 0.2 },
      workerEnvironment: {
        [MCP_WORKER_TURN_URL_ENV]:
          `http://127.0.0.1:${address.port}/private-worker`,
        [MCP_WORKER_WORKFLOW_STEP_ID_ENV]: REQUIRED_OWNER_STEP_ID,
        [RUNTIME_SESSION_ID_ENV]: fixture.baseRequest.sessionId,
        [RUNTIME_RUN_ID_ENV]: fixture.baseRequest.runId,
        [RUNTIME_ASSIGNMENT_ID_ENV]: fixture.baseRequest.assignmentId,
        TEAM_RUNTIME_TASK_ID: fixture.baseRequest.taskId,
        TEAM_RUNTIME_PROCESS_IDENTITY: fixture.baseRequest.processIdentity,
        TEAM_RUNTIME_WORKFLOW_ID: fixture.baseRequest.workflowId,
      },
    })

    assert.deepEqual(
      result.droppedProviderOptions,
      ['max_tokens', 'temperature'],
      "the lane's answer reaches the caller that keeps the durable record",
    )
    assert.equal(
      readJsonLines(callsPath).length,
      1,
      'and the turn really ran, through the server the Agent was granted',
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fixture.dispose()
    fs.rmSync(callsDirectory, { recursive: true, force: true })
    fs.rmSync(outputPath, { recursive: true, force: true })
  }
})
