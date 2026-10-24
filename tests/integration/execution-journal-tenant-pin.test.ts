import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { ExecutionJournalConfigurationError } from '../../services/workspace-execution-journal-registry.js'
import {
  readTenantPin,
  reconcileWorkspaceTenantPin,
  tenantPinPath,
} from '../../services/execution-journal-tenant-pin.js'

/**
 * The tenant pin decides which tenant a workspace seals into every journal it
 * ever creates. A pin that can be redirected, left group-readable, or filled
 * with a value a manifest would reject is worse than no pin: it reads as a
 * guarantee while providing none.
 */

function makeWorkspace(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'journal-tenant-pin-')),
  )
}

function runtimeDir(workspacePath: string): string {
  return path.join(workspacePath, '.runtime')
}

async function pinFresh(workspacePath: string, tenantId: string): Promise<void> {
  await reconcileWorkspaceTenantPin({
    workspacePath,
    tenantId,
    mode: 'authoritative',
  })
}

function expectConfigurationError(variable: string) {
  return (error: unknown): true => {
    assert.ok(
      error instanceof ExecutionJournalConfigurationError,
      `expected a typed configuration error, got ${String(error)}`,
    )
    assert.equal(error.variable, variable)
    return true
  }
}

test('the pin is written private, and leaves no temporary file behind', async () => {
  const workspacePath = makeWorkspace()
  try {
    await pinFresh(workspacePath, 'local')

    assert.equal(fs.statSync(tenantPinPath(workspacePath)).mode & 0o777, 0o600)
    assert.equal(fs.statSync(runtimeDir(workspacePath)).mode & 0o777, 0o700)
    assert.deepEqual(
      fs.readdirSync(runtimeDir(workspacePath)).filter((name) => name.includes('.tmp-')),
      [],
      'the publication must not leave a temporary file behind',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a pin reached through a symlinked runtime directory is refused', async () => {
  const workspacePath = makeWorkspace()
  const elsewhere = makeWorkspace()
  try {
    // A `.runtime` that resolves outside the workspace can be swapped by
    // anything with write access to that other location.
    fs.mkdirSync(path.join(elsewhere, 'planted'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      path.join(elsewhere, 'planted', 'execution-journal-tenant.json'),
      `${JSON.stringify({ schemaVersion: 1, tenantId: 'attacker', pinnedAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    )
    fs.symlinkSync(path.join(elsewhere, 'planted'), runtimeDir(workspacePath))

    // Assert the diagnosis, not just the refusal. A symlink's own mode is
    // always group-readable, so the permissions guard would refuse this too —
    // and would tell the operator to fix permissions on a path that is really
    // a redirection.
    await assert.rejects(readTenantPin(workspacePath), (error: unknown) => {
      expectConfigurationError('TEAM_TENANT_ID')(error)
      assert.ok(error instanceof Error)
      assert.match(error.message, /symbolic link/)
      return true
    })
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(elsewhere, { recursive: true, force: true })
  }
})

test('a pin left readable by others is refused', async () => {
  const workspacePath = makeWorkspace()
  try {
    await pinFresh(workspacePath, 'local')
    fs.chmodSync(tenantPinPath(workspacePath), 0o644)

    await assert.rejects(
      readTenantPin(workspacePath),
      expectConfigurationError('TEAM_TENANT_ID'),
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a runtime directory left traversable by others is refused', async () => {
  const workspacePath = makeWorkspace()
  try {
    await pinFresh(workspacePath, 'local')
    fs.chmodSync(runtimeDir(workspacePath), 0o755)

    await assert.rejects(
      readTenantPin(workspacePath),
      expectConfigurationError('TEAM_TENANT_ID'),
    )
  } finally {
    fs.chmodSync(runtimeDir(workspacePath), 0o700)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a pin whose contents a manifest could never accept is refused', async () => {
  for (const [label, body] of [
    ['newline in tenant', { schemaVersion: 1, tenantId: 'acme\nlocal', pinnedAt: new Date().toISOString() }],
    ['padded tenant', { schemaVersion: 1, tenantId: ' acme', pinnedAt: new Date().toISOString() }],
    ['pinnedAt is not a date', { schemaVersion: 1, tenantId: 'acme', pinnedAt: 'not-a-date' }],
    ['wrong schema version', { schemaVersion: 2, tenantId: 'acme', pinnedAt: new Date().toISOString() }],
    ['tenant missing', { schemaVersion: 1, pinnedAt: new Date().toISOString() }],
  ] as const) {
    const workspacePath = makeWorkspace()
    try {
      fs.mkdirSync(runtimeDir(workspacePath), { recursive: true, mode: 0o700 })
      fs.writeFileSync(tenantPinPath(workspacePath), `${JSON.stringify(body)}\n`, {
        mode: 0o600,
      })

      await assert.rejects(
        readTenantPin(workspacePath),
        expectConfigurationError('TEAM_TENANT_ID'),
        label,
      )
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true })
    }
  }
})

test('a malformed pin fails as a configuration error, not a raw parse error', async () => {
  const workspacePath = makeWorkspace()
  try {
    fs.mkdirSync(runtimeDir(workspacePath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(tenantPinPath(workspacePath), '{ not json', { mode: 0o600 })

    await assert.rejects(readTenantPin(workspacePath), (error: unknown) => {
      assert.ok(
        error instanceof ExecutionJournalConfigurationError,
        `a SyntaxError escaping here would surface as an unexplained crash: ${String(error)}`,
      )
      return true
    })
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a matching pin does not excuse a workspace that has since diverged', async () => {
  const workspacePath = makeWorkspace()
  try {
    await pinFresh(workspacePath, 'local')

    // A journal sealed for another tenant appears after the pin was written —
    // copied in, restored from a backup, or produced by a build that predates
    // the pin. The pin still matches the environment, so an early return here
    // leaves the disagreement to surface one dispatch at a time mid-run, which
    // is the outcome the startup contract exists to prevent.
    await enrolTenant(workspacePath, 'assignment-foreign', 'acme')

    await assert.rejects(
      reconcileWorkspaceTenantPin({
        workspacePath,
        tenantId: 'local',
        mode: 'authoritative',
      }),
      (error: unknown) => {
        expectConfigurationError('TEAM_TENANT_ID')(error)
        assert.ok(error instanceof Error)
        assert.match(error.message, /acme/)
        return true
      },
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a workspace whose runtime directory is already world-traversable is never pinned', async () => {
  const workspacePath = makeWorkspace()
  try {
    // Something else created `.runtime` first, at the umask default. The owner
    // deliberately does not repair an existing directory, so the write path
    // must refuse rather than publish a pin into it.
    fs.mkdirSync(runtimeDir(workspacePath), { recursive: true, mode: 0o755 })
    fs.chmodSync(runtimeDir(workspacePath), 0o755)

    await assert.rejects(
      reconcileWorkspaceTenantPin({
        workspacePath,
        tenantId: 'local',
        mode: 'authoritative',
      }),
      expectConfigurationError('TEAM_TENANT_ID'),
    )
    assert.equal(
      fs.existsSync(tenantPinPath(workspacePath)),
      false,
      'a refused reconcile must leave no pin behind',
    )
  } finally {
    fs.chmodSync(runtimeDir(workspacePath), 0o700)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/** Enrol one assignment under an explicit tenant. */
async function enrolTenant(
  workspacePath: string,
  assignmentId: string,
  tenantId: string,
): Promise<void> {
  const assignmentPath = path.join(
    workspacePath,
    'sessions',
    'session-one',
    'runs',
    'run-one',
    'assignments',
    assignmentId,
  )
  fs.mkdirSync(assignmentPath, { recursive: true })
  const { WorkspaceExecutionJournalRegistry } = await import(
    '../../services/workspace-execution-journal-registry.js'
  )
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId,
    mode: 'authoritative',
  })
  try {
    await registry.resolve({
      context: {
        contractVersion: 1,
        requestId: `request-${assignmentId}`,
        sessionId: 'session-one',
        runId: 'run-one',
        assignmentId,
        agentPath: 'agents/probe',
        authority: { kind: 'runtime-assignment', processIdentity: 'probe' },
      },
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5_000,
    })
  } finally {
    await registry.close()
  }
}
