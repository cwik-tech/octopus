/**
 * One member pinned to a CLI this machine does not have must not stop the Team.
 *
 * Per-agent provider and model choice is the product's point — a critic on a
 * reasoning model, a router on a cheap one — and 93 of the 94 bundled personas
 * declare a pin on purpose. But `initialize()` refuses on any entry in
 * `ctx.configErrors`, and `validateLoadedAgentProviders` wrote one there for
 * every unready pin, so a single missing binary took the whole roster down.
 * On a machine without `codex` or `claude` that is almost every bundled Team.
 *
 * This boots the real Team Runtime — the real extension, the real provider
 * preflight, the real tool registration — with a roster whose coordinator is
 * ready and whose second member pins `codex` on a PATH where no CLI exists.
 * Only the Pi host around it is a fixture, as in the other boot tests here.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { reconcileWorkspaceTenantPin } from '../../services/execution-journal-tenant-pin.js'
import {
  createFixtureHost,
  writeFixtureTeam,
  FIXTURE_HOST_MODEL_ID,
  FIXTURE_HOST_PROVIDER,
} from '../support/team-runtime-fixture-boot.js'
import { DEFAULT_MODEL_SELECTION_ENV } from '../../domains/provider/provider-settings.js'

const repoRoot = process.cwd()

const SESSION_ID = 'session-pinned-provider'
const RUN_ID = 'run-pinned-provider'
const ASSIGNMENT_ID = 'assignment-pinned-provider'

/**
 * The application default, as a spawned runtime receives it.
 *
 * The deferral only happens when there is a different, available pair to offer
 * instead, and a child runtime reads that pair from this variable rather than
 * from the in-process setter.
 */
function encodedAppDefault(provider: string, model: string): string {
  return Buffer.from(
    JSON.stringify({ status: 'available', provider, model }),
    'utf8',
  ).toString('base64')
}

function restoreEnv(previousEnv: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in previousEnv)) delete process.env[key]
  }
  Object.assign(process.env, previousEnv)
}

test('a Team boots when one member pins a CLI that is not installed', {
  timeout: 60_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-runtime-pinned-'))
  const workspace = path.join(root, 'workspace')
  const emptyBin = path.join(root, 'empty-bin')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(emptyBin, { recursive: true })
  const previousEnv = { ...process.env }

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
      tools: ['spawn_team', 'inspect-task-state'],
    },
    members: [
      // The pin the product is built around, and the one 52 of the bundled
      // personas declare.
      { name: 'research-critic', provider: 'codex', model: 'gpt-5' },
    ],
  })

  let runSessionShutdown: (() => Promise<void>) | undefined
  try {
    Object.assign(process.env, {
      TEAM_CONFIG_PATH: teamConfigPath,
      TEAM_WORKSPACE_PATH: workspace,
      TEAM_RUNTIME_WORKSPACE_PATH: workspace,
      TEAM_RUNTIME_START_SERVICES: '0',
      TEAM_RUNTIME_SESSION_ID: SESSION_ID,
      TEAM_RUNTIME_RUN_ID: RUN_ID,
      TEAM_RUNTIME_ASSIGNMENT_ID: ASSIGNMENT_ID,
      TEAM_RUNTIME_TASK_ID: 'task-pinned-provider',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-pinned-provider',
      TEAM_RUNTIME_FILE_PARSER_ENTRY: path.join(repoRoot, 'file-parser/index.ts'),
      PIPELINE_DURABLE_JOURNAL: 'authoritative',
      TEAM_TENANT_ID: 'local',
      // No CLI of any kind is reachable, on this machine or on CI.
      PATH: emptyBin,
      PIPELINE_CLI_PATH_FALLBACK: '0',
      // A different pair the deferred member could actually be offered.
      [DEFAULT_MODEL_SELECTION_ENV]: encodedAppDefault(
        FIXTURE_HOST_PROVIDER,
        FIXTURE_HOST_MODEL_ID,
      ),
    })
    delete process.env.TEAM_RUNTIME_PI_CLI_PATH

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

    // A refused preflight registers nothing at all and reports why, so the
    // registration count is the boot itself and the notifications say what
    // stopped it when it did not happen.
    assert.ok(
      host.registered.length > 0,
      'the Team refused to boot; it reported: ' +
        JSON.stringify(host.notifications.map((entry) => entry.message)),
    )

    // Nothing told the user the Team cannot start. The pinned member's own
    // failure is deferred to its first dispatch, where it can become a choice.
    assert.deepEqual(
      host.notifications
        .map((entry) => entry.message)
        .filter((message) => /Team cannot start/.test(message)),
      [],
    )

    // The ready member still got the host it asked for.
    assert.deepEqual(
      host.hostModelSwitches.map((model) => `${model.provider}:${model.id}`),
      [`${FIXTURE_HOST_PROVIDER}:${FIXTURE_HOST_MODEL_ID}`],
    )
  } finally {
    if (runSessionShutdown) await runSessionShutdown()
    restoreEnv(previousEnv)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
