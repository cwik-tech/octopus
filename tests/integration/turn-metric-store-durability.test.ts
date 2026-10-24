/**
 * What a helper's turn record says after its terminal write fails.
 *
 * The record exists so a person can ask what a turn ran on and how it ended.
 * That makes one property load-bearing: what is *reported* has to be what was
 * *persisted*. A store that updates itself first and writes afterwards breaks
 * it in two ways at once — a completion nobody can read back is reported as
 * fact, and the row that said "running" is gone, so the failure the caller
 * records next arrives as a second turn rather than as this one's outcome.
 *
 * Driven against a real directory with a real failing write rather than a
 * throwing double, because the double the existing Create tests use throws
 * before the store is reached and so proves nothing about the store's own
 * ordering.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { ResourceArchitectTurnMetric } from '../../contracts/resource-architect.js'
import { TurnMetricStore } from '../../server/turn-metric-store.js'

const DIRECTORY = 'workflow-architect'

const SELECTION = {
  provider: 'connection:fixture',
  model: 'fixture/model',
  source: 'app-default',
  reason: 'agent-default',
  caller: 'agent',
} as const

/**
 * A complete record, written out rather than asserted into shape.
 *
 * `sanitizeTurnMetric` reads `timing.context` immediately, so a partial literal
 * cast to the type throws before any of this reaches a file — and a test whose
 * first save throws for that reason would pass its "nothing was persisted"
 * assertion without ever exercising the store.
 */
function metric(
  jobId: string,
  status: ResourceArchitectTurnMetric['status'],
  selection?: ResourceArchitectTurnMetric['selection'],
): ResourceArchitectTurnMetric {
  return {
    schemaVersion: 1,
    recordedAt: '2026-09-09T10:00:00.000Z',
    jobId,
    operation: 'conversation',
    status,
    provider: 'connection:fixture',
    model: 'fixture/model',
    ...(selection ? { selection } : {}),
    reasoning: 'medium',
    outcomeKind: null,
    fallback: false,
    timing: {
      contextAssemblyMs: 1,
      providerDurationMs: 2,
      processSpawnMs: null,
      firstProviderEventMs: null,
      firstTextMs: null,
      parseDurationMs: 1,
      repairOccurred: false,
      repairDurationMs: 0,
      totalDurationMs: 4,
      context: {
        instructionsChars: 1,
        operationChars: 1,
        uploadedDocumentPolicyChars: 0,
        visualizationPolicyChars: 0,
        teamLibraryChars: 0,
        agentLibraryChars: 0,
        totalChars: 2,
        historyChars: 0,
      },
    },
  }
}

test('a completion nobody could persist is not reported as a completion', async () => {
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'turn-metric-unpersisted-')),
  )
  const store = new TurnMetricStore(workspacePath, DIRECTORY)
  try {
    // First the ordinary case, so the failure below cannot be a fixture that
    // never worked: the running record is written and read back from the file.
    await store.save(metric('job-1', 'running', SELECTION))
    const fresh = new TurnMetricStore(workspacePath, DIRECTORY)
    assert.equal((await fresh.list())[0]?.status, 'running')

    // Now only the terminal write fails.
    fs.rmSync(path.join(workspacePath, DIRECTORY, 'turns.json'))
    fs.mkdirSync(path.join(workspacePath, DIRECTORY, 'turns.json'))
    // Named, not swallowed. A catch-all would pass just as happily against a
    // store that threw for some unrelated reason — or one that never wrote at
    // all — so the rejection is checked for the filesystem failure this test
    // arranged.
    await assert.rejects(
      store.save(metric('job-1', 'completed')),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(
          (error as NodeJS.ErrnoException).code,
          'EISDIR',
          'the terminal write failed because the path is a directory',
        )
        return true
      },
    )

    assert.equal(
      (await store.list())[0]?.status,
      'running',
      'what is reported is what was persisted, not what was attempted',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a failed completion does not turn the caller’s failure into a second turn', async () => {
  // The sequence `server/routes/workflows.ts:261-268` produces: the terminal
  // save throws, and the catch records the turn as failed. One turn ended once,
  // so one row describes it — two would double every count taken from this file
  // and leave a person unable to say which outcome was real.
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'turn-metric-second-row-')),
  )
  const store = new TurnMetricStore(workspacePath, DIRECTORY)
  try {
    await store.save(metric('job-2', 'running', SELECTION))
    assert.equal((await store.list()).length, 1)

    // The disk stops accepting writes between the running record and its
    // outcome.
    fs.rmSync(path.join(workspacePath, DIRECTORY, 'turns.json'))
    fs.mkdirSync(path.join(workspacePath, DIRECTORY, 'turns.json'))
    await assert.rejects(
      store.save(metric('job-2', 'completed')),
      (error: unknown) =>
        (error as NodeJS.ErrnoException).code === 'EISDIR',
    )

    // Writable again, and the caller records what actually happened.
    fs.rmdirSync(path.join(workspacePath, DIRECTORY, 'turns.json'))
    await store.save(metric('job-2', 'failed'))

    for (const [described, rows] of [
      ['the store that wrote it', await store.list()],
      // And the file's own answer, which is the one a later process gets.
      ['a store built fresh over the same workspace',
        await new TurnMetricStore(workspacePath, DIRECTORY).list()],
    ] as const) {
      assert.equal(rows.length, 1, `one turn, one row — ${described}`)
      assert.equal(
        rows[0]?.status,
        'failed',
        `the outcome that was recorded — ${described}`,
      )
      assert.deepEqual(
        rows[0]?.selection,
        SELECTION,
        `the pair the turn ran on is still on record — ${described}`,
      )
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a store with no workspace still replaces its running record in memory', async () => {
  // The in-memory mode has no durable write to succeed or fail, and must keep
  // behaving as it did: one row per turn, the outcome replacing the status.
  const store = new TurnMetricStore(undefined, DIRECTORY)

  await store.save(metric('job-3', 'running', SELECTION))
  await store.save(metric('job-3', 'completed'))

  const rows = await store.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.status, 'completed')
  assert.deepEqual(rows[0]?.selection, SELECTION)
})
