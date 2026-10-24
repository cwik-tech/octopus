/**
 * The runtime itself refuses to boot a team that is still being built.
 *
 * The delegated resolver, Team Chat and workflow validation each refuse one
 * before a process is started. None of them is on the path a direct boot takes:
 * `TEAM_CONFIG_PATH` points the runtime straight at a team.yaml, and the
 * runtime read it and started. This is the last guard, and it is the app's own.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  createFixtureHost,
  writeFixtureTeam,
} from '../support/team-runtime-fixture-boot.js'

const repoRoot = process.cwd()

/** Sets the runtime's environment, restoring it afterwards. */
function applyRuntimeEnv(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('the runtime refuses to boot a team whose build has not finished', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'building-boot-guard-'))
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  const teamConfigPath = writeFixtureTeam({
    teamRoot: path.join(root, 'team'),
    workspacePath: workspace,
    coordinator: { name: 'intake-agent', tools: [] },
  })
  // The marker a build leaves while it is assembling the team.
  fs.writeFileSync(
    teamConfigPath,
    fs
      .readFileSync(teamConfigPath, 'utf8')
      .replace(/^team:\n/mu, 'team:\n  building: true\n'),
  )

  const restoreEnv = applyRuntimeEnv({
    TEAM_CONFIG_PATH: teamConfigPath,
    TEAM_WORKSPACE_PATH: workspace,
    TEAM_RUNTIME_WORKSPACE_PATH: workspace,
    TEAM_RUNTIME_START_SERVICES: '0',
    // The compiled test runs from .tests-dist, so the parser entry cannot be
    // discovered relative to this module. Point it at the real source entry.
    TEAM_RUNTIME_FILE_PARSER_ENTRY: path.join(repoRoot, 'file-parser/index.ts'),
    TEAM_TENANT_ID: 'local',
  })
  try {
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

    const refusal = host.notifications.find((note) =>
      /still being built/iu.test(note.message),
    )
    assert.ok(
      refusal,
      `expected a refusal, saw ${JSON.stringify(host.notifications)}`,
    )
    assert.equal(refusal.level, 'error')
  } finally {
    restoreEnv()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
