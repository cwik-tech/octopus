/**
 * Team Runtime boot coverage that survives a machine with no agent CLI.
 *
 * `team-runtime-receptionist-tools.test.ts` and
 * `team-runtime-journal-public-boundary.test.ts` boot the shipped reception
 * desk, whose receptionist declares the `codex` provider. The runtime refuses
 * to start a Team whose provider is unready, so both tests carry
 * `skip: agentCliSkipReason('codex')` — correct, and fatal for CI, where that
 * binary never exists. The Team Runtime boot path had no coverage left there
 * at all.
 *
 * This drives the same boot with a fixture Team whose persona declares
 * `lm-studio`, which is ready without a binary, a credential or a network
 * call — the same reason `tests/unit/team-builder-health.test.ts` builds its
 * fixture Teams on it. Nothing about the runtime is stubbed: the real
 * `team-runtime/index.ts` extension, the real provider preflight, the real
 * `registerLevelTools`, the real capability dispatcher, the real execution
 * journal. Only the Pi host around it is a fixture, exactly as in the two
 * tests above.
 *
 * The shipped-config tests are still the ones that prove the shipped config.
 * This proves the boot path, everywhere.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { readExecutionJournal } from '../../core/execution-journal.js'
import { reconcileWorkspaceTenantPin } from '../../services/execution-journal-tenant-pin.js'
import {
  createFixtureHost,
  writeFixtureTeam,
  FIXTURE_HOST_MODEL_ID,
  FIXTURE_HOST_PROVIDER,
} from '../support/team-runtime-fixture-boot.js'

const repoRoot = process.cwd()

const SESSION_ID = 'session-fixture-boot'
const RUN_ID = 'run-fixture-boot'
const ASSIGNMENT_ID = 'assignment-fixture-boot'
const INVOCATION_DEADLINE_MS = 20_000

function walkFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walkFiles(path.join(directory, entry.name))
      : [path.join(directory, entry.name)],
  )
}

function applyRuntimeEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value
  }
}

function restoreEnv(previousEnv: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in previousEnv)) delete process.env[key]
  }
  Object.assign(process.env, previousEnv)
}

test('the real Team Runtime boots a fixture Team with no agent CLI and journals its governed tool call', {
  timeout: 60_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-runtime-fixture-boot-'))
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  const previousEnv = { ...process.env }

  // Deterministic acceptance scope: authoritative mode under the local tenant,
  // pinned before the runtime boots.
  await reconcileWorkspaceTenantPin({
    workspacePath: workspace,
    tenantId: 'local',
    mode: 'authoritative',
  })

  const teamConfigPath = writeFixtureTeam({
    teamRoot: path.join(root, 'team'),
    workspacePath: workspace,
    coordinator: {
      name: 'intake-agent',
      // The one grant. `bash` and `write` are absent, so the governed Pi
      // builtins must not register — the shipped receptionist's contract,
      // stated by a persona this test owns.
      tools: ['spawn_team', 'inspect-task-state'],
    },
  })

  let runSessionShutdown: (() => Promise<void>) | undefined
  try {
    applyRuntimeEnv({
      TEAM_CONFIG_PATH: teamConfigPath,
      TEAM_WORKSPACE_PATH: workspace,
      TEAM_RUNTIME_WORKSPACE_PATH: workspace,
      // Dev services start by default during session_start and would bind ports.
      TEAM_RUNTIME_START_SERVICES: '0',
      TEAM_RUNTIME_SESSION_ID: SESSION_ID,
      TEAM_RUNTIME_RUN_ID: RUN_ID,
      TEAM_RUNTIME_ASSIGNMENT_ID: ASSIGNMENT_ID,
      TEAM_RUNTIME_TASK_ID: 'task-fixture-boot',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-fixture-boot',
      // The compiled test runs from .tests-dist, so the parser entry cannot be
      // discovered relative to this module. Point it at the real source entry.
      TEAM_RUNTIME_FILE_PARSER_ENTRY: path.join(repoRoot, 'file-parser/index.ts'),
      PIPELINE_DURABLE_JOURNAL: 'authoritative',
      TEAM_TENANT_ID: 'local',
    })

    const { default: teamRuntimeExtension } = await import(
      '../../team-runtime/index.js'
    )
    const host = createFixtureHost(repoRoot)

    teamRuntimeExtension(host.pi as never)
    const shutdownHandler = host.handlers.get('session_shutdown')
    if (shutdownHandler) {
      runSessionShutdown = () => (shutdownHandler as () => Promise<void>)()
    }
    const sessionStart = host.handlers.get('session_start')
    assert.ok(sessionStart, 'the extension must register a session_start handler')
    await (sessionStart as (event: unknown, context: unknown) => Promise<void>)(
      {},
      host.extensionContext,
    )

    const registeredNames = host.registered.map((tool) => tool.name).sort()

    // 1. The boot got far enough to register. A refused provider preflight
    //    registers nothing at all, so name what the runtime reported instead
    //    of asserting on a symptom of it.
    assert.ok(
      registeredNames.length > 0,
      'the runtime registered no tool; it reported: ' +
        JSON.stringify(host.notifications.map((entry) => entry.message)),
    )

    // 2. The boot put the host on the coordinator's own pair. This is the
    //    substitution the whole fixture rests on: the runtime resolved
    //    `lm-studio` through the same `applyHostModelPreference` that would
    //    have demanded a CLI for `codex`, and found it ready.
    assert.deepEqual(
      host.hostModelSwitches.map((model) => `${model.provider}:${model.id}`),
      [`${FIXTURE_HOST_PROVIDER}:${FIXTURE_HOST_MODEL_ID}`],
    )

    // 3. The registration the coordinator depends on actually ran.
    assert.ok(
      registeredNames.includes('inspect-task-state'),
      `inspect-task-state must be registered; got ${registeredNames.join(', ')}`,
    )

    // 4. The level allow-set the runtime itself computed. A helper test cannot
    //    see this: it proves the runtime still calls the resolver and that the
    //    resolver's answer includes the tool.
    const assignmentPath = path.join(
      workspace, 'sessions', SESSION_ID,
      'runs', RUN_ID, 'assignments', ASSIGNMENT_ID,
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

    // 5. A shell and an arbitrary write are never registered for a persona
    //    that did not ask for one: the governed Pi builtins are filtered by
    //    the coordinator's own `tools:` grant.
    assert.equal(
      registeredNames.includes('bash'),
      false,
      `no shell may be registered for this persona; got ${registeredNames.join(', ')}`,
    )
    assert.equal(
      registeredNames.includes('write'),
      false,
      `no arbitrary write may be registered for this persona; got ${registeredNames.join(', ')}`,
    )

    // 6. The real dispatch policy still refuses a registered tool the
    //    coordinator did not declare.
    const browser = host.registered.find((tool) => tool.name === 'browser')
    assert.ok(browser, 'browser is registered globally and must be policy-denied here')
    await assert.rejects(
      browser.execute(
        'call-browser',
        { action: 'observe' },
        undefined,
        undefined,
        host.extensionContext,
      ),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'tool_not_allowed_for_agent')
        return true
      },
    )

    // 7. A governed tool invoked through the real runtime travels the
    //    production path — registerLevelTools → ensureCapabilityDispatcher →
    //    the capability dispatch factory → governed dispatch — and lands on
    //    the assignment's durable journal authority. A governed tool throws
    //    unless its dispatch completes, so a returned value means the dispatch
    //    ran to a completed terminal.
    const inspectTaskState = host.registered.find(
      (tool) => tool.name === 'inspect-task-state',
    )
    assert.ok(inspectTaskState)
    const invocation: unknown = await inspectTaskState.execute(
      'call-inspect-task-state-fixture',
      { taskId: 'task-inspect-fixture' },
      AbortSignal.timeout(INVOCATION_DEADLINE_MS),
      undefined,
      host.extensionContext,
    )
    assert.ok(
      typeof invocation === 'object' && invocation !== null,
      'the governed invocation must complete and return a result',
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
    // Runs even when an assertion throws, so runtime resources are released on
    // the failure path too. Awaited without a catch so a shutdown failure stays
    // visible instead of being swallowed.
    if (runSessionShutdown) await runSessionShutdown()
    restoreEnv(previousEnv)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a fixture Team whose persona declares an unready provider registers no tool at all', {
  timeout: 60_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-runtime-unready-provider-'))
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  const previousEnv = { ...process.env }

  // `xai` stands in for `codex` here on purpose. The readiness rule is the
  // same branch of `validateLoadedAgentProviders`, but a missing environment
  // variable is missing on every machine, while a missing CLI is not — and a
  // test that only failed on a runner without the binary would be the very
  // skip this file exists to replace.
  const teamConfigPath = writeFixtureTeam({
    teamRoot: path.join(root, 'team'),
    workspacePath: workspace,
    coordinator: {
      name: 'intake-agent',
      provider: 'xai',
      model: 'grok-4',
      tools: ['spawn_team', 'inspect-task-state'],
    },
  })

  try {
    applyRuntimeEnv({
      TEAM_CONFIG_PATH: teamConfigPath,
      TEAM_WORKSPACE_PATH: workspace,
      TEAM_RUNTIME_WORKSPACE_PATH: workspace,
      TEAM_RUNTIME_START_SERVICES: '0',
      TEAM_RUNTIME_SESSION_ID: 'session-unready-provider',
      TEAM_RUNTIME_RUN_ID: 'run-unready-provider',
      TEAM_RUNTIME_ASSIGNMENT_ID: 'assignment-unready-provider',
      TEAM_RUNTIME_TASK_ID: 'task-unready-provider',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-unready-provider',
      TEAM_RUNTIME_FILE_PARSER_ENTRY: path.join(repoRoot, 'file-parser/index.ts'),
      TEAM_TENANT_ID: 'local',
    })
    delete process.env.XAI_API_KEY

    const { default: teamRuntimeExtension } = await import(
      '../../team-runtime/index.js'
    )
    const host = createFixtureHost(repoRoot)

    teamRuntimeExtension(host.pi as never)
    const sessionStart = host.handlers.get('session_start')
    assert.ok(sessionStart, 'the extension must register a session_start handler')
    await (sessionStart as (event: unknown, context: unknown) => Promise<void>)(
      {},
      host.extensionContext,
    )

    // The refusal happens before a single tool registers. This is why a test
    // that boots a Team declaring an absent CLI cannot assert on the booted
    // runtime at all, and why the shipped-config tests skip instead.
    assert.deepEqual(
      host.registered.map((tool) => tool.name),
      [],
      'an unready agent provider must stop the boot before any registration',
    )
    const reported = host.notifications.map((entry) => entry.message).join('\n')
    assert.match(
      reported,
      /agent 'intake-agent' cannot use provider 'xai': missing XAI_API_KEY/,
    )

    const shutdown = host.handlers.get('session_shutdown')
    if (shutdown) await (shutdown as () => Promise<void>)()
  } finally {
    restoreEnv(previousEnv)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
