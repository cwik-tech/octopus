/**
 * A persona's `tools:` list has to reach the model.
 *
 * The runtime registers governed replacements for Pi's own file tools —
 * `write` and its siblings — whenever the level's coordinator lists them
 * (`team-runtime/index.ts:1505`, `team-runtime/governed-pi-tools.ts:95`). They
 * are the only way a routing coordinator can produce the artifact its gate is
 * waiting for, because a routing level registers no engine tools at all
 * (`team-runtime/index.ts:1219`).
 *
 * Registering them is not enough. Every Team host launch passes
 * `--no-builtin-tools` (`core/pi-runtime.ts:98`), which in the installed Pi
 * 0.84.1 means `noTools: "builtin"`: the built-in definitions stay in the tool
 * registry and start inactive (`dist/core/sdk.js:132`,
 * `dist/core/agent-session.js:158`). When an extension registers a tool later,
 * `_refreshToolRegistry` activates it only if its name was *new* to that
 * registry (`dist/core/agent-session.js:2005-2012`). The governed tools reuse
 * the built-in names deliberately, so their names are never new — Pi swaps the
 * definition in and leaves the tool inactive, and the coordinator that was
 * granted `write` is told "Tool write not found".
 *
 * This drives the rule at the runtime's Pi-facing boundary. The fake here
 * reproduces exactly that activation rule, with the same starting state the
 * lockdown produces, so the assertion is about what the host can call rather
 * than about which API was used to arrange it. The real-process proof is
 * `team-runtime-print-mode-handover.test.ts`, where the governed write is what
 * satisfies the A-to-B gate.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { PI_BUILTIN_TOOL_NAMES } from '../../core/pi-runtime.js'

const repoRoot = process.cwd()

const PROVIDER = 'lm-studio'
const MODEL = 'loopback-model'

interface ToolActivationHarness {
  readonly runStartup: () => Promise<void>
  readonly activeTools: () => string[]
  readonly registeredTools: () => string[]
  readonly dispose: () => void
}

function writeTeam(teamRoot: string, coordinatorTools: readonly string[]): void {
  fs.mkdirSync(path.join(teamRoot, 'agents'), { recursive: true })
  fs.writeFileSync(
    path.join(teamRoot, 'agents', 'lead.md'),
    `---
name: lead
description: lead persona.
provider: ${PROVIDER}
model: ${MODEL}
thinking: low
---

You are lead.
`,
  )
  const toolLines = coordinatorTools.map((name) => `      - ${name}`).join('\n')
  fs.writeFileSync(
    path.join(teamRoot, 'team.yaml'),
    `team:
  name: governed-tool-team
  description: One routing level whose coordinator was granted file tools.

workspace:
  path: workspace
  watch: false

agents:
  - name: lead
    type: agent
    role: Coordinates the draft.
    tier: orchestration
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
      coordinator: lead
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

async function startToolActivationHarness(
  coordinatorTools: readonly string[],
): Promise<ToolActivationHarness> {
  const fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'governed-tool-')),
  )
  const teamRoot = path.join(fixtureRoot, 'team')
  const workspace = path.join(fixtureRoot, 'workspace')
  const sessionId = 'governed-tools'
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

  /**
   * The tool registry a `--no-builtin-tools` launch starts with: every built-in
   * present but inactive (`dist/core/sdk.js:132`,
   * `dist/core/agent-session.js:158`).
   */
  const registry = new Set<string>(PI_BUILTIN_TOOL_NAMES)
  const active = new Set<string>()
  const registered: string[] = []

  const handlers = new Map<string, (...args: never[]) => unknown>()
  const availableModels = [{ provider: PROVIDER, id: MODEL }]

  const pi = {
    on: (event: string, handler: (...args: never[]) => unknown) => {
      handlers.set(event, handler)
    },
    registerTool: (tool: { name: string }) => {
      registered.push(tool.name)
      // Pi's rule, verbatim: a registered tool joins the active set only when
      // its name was new to the registry
      // (`dist/core/agent-session.js:2005-2012`).
      if (!registry.has(tool.name)) active.add(tool.name)
      registry.add(tool.name)
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
    getActiveTools: () => [...active],
    getAllTools: () => [...registry].map((name) => ({ name })),
    setActiveTools: (toolNames: string[]) => {
      active.clear()
      for (const name of toolNames) {
        if (registry.has(name)) active.add(name)
      }
    },
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
    activeTools: () => [...active],
    registeredTools: () => [...registered],
    dispose: () => {
      for (const key of Object.keys(process.env)) {
        if (!(key in previousEnv)) delete process.env[key]
      }
      Object.assign(process.env, previousEnv)
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    },
  }
}

test(
  'a governed file tool the coordinator was granted is callable, not merely registered',
  { timeout: 30_000 },
  async () => {
    const harness = await startToolActivationHarness(['write'])
    try {
      await harness.runStartup()

      assert.ok(
        harness.registeredTools().includes('write'),
        'the runtime must register the governed write for a coordinator granted it',
      )
      assert.ok(
        harness.activeTools().includes('write'),
        'the governed write must be callable by the host, not shadowed by the ' +
          `inactive built-in it replaces; active tools were ${JSON.stringify(harness.activeTools())}`,
      )
    } finally {
      harness.dispose()
    }
  },
)

test(
  'a file tool the coordinator was not granted stays uncallable',
  { timeout: 30_000 },
  async () => {
    // The permission is the persona's list, so activation must not become a
    // blanket re-enable of everything Pi ships.
    const harness = await startToolActivationHarness(['write'])
    try {
      await harness.runStartup()

      for (const name of ['read', 'bash', 'edit', 'grep', 'find', 'ls']) {
        assert.ok(
          !harness.activeTools().includes(name),
          `'${name}' was never granted to this coordinator and must stay uncallable`,
        )
      }
    } finally {
      harness.dispose()
    }
  },
)
