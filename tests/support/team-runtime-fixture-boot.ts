/**
 * Boot the real Team Runtime against a fixture Team that needs no CLI binary.
 *
 * The shipped reception desk declares the `codex` provider, and
 * `validateLoadedAgentProviders` refuses to start a Team whose provider is
 * unready — so every acceptance test that boots it must skip on a machine
 * without that CLI, which is every CI runner. That left the Team Runtime boot
 * path with no coverage at all on CI.
 *
 * This builds the same boot out of a Team whose personas declare `lm-studio`.
 * `getAgentProviderReadinessError('lm-studio')` returns `undefined` and
 * `validateHostProviderReadiness('lm-studio', ...)` returns no errors, both
 * without touching the filesystem, PATH or any credential — the same reason
 * `tests/unit/team-builder-health.test.ts` builds its fixture Teams on it. The
 * boot itself is untouched: the real `team-runtime/index.ts` extension, its
 * real provider preflight, its real `registerLevelTools`, its real capability
 * dispatcher.
 *
 * What is a fake here is the *host*, not the runtime: `pi` and the extension
 * context stand in for the Pi process the extension is loaded into, exactly as
 * `tests/integration/team-runtime-receptionist-tools.test.ts` does.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { reconcileWorkspaceTenantPin } from '../../services/execution-journal-tenant-pin.js'

/** The host model the fixture personas name. No binary, no credential. */
export const FIXTURE_HOST_PROVIDER = 'lm-studio'
export const FIXTURE_HOST_MODEL_ID = 'local-model'

/**
 * The file the runtime extension is loaded from in this run.
 *
 * The TypeScript source under tsx, the compiled module under `.tests-dist`.
 * The bypass detector accepts a tool call only when the host reports the
 * tool's source as the runtime's own module path, so a host reporting any
 * other path has every governed call refused as `shadowed_tool_registration`.
 */
export const TEAM_RUNTIME_MODULE_PATH = runtimeModulePath()

function runtimeModulePath(): string {
  const supportModule = fileURLToPath(import.meta.url)
  return path.resolve(
    path.dirname(supportModule),
    '..',
    '..',
    'team-runtime',
    `index${path.extname(supportModule)}`,
  )
}

/**
 * The stage types a fixture level can declare. Each config shape is copied
 * from a shipped Team: routing from `teams/reception-desk`, discussion from
 * `teams/crypto-investment-board`, chain from `teams/furniture-makers`,
 * pipeline from `teams/research-team`, review from `teams/writing-team`, and
 * broadcast from `tests/fixtures/reflection-disclosure-e2e` (no shipped Team
 * declares one).
 */
export type FixtureStageType =
  | 'routing'
  | 'discussion'
  | 'pipeline'
  | 'chain'
  | 'broadcast'
  | 'review'

export interface FixtureTeamPersona {
  readonly name: string
  /** Defaults to `lm-studio`. Override to declare an unready provider. */
  readonly provider?: string
  /** Defaults to `local-model`. */
  readonly model?: string
  /**
   * The persona's `tools:` grant. Omit for an unrestricted persona; the
   * runtime reads this list to decide which governed Pi builtins to register.
   */
  readonly tools?: readonly string[]
  /**
   * `false` keeps the roster entry and writes no persona file, so the agent
   * never loads. Defaults to `true`.
   */
  readonly loadable?: boolean
}

/** A level after the entry level. Each one gates into the next. */
export interface FixtureLaterLevel {
  readonly id: string
  readonly coordinator: FixtureTeamPersona
  /** Defaults to `routing`. */
  readonly stage?: FixtureStageType
}

export interface FixtureTeamOptions {
  /** Directory the team.yaml and persona files are written into. */
  readonly teamRoot: string
  /** `workspace.path` in the written team.yaml. */
  readonly workspacePath: string
  readonly teamName?: string
  readonly coordinator: FixtureTeamPersona
  /**
   * Further roster members, each with its own persona file.
   *
   * Every one of them is loaded and preflighted at boot, which is what a Team
   * with a mixed roster looks like: one member may pin a provider this machine
   * cannot run while the rest are ready. A non-routing stage uses them as its
   * participants; when none are given, one member (two for `review`) is
   * written for it.
   */
  readonly members?: readonly FixtureTeamPersona[]
  /**
   * `levels[0].permissions.spawn_teams`. The runtime registers `spawn_team`
   * and `inspect-task-state` in this one branch and puts them in the level
   * allow-set from the same branch, so this is what the registration and the
   * policy both hang off.
   */
  readonly spawnTeams?: boolean
  /** The entry level's stage type. Defaults to `routing`. */
  readonly stage?: FixtureStageType
  /**
   * Leave `coordinator:` off the entry level's stage, which makes it a
   * runtime-owned stage. Routing and discussion require a coordinator, so
   * this throws for them.
   */
  readonly omitStageCoordinator?: boolean
  /** Levels after the entry level, in order. */
  readonly laterLevels?: readonly FixtureLaterLevel[]
}

interface PlannedLevel {
  readonly id: string
  readonly name: string
  readonly stage: FixtureStageType
  readonly coordinator: FixtureTeamPersona
  readonly declareCoordinator: boolean
  readonly permissions: string
  /** Undefined for a pipeline, whose gate waits on its tasks instead. */
  readonly outputArtifact: string | undefined
}

/**
 * Write a fixture Team, its coordinator persona, and any further roster
 * members.
 *
 * With no stage options this is the shape of the shipped reception desk — one
 * routing level, one coordinator, `spawn_teams` — because that is the shape
 * whose boot the skipped tests used to cover. Everything the shipped Team
 * needs a binary for is replaced, and nothing else is. Extra members exist so
 * a test can boot the mixed roster a real Team has: some agents ready, one
 * pinned to a provider this machine cannot run.
 */
export function writeFixtureTeam(options: FixtureTeamOptions): string {
  const teamName = options.teamName ?? 'fixture-desk'
  const entryStage = options.stage ?? 'routing'
  if (
    options.omitStageCoordinator === true &&
    (entryStage === 'routing' || entryStage === 'discussion')
  ) {
    throw new Error(`A ${entryStage} stage requires a coordinator.`)
  }
  fs.mkdirSync(options.teamRoot, { recursive: true })

  const members = options.members ?? defaultMembers(options)
  const levels: PlannedLevel[] = [
    {
      id: 'intake',
      name: 'Intake',
      stage: entryStage,
      coordinator: options.coordinator,
      declareCoordinator: options.omitStageCoordinator !== true,
      permissions: `    permissions:
      spawn_teams: ${options.spawnTeams === false ? 'false' : 'true'}
`,
      outputArtifact: outputArtifactFor(entryStage, 'routing-decision.md', `${entryStage}-result.md`),
    },
    ...(options.laterLevels ?? []).map((level) => {
      const stage = level.stage ?? 'routing'
      return {
        id: level.id,
        name: level.id,
        stage,
        coordinator: level.coordinator,
        declareCoordinator: true,
        permissions: '',
        outputArtifact: outputArtifactFor(stage, `${level.id}-result.md`, `${level.id}-result.md`),
      }
    }),
  ]

  const personas = uniqueByName([
    options.coordinator,
    ...members,
    ...levels.map((level) => level.coordinator),
  ])
  for (const persona of personas) {
    if (persona.loadable !== false) writePersona(options.teamRoot, persona)
  }

  const coordinatorEntries = uniqueByName(levels.map((level) => level.coordinator))
    .map((coordinator) =>
      coordinatorRosterEntry(
        coordinator,
        coordinator.name === options.coordinator.name
          ? 'Fixture intake and routing agent.'
          : 'Fixture level coordinator.',
        levels
          .filter((level) => level.coordinator.name === coordinator.name)
          .flatMap((level) => (level.outputArtifact ? [level.outputArtifact] : [])),
      ),
    )
    .join('')
  const coordinatorNames = new Set(levels.map((level) => level.coordinator.name))
  const memberRoster = members
    .filter((member) => !coordinatorNames.has(member.name))
    .map(
      (member) => `  - name: ${member.name}
    type: agent
    role: Fixture team member.
    agent_file: ./${member.name}.md
    experience_enabled: false
`,
    )
    .join('')

  const levelBlocks = levels
    .map(
      (level, index) => `  - id: ${level.id}
    name: ${level.name}
    order: ${index}
${level.permissions}    stage:
${stageBlock(level, members)}`,
    )
    .join('\n')

  const gateBlocks = levels
    .map((level, index) => {
      const destination = levels[index + 1]?.id ?? 'done'
      const condition = level.outputArtifact
        ? `      type: artifact_exists
      artifact: ${level.outputArtifact}`
        : '      type: all_tasks_terminal'
      return `  - from: ${level.id}
    to: ${destination}
    condition:
${condition}
`
    })
    .join('')

  const teamConfigPath = path.join(options.teamRoot, 'team.yaml')
  fs.writeFileSync(
    teamConfigPath,
    `team:
  name: ${teamName}
  description: Fixture intake team used to boot the real Team Runtime in tests.
  version: '0.1.0'

workspace:
  path: ${JSON.stringify(options.workspacePath)}
  watch: false

workflow:
  entry_level: intake

agents:
${coordinatorEntries}${memberRoster}
levels:
${levelBlocks}
gates:
${gateBlocks}`,
  )
  return teamConfigPath
}

function defaultMembers(options: FixtureTeamOptions): FixtureTeamPersona[] {
  const stages = [options.stage ?? 'routing', ...(options.laterLevels ?? []).map((level) => level.stage ?? 'routing')]
  if (stages.includes('review')) {
    return [{ name: 'fixture-producer' }, { name: 'fixture-reviewer' }]
  }
  if (stages.some((stage) => stage !== 'routing')) {
    return [{ name: 'fixture-member' }]
  }
  return []
}

function outputArtifactFor(
  stage: FixtureStageType,
  routingArtifact: string,
  otherArtifact: string,
): string | undefined {
  if (stage === 'pipeline') return undefined
  return stage === 'routing' ? routingArtifact : otherArtifact
}

function uniqueByName(personas: readonly FixtureTeamPersona[]): FixtureTeamPersona[] {
  const seen = new Set<string>()
  return personas.filter((persona) => {
    if (seen.has(persona.name)) return false
    seen.add(persona.name)
    return true
  })
}

function coordinatorRosterEntry(
  coordinator: FixtureTeamPersona,
  role: string,
  produces: readonly string[],
): string {
  const producesBlock = produces.length === 0
    ? ''
    : `    # The gate below requires this artifact, and the config validator refuses a
    # Team whose gate asks for an artifact no roster member declares.
    produces:
${produces.map((artifact) => `      - path: ${artifact}\n`).join('')}`
  return `  - name: ${coordinator.name}
    type: agent
    role: ${role}
    agent_file: ./${coordinator.name}.md
    experience_enabled: false
${producesBlock}`
}

function stageBlock(level: PlannedLevel, members: readonly FixtureTeamPersona[]): string {
  const coordinatorLine = level.declareCoordinator
    ? `      coordinator: ${level.coordinator.name}\n`
    : ''
  const participantLines = members.map((member) => `        - ${member.name}\n`).join('')
  const output = `        output:
          format: ${level.outputArtifact ?? ''}
          user_review: false
`
  switch (level.stage) {
    case 'routing':
      return `      type: routing
${coordinatorLine}      config:
${output}`
    case 'discussion':
      return `      type: discussion
${coordinatorLine}      participants:
${participantLines}      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        constraints:
          max_time_minutes: 6
          max_budget_usd: 20
${output}`
    case 'pipeline':
      return `      type: pipeline
${coordinatorLine}      participants:
${participantLines}      config:
        parallel: false
        constraints:
          max_time_minutes: 20
          agent_timeout_minutes: 8
          max_budget_usd: 12
        gate:
          type: all_tasks_terminal
          strictness: hard
`
    case 'chain':
      return `      type: chain
${coordinatorLine}      sequence:
${participantLines}      config:
        handoff_format: markdown
${output}`
    case 'broadcast':
      return `      type: broadcast
${coordinatorLine}      fan_out:
${participantLines}      config:
        aggregation: merge
        constraints:
          max_time_minutes: 2
          agent_timeout_minutes: 1
          max_budget_usd: 1
${output}`
    case 'review': {
      const [producer, reviewer] = members
      if (!producer || !reviewer) {
        throw new Error('A review stage needs two members: a producer and a reviewer.')
      }
      return `      type: review
${coordinatorLine}      producer: ${producer.name}
      reviewer: ${reviewer.name}
      config:
        max_iterations: 3
        on_max_iterations: approve_latest_with_warnings
        constraints:
          max_time_minutes: 10
          agent_timeout_minutes: 3
          max_budget_usd: 8
${output}`
    }
  }
}

function writePersona(teamRoot: string, persona: FixtureTeamPersona): void {
  const toolsLine =
    persona.tools === undefined ? '' : `tools: ${persona.tools.join(', ')}\n`
  fs.writeFileSync(
    path.join(teamRoot, `${persona.name}.md`),
    `---
name: ${persona.name}
provider: ${persona.provider ?? FIXTURE_HOST_PROVIDER}
model: ${persona.model ?? FIXTURE_HOST_MODEL_ID}
thinking: low
${toolsLine}---

# ${persona.name}

Fixture persona. This file exists so a test can boot the real Team Runtime
without any external CLI.
`,
  )
}

export interface RegisteredTool {
  readonly name: string
  execute(
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    extensionContext: unknown,
  ): Promise<unknown>
}

export interface HostNotification {
  readonly message: string
  readonly level: string
}

/** A lifecycle handler the extension registered through `pi.on`. */
export type FixtureHandler = (event: unknown, context: unknown) => unknown

/** One `pi.registerProvider` call, with the config exactly as it was passed. */
export interface ProviderRegistration {
  readonly name: string
  readonly config: unknown
}

/** The fields of Pi's `tool_call` event the runtime reads. */
export interface FixtureToolCallEvent {
  readonly toolName: string
  readonly toolCallId: string
  readonly input?: unknown
}

export interface FixtureHostOptions {
  /**
   * Models the host registry lists before the runtime registers anything,
   * added after the fixture's own `lm-studio` model. A built-in `anthropic`
   * model here is what lets the runtime register its Anthropic API fallback.
   */
  readonly hostModels?: readonly unknown[]
  /**
   * `extensionContext.model`: the pair Pi reports it is on before the runtime
   * asks it to switch. Undefined by default. `setModel` does not change it.
   */
  readonly initialModel?: { readonly provider: string; readonly id: string }
  /** `extensionContext.cwd`. Defaults to `repoRoot`. */
  readonly cwd?: string
  /**
   * What `sessionManager.getEntries()` returns: the entries Pi restored for a
   * reopened session. Empty by default, which is a new session.
   */
  readonly sessionEntries?: readonly unknown[]
}

/** One `pi.appendEntry` call: an entry Pi saves in the session file. */
export interface AppendedEntry {
  readonly customType: string
  readonly data: unknown
}

export interface FixtureHost {
  /** Passed to the real extension as its `ExtensionAPI`. */
  readonly pi: unknown
  /** Passed to every handler the extension registers. */
  readonly extensionContext: unknown
  /** Event handlers the extension registered, by event name. */
  readonly handlers: Map<string, FixtureHandler>
  /** Tools the runtime registered, in registration order. */
  readonly registered: RegisteredTool[]
  /** Everything the runtime reported through `ui.notify`. */
  readonly notifications: HostNotification[]
  /**
   * Every model the runtime asked the host to switch to, in order. This is
   * what `applyHostModelPreference` resolved out of the model registry, so it
   * says which pair the boot actually put the host on.
   */
  readonly hostModelSwitches: Array<{ provider?: unknown; id?: unknown }>
  /** Every `pi.registerProvider` call, in order. */
  readonly providerRegistrations: ProviderRegistration[]
  /** Every `pi.appendEntry` call, in order. */
  readonly appendedEntries: AppendedEntry[]
  /**
   * Run the registered `tool_call` handler the way Pi does before it executes
   * a tool, and return what the handler returned: `undefined` lets the call
   * through, a `{ block: true, ... }` result stops it.
   */
  callToolCall(event: FixtureToolCallEvent): Promise<unknown>
  /** Run any registered lifecycle handler with the host's extension context. */
  callHandler(name: string, event?: unknown): Promise<unknown>
  /**
   * Execute a tool the runtime registered, through the wrapper it registered.
   * The capability policy runs inside this wrapper.
   */
  invokeTool(
    name: string,
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>
}

/**
 * A Pi host that records what the runtime does to it.
 *
 * The model registry starts with the one fixture host model, and
 * `registerProvider` folds newly registered models into it the way Pi's own
 * registry does — `applyHostModelPreference` reads the registry back after
 * registering, so a registry that ignored registration would block the boot.
 *
 * `getAllTools` reports every registered tool as coming from the runtime's
 * own module, which is what Pi reports for tools an extension registered.
 */
export function createFixtureHost(
  repoRoot: string,
  options: FixtureHostOptions = {},
): FixtureHost {
  const handlers = new Map<string, FixtureHandler>()
  const registered: RegisteredTool[] = []
  const notifications: HostNotification[] = []
  const hostModelSwitches: Array<{ provider?: unknown; id?: unknown }> = []
  const providerRegistrations: ProviderRegistration[] = []
  const appendedEntries: AppendedEntry[] = []

  let registryModels: unknown[] = [
    {
      id: FIXTURE_HOST_MODEL_ID,
      name: 'LM Studio Fixture Model',
      provider: FIXTURE_HOST_PROVIDER,
      api: 'openai-completions',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    },
    ...(options.hostModels ?? []),
  ]

  const pi = {
    on: (event: string, handler: FixtureHandler) =>
      handlers.set(event, handler),
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
    appendEntry: (customType: string, data?: unknown) => {
      appendedEntries.push({ customType, data })
    },
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    getActiveTools: () => registered.map((tool) => tool.name),
    // The bypass detector resolves a tool's registration by source path.
    getAllTools: () =>
      registered.map((tool) => ({
        ...tool,
        sourceInfo: { path: TEAM_RUNTIME_MODULE_PATH },
      })),
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: async (model: { provider?: unknown; id?: unknown }) => {
      hostModelSwitches.push(model)
      return true
    },
    getThinkingLevel: () => 'medium',
    setThinkingLevel: () => {},
    registerProvider: (name: string, config: { models?: unknown[] }) => {
      providerRegistrations.push({ name, config })
      if (typeof name === 'string' && config?.models) {
        registryModels = [
          ...registryModels,
          ...config.models.map((model) => ({
            ...(model as object),
            provider: name,
          })),
        ]
      }
    },
    unregisterProvider: () => {},
    events: { on: () => {}, off: () => {}, emit: () => {} },
  }

  const extensionContext = {
    ui: {
      notify: (message: string, level: string) =>
        notifications.push({ message, level }),
      setStatus: () => {},
      setWidget: () => {},
    },
    mode: 'headless',
    hasUI: false,
    cwd: options.cwd ?? repoRoot,
    sessionManager: {
      getEntries: () => [...(options.sessionEntries ?? [])],
      getSessionId: () => 'pi-session',
      getSessionFile: () => undefined,
    },
    modelRegistry: {
      getAvailable: () => registryModels,
      getAll: () => registryModels,
    },
    model: options.initialModel,
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

  async function callHandler(name: string, event: unknown = {}): Promise<unknown> {
    const handler = handlers.get(name)
    if (!handler) throw new Error(`the extension registered no ${name} handler`)
    return handler(event, extensionContext)
  }

  return {
    pi,
    extensionContext,
    handlers,
    registered,
    notifications,
    hostModelSwitches,
    providerRegistrations,
    appendedEntries,
    callHandler,
    callToolCall: (event) =>
      callHandler('tool_call', {
        type: 'tool_call',
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: event.input ?? {},
      }),
    async invokeTool(name, toolCallId, params, signal) {
      const tool = registered.find((candidate) => candidate.name === name)
      if (!tool) {
        throw new Error(
          `the runtime registered no ${name} tool; registered: ` +
            registered.map((candidate) => candidate.name).join(', '),
        )
      }
      return tool.execute(toolCallId, params, signal, undefined, extensionContext)
    },
  }
}

/** The assignment logs the runtime writes as JSON lines. */
export const ASSIGNMENT_LOG = {
  toolUse: 'tool-use.jsonl',
  runtimeEvents: 'runtime-events.jsonl',
  hostEvents: 'host-events.jsonl',
  capabilityDispatchEvents: 'capability-dispatch-events.jsonl',
} as const

/**
 * Every record in one of an assignment's JSONL logs, in file order.
 *
 * A missing file reads as no records. A line that is not a JSON object throws,
 * naming the file, because a log the runtime owns never holds one.
 */
export function readAssignmentJsonl(
  assignmentPath: string,
  fileName: string,
): Array<Record<string, unknown>> {
  const logPath = path.join(assignmentPath, 'logs', fileName)
  if (!fs.existsSync(logPath)) return []
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const parsed: unknown = JSON.parse(line)
      if (!isJsonObject(parsed)) {
        throw new Error(`${logPath}:${index + 1} is not a JSON object`)
      }
      return parsed
    })
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Every file under `directory` whose text contains `needle`. */
export function findFilesContaining(directory: string, needle: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => fs.readFileSync(file, 'utf8').includes(needle))
}

/**
 * Variables a developer's shell may carry that change what a boot does. Removed
 * for every fixture boot unless the boot sets them itself.
 */
const RUNTIME_MODE_ENV = [
  'TEAM_DELEGATED_AUTOSTART',
  'TEAM_RUNTIME_FAULT_INJECT',
  'TEAM_RUNTIME_RECOVERY',
  'TEAM_CHAT_MODE',
  'TEAM_CONFIG_OVERRIDES_JSON',
  'TEAM_BOOT_ENTRY_JSON',
  'TEAM_INPUT_ARTIFACT',
] as const

export interface FixtureRuntimeOptions {
  /**
   * Names the temp directory and the run: session `session-<label>`, run
   * `run-<label>`, assignment `assignment-<label>`. Must be a safe path segment.
   */
  readonly label: string
  /** Defaults to `process.cwd()`. */
  readonly repoRoot?: string
  /**
   * The Team to write. Required unless `setupMode` is set. `teamRoot` and
   * `workspacePath` are filled in by the boot.
   */
  readonly team?: Omit<FixtureTeamOptions, 'teamRoot' | 'workspacePath'>
  /**
   * Boot with no Team at all: `TEAM_CONFIG_PATH` is unset and the host's cwd is
   * an empty directory, so the runtime enters setup mode.
   */
  readonly setupMode?: boolean
  /** `TEAM_DELEGATED_AUTOSTART=1`. */
  readonly delegatedAutostart?: boolean
  /** `TEAM_RUNTIME_FAULT_INJECT`. Read once, when the extension is called. */
  readonly faultInjection?: string
  /** Further environment, applied last so it wins over every default. */
  readonly env?: Readonly<Record<string, string>>
  /** Variables removed from the environment for the boot. */
  readonly unsetEnv?: readonly string[]
  /** Passed to `createFixtureHost`. */
  readonly hostModels?: readonly unknown[]
  /** Passed to `createFixtureHost` as `initialModel`. */
  readonly initialHostModel?: { readonly provider: string; readonly id: string }
  /** Passed to `createFixtureHost`. */
  readonly sessionEntries?: readonly unknown[]
  /**
   * Pin the workspace journal to tenant `local` in authoritative mode before
   * the boot, so governed dispatches land on a durable journal. Default true.
   */
  readonly authoritativeJournal?: boolean
  /** Run `session_start` before returning. Default true. */
  readonly startSession?: boolean
}

export interface FixtureRuntime {
  readonly host: FixtureHost
  /** The temp directory everything below lives in. Removed by `close`. */
  readonly root: string
  readonly workspace: string
  /** Undefined in setup mode. */
  readonly teamConfigPath: string | undefined
  /** `<workspace>/sessions/<session>/runs/<run>/assignments/<assignment>`. */
  readonly assignmentPath: string
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  /** Run `session_start`. Only needed when `startSession: false` was passed. */
  startSession(): Promise<void>
  /**
   * Run `session_shutdown` now, leaving the files in place to read. It closes
   * the capability evidence writer, so `capability-dispatch-events.jsonl` is
   * complete afterwards. `close` does not run it a second time.
   */
  shutdown(): Promise<void>
  /** `readAssignmentJsonl` on this run's assignment. */
  readAssignmentJsonl(fileName: string): Array<Record<string, unknown>>
  /**
   * Run `session_shutdown` unless `shutdown` already did, restore the
   * environment and remove `root`. A shutdown failure is rethrown after the
   * restore.
   */
  close(): Promise<void>
}

/**
 * Write a fixture Team, set the environment, load the real extension into a
 * fixture host and run `session_start`.
 *
 * The environment is process-wide, so boots in one file must not overlap:
 * await `close` before the next boot.
 */
export async function bootFixtureRuntime(
  options: FixtureRuntimeOptions,
): Promise<FixtureRuntime> {
  const repoRoot = options.repoRoot ?? process.cwd()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `team-runtime-${options.label}-`))
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  const sessionId = `session-${options.label}`
  const runId = `run-${options.label}`
  const assignmentId = `assignment-${options.label}`
  const assignmentPath = path.join(
    workspace, 'sessions', sessionId, 'runs', runId, 'assignments', assignmentId,
  )
  const previousEnv = { ...process.env }

  let teamConfigPath: string | undefined
  let hostCwd = repoRoot
  if (options.setupMode === true) {
    hostCwd = path.join(root, 'empty-cwd')
    fs.mkdirSync(hostCwd, { recursive: true })
  } else {
    if (!options.team) throw new Error('bootFixtureRuntime needs a team unless setupMode is set')
    teamConfigPath = writeFixtureTeam({
      ...options.team,
      teamRoot: path.join(root, 'team'),
      workspacePath: workspace,
    })
  }

  let shutDown = false
  let host: FixtureHost | undefined
  function restoreEnv(): void {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key]
    }
    Object.assign(process.env, previousEnv)
  }
  // Pi shuts a session down once, so the fixture does too.
  async function shutdownOnce(): Promise<void> {
    if (shutDown || !host?.handlers.has('session_shutdown')) return
    shutDown = true
    await host.callHandler('session_shutdown')
  }
  async function close(): Promise<void> {
    let shutdownFailure: unknown
    try {
      await shutdownOnce()
    } catch (error) {
      shutdownFailure = error
    }
    restoreEnv()
    fs.rmSync(root, { recursive: true, force: true })
    if (shutdownFailure !== undefined) throw shutdownFailure
  }

  try {
    if (options.authoritativeJournal !== false) {
      await reconcileWorkspaceTenantPin({
        workspacePath: workspace,
        tenantId: 'local',
        mode: 'authoritative',
      })
    }

    for (const key of RUNTIME_MODE_ENV) delete process.env[key]
    delete process.env.TEAM_CONFIG_PATH
    Object.assign(process.env, {
      ...(teamConfigPath ? { TEAM_CONFIG_PATH: teamConfigPath } : {}),
      TEAM_WORKSPACE_PATH: workspace,
      TEAM_RUNTIME_WORKSPACE_PATH: workspace,
      // Dev services start by default during session_start and would bind ports.
      TEAM_RUNTIME_START_SERVICES: '0',
      TEAM_RUNTIME_SESSION_ID: sessionId,
      TEAM_RUNTIME_RUN_ID: runId,
      TEAM_RUNTIME_ASSIGNMENT_ID: assignmentId,
      TEAM_RUNTIME_TASK_ID: `task-${options.label}`,
      TEAM_RUNTIME_PROCESS_IDENTITY: `process-${options.label}`,
      // The compiled test runs from .tests-dist, so the parser entry cannot be
      // discovered relative to this module. Point it at the real source entry.
      TEAM_RUNTIME_FILE_PARSER_ENTRY: path.join(repoRoot, 'file-parser/index.ts'),
      PIPELINE_DURABLE_JOURNAL: 'authoritative',
      TEAM_TENANT_ID: 'local',
      ...(options.delegatedAutostart === true ? { TEAM_DELEGATED_AUTOSTART: '1' } : {}),
      ...(options.faultInjection !== undefined
        ? { TEAM_RUNTIME_FAULT_INJECT: options.faultInjection }
        : {}),
      ...options.env,
    })
    for (const key of options.unsetEnv ?? []) delete process.env[key]

    const { default: teamRuntimeExtension } = await import('../../team-runtime/index.js')
    const bootedHost = createFixtureHost(repoRoot, {
      cwd: hostCwd,
      ...(options.hostModels ? { hostModels: options.hostModels } : {}),
      ...(options.initialHostModel ? { initialModel: options.initialHostModel } : {}),
      ...(options.sessionEntries ? { sessionEntries: options.sessionEntries } : {}),
    })
    host = bootedHost
    // The fixture host is not a full `ExtensionAPI`; it implements the part the
    // runtime calls.
    teamRuntimeExtension(bootedHost.pi as never)
    const runtime: FixtureRuntime = {
      host: bootedHost,
      root,
      workspace,
      teamConfigPath,
      assignmentPath,
      sessionId,
      runId,
      assignmentId,
      startSession: async () => {
        await bootedHost.callHandler('session_start')
      },
      shutdown: shutdownOnce,
      readAssignmentJsonl: (fileName) => readAssignmentJsonl(assignmentPath, fileName),
      close,
    }
    if (options.startSession !== false) await runtime.startSession()
    return runtime
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}
