import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'

import {
  describeErrors,
  processesCarrying,
  processesWithEnvironment,
  stopProcessesCarrying,
  stopProcessesWithEnvironment,
  withinBound,
} from '../support/fixture-process-markers.js'

// The fixture cleanup helper must attempt every process that carries a
// marker, even when handling an earlier one fails, and report every failure.
// A marker shared by several processes is the case that shows it.

const BOUND_MS = 5_000

/**
 * Runs `body`, then every cleanup step whatever failed before, and reports
 * the body's failure beside every cleanup error.
 */
async function withCleanup(body: () => Promise<void>, steps: ReadonlyArray<() => Promise<unknown>>): Promise<void> {
  const failures: unknown[] = []
  try {
    await body()
  } catch (error) {
    failures.push(error)
  }
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, `the test and its cleanup failed: ${describeErrors(failures)}`)
}

function spawnCarrying(marker: string): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', '--', marker], {
    detached: true,
    stdio: 'ignore',
  })
}

test('when handling one process fails, the others carrying the same marker are still stopped, and the failure is reported', async () => {
  const marker = `--fixture-helper-shared=${randomUUID()}`
  const first = spawnCarrying(marker)
  const second = spawnCarrying(marker)
  const exits = [once(first, 'exit'), once(second, 'exit')]
  await withCleanup(async () => {
    await withinBound(Promise.all([once(first, 'spawn'), once(second, 'spawn')]), BOUND_MS, 'both fixtures to spawn')
    const injected = new Error('injected failure while signalling the first process')
    let failedPid: number | undefined
    const failure = await stopProcessesCarrying(marker, {
      signal: (pid, name) => {
        if (failedPid === undefined) {
          failedPid = pid
          throw injected
        }
        process.kill(pid, name)
      },
    }).then(() => undefined, (error: unknown) => error)

    assert.ok(failedPid !== undefined, 'the first process was handled')
    const survivors = processesCarrying(marker).map((row) => row.pid)
    assert.deepEqual(survivors, [failedPid], 'every process but the one whose handling failed was stopped')
    const errors = failure instanceof AggregateError ? failure.errors : [failure]
    assert.ok(errors.includes(injected), 'the failure is reported')
  }, [
    // The one left running is stopped by the unfaulted helper; bounded.
    () => stopProcessesCarrying(marker),
    () => withinBound(Promise.all(exits), BOUND_MS, 'both fixtures to exit'),
  ])
})

test('an environment identity reaches a descendant the test never saw, and leaves an unrelated process alone', async () => {
  const value = randomUUID()
  const unrelatedMarker = `--fixture-helper-unrelated=${randomUUID()}`
  // The child starts a detached grandchild that inherits the value; neither
  // carries it on its command line.
  const parent = spawn(process.execPath, ['-e', [
    "const { spawn } = require('node:child_process')",
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { detached: true, stdio: 'ignore' })",
    "grandchild.on('spawn', () => process.stdout.write('ready\\n'))",
    'setInterval(() => {}, 1 << 30)',
  ].join('\n')], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, FIXTURE_HELPER_ENVIRONMENT: value },
  })
  const parentExited = once(parent, 'exit')
  const unrelated = spawnCarrying(unrelatedMarker)
  const unrelatedExited = once(unrelated, 'exit')
  await withCleanup(async () => {
    const stdout = parent.stdout
    assert.ok(stdout)
    await withinBound(once(stdout, 'data'), BOUND_MS, 'the grandchild to start')
    assert.equal(processesWithEnvironment('FIXTURE_HELPER_ENVIRONMENT', value).length, 2, 'the child and the grandchild carry the value')

    await stopProcessesWithEnvironment('FIXTURE_HELPER_ENVIRONMENT', value)

    assert.deepEqual(processesWithEnvironment('FIXTURE_HELPER_ENVIRONMENT', value), [])
    assert.equal(processesCarrying(unrelatedMarker).length, 1, 'a process without the value is left alone')
  }, [
    () => stopProcessesWithEnvironment('FIXTURE_HELPER_ENVIRONMENT', value),
    () => stopProcessesCarrying(unrelatedMarker),
    () => withinBound(parentExited, BOUND_MS, 'the environment fixture to exit'),
    () => withinBound(unrelatedExited, BOUND_MS, 'the unrelated fixture to exit'),
  ])
})
