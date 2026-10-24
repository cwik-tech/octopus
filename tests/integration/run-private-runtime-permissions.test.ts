import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { CapabilityExecutionContext } from '../../contracts/capability-dispatch.js'
import { runTeam } from '../../domains/agent-execution/agent-runner.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { writeCheckpoint } from '../../domains/runtime/checkpoint.js'
import { ensureRunPrivateRuntimeDirectory } from '../../domains/runtime/runtime-paths.js'
import { writeFileAtomicSync } from '../../core/file-mutation.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'

/**
 * AC17: Pipeline must not create an assignment it cannot then enrol.
 *
 * `writeFileAtomicSync` creates parent directories with no mode, so under a
 * normal umask the run-private `.runtime` directory lands at 0755. The journal
 * refuses to open under a directory with any group or other permission bit and
 * never repairs the mode, so every dispatch on that assignment fails closed
 * forever. The delegated-agent launcher hits this on a shipped workflow shape:
 * it writes `human-input-routing.json` into a fresh child assignment's
 * `.runtime` before any journal exists.
 */

const TENANT = 'tenant-runtime-permissions'

const ROUTING = {
  interactionId: 'interaction-one',
  source: 'step-one',
  messages: [{ id: 'message-one', text: 'proceed?', recipients: 'all' as const }],
}

function makeWorkspace(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-permissions-')),
  )
}

function assignmentDir(workspacePath: string, assignmentId: string): string {
  const directory = path.join(
    workspacePath,
    'sessions',
    'session-one',
    'runs',
    'run-one',
    'assignments',
    assignmentId,
  )
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

function makeContext(assignmentId: string): CapabilityExecutionContext {
  return {
    contractVersion: 1,
    requestId: `request-${assignmentId}`,
    sessionId: 'session-one',
    runId: 'run-one',
    assignmentId,
    agentPath: 'agents/child',
    authority: { kind: 'runtime-assignment', processIdentity: 'child' },
  }
}

function modeOf(directory: string): number {
  return fs.statSync(directory).mode & 0o777
}

/** A fake `pi` on PATH, so `runTeam` spawns a real child without a provider. */
async function withFakePi<T>(
  handlerSource: string,
  run: () => Promise<T>,
): Promise<T> {
  const binDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'runtime-permissions-pi-'),
  )
  fs.writeFileSync(path.join(binDirectory, 'pi'), `#!/usr/bin/env node\n${handlerSource}\n`, {
    mode: 0o755,
  })
  const originalPath = process.env.PATH
  const originalBundledCli = process.env.TEAM_RUNTIME_PI_CLI_PATH
  process.env.PATH = `${binDirectory}${path.delimiter}${originalPath ?? ''}`
  delete process.env.TEAM_RUNTIME_PI_CLI_PATH
  try {
    return await run()
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    if (originalBundledCli !== undefined) {
      process.env.TEAM_RUNTIME_PI_CLI_PATH = originalBundledCli
    }
    fs.rmSync(binDirectory, { recursive: true, force: true })
  }
}

test('a delegated child launched with human-input routing can enrol its journal', async () => {
  // Driven through `runTeam`, the production path that creates the child
  // assignment and seeds its private runtime directory. A test that called the
  // routing helper directly would stay green if `runTeam` were reverted to the
  // unsafe write, which is exactly the regression worth catching.
  await withFakePi(
    `require('node:fs').writeFileSync(require('node:path').join(process.cwd(), 'out.json'), '{}')`,
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-permissions-run-'))
      const workspacePath = path.join(root, 'workspace')
      const teamPath = path.join(root, 'child-team')
      const registry = new WorkspaceExecutionJournalRegistry({
        workspacePath,
        tenantId: TENANT,
        mode: 'authoritative',
      })
      try {
        fs.mkdirSync(teamPath, { recursive: true })
        const parentAssignmentLocation = buildSessionRunAssignmentLocation(
          workspacePath,
          {
            sessionId: 'session-one',
            runId: 'run-one',
            assignmentId: 'root-assignment',
          },
        )
        assert.ok(parentAssignmentLocation)

        await runTeam({
          teamPath,
          workspacePath,
          workspacePathOverride: workspacePath,
          brief: 'Exercise the delegated routing path.',
          childSessionId: 'child-assignment',
          outputArtifact: 'out.json',
          spawnDepth: 0,
          rootSessionId: 'run-one',
          parentSessionId: 'root-assignment',
          parentAssignmentLocation,
          humanInputRouting: ROUTING,
        })

        const childAssignmentPath = path.join(
          workspacePath,
          'sessions',
          'session-one',
          'runs',
          'run-one',
          'assignments',
          'child-assignment',
        )
        assert.equal(
          modeOf(path.join(childAssignmentPath, '.runtime')),
          0o700,
          'the child\'s private runtime directory must be created private',
        )

        const port = await registry.resolve({
          context: makeContext('child-assignment'),
          signal: new AbortController().signal,
          deadlineMs: Date.now() + 5_000,
        })
        assert.ok(port, 'the child assignment must be able to enrol')
      } finally {
        await registry.close()
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  )
})

test('a checkpoint written before any journal leaves the assignment able to enrol', async () => {
  // The same defect as above, reached by a different writer. Before the fix,
  // `writeCheckpoint` resolved a path under `.runtime` and handed it straight
  // to `writeFileAtomicSync`, which creates missing parents with no mode — so
  // on a fresh assignment the private directory used to be created by the
  // atomic write, at the umask.
  //
  // Every host turn persists state, and `team-advance` persists before any
  // governed tool runs, so an ordinary run reached this first and could then
  // never enrol: the journal refuses a relaxed private directory and never
  // repairs it (`core/execution-journal.ts:747-751`). `writeCheckpoint` now
  // creates `.runtime` through the owner that sets its mode, which is what
  // this test holds it to.
  const workspacePath = makeWorkspace()
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  try {
    const assignmentPath = assignmentDir(workspacePath, 'checkpointed-assignment')
    assert.equal(
      fs.existsSync(path.join(assignmentPath, '.runtime')),
      false,
      'precondition: nothing has created the private runtime directory yet',
    )

    writeCheckpoint(assignmentPath, {
      sessionId: 'session-one',
      tenantId: TENANT,
      currentLevelIndex: 0,
      levelStates: new Map(),
      totalCost: 0,
      startTime: 0,
      timerStarted: false,
      endTime: null,
      spawnDepth: 0,
    })

    assert.equal(
      modeOf(path.join(assignmentPath, '.runtime')),
      0o700,
      'persisting state must not be what creates a world-readable private directory',
    )

    const port = await registry.resolve({
      context: makeContext('checkpointed-assignment'),
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5_000,
    })
    assert.ok(
      port,
      'and the assignment must still be able to enrol its journal afterwards',
    )
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('the run-private runtime directory owner creates it private, and a later atomic write leaves the mode alone', () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = assignmentDir(workspacePath, 'owned-assignment')

    const privateRuntimePath = ensureRunPrivateRuntimeDirectory(assignmentPath)
    assert.equal(
      modeOf(privateRuntimePath),
      0o700,
      'the owner must create the private runtime directory at 0700',
    )

    writeFileAtomicSync(
      path.join(privateRuntimePath, 'some-file.json'),
      JSON.stringify({ written: true }),
    )
    assert.equal(
      modeOf(privateRuntimePath),
      0o700,
      'writing into an existing private runtime directory must not relax it',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
