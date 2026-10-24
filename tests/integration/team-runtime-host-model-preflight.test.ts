/**
 * An invalid host configuration must stop before the host speaks.
 *
 * A coordinator named in the roster whose persona file is absent is invalid
 * input. Today it is dropped silently at load, preflight never sees it because
 * preflight only inspects Agents that loaded, and the host resolves to the
 * application default or to nothing — so the run continues on a model nobody
 * chose.
 *
 * Entering config-error mode is not enough on its own. `before_agent_start`
 * cannot cancel a turn — its result type carries only `message` and
 * `systemPrompt` — so returning a config-error prompt still lets Pi call its
 * boot model to have an LLM narrate the failure. The only hook that can stop
 * the loop is `input`, whose result admits `{ action: 'handled' }`. So these
 * tests drive the real `input` interceptor and prove the turn is handled
 * before any provider request, while the durable `runtime.config_error` record
 * and the UI notification still reach the user without an LLM.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

const repoRoot = process.cwd()

/**
 * Stands in for whatever a provider error might carry.
 *
 * A host error is external text: it can quote a request, a header, or a
 * credential. Nothing this repo writes down or shows may contain it, so the
 * fixture makes that concrete with a value no safe message could ever need —
 * named for what it is rather than shaped like a token, because a fixture that
 * looks like a credential is one too.
 */
const SENSITIVE_PROVIDER_DETAIL_DO_NOT_COPY =
  'SENSITIVE_PROVIDER_DETAIL_DO_NOT_COPY'

interface HostHarness {
  readonly runExtension: () => Promise<void>
  readonly sendInput: () => Promise<unknown>
  readonly setModelCalls: number
  readonly providerRequests: number
  readonly notifications: Array<{ message: string; level: string }>
  /** Set when startup threw instead of failing closed. */
  readonly startupRejection: unknown
  readonly assignmentPath: string
  readonly dispose: () => void
}

function writeAgent(filePath: string, name: string): void {
  fs.writeFileSync(
    filePath,
    `---
name: ${name}
description: ${name} persona.
provider: anthropic
model: claude-haiku-4-5
thinking: low
---

You are ${name}.
`,
  )
}

/**
 * A Team with a valid entry coordinator and a later one that cannot be loaded.
 *
 * `unloadable: 'later'` is the shape that matters: the run starts on a level
 * whose coordinator is fine, so a check that only inspects the *current* level
 * passes and the host still boots. The declaration is invalid from the moment
 * the config is read, and `teamConfig.levels` names every coordinator, so
 * startup can see it without running anything.
 *
 * `unloadable: 'entry'` is the easier case, kept so the two are distinguishable.
 */
function writeTeam(
  teamRoot: string,
  options: { readonly unloadable: 'entry' | 'later' | 'none' },
): void {
  fs.mkdirSync(path.join(teamRoot, 'agents'), { recursive: true })
  writeAgent(path.join(teamRoot, 'agents', 'specialist.md'), 'specialist')
  // Only the persona whose level is meant to be valid is written to disk. The
  // roster still declares both, so parsing succeeds either way. `none` writes
  // both, so the run is valid and reaches host model selection.
  if (options.unloadable !== 'entry') {
    writeAgent(path.join(teamRoot, 'agents', 'lead.md'), 'lead')
  }
  if (options.unloadable !== 'later') {
    writeAgent(path.join(teamRoot, 'agents', 'auditor.md'), 'auditor')
  }
  fs.writeFileSync(
    path.join(teamRoot, 'team.yaml'),
    `team:
  name: missing-coordinator-team
  description: A declared coordinator persona is absent.

workspace:
  path: workspace
  watch: false

agents:
  - name: lead
    type: agent
    role: Coordinates the discussion.
    tier: orchestration
    tools: []
    agent_file: ./agents/lead.md
  - name: auditor
    type: agent
    role: Coordinates the review.
    tier: orchestration
    tools: []
    agent_file: ./agents/auditor.md
  - name: specialist
    type: agent
    role: Reviews the material.
    tier: strategic
    tools: []
    agent_file: ./agents/specialist.md

levels:
  - id: discuss
    name: Discuss
    order: 0
    stage:
      type: discussion
      coordinator: lead
      participants:
        - specialist
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        output:
          format: result.md
          user_review: false
  - id: review
    name: Review
    order: 1
    stage:
      type: discussion
      coordinator: auditor
      participants:
        - specialist
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        output:
          format: reviewed.md
          user_review: false

gates: []

workflow:
  entry_level: discuss
  input_contract:
    artifacts:
      - path: incoming-brief.md
        required: true
`,
  )
}

async function startHostHarness(options: {
  readonly unloadable: 'entry' | 'later' | 'none'
  /** What the host's `setModel` does. Pi returns false for an unconfigured
   *  provider and rejects when the deeper credential check fails. */
  readonly setModel?: 'ok' | 'false' | 'reject'
}): Promise<HostHarness> {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-model-preflight-'))
  const teamRoot = path.join(fixtureRoot, 'team')
  const workspace = path.join(fixtureRoot, 'workspace')
  writeTeam(teamRoot, options)

  const assignmentPath = path.join(
    workspace,
    'sessions',
    'session-host-preflight',
    'runs',
    'run-host-preflight',
    'assignments',
    'assignment-host-preflight',
  )
  fs.mkdirSync(assignmentPath, { recursive: true })
  fs.writeFileSync(path.join(assignmentPath, 'incoming-brief.md'), 'Review this.')

  const previousEnv = { ...process.env }
  process.env.TEAM_CONFIG_PATH = path.join(teamRoot, 'team.yaml')
  process.env.TEAM_WORKSPACE_PATH = workspace
  process.env.TEAM_RUNTIME_START_SERVICES = '0'
  process.env.TEAM_RUNTIME_SESSION_ID = 'session-host-preflight'
  process.env.TEAM_RUNTIME_RUN_ID = 'run-host-preflight'
  process.env.TEAM_RUNTIME_ASSIGNMENT_ID = 'assignment-host-preflight'
  process.env.TEAM_RUNTIME_TASK_ID = 'task-host-preflight'
  process.env.TEAM_RUNTIME_PROCESS_IDENTITY = 'process-host-preflight'
  process.env.TEAM_SESSION_ID = 'assignment-host-preflight'
  process.env.TEAM_ROOT_SESSION_ID = 'session-host-preflight'
  process.env.TEAM_INPUT_ARTIFACT = 'incoming-brief.md'
  process.env.TEAM_OUTPUT_ARTIFACT = 'unused-result.md'
  process.env.TEAM_RUNTIME_FILE_PARSER_ENTRY = path.join(repoRoot, 'file-parser/index.ts')
  // Presence-only: `team-runtime/index.ts:3878` registers the host Anthropic
  // provider on existence alone. Without it the run fails for a missing key
  // instead of the missing persona this test is about.
  process.env.ANTHROPIC_API_KEY = 'test-key'
  delete process.env.TEAM_DELEGATED_AUTOSTART
  delete process.env.TEAM_CHAT_MODE

  // The pair the team declares is genuinely on offer, so selection succeeds and
  // the run reaches the switch itself.
  const availableModels = [{ provider: 'anthropic-api', id: 'claude-haiku-4-5' }]
  const { default: teamRuntimeExtension } = await import('../../team-runtime/index.js')
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const notifications: Array<{ message: string; level: string }> = []
  const harness: {
    setModelCalls: number
    providerRequests: number
    startupRejection: unknown
  } = { setModelCalls: 0, providerRequests: 0, startupRejection: undefined }

  const pi = {
    on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
    registerTool: () => {},
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
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: async () => {
      harness.setModelCalls += 1
      if (options.setModel === 'reject') {
        // Pi's own shape: `AgentSession.setModel` throws this when the deeper
        // credential check fails, and the extension surface propagates it.
        throw new Error(
          `No API key for anthropic-api/claude-haiku-4-5 (${SENSITIVE_PROVIDER_DETAIL_DO_NOT_COPY})`,
        )
      }
      return options.setModel !== 'false'
    },
    getThinkingLevel: () => 'medium',
    setThinkingLevel: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    events: { on: () => {}, off: () => {}, emit: () => {} },
  }

  const extensionContext = {
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level })
      },
      setStatus: () => {},
      setWidget: () => {},
    },
    mode: 'headless',
    hasUI: false,
    cwd: repoRoot,
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => 'pi-session',
      getSessionFile: () => undefined,
    },
    // The pair the team declares is genuinely available, so host selection
    // succeeds. An empty registry would block session start on its own
    // ('not found in Pi's host model registry') and mask the missing persona.
    modelRegistry: {
      getAvailable: () => availableModels,
      getAll: () => availableModels,
    },
    model: { provider: 'anthropic-api', id: 'boot-model' },
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

  return {
    assignmentPath,
    notifications,
    get setModelCalls() {
      return harness.setModelCalls
    },
    get providerRequests() {
      return harness.providerRequests
    },
    get startupRejection() {
      return harness.startupRejection
    },
    runExtension: async () => {
      const sessionStart = handlers.get('session_start')
      assert.ok(sessionStart, 'the extension must register session_start')
      try {
        await (sessionStart as (event: unknown, context: unknown) => Promise<void>)(
          {},
          extensionContext,
        )
      } catch (error) {
        harness.startupRejection = error
      }
    },
    /**
     * The installed Pi control flow, not just our one hook.
     *
     * `input` returning `handled` consumes the prompt and the agent loop never
     * starts (`InputEventResult`, `extensions/types.d.ts:639-647`). Anything
     * else proceeds: Pi assembles the system prompt through
     * `before_agent_start` — which cannot cancel, its result carrying only
     * `message` and `systemPrompt` (`:805-809`) — and then crosses the provider
     * boundary. Counting that boundary here is what makes "no host request" a
     * claim about behaviour rather than about a handler we chose not to call.
     */
    sendInput: async () => {
      const input = handlers.get('input')
      assert.ok(input, 'the extension must register an input interceptor')
      const result = (await (input as (event: unknown, context: unknown) => unknown)(
        { type: 'input', text: 'Please start.', source: 'interactive' },
        extensionContext,
      )) as { action?: string } | undefined

      if (result?.action === 'handled') return result

      const beforeAgentStart = handlers.get('before_agent_start')
      if (beforeAgentStart) {
        await (beforeAgentStart as (event: unknown, context: unknown) => unknown)(
          {
            type: 'before_agent_start',
            prompt: 'Please start.',
            systemPrompt: '',
            systemPromptOptions: {},
          },
          extensionContext,
        )
      }

      harness.providerRequests += 1
      const beforeProviderRequest = handlers.get('before_provider_request')
      if (beforeProviderRequest) {
        await (beforeProviderRequest as (event: unknown, context: unknown) => unknown)(
          { type: 'before_provider_request', payload: {} },
          extensionContext,
        )
      }
      return result
    },
    dispose: () => {
      for (const key of Object.keys(process.env)) {
        if (!(key in previousEnv)) delete process.env[key]
      }
      Object.assign(process.env, previousEnv)
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    },
  }
}

/** Every byte this run wrote to its logs, for a leak check that misses nothing. */
function allLoggedText(assignmentPath: string): string {
  const logsDir = path.join(assignmentPath, 'logs')
  if (!fs.existsSync(logsDir)) return ''
  return fs
    .readdirSync(logsDir)
    .map((name) => fs.readFileSync(path.join(logsDir, name), 'utf8'))
    .join('\n')
}

function runtimeEvents(assignmentPath: string, fileName: string): Array<Record<string, unknown>> {
  const logPath = path.join(assignmentPath, 'logs', fileName)
  if (!fs.existsSync(logPath)) return []
  return fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test('a later level whose declared coordinator cannot be loaded stops the turn before any host request', {
  timeout: 30_000,
}, async () => {
  // The entry level's coordinator loads fine, so nothing about the *current*
  // level is wrong. The invalid declaration belongs to a level the run has not
  // reached, and it is still invalid input now.
  const harness = await startHostHarness({ unloadable: 'later' })
  try {
    await harness.runExtension()

    // The turn itself must not reach the agent loop. `before_agent_start`
    // cannot cancel one, so a config-error system prompt would still spend a
    // host request narrating the failure.
    const result = await harness.sendInput()

    // Asserted first, because this is the requirement: an invalid declaration
    // must not cost a host request. Today the flow reaches the provider
    // boundary, so this reports 1.
    assert.equal(
      harness.providerRequests,
      0,
      'no provider request may be made for an invalid run',
    )
    assert.equal(harness.setModelCalls, 0, 'no host model may be selected for an invalid run')
    assert.deepEqual(
      result,
      { action: 'handled' },
      'an invalid host configuration must consume the input rather than run a turn',
    )
  } finally {
    harness.dispose()
  }
})

test('the entry level’s own unloadable coordinator stops the turn too', {
  timeout: 30_000,
}, async () => {
  const harness = await startHostHarness({ unloadable: 'entry' })
  try {
    await harness.runExtension()
    const result = await harness.sendInput()
    assert.equal(harness.providerRequests, 0)
    assert.equal(harness.setModelCalls, 0)
    assert.deepEqual(result, { action: 'handled' })
  } finally {
    harness.dispose()
  }
})

test('the user is told why, without an LLM being asked to explain it', {
  timeout: 30_000,
}, async () => {
  const harness = await startHostHarness({ unloadable: 'later' })
  try {
    await harness.runExtension()
    await harness.sendInput()

    const configErrors = runtimeEvents(harness.assignmentPath, 'runtime-events.jsonl').filter(
      (event) => event.event === 'runtime.config_error',
    )
    assert.equal(configErrors.length, 1, 'the failure must be recorded durably')
    assert.match(
      JSON.stringify(configErrors[0]?.errors ?? []),
      /auditor/,
      'the record must name the coordinator that could not be loaded',
    )

    const errorNotices = harness.notifications.filter((notice) => notice.level === 'error')
    assert.equal(errorNotices.length, 1, 'the user must be notified once')
    assert.equal(harness.providerRequests, 0, 'the explanation must not cost a host request')
  } finally {
    harness.dispose()
  }
})

test('a host model the provider will not accept blocks the turn', {
  timeout: 30_000,
}, async () => {
  // Pi returns false when the provider is not in its configured set
  // (`agent-session.js:1885-1890`), and returns it *before* switching — so the
  // host silently stays on its previous model. Ignoring that boolean is a run
  // on a pair nobody chose.
  const harness = await startHostHarness({ unloadable: 'none', setModel: 'false' })
  try {
    await harness.runExtension()
    const result = await harness.sendInput()

    assert.equal(harness.providerRequests, 0, 'a refused host model may not reach the provider')
    assert.deepEqual(result, { action: 'handled' })

    const recorded = runtimeEvents(harness.assignmentPath, 'runtime-events.jsonl')
    assert.deepEqual(
      recorded.filter((event) => event.event === 'runtime.host_start_failed'),
      [],
      'a refused model switch is an expected outcome, not an unexpected crash',
    )
    const configErrors = recorded.filter(
      (event) => event.event === 'runtime.config_error',
    )
    assert.equal(configErrors.length, 1, 'the refusal must be recorded durably')
    const errorText = JSON.stringify(configErrors[0]?.errors ?? [])
    assert.match(errorText, /claude-haiku-4-5/, 'the record must name the refused model')
    assert.match(errorText, /anthropic/, 'the record must name the refused provider')
    assert.equal(
      harness.notifications.filter((notice) => notice.level === 'error').length,
      1,
    )
  } finally {
    harness.dispose()
  }
})

test('a host model switch that throws blocks the turn without an unhandled rejection', {
  timeout: 30_000,
}, async () => {
  // The same call can reject rather than return false: `hasConfiguredAuth` is a
  // synchronous set lookup, and when it passes but the deeper async `checkAuth`
  // fails, `AgentSession.setModel` throws (`agent-session.js:1197-1200`). Both
  // refusals mean the same thing — the host is still on its old pair — so both
  // must block the turn.
  const harness = await startHostHarness({ unloadable: 'none', setModel: 'reject' })
  try {
    await harness.runExtension()
    assert.equal(
      harness.startupRejection,
      undefined,
      'startup must handle the failure rather than reject',
    )

    const result = await harness.sendInput()
    assert.equal(harness.providerRequests, 0)
    assert.deepEqual(result, { action: 'handled' })

    const recorded = runtimeEvents(harness.assignmentPath, 'runtime-events.jsonl')

    // A refused model switch is an expected outcome with a known cause, not an
    // unexpected crash. If it reached the top-level `session_start` catch
    // (`team-runtime/index.ts:3170-3181`) it would be recorded as a stack trace
    // under `runtime.host_start_failed`, telling a reader that something broke
    // but not that a pair was refused.
    assert.deepEqual(
      recorded.filter((event) => event.event === 'runtime.host_start_failed'),
      [],
      'a refused model switch must not be reported as an unexpected startup crash',
    )

    const configErrors = recorded.filter(
      (event) => event.event === 'runtime.config_error',
    )
    assert.equal(configErrors.length, 1, 'the refusal must be recorded durably')
    const errorText = JSON.stringify(configErrors[0]?.errors ?? [])
    assert.match(errorText, /claude-haiku-4-5/, 'the record must name the refused model')
    assert.match(errorText, /anthropic/, 'the record must name the refused provider')
    assert.equal(
      harness.notifications.filter((notice) => notice.level === 'error').length,
      1,
      'the user must be told once',
    )

    // The host's own words are external text. Nothing durable and nothing on
    // screen may repeat them.
    assert.doesNotMatch(
      allLoggedText(harness.assignmentPath),
      new RegExp(SENSITIVE_PROVIDER_DETAIL_DO_NOT_COPY),
      'a provider error must not be written into any log',
    )
    assert.doesNotMatch(
      harness.notifications.map((notice) => notice.message).join('\n'),
      new RegExp(SENSITIVE_PROVIDER_DETAIL_DO_NOT_COPY),
      'a provider error must not be shown to the user',
    )
  } finally {
    harness.dispose()
  }
})

test('the blocked record and the config error say which of the two host refusals happened', {
  timeout: 60_000,
}, async (t) => {
  // `false` is Pi turning the pair down; a rejection is Pi failing while it
  // tried. Each gets its own fixed reason, and neither copies the host's text.
  const cases = [
    { setModel: 'false', reason: 'host_refused_model' },
    { setModel: 'reject', reason: 'host_model_switch_failed' },
  ] as const
  for (const { setModel, reason } of cases) {
    await t.test(`setModel ${setModel === 'false' ? 'returns false' : 'rejects'}`, async () => {
      const harness = await startHostHarness({ unloadable: 'none', setModel })
      try {
        await harness.runExtension()

        const blocked = runtimeEvents(harness.assignmentPath, 'host-events.jsonl').filter(
          (event) => event.event === 'host.model_selection.blocked',
        )
        assert.equal(blocked.length, 1, 'one blocked record')
        const { timestamp: _timestamp, ...record } = blocked[0] ?? {}
        assert.deepEqual(record, {
          event: 'host.model_selection.blocked',
          session_id: 'assignment-host-preflight',
          root_session_id: 'session-host-preflight',
          assignment_path: harness.assignmentPath,
          desired_provider: 'anthropic',
          desired_model: 'claude-haiku-4-5',
          current_provider: 'anthropic-api',
          current_model: 'boot-model',
          selected_provider: 'anthropic-api',
          selected_model: 'claude-haiku-4-5',
          reason,
        })

        const configErrors = runtimeEvents(harness.assignmentPath, 'runtime-events.jsonl')
          .filter((event) => event.event === 'runtime.config_error')
          .map((event) => event.errors)
        assert.deepEqual(configErrors, [
          [
            `Host model 'claude-haiku-4-5' on provider 'anthropic-api' was refused by the host (${reason}). ` +
              'Team execution is blocked.',
          ],
        ])
      } finally {
        harness.dispose()
      }
    })
  }
})
