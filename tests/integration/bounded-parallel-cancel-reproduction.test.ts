/**
 * B1 Step 1 — reproduction through the real task-runner and engine.
 *
 * The remediation plan carries an UNVERIFIED claim: that cancelling a run
 * produces a permanently failed, non-resumable task. The engine tests in
 * `tests/unit/pipeline-runtime-loop.test.ts` prove what the bounded-parallel
 * drain does with an abort, but they cannot see the durable outcome, which is
 * written by the task service and the launcher rather than the engine.
 *
 * This drives the real API server, the real `SessionTaskRunnerLauncher`, a real
 * worker process, the real team-runtime extension and the real
 * `createPipelineTool` bounded drain, cancels while two dispatched workers are
 * genuinely in flight against a file barrier, and records what the durable
 * record actually says and whether the task can be resumed.
 *
 * The host `pi -e <extension>` invocation is delegated to the real CLI so the
 * real extension and engine execute. Only the *dispatched agent* invocations
 * are replaced, and they simply block. That replacement is necessary rather
 * than incidental: a real dispatched agent turn calls a provider, which is
 * credentialed and billed, and the behaviour under test is what the runtime
 * does when a wave is cancelled — not what a model returns.
 */
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer } from '../../server/api-server.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { SessionTaskRunnerLauncher } from '../../domains/sessions/session-task-launcher.js'

const repoRoot = process.cwd()
const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'bounded-parallel-cancel')

/** An executable plan with two independent tasks, so one wave dispatches both. */
const EXECUTABLE_PLAN = `# Plan: Barrier fixture
**Status:** draft

### S1: Execute

#### T1: First task
- **Agent:** barrier-worker
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** output/T1.md

#### T2: Second task
- **Agent:** barrier-worker
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** output/T2.md
`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read an id from an API response body without asserting a whole contract. */
function readId(body: unknown, label: string): string {
  assert.ok(isRecord(body), `${label} must be an object: ${JSON.stringify(body)}`)
  const id = body.id
  assert.equal(typeof id, 'string', `${label} must carry an id: ${JSON.stringify(body)}`)
  return String(id)
}

function readTaskStatus(record: unknown): string | undefined {
  if (!isRecord(record)) return undefined
  return typeof record.status === 'string' ? record.status : undefined
}

function readProcessIds(record: unknown): { pid?: number; groupId?: number } {
  if (!isRecord(record)) return {}
  return {
    ...(typeof record.pid === 'number' ? { pid: record.pid } : {}),
    ...(typeof record.processGroupId === 'number' ? { groupId: record.processGroupId } : {}),
  }
}

/** Resolve when the barrier directory holds `count` in-flight agent markers. */
function waitForAgentsInFlight(
  barrierDir: string,
  count: number,
  timeoutMs = 90_000,
): Promise<void> {
  const arrived = () =>
    fs.readdirSync(barrierDir).filter((entry) => entry.startsWith('agent-')).length >= count
  if (arrived()) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const watcher = fs.watch(barrierDir, () => {
      if (!arrived()) return
      cleanup()
      resolve()
    })
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${count} dispatched agents in flight`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      watcher.close()
    }
    // fs.watch can miss a write that lands between the initial check and the
    // subscription, so re-check once the watcher is armed.
    if (arrived()) {
      cleanup()
      resolve()
    }
  })
}

/**
 * Exact identities the fixture recorded for itself, re-read on each call.
 *
 * `readdirSync` is deliberately unguarded. The directory is pre-created and
 * lives until final cleanup, so a read failure means the identity evidence is
 * gone — and returning `[]` there would let both the survivor assertion and the
 * cleanup loop succeed while proving and killing nothing.
 */
function readFixtureProcesses(
  directory: string,
): ReadonlyArray<{ role: string; pid: number }> {
  const entries = fs.readdirSync(directory)
  const captured: Array<{ role: string; pid: number }> = []
  for (const entry of entries) {
    const separator = entry.lastIndexOf('-')
    if (separator <= 0) continue
    const role = entry.slice(0, separator)
    const pid = Number(entry.slice(separator + 1))
    if (Number.isSafeInteger(pid) && pid > 0) captured.push({ role, pid })
  }
  return captured
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    // EPERM means it exists but is not ours to signal.
    return true
  }
}

/** Process group of a captured pid, read without assuming a Node API for it. */
function readProcessGroupId(pid: number): number | null {
  try {
    const raw = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const parsed = Number(raw)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

test('cancelling a live bounded-parallel wave: durable and resume outcome', { timeout: 180_000 }, async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'b1-drain-cancel-'))
  const binDir = path.join(workspacePath, 'bin')
  const barrierDir = path.join(workspacePath, 'barrier')
  // One marker file per pid this fixture spawns, host wrapper and dispatched
  // agent alike. Pre-created so a child never races the directory into being.
  const fixtureProcessDir = path.join(workspacePath, 'fixture-processes')
  fs.mkdirSync(binDir, { recursive: true })
  fs.mkdirSync(barrierDir, { recursive: true })
  fs.mkdirSync(fixtureProcessDir, { recursive: true })

  // The host runtime invocation carries `-e <extension>`; dispatched agent turns
  // never do. Delegating the former to the real CLI is what keeps the actual
  // extension and the actual bounded drain in the run.
  const realCli = path.join(
    repoRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js',
  )
  assert.ok(fs.existsSync(realCli), 'the real Pi CLI must be installed for this fixture')
  fs.writeFileSync(
    path.join(binDir, 'pi'),
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
// One marker file per process this fixture owns, so cleanup and the end-to-end
// assertion work from captured identities rather than name scans. A directory
// of exact files avoids the concurrent-append corruption a shared ledger would
// invite, and needs no escaping inside this generated script.
//
// Deliberately NOT best-effort and deliberately not wrapped in a catch: if a
// process this fixture spawned cannot record its own identity, safe cleanup and
// honest evidence are both impossible, so it must fail loudly and immediately.
const record = (role) => {
  fs.writeFileSync(
    path.join(${JSON.stringify(fixtureProcessDir)}, role + '-' + process.pid),
    String(process.pid),
  )
}
if (args.includes('-e')) {
  record('host')
  const result = spawnSync(process.execPath, [${JSON.stringify(realCli)}, ...args], {
    stdio: 'inherit',
    env: process.env,
  })
  process.exit(result.status ?? 1)
}
record('agent')
// A dispatched agent turn: announce arrival, then block until killed.
fs.writeFileSync(path.join(${JSON.stringify(barrierDir)}, 'agent-' + process.pid), 'in-flight')
setInterval(() => {}, 1000)
`,
    { mode: 0o755 },
  )

  // Capture every variable that decides which Pi binary runs. A caller with an
  // existing bundled-CLI path would otherwise bypass the wrapper entirely and
  // silently run a different binary than this fixture intends.
  const previous = {
    PATH: process.env.PATH,
    TEAM_RUNTIME_PI_CLI_PATH: process.env.TEAM_RUNTIME_PI_CLI_PATH,
    TEAM_RUNTIME_PI_NODE_PATH: process.env.TEAM_RUNTIME_PI_NODE_PATH,
    TEAM_RUNTIME_FILE_PARSER_ENTRY: process.env.TEAM_RUNTIME_FILE_PARSER_ENTRY,
    TEAM_RUNTIME_REPO_ROOT: process.env.TEAM_RUNTIME_REPO_ROOT,
    TEAM_RUNTIME_WORKFLOWS_REGISTRY_PATH: process.env.TEAM_RUNTIME_WORKFLOWS_REGISTRY_PATH,
  }
  const restoreEnv = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  process.env.PATH = `${binDir}${path.delimiter}${previous.PATH ?? ''}`
  delete process.env.TEAM_RUNTIME_PI_CLI_PATH
  delete process.env.TEAM_RUNTIME_PI_NODE_PATH
  process.env.TEAM_RUNTIME_REPO_ROOT = fixtureRoot
  process.env.TEAM_RUNTIME_WORKFLOWS_REGISTRY_PATH = path.join(fixtureRoot, 'workflows', 'registry.yaml')
  // The fixture root holds only team and workflow config, so the parser entry
  // still has to resolve against the real repository.
  process.env.TEAM_RUNTIME_FILE_PARSER_ENTRY = path.join(repoRoot, 'file-parser', 'index.ts')

  const sessionStore = new FileSystemSessionStore(workspacePath)
  const launcher = new SessionTaskRunnerLauncher(repoRoot)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher,
    taskLauncher: launcher,
    sessionStore,
    workspacePath,
    repoRootPath: fixtureRoot,
    workflowsRegistryPath: path.join(fixtureRoot, 'workflows', 'registry.yaml'),
  })

  let sessionId: string | undefined
  let taskId: string | undefined
  let cancelConfirmed = false
  // Groups captured before cancellation, so `finally` can reach a survivor
  // whose parent is already gone. Exact identities only — never a name scan.
  const capturedFixtureGroupIds = new Set<number>()
  // Captured before cancelling so the fallback can still terminate the worker
  // if the cancel request itself fails.
  let liveProcess: { pid?: number; groupId?: number } = {}

  try {
    const createdSession = await fetch(`${server.url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Bounded parallel cancel reproduction' }),
    })
    assert.equal(createdSession.status, 201)
    sessionId = readId(await createdSession.json(), 'created session')

    const created = await fetch(`${server.url}/sessions/${sessionId}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowId: 'barrier-pipeline-flow', brief: EXECUTABLE_PLAN }),
    })
    const createdBody: unknown = await created.json()
    assert.equal(created.status, 202, JSON.stringify(createdBody))
    taskId = readId(createdBody, 'accepted task')

    // Two dispatched agents in flight means the wave really is mid-drain.
    await waitForAgentsInFlight(barrierDir, 2)

    liveProcess = readProcessIds(await sessionStore.getTaskRecord(sessionId, taskId))

    // Capture process groups while the fixture's processes are still alive.
    // After cancellation a dead pid has no group to read, so cleanup would lose
    // its only handle on anything that outlived its parent.
    for (const { pid } of readFixtureProcesses(fixtureProcessDir)) {
      const groupId = readProcessGroupId(pid)
      if (groupId !== null) capturedFixtureGroupIds.add(groupId)
    }

    const cancelled = await fetch(
      `${server.url}/sessions/${sessionId}/tasks/${taskId}`,
      { method: 'DELETE' },
    )
    const cancelledBody: unknown = await cancelled.json()
    assert.equal(cancelled.status, 200, JSON.stringify(cancelledBody))
    assert.equal(readTaskStatus(cancelledBody), 'cancelled')
    // Only now is the worker known to have been stopped through the product.
    cancelConfirmed = true

    // Cancellation fences the record by compare-and-set before signalling, so
    // the durable state is already written when DELETE returns; no polling.
    const durable = await sessionStore.getTaskRecord(sessionId, taskId)
    const durableStatus = readTaskStatus(durable)

    const resume = await fetch(
      `${server.url}/sessions/${sessionId}/tasks/${taskId}/resume`,
      { method: 'POST' },
    )
    const resumeStatus = resume.status
    await resume.body?.cancel().catch(() => undefined)

    // Recorded observations. The plan claimed this ends `failed` and cannot
    // resume; these assertions are what settle it either way.
    console.log(
      `[B1 reproduction] durable status=${durableStatus} resumeHttp=${resumeStatus}`,
    )
    assert.equal(durableStatus, 'cancelled')
    // The exact observed contract, not merely "not success".
    assert.equal(resumeStatus, 409)

    // End-to-end evidence, not just a durable status. Cancellation has returned
    // through the real API, so every process this fixture spawned — the host
    // wrapper and each dispatched agent turn — must be gone. Eleven such
    // processes were once found orphaned at PID 1 after runs like this one.
    const survivors = readFixtureProcesses(fixtureProcessDir)
      .filter(({ pid }) => processIsAlive(pid))
    assert.deepEqual(
      survivors,
      [],
      `cancellation returned while fixture processes were still alive: ` +
        `${JSON.stringify(survivors)}`,
    )
  } finally {
    // Cleanup runs UNCONDITIONALLY, including after a confirmed cancellation.
    // Gating it on `cancelConfirmed` assumed the product had already stopped
    // everything — the assumption this whole package exists because it was
    // false. Everything below is scoped to identities this fixture captured;
    // nothing scans or kills by process name.
    //
    // Structured so that gathering evidence can FAIL without skipping teardown:
    // the inner try does the killing and verification, the inner finally always
    // closes the server, restores the environment and removes the workspace, and
    // any evidence error is rethrown afterwards. A missing marker directory must
    // fail loudly, but never with the global environment left mutated.
    let cleanupError: unknown
    let stubborn: Array<{ role: string; pid: number }> = []
    try {
      if (!cancelConfirmed && sessionId && taskId) {
        // Cancellation is idempotent, so attempting it is safe and is the only
        // thing that stops a real worker and its blocked children.
        await fetch(`${server.url}/sessions/${sessionId}/tasks/${taskId}`, { method: 'DELETE' })
          .then((response) => response.body?.cancel())
          .catch(() => undefined)
      }

      // The record is only readable once the run actually reached the point of
      // creating one; before that, the ids captured live are all there is.
      const record = sessionId && taskId
        ? await sessionStore.getTaskRecord(sessionId, taskId).catch(() => undefined)
        : undefined
      const observed = readProcessIds(record)
      const rootPid = observed.pid ?? liveProcess.pid
      const rootGroupId = observed.groupId ?? liveProcess.groupId

      // Read identities BEFORE the workspace is removed.
      const capturedPids = readFixtureProcesses(fixtureProcessDir)

      // Groups first: a reparented survivor is still reachable through its group.
      for (const groupId of [rootGroupId, ...capturedFixtureGroupIds]) {
        if (groupId === undefined) continue
        try { process.kill(-groupId, 'SIGKILL') } catch { /* already gone */ }
      }
      for (const pid of [rootPid, ...capturedPids.map((entry) => entry.pid)]) {
        if (pid === undefined) continue
        try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
      }

      // Prove cleanup worked, against the exact identities this fixture
      // captured. A `pgrep -f b1-drain-cancel` would NOT prove it: the leaked
      // processes' argv is `pi`, and only their working directory sits under the
      // fixture path, so such a scan reports clean even with orphans alive.
      //
      // The root worker is fixture-owned and SIGKILLed above, so it belongs in
      // the verified set rather than being killed and forgotten.
      const verifiedIdentities: Array<{ role: string; pid: number }> = [
        ...(rootPid === undefined ? [] : [{ role: 'root', pid: rootPid }]),
        ...capturedPids,
      ]
      const cleanupDeadline = Date.now() + 5_000
      for (const entry of verifiedIdentities) {
        while (processIsAlive(entry.pid) && Date.now() < cleanupDeadline) {
          await new Promise((settle) => setTimeout(settle, 25))
        }
        if (processIsAlive(entry.pid)) stubborn.push(entry)
      }
    } catch (error) {
      cleanupError = error
    } finally {
      await server.close().catch(() => undefined)
      restoreEnv()
      fs.rmSync(workspacePath, { recursive: true, force: true })
    }

    if (cleanupError !== undefined) throw cleanupError
    // A surviving captured identity is a real failure, not a warning: it means
    // this run left processes on the machine.
    assert.deepEqual(
      stubborn,
      [],
      `fixture cleanup failed; these captured processes survived SIGKILL: ` +
        `${JSON.stringify(stubborn)}`,
    )
  }
})
