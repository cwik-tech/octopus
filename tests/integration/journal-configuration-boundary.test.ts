import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { buildServices } from '../../server/composition.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { SourceFileParserLauncher } from '../../core/file-parser-launcher.js'
import {
  reconcileWorkspaceTenantPin,
  tenantPinPath,
} from '../../services/execution-journal-tenant-pin.js'

/**
 * AC2: a misconfigured durable journal must refuse to start, naming the
 * variable and the value.
 *
 * Silent fallback to `disabled` is the failure this closes: a typo in a deploy
 * reads as "protection on" while nothing is enrolled, and enrollment is
 * irreversible, so the mistake is only discovered when it is too late to
 * cheaply undo.
 */

async function makeWorkspace(t: {
  after: (fn: () => unknown) => void
}): Promise<string> {
  const workspacePath = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'journal-config-boundary-')),
  )
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  return workspacePath
}

function withEnvironment(
  t: { after: (fn: () => unknown) => void },
  values: Readonly<Record<string, string | undefined>>,
): void {
  const previous = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

async function compositionOptions(workspacePath: string) {
  const repoRootPath = process.cwd()
  const launcher = {
    async startRun() {
      return { launched: true as const, pid: process.pid, cwd: repoRootPath }
    },
  }
  return {
    store: new FileSystemRunStore(workspacePath),
    launcher,
    taskLauncher: launcher,
    fileParserLauncher: new SourceFileParserLauncher(repoRootPath),
    sessionStore: new FileSystemSessionStore(workspacePath),
    workspacePath,
    repoRootPath,
    workflowsRegistryPath: path.join(repoRootPath, 'workflows', 'registry.yaml'),
  }
}

test('an unrecognised durable journal flag value fails startup, naming the variable and the value', async (t) => {
  const workspacePath = await makeWorkspace(t)
  withEnvironment(t, { PIPELINE_DURABLE_JOURNAL: 'authoratative' })

  await assert.rejects(
    buildServices(await compositionOptions(workspacePath)),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /PIPELINE_DURABLE_JOURNAL/)
      assert.match(error.message, /authoratative/)
      return true
    },
    'a typo must fail startup rather than silently disabling the journal',
  )
})

test('deprecated flag values still resolve, and say so', async (t) => {
  const workspacePath = await makeWorkspace(t)
  withEnvironment(t, { PIPELINE_DURABLE_JOURNAL: 'shadow' })

  // `shadow` was folded into `disabled` and `1` into `authoritative`. A
  // repository search cannot inventory the environments these are exported in,
  // so they keep working for one release rather than becoming startup failures.
  const composition = await buildServices(await compositionOptions(workspacePath))
  t.after(() => composition.dispose())
  assert.ok(composition.services.capabilityDispatchRuntime)
})

test('a tenant that disagrees with this workspace fails startup, naming both values', async (t) => {
  const workspacePath = await makeWorkspace(t)

  // The workspace was first started under one tenant, which pinned it.
  await reconcileWorkspaceTenantPin({
    workspacePath,
    tenantId: 'acme',
    mode: 'authoritative',
  })
  assert.ok(await fs.stat(tenantPinPath(workspacePath)))

  withEnvironment(t, {
    PIPELINE_DURABLE_JOURNAL: 'authoritative',
    TEAM_TENANT_ID: 'local',
  })

  await assert.rejects(
    buildServices(await compositionOptions(workspacePath)),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /acme/)
      assert.match(error.message, /local/)
      return true
    },
    'a changed tenant must fail at startup, not one dispatch at a time mid-run',
  )
})

test('the tenant pin is written once and is stable across restarts', async (t) => {
  const workspacePath = await makeWorkspace(t)
  withEnvironment(t, {
    PIPELINE_DURABLE_JOURNAL: 'authoritative',
    TEAM_TENANT_ID: 'local',
  })

  const first = await buildServices(await compositionOptions(workspacePath))
  await first.dispose()

  const pinned = JSON.parse(
    await fs.readFile(tenantPinPath(workspacePath), 'utf8'),
  ) as { tenantId: string; pinnedAt: string }
  assert.equal(pinned.tenantId, 'local')

  const second = await buildServices(await compositionOptions(workspacePath))
  t.after(() => second.dispose())

  const again = JSON.parse(
    await fs.readFile(tenantPinPath(workspacePath), 'utf8'),
  ) as { tenantId: string; pinnedAt: string }
  assert.deepEqual(again, pinned, 'the pin is immutable once written')
})

test('a healthy workspace whose journals already agree can be pinned', async (t) => {
  const workspacePath = await makeWorkspace(t)
  await enrolLegacyAssignment(workspacePath, 'assignment-healthy', 'local')

  // The state the first implementation refused outright: journals exist, they
  // are all readable, and they all agree with the environment. Refusing this
  // left no supported way to adopt the pin, and the read-only preflight the
  // error pointed at cannot resolve it either.
  const pin = await reconcileWorkspaceTenantPin({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })

  assert.equal(pin?.tenantId, 'local')
  const onDisk = JSON.parse(
    await fs.readFile(tenantPinPath(workspacePath), 'utf8'),
  ) as { tenantId: string }
  assert.equal(onDisk.tenantId, 'local')
})

test('a workspace the preflight blocks is never pinned', async (t) => {
  const workspacePath = await makeWorkspace(t)
  await enrolLegacyAssignment(workspacePath, 'assignment-local', 'local')
  await enrolLegacyAssignment(workspacePath, 'assignment-acme', 'acme')

  await assert.rejects(
    reconcileWorkspaceTenantPin({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /preflight/)
      return true
    },
    'disagreeing tenants must not be pinned over',
  )
  await assert.rejects(fs.stat(tenantPinPath(workspacePath)))
})

test('a workspace holding unreadable durable state is never pinned', async (t) => {
  const workspacePath = await makeWorkspace(t)
  // A journal directory with events and no manifest: the exact shape the first
  // discovery implementation reported as an empty workspace.
  const directory = path.join(
    workspacePath,
    'sessions',
    'session-x',
    'runs',
    'run-x',
    'assignments',
    'assignment-x',
    '.runtime',
    'execution-journal',
  )
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(directory, 'journal.jsonl'), '', { mode: 0o600 })

  await assert.rejects(
    reconcileWorkspaceTenantPin({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /preflight/)
      return true
    },
  )
  await assert.rejects(fs.stat(tenantPinPath(workspacePath)))
})

/** Enrol one assignment directly, the way a build without a pin would have. */
async function enrolLegacyAssignment(
  workspacePath: string,
  assignmentId: string,
  tenantId: string,
): Promise<void> {
  const assignmentPath = path.join(
    workspacePath,
    'sessions',
    'session-legacy',
    'runs',
    'run-legacy',
    'assignments',
    assignmentId,
  )
  await fs.mkdir(assignmentPath, { recursive: true })
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
        sessionId: 'session-legacy',
        runId: 'run-legacy',
        assignmentId,
        agentPath: 'agents/legacy',
        authority: { kind: 'runtime-assignment', processIdentity: 'legacy' },
      },
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5_000,
    })
  } finally {
    await registry.close()
  }
}
