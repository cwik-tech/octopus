import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { RunLaunchResult } from '../../contracts/runs.js'
import { SessionTaskRunnerLauncher } from '../../domains/sessions/session-task-launcher.js'
import { PROCESS_IDENTITY_ARGUMENT } from '../../domains/sessions/task-process-supervisor.js'
import {
  describeErrors,
  stopProcessesCarrying,
  withinBound,
} from '../support/fixture-process-markers.js'

// The session task launcher's release callback (review rank 14, item 3): a
// caller that needs to know a launched runner has ended, as a test waiting for
// a root to exit does, is told by the child's own close rather than by reading
// the process table until the runner is gone.
//
// The launcher runs `<repo root>/domains/sessions/session-task-runner.ts`
// through tsx, so a stand-in repo root holds a stand-in runner. It says it is
// ready, and exits when its release file appears.

const BOUND_MS = 20_000
const CONTROL_ENV = 'SESSION_TASK_LAUNCHER_TEST_CONTROL_DIR'
const NAME_ENV = 'SESSION_TASK_LAUNCHER_TEST_NAME'

const STAND_IN_RUNNER = `import * as fs from 'node:fs'
import * as path from 'node:path'

const control = process.env.${CONTROL_ENV} ?? ''
const name = process.env.${NAME_ENV} ?? ''
const release = path.join(control, 'release-' + name)
// Watched before the check, so a release written between the two is seen.
fs.watch(control, () => {
  if (fs.existsSync(release)) process.exit(0)
})
if (fs.existsSync(release)) process.exit(0)
fs.writeFileSync(path.join(control, 'ready-' + name), String(process.pid))
`

interface LaunchedRunner {
  readonly result: RunLaunchResult
  readonly processIdentity: string
  /** Lets the runner exit. */
  release(): void
}

interface StandIn {
  readonly repoRoot: string
  readonly cwd: string
  launch(launcher: SessionTaskRunnerLauncher, name: string): Promise<LaunchedRunner>
}

/** Resolves once `name` exists in `folder`, checked on each change there; bounded. */
async function fileAppears(folder: string, name: string, description: string): Promise<void> {
  let watcher: fs.FSWatcher | undefined
  const appeared = new Promise<void>((resolve, reject) => {
    const check = (): void => {
      if (fs.existsSync(path.join(folder, name))) resolve()
    }
    watcher = fs.watch(folder, check)
    watcher.on('error', reject)
    check()
  })
  try {
    await withinBound(appeared, BOUND_MS, description)
  } finally {
    watcher?.close()
  }
}

/**
 * Runs `fn` with a stand-in repo root. Every runner is registered by its
 * identity marker before it is launched, and cleanup stops whatever still
 * carries one, rechecked before each signal, whatever the body did.
 */
async function withStandIn(fn: (standIn: StandIn) => Promise<void>): Promise<void> {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'session-task-launcher-'))
  const repoRoot = path.join(rootPath, 'repo')
  const control = path.join(rootPath, 'control')
  fs.mkdirSync(path.join(repoRoot, 'domains', 'sessions'), { recursive: true })
  fs.mkdirSync(control)
  fs.writeFileSync(path.join(repoRoot, 'domains', 'sessions', 'session-task-runner.ts'), STAND_IN_RUNNER)
  const identities: string[] = []
  const standIn: StandIn = {
    repoRoot,
    cwd: rootPath,
    async launch(launcher, name) {
      const processIdentity = `launcher-release-${randomUUID()}`
      identities.push(processIdentity)
      const result = await launcher.startRun({
        cwd: rootPath,
        env: { [CONTROL_ENV]: control, [NAME_ENV]: name },
        processIdentity,
      })
      await fileAppears(control, `ready-${name}`, `the ${name} runner to be ready`)
      return {
        result,
        processIdentity,
        release: () => fs.writeFileSync(path.join(control, `release-${name}`), 'release'),
      }
    },
  }
  const failures: unknown[] = []
  try {
    await fn(standIn)
  } catch (error) {
    failures.push(error)
  }
  for (const identity of identities) {
    try {
      await stopProcessesCarrying(`${PROCESS_IDENTITY_ARGUMENT}${identity}`)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 0) fs.rmSync(rootPath, { recursive: true, force: true })
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, `the test and its cleanup failed; ${rootPath} is kept: ${describeErrors(failures)}`)
}

test('a launcher given onRelease is told once for each runner it launched, when that runner closes and not while it runs', { timeout: 60_000, skip: process.platform === 'win32' }, async () => {
  await withStandIn(async (standIn) => {
    let released = 0
    const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = []
    const releasedTimes = (count: number): Promise<void> => new Promise<void>((resolve) => {
      if (released >= count) resolve()
      else waiters.push({ count, resolve })
    })
    const launcher = new SessionTaskRunnerLauncher(standIn.repoRoot, {
      onRelease: () => {
        released += 1
        for (const waiter of waiters) if (released >= waiter.count) waiter.resolve()
      },
    })

    const first = await standIn.launch(launcher, 'first')
    assert.equal(released, 0, 'not released while the first runner runs')
    const firstReleased = releasedTimes(1)
    first.release()
    await withinBound(firstReleased, BOUND_MS, 'the first runner\'s release')
    assert.equal(released, 1, 'released once the first runner closed')

    const second = await standIn.launch(launcher, 'second')
    assert.equal(released, 1, 'the first runner was released once, and the second, still running, not at all')
    const secondReleased = releasedTimes(2)
    second.release()
    await withinBound(secondReleased, BOUND_MS, 'the second runner\'s release')
    assert.equal(released, 2, 'each runner is released once, when it closes')
  })
})

test('a launcher built without onRelease launches as before', { timeout: 60_000, skip: process.platform === 'win32' }, async () => {
  await withStandIn(async (standIn) => {
    const launched = await standIn.launch(new SessionTaskRunnerLauncher(standIn.repoRoot), 'plain')
    assert.equal(typeof launched.result.pid, 'number')
    assert.deepEqual(launched.result, {
      launched: true,
      pid: launched.result.pid,
      processGroupId: launched.result.pid,
      processIdentity: launched.processIdentity,
      cwd: standIn.cwd,
    })
    launched.release()
  })
})
