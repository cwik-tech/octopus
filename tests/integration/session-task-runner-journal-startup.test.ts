import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { reconcileWorkspaceTenantPin } from '../../services/execution-journal-tenant-pin.js'

/**
 * The task worker is a separate process, and it resolved the journal's
 * configuration on its own: `createWorkspaceExecutionJournalRegistry` read
 * `PIPELINE_DURABLE_JOURNAL` and `TEAM_TENANT_ID` from its environment and
 * nothing else. A workspace pinned to one tenant would therefore accept a
 * worker launched with another and seal a fresh manifest to it — the exact
 * failure the pin exists to prevent, reached through the door the pin was not
 * fitted to.
 *
 * Parent and worker must share one asynchronous startup boundary.
 */

const REPO_ROOT = process.cwd()

function makeWorkspace(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'worker-journal-startup-')),
  )
}

function journalManifestsUnder(root: string): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (
        entry.name === 'manifest.json' &&
        path.basename(directory) === 'execution-journal'
      ) {
        found.push(full)
      }
    }
  }
  walk(root)
  return found
}

interface WorkerOutcome {
  readonly code: number | null
  readonly stderr: string
}

/** Start the real worker entry point the launcher starts. */
async function runWorker(
  environment: Readonly<Record<string, string>>,
): Promise<WorkerOutcome> {
  const runnerEntry = path.join(
    REPO_ROOT,
    'domains',
    'sessions',
    'session-task-runner.ts',
  )
  const tsxEntry = createRequire(import.meta.url).resolve('tsx/cli')
  const child = spawn(process.execPath, [tsxEntry, runnerEntry], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // Cleared so the worker cannot inherit an ambient flag from whoever ran
      // the suite; each case sets exactly what it means to test.
      PIPELINE_DURABLE_JOURNAL: '',
      TEAM_TENANT_ID: '',
      ...environment,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const [code] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null]
  return { code, stderr }
}

test('the worker refuses to start when its tenant disagrees with the workspace pin', async () => {
  const workspacePath = makeWorkspace()
  try {
    await reconcileWorkspaceTenantPin({
      workspacePath,
      tenantId: 'good',
      mode: 'authoritative',
    })

    const outcome = await runWorker({
      TEAM_RUNTIME_WORKSPACE_PATH: workspacePath,
      TEAM_TENANT_ID: 'bad',
      PIPELINE_DURABLE_JOURNAL: 'authoritative',
    })

    assert.notEqual(outcome.code, 0, 'a mismatched worker must not start')
    assert.match(outcome.stderr, /good/)
    assert.match(outcome.stderr, /bad/)
    assert.deepEqual(
      journalManifestsUnder(workspacePath),
      [],
      'no journal may be sealed under the wrong tenant',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('the worker refuses to start on an unrecognised journal flag', async () => {
  const workspacePath = makeWorkspace()
  try {
    const outcome = await runWorker({
      TEAM_RUNTIME_WORKSPACE_PATH: workspacePath,
      PIPELINE_DURABLE_JOURNAL: 'authoratative',
    })

    assert.notEqual(outcome.code, 0)
    assert.match(outcome.stderr, /PIPELINE_DURABLE_JOURNAL/)
    assert.match(outcome.stderr, /authoratative/)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('the pin is checked even with the journal disabled, because enrolled assignments still resolve', async () => {
  const workspacePath = makeWorkspace()
  try {
    await reconcileWorkspaceTenantPin({
      workspacePath,
      tenantId: 'good',
      mode: 'authoritative',
    })

    // Authority is sticky: an assignment that enrolled resolves its journal
    // whatever the flag says, so a disagreeing tenant is just as fatal here.
    const outcome = await runWorker({
      TEAM_RUNTIME_WORKSPACE_PATH: workspacePath,
      TEAM_TENANT_ID: 'bad',
      PIPELINE_DURABLE_JOURNAL: 'disabled',
    })

    assert.notEqual(
      outcome.code,
      0,
      'disabled mode must not be a way around the pin',
    )
    assert.match(outcome.stderr, /good/)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
