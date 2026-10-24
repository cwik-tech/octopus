/**
 * Session shutdown gives back the capability evidence file a run held open.
 *
 * With the durable journal disabled, the first governed dispatch of a run
 * opens the assignment's `logs/capability-dispatch-events.jsonl` and keeps it
 * open for the rest of the run. A Pi host process loads one runtime per
 * session and outlives all of them, so a descriptor a finished run keeps stays
 * open for the life of the host, one more per run.
 *
 * Both measurements go through the operating system, not the runtime: which
 * open descriptors point at a run's evidence file, and how many descriptors
 * the process holds after each run compared with a baseline taken after one
 * warm-up run.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'

import {
  ASSIGNMENT_LOG,
  bootFixtureRuntime,
  type FixtureRuntime,
} from '../support/team-runtime-fixture-boot.js'

/** Enough runs that one kept descriptor per run cannot hide in the noise. */
const RUN_COUNT = 12

const DESCRIPTOR_DIRECTORY = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'

function openDescriptors(): number[] {
  return fs
    .readdirSync(DESCRIPTOR_DIRECTORY)
    .map((entry) => Number(entry))
    .filter((fd) => Number.isInteger(fd))
}

/** Descriptors this process holds on `filePath`, matched by device and inode. */
function descriptorsOpenOn(filePath: string): number[] {
  const target = fs.statSync(filePath)
  return openDescriptors().filter((fd) => {
    try {
      const held = fs.fstatSync(fd)
      return held.dev === target.dev && held.ino === target.ino
    } catch {
      // The directory listing's own descriptor is closed by now.
      return false
    }
  })
}

interface RunMeasurement {
  readonly heldWhileLive: number
  readonly heldAfterShutdown: number
  readonly dispatchEvents: readonly unknown[]
}

/**
 * Boot a runtime, run one governed tool so the evidence file is opened, shut
 * the session down, and remove the run's files.
 *
 * The booted runtime is pushed to `keepAlive` so a descriptor the runtime
 * failed to close stays reachable, and garbage collection cannot close it on
 * the runtime's behalf before the count is taken.
 */
async function governedRun(label: string, keepAlive: FixtureRuntime[]): Promise<RunMeasurement> {
  const runtime = await bootFixtureRuntime({
    label,
    team: { coordinator: { name: 'intake-agent', tools: ['spawn_team', 'inspect-task-state'] } },
    // With the journal authoritative, the evidence file is a projection the
    // journal opens and closes per write. The runtime's own evidence writer
    // keeps the file open only when the journal is disabled.
    authoritativeJournal: false,
    env: { PIPELINE_DURABLE_JOURNAL: 'disabled' },
  })
  keepAlive.push(runtime)
  try {
    await runtime.host.invokeTool('inspect-task-state', `call-${label}`, {
      taskId: `task-inspect-${label}`,
    })
    const evidencePath = path.join(
      runtime.assignmentPath,
      'logs',
      ASSIGNMENT_LOG.capabilityDispatchEvents,
    )
    const heldWhileLive = descriptorsOpenOn(evidencePath).length
    await runtime.shutdown()
    return {
      heldWhileLive,
      heldAfterShutdown: descriptorsOpenOn(evidencePath).length,
      dispatchEvents: runtime
        .readAssignmentJsonl(ASSIGNMENT_LOG.capabilityDispatchEvents)
        .map((record) => record.type),
    }
  } finally {
    await runtime.close()
  }
}

test('session shutdown releases the capability evidence file, so many runs in one process do not accumulate descriptors', {
  skip: process.platform === 'win32' ? 'no per-process descriptor directory on Windows' : false,
  timeout: 300_000,
}, async () => {
  const keepAlive: FixtureRuntime[] = []

  // The first run loads the module graph and opens whatever the process keeps
  // for its whole life. The baseline is taken after it, so every later count
  // means only what a run left behind.
  await governedRun('evidence-fd-warm-up', keepAlive)
  const baseline = openDescriptors().length

  const runs: RunMeasurement[] = []
  const settledCounts: number[] = []
  for (let index = 0; index < RUN_COUNT; index++) {
    runs.push(await governedRun(`evidence-fd-${index}`, keepAlive))
    settledCounts.push(openDescriptors().length - baseline)
  }

  // Preconditions: every run wrote its evidence through a descriptor it held.
  for (const [index, run] of runs.entries()) {
    assert.deepEqual(
      run.dispatchEvents,
      [
        'capability.dispatch.requested',
        'capability.dispatch.started',
        'capability.dispatch.completed',
      ],
      `run ${index}: the governed call must have written its evidence`,
    )
    assert.equal(
      run.heldWhileLive,
      1,
      `run ${index}: a live run holds its evidence file open once`,
    )
  }

  assert.deepEqual(
    settledCounts,
    settledCounts.map(() => 0),
    `after each of ${RUN_COUNT} runs the process must hold as many descriptors as after the warm-up; ` +
      `growth over the baseline after each run: ${JSON.stringify(settledCounts)}`,
  )
  for (const [index, run] of runs.entries()) {
    assert.equal(
      run.heldAfterShutdown,
      0,
      `run ${index}: session shutdown must close the evidence file`,
    )
  }
  assert.equal(
    keepAlive.length,
    RUN_COUNT + 1,
    'every runtime stayed reachable until the counts were taken',
  )
})
