/**
 * Branch 1, Package 1a — the production public-boundary acceptance test.
 *
 * Boots the actual default Team Runtime extension against the shipped
 * reception-desk config with a fake Pi host (the harness established by
 * tests/integration/team-runtime-receptionist-tools.test.ts), runs
 * session_start, and invokes the deterministic registered governed tool
 * `inspect-task-state` through the real runtime. That invocation travels the
 * production path: registerLevelTools → ensureCapabilityDispatcher → the
 * capability dispatch factory → governed dispatch. The test then inspects the
 * assignment with readExecutionJournal.
 *
 * This is the coverage the factory-level barriers test cannot provide on its
 * own: it observes the real construction site, not a dispatcher built
 * directly against the factory. The factory-level test remains the inner
 * seam test and asserts the evidence view's consistency there.
 *
 * One coherent outcome: a governed tool invocation through the real runtime
 * lands on the assignment's durable journal authority.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { readExecutionJournal } from '../../core/execution-journal.js'
import { reconcileWorkspaceTenantPin } from '../../services/execution-journal-tenant-pin.js'
import { agentCliSkipReason } from '../support/agent-cli-availability.js'

const repoRoot = process.cwd()

const SESSION_ID = 'session-journal-boundary'
const RUN_ID = 'run-journal-boundary'
const ASSIGNMENT_ID = 'assignment-journal-boundary'
const TASK_ID = 'task-journal-boundary'
const PROCESS_IDENTITY = 'process-journal-boundary'
// lm-studio readiness is credential-free and applyHostModelPreference selects
// it without registering or calling a provider, so the harness stays
// credential-independent.
const HOST_MODEL_ID = 'lm-studio-host-fixture'
const INVOCATION_DEADLINE_MS = 20_000

interface RegisteredTool {
  readonly name: string
  execute(
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    extensionContext: unknown,
  ): Promise<unknown>
}

test('a governed tool invoked through the real Team Runtime is journaled on the assignment', {
  timeout: 60_000,
  // The harness boots the shipped reception desk, whose receptionist declares
  // the codex provider. Provider preflight refuses the Team when that CLI is
  // absent, so no tool registers and the journal assertion never gets a
  // dispatch to observe.
  skip: agentCliSkipReason('codex'),
}, async () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'team-runtime-journal-boundary-'),
  )
  const previousEnv = { ...process.env }
  // Deterministic acceptance scope: authoritative mode under the local
  // tenant, pinned before the runtime boots.
  await reconcileWorkspaceTenantPin({
    workspacePath: workspace,
    tenantId: 'local',
    mode: 'authoritative',
  })

  process.env.TEAM_CONFIG_PATH = path.join(repoRoot, 'teams/reception-desk/team.yaml')
  process.env.TEAM_WORKSPACE_PATH = workspace
  process.env.TEAM_RUNTIME_WORKSPACE_PATH = workspace
  // Dev services start by default during session_start and would bind ports.
  process.env.TEAM_RUNTIME_START_SERVICES = '0'
  process.env.TEAM_RUNTIME_SESSION_ID = SESSION_ID
  process.env.TEAM_RUNTIME_RUN_ID = RUN_ID
  process.env.TEAM_RUNTIME_ASSIGNMENT_ID = ASSIGNMENT_ID
  process.env.TEAM_RUNTIME_TASK_ID = TASK_ID
  process.env.TEAM_RUNTIME_PROCESS_IDENTITY = PROCESS_IDENTITY
  // The compiled test runs from .tests-dist, so the parser entry cannot be
  // discovered relative to this module. Point it at the real source entry.
  process.env.TEAM_RUNTIME_FILE_PARSER_ENTRY = path.join(repoRoot, 'file-parser/index.ts')
  process.env.PIPELINE_DURABLE_JOURNAL = 'authoritative'
  process.env.TEAM_TENANT_ID = 'local'
  process.env.PIPELINE_DEFAULT_MODEL_SELECTION = Buffer.from(
    JSON.stringify({ provider: 'lm-studio', model: HOST_MODEL_ID }),
    'utf8',
  ).toString('base64')

  let runSessionShutdown: (() => Promise<void>) | undefined
  try {
    const { default: teamRuntimeExtension } = await import(
      '../../team-runtime/index.js'
    )

    const handlers = new Map<string, (...args: never[]) => unknown>()
    const registered: RegisteredTool[] = []
    const hostModel = {
      id: HOST_MODEL_ID,
      name: 'LM Studio Host Fixture',
      provider: 'lm-studio',
      api: 'openai-completions',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    }
    // The shipped receptionist declares codex/gpt-5.4-mini in its own agent
    // file, and that is now what decides the host: no team roster entry
    // redirects it to the application default any more. A host that cannot
    // serve the shipped agent blocks session start before any tool registers.
    const shippedCoordinatorHostModel = {
      ...hostModel,
      id: 'gpt-5.4-mini',
      name: 'GPT-5.4 mini',
      provider: 'openai-codex',
      api: 'openai-codex-responses',
    }
    let registryModels: unknown[] = [hostModel, shippedCoordinatorHostModel]

    const pi = {
      on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
      registerTool: (tool: RegisteredTool) => registered.push(tool),
      registerCommand: () => {},
      registerShortcut: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
      registerMessageRenderer: () => {},
      registerEntryRenderer: () => {},
      registerMarkdownTransformer: () => {},
      sendMessage: () => {},
      sendUserMessage: () => {},
      appendEntry: () => {},
      setSessionName: () => {},
      getSessionName: () => undefined,
      setLabel: () => {},
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
      getActiveTools: () => registered.map((tool) => tool.name),
      getAllTools: () => registered.map((tool) => ({
        ...tool,
        sourceInfo: { path: path.join(repoRoot, 'team-runtime/index.ts') },
      })),
      setActiveTools: () => {},
      getCommands: () => [],
      setModel: async () => true,
      getThinkingLevel: () => 'medium',
      setThinkingLevel: () => {},
      registerProvider: (name: string, config: { models?: unknown[] }) => {
        if (typeof name === 'string' && config?.models) {
          registryModels = [
            ...registryModels,
            ...config.models.map((model) => ({ ...(model as object), provider: name })),
          ]
        }
      },
      unregisterProvider: () => {},
      events: { on: () => {}, off: () => {}, emit: () => {} },
    }

    const extensionContext = {
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
      mode: 'headless',
      hasUI: false,
      cwd: repoRoot,
      sessionManager: {
        getEntries: () => [],
        getSessionId: () => 'pi-session',
        getSessionFile: () => undefined,
      },
      modelRegistry: {
        getAvailable: () => registryModels,
        getAll: () => registryModels,
      },
      model: undefined,
      scopedModels: [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      signal: undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => '',
    }

    teamRuntimeExtension(pi as never)
    const shutdownHandler = handlers.get('session_shutdown')
    if (shutdownHandler) {
      runSessionShutdown = () => (shutdownHandler as () => Promise<void>)()
    }
    const sessionStart = handlers.get('session_start')
    assert.ok(sessionStart, 'the extension must register a session_start handler')
    await (sessionStart as (event: unknown, context: unknown) => Promise<void>)(
      {},
      extensionContext,
    )

    const inspectTaskState = registered.find((tool) => tool.name === 'inspect-task-state')
    assert.ok(
      inspectTaskState,
      `inspect-task-state must be registered; got ${registered
        .map((tool) => tool.name)
        .join(', ')}`,
    )

    // Invoke the deterministic governed tool through the real dispatch path.
    // A governed tool throws unless its dispatch completes, so a returned
    // value means the dispatch ran to a completed terminal.
    const invocation: unknown = await inspectTaskState.execute(
      'call-inspect-task-state-public',
      { taskId: 'task-inspect-public' },
      AbortSignal.timeout(INVOCATION_DEADLINE_MS),
      undefined,
      extensionContext,
    )
    assert.ok(
      typeof invocation === 'object' && invocation !== null,
      'the governed invocation must complete and return a result',
    )

    // The acceptance contract: the dispatch reached the assignment's durable
    // journal authority.
    const assignmentPath = path.join(
      workspace, 'sessions', SESSION_ID,
      'runs', RUN_ID, 'assignments', ASSIGNMENT_ID,
    )
    const journal = await readExecutionJournal(assignmentPath)
    assert.equal(
      journal.kind,
      'ok',
      'a governed Team Runtime invocation must be under the assignment ' +
        `durable journal authority, but the journal read returned '${journal.kind}'` +
        (journal.kind === 'corrupt' ? ` (${journal.reason})` : '') +
        ' — the dispatcher construction path provides no durable port',
    )
    if (journal.kind !== 'ok') return

    const dispatchTypes = journal.events
      .filter((event) => event.streamKind === 'capability.dispatch')
      .map((event) => event.type)
    for (const barrier of [
      'capability.dispatch.prepared',
      'capability.dispatch.started',
      'capability.dispatch.accepted',
    ]) {
      assert.ok(
        dispatchTypes.includes(barrier),
        `the assignment journal must carry ${barrier} for the invocation; ` +
          `recorded dispatch events: ${JSON.stringify(dispatchTypes)}`,
      )
    }

  } finally {
    // Runs even when the journal assertion throws, so runtime resources are
    // released on the failure path too. Awaited without a catch so a
    // shutdown failure stays visible instead of being swallowed.
    if (runSessionShutdown) {
      await runSessionShutdown()
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key]
    }
    Object.assign(process.env, previousEnv)
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
