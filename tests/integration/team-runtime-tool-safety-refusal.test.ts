/**
 * The runtime's third refusal gate, and the record a reader is owed from it.
 *
 * Two gates already write a refusal a person can read: the capability policy
 * (`team-runtime/capability-tool-policy.ts`) and the bypass detector
 * (`team-runtime/capability-bypass-detector.ts`). Both write
 * `tool.execution_failed` with a flag saying the call was blocked and a
 * `policy_code` that selects the sentence the timeline shows
 * (`contracts/capability-policy-denial.ts`).
 *
 * The governed Pi tools have a gate of their own, and it is the one a person is
 * most likely to hit: a destructive shell command, or a path outside the folder
 * the run owns (`team-runtime/governed-pi-tools.ts`). It refuses inside the tool
 * adapter, and the dispatcher resolves the adapter's denial ahead of the policy
 * (`core/capability-policy.ts:25` returns the first deny of
 * `[adapter, prepared, policy]`), so the capability policy allows the same call
 * and its `onDenied` never fires. Without a record of its own the refusal
 * reached the timeline through the failure arm — "lead failed using tool bash",
 * red, with the reason discarded.
 *
 * Driven through the real extension against Pi's own registration surface: the
 * team grants the coordinator the governed tools, the runtime registers them,
 * and the test calls the registration Pi would call. Nothing about the refusal
 * is stubbed — the denial, the dispatch, and the durable record are all the
 * production path.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

const repoRoot = process.cwd()

const PROVIDER = 'lm-studio'
const MODEL = 'loopback-model'
const COORDINATOR = 'lead'

interface RegisteredTool {
  readonly name: string
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    extensionContext: unknown,
  ): Promise<unknown>
}

interface SafetyRefusalHarness {
  readonly runStartup: () => Promise<void>
  readonly invokeRegisteredTool: (
    name: string,
    toolCallId: string,
    params: unknown,
  ) => Promise<unknown>
  readonly readToolUseLog: () => Array<Record<string, unknown>>
  /** The folder the run owns, and the only one a governed tool may touch. */
  readonly assignmentPath: string
  /**
   * Where `../../<name>` from inside the run folder lands.
   *
   * The gate resolves the requested path against the assignment folder and
   * refuses anything that leaves it (`team-runtime/governed-pi-tools.ts:262`),
   * so the escape a test drives and the place it checks afterwards have to be
   * the same one.
   */
  readonly pathOutsideRunFolder: (name: string) => string
  readonly dispose: () => Promise<void>
}

function writeTeam(teamRoot: string, coordinatorTools: readonly string[]): void {
  fs.mkdirSync(path.join(teamRoot, 'agents'), { recursive: true })
  fs.writeFileSync(
    path.join(teamRoot, 'agents', 'lead.md'),
    `---
name: ${COORDINATOR}
description: lead persona.
provider: ${PROVIDER}
model: ${MODEL}
thinking: low
---

You are ${COORDINATOR}.
`,
  )
  const toolLines = coordinatorTools.map((name) => `      - ${name}`).join('\n')
  fs.writeFileSync(
    path.join(teamRoot, 'team.yaml'),
    `team:
  name: tool-safety-team
  description: One routing level whose coordinator was granted governed tools.

workspace:
  path: workspace
  watch: false

agents:
  - name: ${COORDINATOR}
    type: agent
    role: Coordinates the draft.
    tools:
${toolLines}
    produces:
      - path: handoff-ready.md
    agent_file: ./agents/lead.md

levels:
  - id: draft
    name: Draft
    order: 0
    stage:
      type: routing
      coordinator: ${COORDINATOR}
      config:
        output:
          format: handoff-ready.md
          user_review: false

gates:
  - from: draft
    to: done
    condition:
      type: artifact_exists
      artifact: handoff-ready.md

workflow:
  entry_level: draft
`,
  )
}

async function startSafetyRefusalHarness(
  sessionId: string,
  coordinatorTools: readonly string[],
): Promise<SafetyRefusalHarness> {
  const fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'tool-safety-')),
  )
  const teamRoot = path.join(fixtureRoot, 'team')
  const workspace = path.join(fixtureRoot, 'workspace')
  const assignmentPath = path.join(
    workspace,
    'sessions',
    sessionId,
    'runs',
    `run-${sessionId}`,
    'assignments',
    `assignment-${sessionId}`,
  )
  fs.mkdirSync(assignmentPath, { recursive: true })
  writeTeam(teamRoot, coordinatorTools)

  const previousEnv = { ...process.env }
  process.env.TEAM_CONFIG_PATH = path.join(teamRoot, 'team.yaml')
  process.env.TEAM_WORKSPACE_PATH = workspace
  process.env.TEAM_RUNTIME_START_SERVICES = '0'
  process.env.TEAM_RUNTIME_SESSION_ID = sessionId
  process.env.TEAM_RUNTIME_RUN_ID = `run-${sessionId}`
  process.env.TEAM_RUNTIME_ASSIGNMENT_ID = `assignment-${sessionId}`
  process.env.TEAM_RUNTIME_TASK_ID = `task-${sessionId}`
  process.env.TEAM_RUNTIME_PROCESS_IDENTITY = `process-${sessionId}`
  process.env.TEAM_SESSION_ID = `assignment-${sessionId}`
  process.env.TEAM_ROOT_SESSION_ID = sessionId
  process.env.TEAM_RUNTIME_FILE_PARSER_ENTRY = path.join(repoRoot, 'file-parser/index.ts')
  delete process.env.TEAM_DELEGATED_AUTOSTART
  delete process.env.TEAM_CHAT_MODE

  const handlers = new Map<string, (...args: never[]) => unknown>()
  const registeredTools = new Map<string, RegisteredTool>()
  const availableModels = [{ provider: PROVIDER, id: MODEL }]

  const pi = {
    on: (event: string, handler: (...args: never[]) => unknown) => {
      handlers.set(event, handler)
    },
    registerTool: (tool: RegisteredTool) => {
      registeredTools.set(tool.name, tool)
    },
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
    getActiveTools: () => [...registeredTools.keys()],
    getAllTools: () => [...registeredTools.keys()].map((name) => ({ name })),
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => 'medium',
    setThinkingLevel: () => {},
    registerProvider: () => {},
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
    modelRegistry: { getAvailable: () => availableModels, getAll: () => availableModels },
    model: { provider: PROVIDER, id: MODEL },
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

  const { default: teamRuntimeExtension } = await import('../../team-runtime/index.js')
  teamRuntimeExtension(pi as never)

  return {
    runStartup: async () => {
      const sessionStart = handlers.get('session_start')
      assert.ok(sessionStart, 'the extension must register session_start')
      await (sessionStart as (event: unknown, context: unknown) => Promise<void>)(
        {},
        extensionContext,
      )
    },
    invokeRegisteredTool: async (name, toolCallId, params) => {
      const tool = registeredTools.get(name)
      assert.ok(tool, `the runtime must have registered the ${name} tool`)
      return tool.execute(toolCallId, params, undefined, undefined, extensionContext)
    },
    readToolUseLog: () => {
      const logPath = path.join(assignmentPath, 'logs', 'tool-use.jsonl')
      if (!fs.existsSync(logPath)) return []
      return fs
        .readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    },
    assignmentPath,
    pathOutsideRunFolder: (name: string) =>
      path.resolve(assignmentPath, '..', '..', name),
    dispose: async () => {
      const shutdown = handlers.get('session_shutdown')
      if (shutdown) {
        await (shutdown as (event: unknown, context: unknown) => Promise<void>)(
          {},
          extensionContext,
        )
      }
      for (const key of Object.keys(process.env)) {
        if (!(key in previousEnv)) delete process.env[key]
      }
      Object.assign(process.env, previousEnv)
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    },
  }
}

test(
  'a shell command refused on safety grounds is recorded as a refusal, with its code',
  { timeout: 60_000 },
  async () => {
    const harness = await startSafetyRefusalHarness('safety-bash', ['bash'])
    try {
      await harness.runStartup()
      const marker = harness.pathOutsideRunFolder('protected-marker')
      fs.mkdirSync(marker)

      const toolCallId = 'unsafe-bash-call'
      await assert.rejects(
        harness.invokeRegisteredTool('bash', toolCallId, {
          command: "rm -rf '../../protected-marker'",
        }),
        'a destructive shell command must be refused before it runs',
      )

      assert.equal(
        fs.existsSync(marker),
        true,
        'the refused command must not have run',
      )
      const records = harness
        .readToolUseLog()
        .filter((record) => record.tool_call_id === toolCallId)
      assert.ok(
        records.length > 0,
        'a refusal a reader can be shown has to be recorded at all; ' +
          'without a record the timeline only ever sees the failed call',
      )
      for (const record of records) {
        // The flag is what puts the row in the timeline's refusal arm rather
        // than its failure arm (`ui/src/lib/models/runtime-model.ts:434`).
        assert.equal(record.blocked_tool_safety, true)
        assert.equal(
          record.policy_code,
          'unsafe_bash_command',
          'a refusal a reader can be shown needs the code that selects its sentence',
        )
        // The engineer's half stays beside the code rather than in place of it.
        assert.equal(
          record.reason,
          'The bash command exceeds the Team Runtime risk boundary.',
        )
        assert.equal(record.is_error, true)
        assert.equal(record.tool_name, 'bash')
        assert.equal(record.agent_name, COORDINATOR)
        assert.equal(record.level_id, 'draft')
      }
    } finally {
      await harness.dispose()
    }
  },
)

test(
  'a path outside the run folder is recorded as a refusal, with its code',
  { timeout: 60_000 },
  async () => {
    const harness = await startSafetyRefusalHarness('safety-path', ['write'])
    try {
      await harness.runStartup()

      const toolCallId = 'escaping-write-call'
      await assert.rejects(
        harness.invokeRegisteredTool('write', toolCallId, {
          path: '../../escaped.txt',
          content: 'must not be written',
        }),
        'a write outside the run folder must be refused',
      )

      assert.equal(
        fs.existsSync(harness.pathOutsideRunFolder('escaped.txt')),
        false,
        'the refused write must not have reached the filesystem',
      )
      const records = harness
        .readToolUseLog()
        .filter((record) => record.tool_call_id === toolCallId)
      assert.ok(
        records.length > 0,
        'a refusal a reader can be shown has to be recorded at all',
      )
      for (const record of records) {
        assert.equal(record.blocked_tool_safety, true)
        assert.equal(
          record.policy_code,
          'tool_path_outside_workspace',
          'a refusal a reader can be shown needs the code that selects its sentence',
        )
        assert.equal(
          record.reason,
          'The tool path must remain inside the Team Runtime workspace.',
        )
        assert.equal(record.is_error, true)
        assert.equal(record.tool_name, 'write')
        assert.equal(record.agent_name, COORDINATOR)
      }
    } finally {
      await harness.dispose()
    }
  },
)
