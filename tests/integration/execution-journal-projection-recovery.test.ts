import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createJournalBackedDurableDispatch } from '../../core/durable-dispatch-journal.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import { PROJECTION_RECOVERY_IDENTITY } from './execution-journal-projection-recovery-identity.js'

/**
 * AC8, across a process boundary: recovery reads the journal, not a buffer.
 *
 * The in-memory path can be made to look correct while the durable one is not.
 * Inside a single process a "recovered" line may simply be the batch still
 * sitting in the port's buffer, and no assertion can tell the two apart. A
 * worker that exits takes its buffer with it, so whatever the parent finds
 * afterwards was read back from the canonical journal — which is the property
 * that has to survive a restart.
 */

const WORKER_PATH = fileURLToPath(
  new URL('./execution-journal-projection-recovery-worker.js', import.meta.url),
)

test('a view stranded by a worker that exited is recovered by the next process', {
  timeout: 60_000,
}, async () => {
  const scopeRoot = makeScopeRoot()
  const logsDirectory = path.join(scopeRoot, 'logs')
  const evidencePath = path.join(
    logsDirectory,
    'capability-dispatch-events.jsonl',
  )
  try {
    // The worker cannot derive: its view's parent is a regular file. That
    // fails with `ENOTDIR` whatever user it runs as, which `chmod` cannot
    // promise.
    fs.writeFileSync(logsDirectory, 'not a directory', { mode: 0o600 })

    const outcomePath = path.join(scopeRoot, 'worker-outcome.json')
    const exitCode = await spawnWorker([scopeRoot, evidencePath, outcomePath])
    assert.equal(exitCode, 0, readWorkerFailure(outcomePath))

    const outcome = readWorkerOutcome(outcomePath)
    assert.equal(
      outcome.status,
      'completed',
      'the dispatch succeeded even though its view could not be written',
    )
    assert.equal(outcome.executions, 1, 'and its effect ran exactly once')
    assert.equal(
      outcome.projection,
      'lagging',
      'and the worker knew its view was behind before it exited',
    )
    assert.ok(outcome.dispatchId, 'the worker reports the dispatch it recorded')
    assert.equal(
      fs.existsSync(evidencePath),
      false,
      'nothing was derived while the fault was active',
    )

    // The fault clears, and a *different* process opens the same assignment.
    fs.rmSync(logsDirectory)
    fs.mkdirSync(logsDirectory, { recursive: true, mode: 0o700 })

    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: PROJECTION_RECOVERY_IDENTITY,
    })
    try {
      const port = createJournalBackedDurableDispatch(journal, {
        capabilityEvidenceProjectionPath: evidencePath,
      })
      assert.equal(
        await port.projectionStatus('capability-evidence'),
        'current',
        'the new process catches the view up from the journal',
      )

      assert.deepEqual(
        readEvidenceIdentities(evidencePath),
        [
          `${outcome.dispatchId}:capability.dispatch.requested`,
          `${outcome.dispatchId}:capability.dispatch.started`,
          `${outcome.dispatchId}:capability.dispatch.completed`,
        ],
        'every event the worker recorded, once, with no buffer to inherit',
      )
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

function makeScopeRoot(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'projection-recovery-')),
  )
}

async function spawnWorker(args: readonly string[]): Promise<number | null> {
  const child = spawn(process.execPath, [WORKER_PATH, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  // The exit payload is an event-emitter callback argument, so it is narrowed
  // rather than asserted into shape — the same rule the worker's outcome and
  // the derived view follow.
  const code = readExitCode(await once(child, 'exit'))
  if (code !== 0 && stderr.length > 0) process.stderr.write(stderr)
  return code
}

function readExitCode(payload: unknown): number | null {
  if (!Array.isArray(payload)) return null
  const [code]: unknown[] = payload
  if (code === null || typeof code === 'number') return code
  return null
}

function readWorkerFailure(outcomePath: string): string {
  try {
    return fs.readFileSync(outcomePath, 'utf8')
  } catch {
    return 'worker produced no outcome file'
  }
}

/**
 * The worker's outcome crossed a process boundary, so every field is narrowed
 * rather than asserted into shape.
 */
function readWorkerOutcome(outcomePath: string): {
  readonly status: string | undefined
  readonly dispatchId: string | undefined
  readonly executions: number | undefined
  readonly projection: string | undefined
} {
  const parsed: unknown = JSON.parse(fs.readFileSync(outcomePath, 'utf8'))
  return {
    status: readString(parsed, 'status'),
    dispatchId: readString(parsed, 'dispatchId'),
    executions: readNumber(parsed, 'executions'),
    projection: readString(parsed, 'projection'),
  }
}

/** The derived view is a file on disk, so its lines are narrowed too. */
function readEvidenceIdentities(evidencePath: string): string[] {
  return fs
    .readFileSync(evidencePath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line)
      return `${readString(parsed, 'dispatchId') ?? '?'}:${
        readString(parsed, 'type') ?? '?'
      }`
    })
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined
  }
  const held: unknown = Reflect.get(value, key)
  return typeof held === 'string' ? held : undefined
}

function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined
  }
  const held: unknown = Reflect.get(value, key)
  return typeof held === 'number' ? held : undefined
}
