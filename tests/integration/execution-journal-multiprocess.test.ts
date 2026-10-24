import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ExecutionJournalError,
  type ExecutionJournalEvent,
  type ExecutionJournalScopeIdentity,
} from '../../contracts/execution-journal.js'
import {
  initializeExecutionJournal,
  recomputeEventHash,
} from '../../core/execution-journal.js'
import {
  acquireProcessFileLock,
  createCrossProcessFileLockRecord,
  crossProcessFileLockAdapter,
} from '../../core/cross-process-file-lock.js'

const WORKER_PATH = fileURLToPath(
  new URL('./execution-journal-multiprocess-worker.js', import.meta.url),
)

const TEST_IDENTITY: ExecutionJournalScopeIdentity = {
  scopeKind: 'assignment',
  scopeId: 'assignment-scope-1',
  tenantId: 'tenant-test',
  sessionId: 'session-1',
  runId: 'run-1',
  assignmentId: 'assignment-1',
}

test('two real processes append complete contiguous hash-chained records to one scope journal', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    await journal.close()

    const outcomeA = path.join(scopeRoot, 'outcome-a.json')
    const outcomeB = path.join(scopeRoot, 'outcome-b.json')
    const [exitA, exitB] = await Promise.all([
      spawnWorker([
        scopeRoot,
        JSON.stringify(TEST_IDENTITY),
        'burst',
        'worker-a',
        outcomeA,
        '25',
      ]),
      spawnWorker([
        scopeRoot,
        JSON.stringify(TEST_IDENTITY),
        'burst',
        'worker-b',
        outcomeB,
        '25',
      ]),
    ])
    assert.equal(exitA, 0, readWorkerFailure(outcomeA))
    assert.equal(exitB, 0, readWorkerFailure(outcomeB))

    const reopened = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    try {
      const scan = await reopened.scan()
      assert.equal(scan.eventCount, 50)
      assert.equal(scan.lastSequence, 50)

      const sequences = scan.events.map((event) => event.sequence)
      assert.deepEqual(
        sequences,
        Array.from({ length: 50 }, (_unused, index) => index + 1),
      )

      const eventIds = new Set(scan.events.map((event) => event.eventId))
      assert.equal(eventIds.size, 50)

      let previousHash = reopened.manifest.initialPreviousEventHash
      for (const event of scan.events) {
        assert.equal(event.previousEventHash, previousHash)
        assert.equal(event.eventHash, recomputeEventHash(event))
        previousHash = event.eventHash
      }

      for (const workerId of ['worker-a', 'worker-b']) {
        const stream = scan.events.filter((event) => event.streamId === workerId)
        assert.equal(stream.length, 25)
        assert.deepEqual(
          stream.map((event) => event.streamRevision),
          Array.from({ length: 25 }, (_unused, index) => index + 1),
        )
        assert.ok(stream.every((event) => event.streamKind === 'test'))
      }
    } finally {
      await reopened.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

test('a cross-process stream revision race admits exactly one writer', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    const seeded = await journal.append({
      eventId: 'race-seed',
      streamKind: 'test',
      streamId: 'race',
      expectedStreamRevision: 0,
      type: 'test.seed',
      payloadSchemaVersion: 1,
      payload: { seeded: true },
      correlationId: 'corr-race',
    })
    assert.equal(seeded.kind, 'appended')
    await journal.close()

    const outcomeA = path.join(scopeRoot, 'outcome-a.json')
    const outcomeB = path.join(scopeRoot, 'outcome-b.json')
    const [exitA, exitB] = await Promise.all([
      spawnWorker([
        scopeRoot,
        JSON.stringify(TEST_IDENTITY),
        'race',
        'worker-a',
        outcomeA,
        '1',
        '1',
      ]),
      spawnWorker([
        scopeRoot,
        JSON.stringify(TEST_IDENTITY),
        'race',
        'worker-b',
        outcomeB,
        '1',
        '1',
      ]),
    ])
    assert.equal(exitA, 0, readWorkerFailure(outcomeA))
    assert.equal(exitB, 0, readWorkerFailure(outcomeB))

    const outcomeResults = [
      readWorkerOutcome(outcomeA),
      readWorkerOutcome(outcomeB),
    ]
    const appended = outcomeResults.filter(
      (outcome) => outcome.kind === 'appended',
    )
    const conflicted = outcomeResults.filter(
      (outcome) => outcome.kind === 'revision-conflict',
    )
    assert.equal(appended.length, 1)
    assert.equal(conflicted.length, 1)
    const winner = appended[0]
    const loser = conflicted[0]
    assert.ok(winner && loser)
    assert.equal(winner.event?.streamRevision, 2)
    assert.equal(loser.expectedRevision, 1)
    assert.equal(loser.actualRevision, 2)

    const reopened = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    try {
      const scan = await reopened.scan()
      const raceEvents = scan.events.filter((event) => event.streamId === 'race')
      assert.equal(raceEvents.length, 2)
      assert.deepEqual(
        raceEvents.map((event) => event.streamRevision),
        [1, 2],
      )
    } finally {
      await reopened.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

test('restart fails closed when the persisted hash-linked tail is invalid', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    for (let index = 0; index < 3; index += 1) {
      await journal.append({
        eventId: `tail-event-${index}`,
        streamKind: 'test',
        streamId: 'tail',
        expectedStreamRevision: index,
        type: 'test.observation',
        payloadSchemaVersion: 1,
        payload: { index },
        correlationId: 'corr-tail',
      })
    }
    await journal.close()

    const journalPath = path.join(
      scopeRoot,
      '.runtime',
      'execution-journal',
      'journal.jsonl',
    )
    const original = fs.readFileSync(journalPath, 'utf8')
    const lines = original.split('\n').filter((line) => line.length > 0)
    assert.equal(lines.length, 3)
    const lastLine = lines[2]
    assert.ok(lastLine)
    const corrupted = lastLine.replace(
      /"eventHash":"[a-f0-9]{64}"/,
      `"eventHash":"${'0'.repeat(64)}"`,
    )
    assert.notEqual(corrupted, lastLine)
    fs.writeFileSync(
      journalPath,
      `${lines.slice(0, 2).join('\n')}\n${corrupted}\n`,
      'utf8',
    )

    await assert.rejects(
      initializeExecutionJournal({ scopeRoot, identity: TEST_IDENTITY }),
      (error: unknown) =>
        error instanceof ExecutionJournalError && error.code === 'corrupt',
    )

    assert.equal(fs.readFileSync(journalPath, 'utf8'), `${lines.slice(0, 2).join('\n')}\n${corrupted}\n`)
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

test('restart truncates only an unterminated fragment from an unacknowledged append', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    for (let index = 0; index < 2; index += 1) {
      await journal.append({
        eventId: `fragment-event-${index}`,
        streamKind: 'test',
        streamId: 'fragment',
        expectedStreamRevision: index,
        type: 'test.observation',
        payloadSchemaVersion: 1,
        payload: { index },
        correlationId: 'corr-fragment',
      })
    }
    await journal.close()

    const journalPath = path.join(
      scopeRoot,
      '.runtime',
      'execution-journal',
      'journal.jsonl',
    )
    const acknowledged = fs.readFileSync(journalPath, 'utf8')
    fs.writeFileSync(
      journalPath,
      `${acknowledged}{"schemaVersion":1,"eventId":"frag`,
      'utf8',
    )

    const reopened = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    try {
      const scan = await reopened.scan()
      assert.equal(scan.eventCount, 2)
      assert.deepEqual(
        scan.events.map((event) => event.eventId),
        ['fragment-event-0', 'fragment-event-1'],
      )
      assert.equal(fs.readFileSync(journalPath, 'utf8'), acknowledged)
    } finally {
      await reopened.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

test('repeating an accepted append is idempotent and a changed digest conflicts', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    try {
      const appendInput = {
        eventId: 'idempotent-1',
        streamKind: 'test',
        streamId: 'idempotent',
        expectedStreamRevision: 0,
        type: 'test.observation',
        payloadSchemaVersion: 1,
        payload: { value: 'original' },
        correlationId: 'corr-idempotent',
      } as const
      const first = await journal.append(appendInput)
      assert.equal(first.kind, 'appended')
      if (first.kind !== 'appended') return

      const replayed = await journal.append(appendInput)
      assert.equal(replayed.kind, 'already-accepted')
      if (replayed.kind !== 'already-accepted') return
      assert.deepEqual(replayed.event, first.event)

      const conflicted = await journal.append({
        ...appendInput,
        payload: { value: 'tampered' },
      })
      assert.equal(conflicted.kind, 'event-identity-conflict')

      const scan = await journal.scan()
      assert.equal(scan.eventCount, 1)
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

test('initialization is idempotent for the same identity and fails closed on conflict', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const first = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    const manifestBefore = fs.readFileSync(
      path.join(scopeRoot, '.runtime', 'execution-journal', 'manifest.json'),
      'utf8',
    )
    await first.close()

    const second = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    await second.close()
    assert.equal(
      fs.readFileSync(
        path.join(scopeRoot, '.runtime', 'execution-journal', 'manifest.json'),
        'utf8',
      ),
      manifestBefore,
    )

    await assert.rejects(
      initializeExecutionJournal({
        scopeRoot,
        identity: { ...TEST_IDENTITY, scopeId: 'different-scope' },
      }),
      (error: unknown) =>
        error instanceof ExecutionJournalError &&
        error.code === 'manifest_conflict',
    )
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

test('relaxed journal permissions fail closed on open', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    await journal.close()

    const manifestPath = path.join(
      scopeRoot,
      '.runtime',
      'execution-journal',
      'manifest.json',
    )
    fs.chmodSync(manifestPath, 0o644)

    await assert.rejects(
      initializeExecutionJournal({ scopeRoot, identity: TEST_IDENTITY }),
      (error: unknown) =>
        error instanceof ExecutionJournalError &&
        error.code === 'permissions_unsafe',
    )
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

test('a symbolic-linked journal directory is rejected as an unsafe path', async () => {
  const scopeRoot = makeScopeRoot()
  const outsideTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-outside-'))
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    await journal.close()

    const runtimePath = path.join(scopeRoot, '.runtime')
    const journalDir = path.join(runtimePath, 'execution-journal')
    fs.rmSync(journalDir, { recursive: true, force: true })
    fs.symlinkSync(outsideTarget, journalDir, 'dir')

    await assert.rejects(
      initializeExecutionJournal({ scopeRoot, identity: TEST_IDENTITY }),
      (error: unknown) =>
        error instanceof ExecutionJournalError && error.code === 'path_unsafe',
    )
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
    fs.rmSync(outsideTarget, { recursive: true, force: true })
  }
})

test('append lock waits are bounded and report a typed timeout', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
      lockTimeoutMs: 300,
    })
    const lockPath = path.join(
      scopeRoot,
      '.runtime',
      'execution-journal',
      'journal.lock',
    )
    const lock = await acquireProcessFileLock({
      lockPath,
      record: createCrossProcessFileLockRecord(),
      adapter: crossProcessFileLockAdapter,
      timeoutMs: 0,
    })
    try {
      await assert.rejects(
        journal.append({
          eventId: 'locked-event',
          streamKind: 'test',
          streamId: 'locked',
          expectedStreamRevision: 0,
          type: 'test.observation',
          payloadSchemaVersion: 1,
          payload: { blocked: true },
          correlationId: 'corr-locked',
        }),
        (error: unknown) =>
          error instanceof ExecutionJournalError &&
          error.code === 'lock_timeout',
      )
    } finally {
      await lock.release()
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

function makeScopeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'execution-journal-mp-'))
}

async function spawnWorker(args: readonly string[]): Promise<number | null> {
  const child = spawn(process.execPath, [WORKER_PATH, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const [code] = (await once(child, 'exit')) as [number | null]
  if (code !== 0 && stderr.length > 0) {
    process.stderr.write(stderr)
  }
  return code
}

function readWorkerOutcome(outcomePath: string): {
  readonly kind: string
  readonly event?: ExecutionJournalEvent
  readonly expectedRevision?: number
  readonly actualRevision?: number
} {
  return JSON.parse(fs.readFileSync(outcomePath, 'utf8')) as {
    kind: string
    event?: ExecutionJournalEvent
    expectedRevision?: number
    actualRevision?: number
  }
}

function readWorkerFailure(outcomePath: string): string {
  try {
    return fs.readFileSync(outcomePath, 'utf8')
  } catch {
    return 'worker produced no outcome file'
  }
}
