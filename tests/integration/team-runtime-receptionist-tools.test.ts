/**
 * The shipped receptionist's declared tools, observed through the real runtime.
 *
 * `tests/unit/tool-policy.test.ts` asserts the resolution helpers directly. That
 * cannot see whether `team-runtime/index.ts` still calls them, nor whether the
 * `inspect-task-state` registration and the level allow-set agree — if the
 * runtime stopped calling the helper, those unit tests would stay green while
 * the shipped feature broke.
 *
 * This boots the actual extension against the shipped `teams/reception-desk`
 * config with a fake Pi host, and observes what the runtime registers, what it
 * records as the level allow-set, and what its real dispatch policy admits.
 *
 * Recorded honestly: this is post-review acceptance coverage for work that was
 * already implemented, not an initial Red-first cycle. It was proved to bite by
 * removing the registration and the allow-set entry in turn.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { agentCliSkipReason } from '../support/agent-cli-availability.js'

const repoRoot = process.cwd()

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

function walkFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walkFiles(path.join(directory, entry.name))
      : [path.join(directory, entry.name)],
  )
}

test('the shipped receptionist boots with its declared task-inspection tool and without a shell', {
  // The shipped receptionist declares the codex provider in its own agent
  // file, and provider preflight refuses to start a Team whose provider is
  // unready. Without the CLI nothing registers and every assertion below
  // reports a symptom of the absent binary rather than the shipped config.
  skip: agentCliSkipReason('codex'),
}, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'reception-runtime-'))
  const previousEnv = { ...process.env }

  process.env.TEAM_CONFIG_PATH = path.join(repoRoot, 'teams/reception-desk/team.yaml')
  process.env.TEAM_WORKSPACE_PATH = workspace
  // Dev services start by default during session_start and would bind ports.
  process.env.TEAM_RUNTIME_START_SERVICES = '0'
  process.env.TEAM_RUNTIME_SESSION_ID = 'session-reception'
  process.env.TEAM_RUNTIME_RUN_ID = 'run-reception'
  process.env.TEAM_RUNTIME_ASSIGNMENT_ID = 'assignment-reception'
  process.env.TEAM_RUNTIME_TASK_ID = 'task-reception'
  process.env.TEAM_RUNTIME_PROCESS_IDENTITY = 'process-reception'
  // Provider preflight checks presence only; no network call is made.
  // The compiled test runs from .tests-dist, so the parser entry cannot be
  // discovered relative to this module. Point it at the real source entry.
  process.env.TEAM_RUNTIME_FILE_PARSER_ENTRY = path.join(repoRoot, 'file-parser/index.ts')
  process.env.ANTHROPIC_API_KEY = 'preflight-presence-only'
  process.env.PIPELINE_DEFAULT_MODEL_SELECTION = Buffer.from(
    JSON.stringify({ provider: 'anthropic', model: 'claude-haiku-4-5' }),
    'utf8',
  ).toString('base64')

  try {
    const { default: teamRuntimeExtension } = await import(
      '../../team-runtime/index.js'
    )

    const handlers = new Map<string, (...args: never[]) => unknown>()
    const registered: RegisteredTool[] = []
    const hostModel = {
      id: 'claude-haiku-4-5',
      name: 'Claude Haiku 4.5',
      provider: 'anthropic',
      api: 'anthropic-messages',
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
      // The bypass detector resolves a tool's registration by source path.
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
    const sessionStart = handlers.get('session_start')
    assert.ok(sessionStart, 'the extension must register a session_start handler')
    await (sessionStart as (event: unknown, context: unknown) => Promise<void>)(
      {},
      extensionContext,
    )

    const registeredNames = registered.map((tool) => tool.name).sort()

    // 1. The registration the receptionist depends on actually ran.
    assert.ok(
      registeredNames.includes('inspect-task-state'),
      `inspect-task-state must be registered; got ${registeredNames.join(', ')}`,
    )

    // 2. The level allow-set the runtime itself computed. This is what a helper
    //    test cannot see: it proves the runtime still calls the resolver and
    //    that the resolver's answer includes the tool.
    const assignmentPath = path.join(
      workspace, 'sessions', 'session-reception',
      'runs', 'run-reception', 'assignments', 'assignment-reception',
    )
    const registrationLines = walkFiles(assignmentPath)
      .flatMap((file) => fs.readFileSync(file, 'utf8').split('\n'))
      .filter((line) => line.includes('tools.registered'))
    assert.ok(registrationLines.length > 0, 'the runtime must record its tool registration')
    assert.ok(
      registrationLines.some((line) => {
        const parsed: unknown = JSON.parse(line)
        const allowed = (parsed as { allowed_level_tools?: unknown }).allowed_level_tools
          ?? (parsed as { payload?: { allowed_level_tools?: unknown } }).payload?.allowed_level_tools
        return Array.isArray(allowed) && allowed.includes('inspect-task-state')
      }),
      'the recorded level allow-set must contain inspect-task-state',
    )

    // 3. A shell and an arbitrary write are never registered for this agent:
    //    the governed Pi builtins are filtered by the coordinator's own tools.
    assert.equal(registeredNames.includes('bash'), false)
    assert.equal(registeredNames.includes('write'), false)

    // 4. The real dispatch policy still refuses a registered tool the
    //    receptionist did not declare. Widening the allow-set for
    //    inspect-task-state must not widen anything else.
    const browser = registered.find((tool) => tool.name === 'browser')
    assert.ok(browser, 'browser is registered globally and must be policy-denied here')
    await assert.rejects(
      browser.execute('call-browser', { action: 'observe' }, undefined, undefined, extensionContext),
      (error: unknown) => {
        const code = (error as { code?: unknown }).code
        assert.equal(code, 'tool_not_allowed_for_agent')
        return true
      },
    )

    const shutdown = handlers.get('session_shutdown')
    if (shutdown) await (shutdown as () => Promise<void>)()
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key]
    }
    Object.assign(process.env, previousEnv)
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
