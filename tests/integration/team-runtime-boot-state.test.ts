/**
 * What a Team Runtime boot leaves behind when it refuses, and what a later
 * `session_start` in the same process inherits from an earlier one.
 *
 * The runtime boots on every `session_start`. Each boot starts by clearing the
 * config errors, the boot entry and the assignment location, and nothing else:
 * the team config, setup mode and the level states of an earlier session stay
 * until this boot replaces them. Where a boot refuses decides which of those it
 * has replaced, and which config error the user is told about.
 *
 * These boot the real `team-runtime/index.ts` on a fixture Team and read what
 * it leaves: the config-error notice and its `runtime.config_error` record,
 * the configuration warnings it prints, the `host.session_start` record, the
 * `run.incomplete` record and checkpoint that shutdown writes, and the prompt
 * `before_agent_start` returns. No stage here calls a provider: every entry
 * level is a routing level started without delegated autostart.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'
import { format } from 'node:util'

import { getRunRuntimePaths } from '../../domains/runtime/runtime-paths.js'
import { parseAgentFrontmatter } from '../../parsers/load-agent.js'
import {
  ASSIGNMENT_LOG,
  bootFixtureRuntime,
  readAssignmentJsonl,
  writeFixtureTeam,
  type FixtureRuntime,
  type FixtureRuntimeOptions,
  type FixtureTeamOptions,
} from '../support/team-runtime-fixture-boot.js'

const COORDINATOR = { name: 'intake-agent', tools: ['spawn_team', 'inspect-task-state'] }
const NEXT_COORDINATOR = { name: 'next-lead' }
const TEAM_NAME = 'fixture-desk'
const RENAMED_TEAM = 'renamed-desk'
const AGENT_LOG_FILES = ['agent-runs.jsonl', 'provider-events.jsonl']

/**
 * Variables a developer's shell may carry that give a failed boot somewhere
 * else to record its error. Every boot here removes them.
 */
const IDENTITY_ENV = [
  'TEAM_SESSION_ID',
  'TEAM_ROOT_SESSION_ID',
  'TEAM_PARENT_SESSION_ID',
  'TEAM_SPAWN_DEPTH',
  'TEAM_RUNTIME_ASSIGNMENT_PATH',
  'TEAM_RUNTIME_RUN_PATH',
] as const

// ── Cleanup ──────────────────────────────────────────────────────────────────

/** Registers a cleanup. Cleanups run last first. */
type Defer = (cleanup: () => unknown) => void

/**
 * Runs `body`, then every cleanup it registered, last first, whether `body`
 * finished, failed an assertion, or failed part way through its setup. Every
 * cleanup runs; the first error, from `body` or a cleanup, is rethrown.
 */
async function withCleanup(body: (defer: Defer) => Promise<void>): Promise<void> {
  const cleanups: Array<() => unknown> = []
  let failure: { readonly error: unknown } | undefined
  try {
    await body((cleanup) => {
      cleanups.push(cleanup)
    })
  } catch (error) {
    failure = { error }
  }
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup()
    } catch (error) {
      failure ??= { error }
    }
  }
  if (failure) throw failure.error
}

/**
 * Boot a fixture Team as an MCP-scoped assignment without starting the
 * session. `close` restores every variable the test sets on `process.env`.
 */
async function bootScoped(
  defer: Defer,
  options: Omit<FixtureRuntimeOptions, 'startSession' | 'unsetEnv'>,
): Promise<FixtureRuntime> {
  const runtime = await bootFixtureRuntime({
    ...options,
    unsetEnv: [...IDENTITY_ENV],
    startSession: false,
  })
  defer(() => runtime.close())
  return runtime
}

// ── Records ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function eventsNamed(assignmentPath: string, event: string): Array<Record<string, unknown>> {
  return readAssignmentJsonl(assignmentPath, ASSIGNMENT_LOG.runtimeEvents)
    .filter((record) => record.event === event)
}

/** The `errors` of every `runtime.config_error` record at `assignmentPath`, in order. */
function recordedConfigErrors(assignmentPath: string): unknown[] {
  return eventsNamed(assignmentPath, 'runtime.config_error').map((record) => record.errors)
}

function onlyEvent(assignmentPath: string, event: string): Record<string, unknown> {
  const records = eventsNamed(assignmentPath, event)
  assert.equal(records.length, 1, `exactly one ${event}; got ${JSON.stringify(records)}`)
  const [record] = records
  assert.ok(record)
  return record
}

function errorNotices(runtime: FixtureRuntime): string[] {
  return runtime.host.notifications
    .filter((notice) => notice.level === 'error')
    .map((notice) => notice.message)
}

/** The notice `enterConfigErrorMode` shows for `errors`. */
function configErrorNotice(errors: readonly string[]): string {
  const list = errors.map((error, index) => `  ${index + 1}. ${error}`).join('\n')
  return `team.yaml has configuration errors:\n\n${list}\n\nFix these errors and restart.`
}

function startNotices(runtime: FixtureRuntime, teamName: string): string[] {
  return runtime.host.notifications
    .filter((notice) => notice.level === 'info' && notice.message.startsWith(`${teamName} — `))
    .map((notice) => notice.message)
}

function assertNoAgentRan(assignmentPath: string): void {
  for (const logFile of AGENT_LOG_FILES) {
    assert.deepEqual(
      readAssignmentJsonl(assignmentPath, logFile),
      [],
      `no agent or provider ran (${logFile})`,
    )
  }
}

/**
 * Every line the runtime writes through `console[method]` while the test runs,
 * formatted as the console would print it. Each call is still passed on.
 */
function captureConsole(t: TestContext, method: 'warn' | 'error'): string[] {
  const lines: string[] = []
  const original = console[method].bind(console)
  t.mock.method(console, method, (...args: unknown[]) => {
    lines.push(format(...args))
    original(...args)
  })
  return lines
}

// ── Team config ──────────────────────────────────────────────────────────────

function editTeamConfig(runtime: FixtureRuntime, edit: (text: string) => string): void {
  const teamConfigPath = runtime.teamConfigPath
  assert.ok(teamConfigPath, 'a Team boot has a team.yaml')
  const before = fs.readFileSync(teamConfigPath, 'utf8')
  const after = edit(before)
  assert.notEqual(after, before, 'the edit changed the team.yaml')
  fs.writeFileSync(teamConfigPath, after)
}

function renameTeam(runtime: FixtureRuntime, name: string): void {
  editTeamConfig(runtime, (text) => text.replace(`team:\n  name: ${TEAM_NAME}\n`, `team:\n  name: ${name}\n`))
}

function teamRoot(runtime: FixtureRuntime): string {
  const teamConfigPath = runtime.teamConfigPath
  assert.ok(teamConfigPath, 'a Team boot has a team.yaml')
  return path.dirname(teamConfigPath)
}

/** The Team name on the one `run.incomplete` record shutdown wrote. */
async function teamOnIncompleteRun(runtime: FixtureRuntime): Promise<unknown> {
  await runtime.shutdown()
  return onlyEvent(runtime.assignmentPath, 'run.incomplete').team
}

function checkpointFields(assignmentPath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(getRunRuntimePaths(assignmentPath).checkpointPath, 'utf8'),
  )
  assert.ok(isRecord(parsed), 'a checkpoint is a JSON object')
  return parsed
}

/**
 * The block `boot` prints for the configuration warnings, one entry per
 * console line.
 */
function configWarningBlock(warnings: readonly string[]): string[] {
  const yellow = '\x1b[33m'
  const bold = '\x1b[1m'
  const dim = '\x1b[2m'
  const reset = '\x1b[0m'
  const count = String(warnings.length)
  return [
    '',
    `${yellow}${bold}╔${'═'.repeat(62)}╗${reset}`,
    `${yellow}${bold}║  ⚠  CONFIG WARNINGS (${count})${' '.repeat(39 - count.length)}║${reset}`,
    `${yellow}${bold}╚${'═'.repeat(62)}╝${reset}`,
    ...warnings.map((warning) => `${yellow}  ⚠  ${warning}${reset}`),
    `${dim}${'─'.repeat(64)}${reset}`,
    '',
  ]
}

const RATE_LIMIT_WARNING = 'rate_limiting.max_concurrent must be >= 1 (got 0), clamping to 1'

// ── A first boot that refuses ────────────────────────────────────────────────

test('boot refuses a team still being built before it resolves the assignment scope or checks the overrides and boot entry from the environment, TEAM_CONFIG_OVERRIDES_JSON before TEAM_BOOT_ENTRY_JSON, and prints the configuration warnings only once both pass', {
  timeout: 60_000,
}, async (t) => {
  const warnLines = captureConsole(t, 'warn')
  await withCleanup(async (defer) => {
    const runtime = await bootScoped(defer, {
      label: 'boot-refusal-order',
      team: { coordinator: COORDINATOR },
      env: { TEAM_CONFIG_OVERRIDES_JSON: '{', TEAM_BOOT_ENTRY_JSON: '{' },
    })
    const assignmentPath = runtime.assignmentPath
    // The team.yaml names a workspace of its own; TEAM_WORKSPACE_PATH, which
    // the fixture sets to `runtime.workspace`, replaces it.
    const configuredWorkspace = path.join(runtime.root, 'configured-workspace')
    editTeamConfig(runtime, (text) =>
      text
        .replace('team:\n', 'team:\n  building: true\n')
        .replace(`path: ${JSON.stringify(runtime.workspace)}`, `path: ${JSON.stringify(configuredWorkspace)}`) +
      'rate_limiting:\n  max_concurrent: 0\n')

    await runtime.startSession()
    const building = `Team '${TEAM_NAME}' is still being built and cannot be run yet. Wait for its build to finish.`
    assert.deepEqual(errorNotices(runtime), [configErrorNotice([building])])
    assert.deepEqual(
      recordedConfigErrors(assignmentPath),
      [],
      'a team still being built is refused before the assignment scope is read, so it has nowhere to record the refusal',
    )

    editTeamConfig(runtime, (text) => text.replace('team:\n  building: true\n', 'team:\n'))
    await runtime.startSession()
    assert.deepEqual(
      recordedConfigErrors(assignmentPath),
      [['Invalid TEAM_CONFIG_OVERRIDES_JSON.']],
      'the overrides are refused first, and at the assignment TEAM_WORKSPACE_PATH places',
    )
    assert.equal(errorNotices(runtime).at(-1), configErrorNotice(['Invalid TEAM_CONFIG_OVERRIDES_JSON.']))

    delete process.env.TEAM_CONFIG_OVERRIDES_JSON
    await runtime.startSession()
    assert.deepEqual(recordedConfigErrors(assignmentPath), [
      ['Invalid TEAM_CONFIG_OVERRIDES_JSON.'],
      ['Invalid TEAM_BOOT_ENTRY_JSON.'],
    ])
    assert.equal(errorNotices(runtime).at(-1), configErrorNotice(['Invalid TEAM_BOOT_ENTRY_JSON.']))
    assert.equal(
      warnLines.filter((line) => line.includes('CONFIG WARNINGS')).length,
      0,
      'no boot refused by its config or environment prints the configuration warnings',
    )
    assert.equal(errorNotices(runtime).length, 3)

    delete process.env.TEAM_BOOT_ENTRY_JSON
    await runtime.startSession()
    assert.equal(errorNotices(runtime).length, 3, 'the fourth start raised no error')
    assert.equal(startNotices(runtime, TEAM_NAME).length, 1, 'the fourth start booted the Team')
    assert.ok(runtime.host.registered.length > 0, 'the booted Team registered its tools')
    assert.deepEqual(await runtime.host.callHandler('input'), { action: 'continue' }, 'the earlier config errors were cleared')
    const header = warnLines.findIndex((line) => line.includes('CONFIG WARNINGS'))
    assert.equal(warnLines.filter((line) => line.includes('CONFIG WARNINGS')).length, 1)
    const expected = configWarningBlock([RATE_LIMIT_WARNING])
    assert.deepEqual(warnLines.slice(header - 2, header - 2 + expected.length), expected)
    assert.equal(fs.existsSync(configuredWorkspace), false, 'nothing is written to the workspace TEAM_WORKSPACE_PATH replaced')
    assertNoAgentRan(assignmentPath)
  })
})

// ── What a later session_start inherits ──────────────────────────────────────

test('a session_start that finds no team.yaml enters setup mode, and a later session_start that boots a Team stays in it', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const runtime = await bootFixtureRuntime({
      label: 'boot-setup-mode-kept',
      setupMode: true,
      unsetEnv: [...IDENTITY_ENV],
      startSession: false,
    })
    defer(() => runtime.close())
    await runtime.startSession()
    assert.equal(runtime.host.notifications.length, 1)
    assert.equal(runtime.host.notifications[0]?.level, 'info')
    assert.ok(runtime.host.notifications[0]?.message.startsWith('No team.yaml found in this directory.'))

    process.env.TEAM_CONFIG_PATH = writeFixtureTeam({
      teamRoot: path.join(runtime.root, 'team'),
      workspacePath: runtime.workspace,
      coordinator: COORDINATOR,
    })
    await runtime.startSession()
    assert.deepEqual(errorNotices(runtime), [])
    assert.equal(startNotices(runtime, TEAM_NAME).length, 1, 'the second start booted the Team')
    assert.ok(runtime.host.registered.length > 0, 'the booted Team registered its tools')

    const setupPrompt = parseAgentFrontmatter(path.join(process.cwd(), 'setup', 'setup-agent.md')).body
    assert.deepEqual(
      await runtime.host.callHandler('before_agent_start', { systemPrompt: 'base prompt' }),
      { systemPrompt: setupPrompt },
      'the host is still given the setup agent prompt',
    )
    assertNoAgentRan(runtime.assignmentPath)
  })
})

test('a session_start boots with the entry TEAM_BOOT_ENTRY_JSON names, and a later session_start without it boots with none', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const runtime = await bootScoped(defer, {
      label: 'boot-entry-reset',
      team: { coordinator: COORDINATOR },
    })
    process.env.TEAM_BOOT_ENTRY_JSON = JSON.stringify({
      type: 'team',
      name: 'fixture-entry',
      team_path: teamRoot(runtime),
    })
    await runtime.startSession()
    delete process.env.TEAM_BOOT_ENTRY_JSON
    await runtime.startSession()

    assert.deepEqual(errorNotices(runtime), [])
    const bootEntries = readAssignmentJsonl(runtime.assignmentPath, ASSIGNMENT_LOG.hostEvents)
      .filter((record) => record.event === 'host.session_start')
      .map((record) => record.boot_entry)
    assert.deepEqual(bootEntries, ['fixture-entry', null])
    assertNoAgentRan(runtime.assignmentPath)
  })
})

test('a session_start booted from start.yaml takes the entry TEAM_BOOT_ENTRY_JSON names over the start.yaml entry, and a later session_start without it boots with the start.yaml entry', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    // Setup mode leaves TEAM_CONFIG_PATH unset and the host in an empty
    // directory, so boot finds the Team through the start.yaml written there.
    const runtime = await bootFixtureRuntime({
      label: 'boot-entry-start-yaml',
      setupMode: true,
      unsetEnv: [...IDENTITY_ENV],
      startSession: false,
    })
    defer(() => runtime.close())
    const startTeam = path.join(runtime.root, 'start-team')
    writeFixtureTeam({ teamRoot: startTeam, workspacePath: runtime.workspace, coordinator: COORDINATOR })
    const hostCwd = path.join(runtime.root, 'empty-cwd')
    fs.writeFileSync(
      path.join(hostCwd, 'teams.yaml'),
      `start-entry:\n  type: team\n  description: The entry start.yaml names\n  team_path: ${JSON.stringify(startTeam)}\n`,
    )
    fs.writeFileSync(path.join(hostCwd, 'start.yaml'), 'entry: start-entry\nregistry: ./teams.yaml\n')

    process.env.TEAM_BOOT_ENTRY_JSON = JSON.stringify({ type: 'team', name: 'env-entry', team_path: startTeam })
    await runtime.startSession()
    delete process.env.TEAM_BOOT_ENTRY_JSON
    await runtime.startSession()

    assert.deepEqual(errorNotices(runtime), [])
    assert.equal(startNotices(runtime, TEAM_NAME).length, 2, 'both starts booted the Team')
    const bootEntries = readAssignmentJsonl(runtime.assignmentPath, ASSIGNMENT_LOG.hostEvents)
      .filter((record) => record.event === 'host.session_start')
      .map((record) => record.boot_entry)
    assert.deepEqual(bootEntries, ['env-entry', 'start-entry'])
    assertNoAgentRan(runtime.assignmentPath)
  })
})

test('a later session_start refused by TEAM_BOOT_ENTRY_JSON keeps the Team config the earlier session booted', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const runtime = await bootScoped(defer, {
      label: 'boot-entry-refusal-keeps-config',
      team: { coordinator: COORDINATOR },
    })
    await runtime.startSession()
    assert.deepEqual(errorNotices(runtime), [], 'precondition: the first start booted')

    renameTeam(runtime, RENAMED_TEAM)
    process.env.TEAM_BOOT_ENTRY_JSON = '{'
    await runtime.startSession()
    assert.deepEqual(recordedConfigErrors(runtime.assignmentPath), [['Invalid TEAM_BOOT_ENTRY_JSON.']])

    assert.equal(await teamOnIncompleteRun(runtime), TEAM_NAME)
    assertNoAgentRan(runtime.assignmentPath)
  })
})

test('a later session_start refused by its workflow registry has replaced the Team config, and records every registry error in order', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const runtime = await bootScoped(defer, {
      label: 'boot-registry-refusal',
      team: { coordinator: COORDINATOR },
    })
    await runtime.startSession()
    assert.deepEqual(errorNotices(runtime), [], 'precondition: the first start booted')

    renameTeam(runtime, RENAMED_TEAM)
    const workflowsDir = path.join(teamRoot(runtime), 'workflows')
    fs.mkdirSync(workflowsDir)
    fs.writeFileSync(
      path.join(workflowsDir, 'registry.yaml'),
      'alpha:\n  description: First\nbeta:\n  description: Second\n',
    )
    await runtime.startSession()
    const registryErrors = [
      "Workflow registry entry 'alpha': template_path is required",
      "Workflow registry entry 'beta': template_path is required",
    ]
    assert.deepEqual(recordedConfigErrors(runtime.assignmentPath), [registryErrors])
    assert.equal(errorNotices(runtime).at(-1), configErrorNotice(registryErrors))

    assert.equal(await teamOnIncompleteRun(runtime), RENAMED_TEAM)
    assertNoAgentRan(runtime.assignmentPath)
  })
})

test('a later session_start whose input files cannot be read fails the start after it has replaced the Team config', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const runtime = await bootScoped(defer, {
      label: 'boot-input-files-failure',
      team: { coordinator: COORDINATOR },
    })
    await runtime.startSession()
    assert.deepEqual(errorNotices(runtime), [], 'precondition: the first start booted')

    renameTeam(runtime, RENAMED_TEAM)
    // A file where the input directory belongs: listing it fails with ENOTDIR.
    fs.writeFileSync(path.join(teamRoot(runtime), 'input-files'), 'not a directory')
    await runtime.startSession()
    const notices = errorNotices(runtime)
    assert.equal(notices.length, 1)
    assert.ok(notices[0]?.startsWith('Team runtime failed to start:\n'), notices[0])
    assert.match(String(onlyEvent(runtime.assignmentPath, 'runtime.host_start_failed').error), /ENOTDIR/)

    assert.equal(await teamOnIncompleteRun(runtime), RENAMED_TEAM)
    assertNoAgentRan(runtime.assignmentPath)
  })
})

test('a later session_start refused by its readiness checks has moved to the new entry level but keeps every level state of the earlier session', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const twoLevels: Omit<FixtureTeamOptions, 'teamRoot' | 'workspacePath'> = {
      coordinator: COORDINATOR,
      laterLevels: [{ id: 'next', coordinator: NEXT_COORDINATOR }],
    }
    const runtime = await bootScoped(defer, { label: 'boot-readiness-keeps-levels', team: twoLevels })
    await runtime.startSession()
    assert.deepEqual(errorNotices(runtime), [], 'precondition: the first start booted')
    const firstLevelStates = checkpointFields(runtime.assignmentPath).levelStates
    assert.deepEqual(
      Array.isArray(firstLevelStates) && firstLevelStates.map((entry: unknown) => isRecord(entry) && [entry.levelId, entry.status]),
      [['intake', 'active'], ['next', 'pending']],
      'precondition: the first start saved the entry level active',
    )

    // The same Team, renamed, entered at `next`, with a third level whose
    // coordinator has no persona file.
    writeFixtureTeam({
      ...twoLevels,
      teamName: RENAMED_TEAM,
      teamRoot: teamRoot(runtime),
      workspacePath: runtime.workspace,
      laterLevels: [
        { id: 'next', coordinator: NEXT_COORDINATOR },
        { id: 'extra', coordinator: { name: 'extra-lead', loadable: false } },
      ],
    })
    editTeamConfig(runtime, (text) => text.replace('  entry_level: intake\n', '  entry_level: next\n'))
    await runtime.startSession()
    const [refusal] = recordedConfigErrors(runtime.assignmentPath)
    assert.ok(Array.isArray(refusal) && refusal.length === 1, JSON.stringify(refusal))
    assert.match(String(refusal[0]), /level 'extra' declares coordinator 'extra-lead', which is not a loaded Agent/)

    assert.equal(await teamOnIncompleteRun(runtime), RENAMED_TEAM)
    const saved = checkpointFields(runtime.assignmentPath)
    assert.equal(saved.currentLevelIndex, 1, 'the refused boot had already moved to its entry level')
    assert.deepEqual(saved.levelStates, firstLevelStates, 'the refused boot neither reset nor activated a level state')
    assertNoAgentRan(runtime.assignmentPath)
  })
})
