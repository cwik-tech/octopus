import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

import type { ExecutionJournalScopeIdentity } from '../../contracts/execution-journal.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import {
  createCapabilityEvidenceProjectionStore,
  lastDispatchSequence,
} from '../../core/capability-dispatch-projection.js'

const WORKER_PATH = fileURLToPath(
  new URL('./dispatch-committed-crash-worker.js', import.meta.url),
)
const EXIT_DEADLINE_MS = 15_000

/**
 * AC13 capability 2 — a real process dies after `capability.dispatch.committed`
 * and before `capability.dispatch.accepted`.
 *
 * In that window the external effect has already run and been recorded, but
 * the derived evidence view exists only as an in-memory batch: `recordCommitted`
 * does not flush, and the terminal flush lives in `recordAccepted`
 * (`core/durable-dispatch-journal.ts`). Killing the process there loses the
 * batch and leaves the canonical journal complete through the committed
 * barrier while the view is behind.
 *
 * What must then hold is that a second process reports the committed effect for
 * reconciliation rather than running it again, and brings the view current from
 * the journal.
 *
 * The kill belongs to a triple-gated test failpoint in the dispatcher. Before
 * that failpoint existed this test failed with the crash worker exiting
 * cleanly and never publishing its marker — a bounded failure, not a hang,
 * which is the Red this capability was built against.
 */
test('a dispatch killed after commit and before accept is reconciled, not repeated', {
  timeout: 60_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-committed-crash-'))
  const ledger = await startEffectLedger()
  let child: ChildProcess | undefined
  try {
    const scopeRoot = path.join(root, 'assignments', 'root-run')
    // The production assignment layout and anchor: the evidence view lives
    // under the assignment's own logs directory, not a sibling of it.
    const evidencePath = path.join(scopeRoot, 'logs', 'capability-dispatch-events.jsonl')
    const markerPath = path.join(root, 'committed.json')
    const outcomePath = path.join(root, 'outcome.json')
    fs.mkdirSync(scopeRoot, { recursive: true })

    // Armed before the spawn, so a marker published between spawn and the
    // parent's first await cannot be missed.
    const marker = watchForFile(root, path.basename(markerPath))

    child = spawn(
      process.execPath,
      [WORKER_PATH, 'crash', scopeRoot, ledger.url, evidencePath, outcomePath],
      {
        stdio: ['pipe', 'ignore', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          // The capability the failpoint targets, matched against the
          // dispatch's own capabilityId.
          PIPELINE_TEST_CRASH_AFTER_DISPATCH_COMMITTED: 'test.mutate',
          PIPELINE_TEST_CRASH_AFTER_DISPATCH_COMMITTED_MARKER: markerPath,
        },
      },
    )
    const stderrChunks: Buffer[] = []
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
      process.stderr.write(chunk)
    })
    const exited = once(child, 'exit')

    // Marker versus exit. The failpoint kills the process the instant after
    // publishing, so the exit can legitimately be observed first; that is
    // accepted only when the atomically published marker is actually on disk.
    // Anything else is a worker that never reached the seam, reported with its
    // own outcome rather than stalling until the timeout.
    try {
      const first = await Promise.race([
        marker.ready.then(() => ({ kind: 'marker' } as const)),
        exited.then((value) => ({ kind: 'exited', value } as const)),
      ])
      if (first.kind === 'exited' && !fs.existsSync(markerPath)) {
        const early = exitOutcomeOf(first.value)
        assert.fail(
          `the crash worker exited before the commit seam ` +
            `(code=${String(early.code)}, signal=${String(early.signal)}), so the ` +
            `required triple-gated failpoint that must SIGKILL between ` +
            `capability.dispatch.committed and capability.dispatch.accepted is ` +
            `absent. Worker outcome: ${describeOutcome(outcomePath)}\n` +
            Buffer.concat(stderrChunks).toString('utf8'),
        )
      }
    } finally {
      marker.close()
    }

    // The failpoint kills itself; this parent never signals it here. Waiting is
    // bounded by one deadline rather than left open, so a worker that publishes
    // the marker and then fails to die is a failure and not a hang.
    const exit = exitOutcomeOf(
      await withDeadline(exited, EXIT_DEADLINE_MS, 'the crash worker to exit'),
    )
    assert.equal(exit.signal, 'SIGKILL', 'the first process died by SIGKILL')
    assert.equal(exit.code, null, 'and not by its own exit path')

    assert.deepEqual(
      ledger.counts(),
      { dispatch: 1 },
      'the mutating effect ran exactly once before the crash',
    )

    const stages = await readDispatchStages(scopeRoot)
    assert.deepEqual(
      stages,
      ['requested', 'prepared', 'started', 'committed'],
      'the canonical stream is complete through the committed barrier and stops ' +
        'there — the effect is recorded, its acceptance is not',
    )

    const lag = await classifyEvidenceLag(scopeRoot, evidencePath)
    assert.equal(
      lag,
      'lagging',
      'the derived view is behind, classified from its own metadata without ' +
        'flushing — asking the port would repair the very state under test',
    )

    const resumeCode = await runWorker([
      'resume',
      scopeRoot,
      ledger.url,
      evidencePath,
      outcomePath,
    ])
    assert.equal(resumeCode, 0, 'the second process completed')

    const outcome = readOutcome(outcomePath)
    assert.equal(outcome.phase, 'resume')
    assert.equal(
      outcome.status,
      'indeterminate',
      'the replayed dispatch settles as indeterminate rather than completed',
    )
    assert.equal(
      outcome.code,
      'durable_replay_reconcile_required',
      'a committed but unaccepted effect is reported for reconciliation',
    )
    assert.equal(
      outcome.executions,
      0,
      'and the adapter did not run again',
    )
    assert.equal(
      outcome.projectionStatus,
      'current',
      'the restarted process caught the view up from the canonical journal',
    )
    assert.deepEqual(
      ledger.counts(),
      { dispatch: 1 },
      'the external effect still stands at one across both processes',
    )
  } finally {
    child?.kill('SIGKILL')
    await ledger.close()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
  }
})

/**
 * Watches for the first appearance of `name` in `directory`.
 *
 * `close()` is exposed because the caller races this against the child dying,
 * and the loser of that race has to release its watcher either way.
 */
function watchForFile(
  directory: string,
  name: string,
): { readonly ready: Promise<void>; close(): void } {
  const target = path.join(directory, name)
  let watcher: fs.FSWatcher | undefined
  let settled = false
  const ready = new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      watcher?.close()
      if (error === undefined) resolve()
      else reject(error)
    }
    watcher = fs.watch(directory, (_event, changed) => {
      if (changed !== name) return
      if (!fs.existsSync(target)) return
      finish()
    })
    watcher.on('error', (error) => finish(error))
    if (fs.existsSync(target)) finish()
  })
  return {
    ready,
    close: () => {
      if (settled) return
      settled = true
      watcher?.close()
    },
  }
}

async function runWorker(args: readonly string[]): Promise<number | null> {
  const child = spawn(process.execPath, [WORKER_PATH, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test' },
  })
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
  return exitOutcomeOf(await once(child, 'exit')).code
}

interface ExitOutcome {
  readonly code: number | null
  readonly signal: string | null
}

/**
 * The `exit` payload is whatever the event emitted, so it is narrowed rather
 * than asserted into shape — the same rule the outcome file follows.
 *
 * An unexpected shape throws instead of collapsing to `null`: silently reading
 * a malformed payload as "no code, no signal" would let a test asserting
 * `signal === 'SIGKILL'` fail for a reason that has nothing to do with the
 * process, and one asserting `code === null` pass for no reason at all.
 */
function exitOutcomeOf(payload: unknown): ExitOutcome {
  if (!Array.isArray(payload) || payload.length < 2) {
    throw new Error(
      `the exit event carried an unexpected payload: ${JSON.stringify(payload)}`,
    )
  }
  const [code, signal] = payload
  if (code !== null && typeof code !== 'number') {
    throw new Error(`the exit event carried a non-numeric code: ${String(code)}`)
  }
  if (signal !== null && typeof signal !== 'string') {
    throw new Error(`the exit event carried a non-string signal: ${String(signal)}`)
  }
  return { code, signal }
}

/** One deadline, cleared on settle, so a stalled wait fails instead of hanging. */
function withDeadline<T>(
  work: Promise<T>,
  milliseconds: number,
  description: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${milliseconds}ms waiting for ${description}`)),
      milliseconds,
    )
  })
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** The dispatch stages the canonical journal actually holds, in order. */
async function readDispatchStages(scopeRoot: string): Promise<readonly string[]> {
  const journal = await initializeExecutionJournal({
    scopeRoot,
    identity: journalIdentity(),
  })
  try {
    const scan = await journal.scan()
    return scan.events
      .map((event) => event.type)
      .filter((type) => type.startsWith('capability.dispatch.'))
      .map((type) => type.slice('capability.dispatch.'.length))
  } finally {
    await journal.close()
  }
}

/**
 * Classify the derived view's lag from its own metadata.
 *
 * Deliberately not `port.projectionStatus`: that flushes first, which would
 * catch the view up and destroy the state being asserted.
 */
async function classifyEvidenceLag(
  scopeRoot: string,
  evidencePath: string,
): Promise<string> {
  const journal = await initializeExecutionJournal({
    scopeRoot,
    identity: journalIdentity(),
  })
  try {
    const scan = await journal.scan()
    const store = createCapabilityEvidenceProjectionStore(journal, evidencePath)
    return store.classifyLag(lastDispatchSequence(scan.events))
  } finally {
    await journal.close()
  }
}

interface WorkerOutcome {
  readonly phase: string
  readonly reachedSeam: boolean
  readonly status: string
  readonly code: string
  readonly executions: number
  readonly projectionStatus: string
}

/** The outcome crossed a process boundary, so every field is narrowed. */
function readOutcome(outcomePath: string): WorkerOutcome {
  const parsed: unknown = JSON.parse(fs.readFileSync(outcomePath, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('the worker produced no outcome object')
  }
  const record: Record<string, unknown> = { ...parsed }
  return {
    phase: stringField(record, 'phase'),
    reachedSeam: booleanField(record, 'reachedSeam'),
    status: stringField(record, 'status'),
    code: stringField(record, 'code'),
    executions: numberField(record, 'executions'),
    projectionStatus: stringField(record, 'projectionStatus'),
  }
}

/** Best-effort rendering for a failure message; never throws. */
function describeOutcome(outcomePath: string): string {
  try {
    return JSON.stringify(readOutcome(outcomePath))
  } catch {
    return 'no readable outcome file'
  }
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`the worker outcome is missing a numeric ${key}`)
  }
  return value
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new Error(`the worker outcome is missing a string ${key}`)
  }
  return value
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') {
    throw new Error(`the worker outcome is missing a boolean ${key}`)
  }
  return value
}

function journalIdentity(): ExecutionJournalScopeIdentity {
  return {
    scopeKind: 'assignment',
    scopeId: 'root-run',
    tenantId: 'local',
    sessionId: 'product-session',
    runId: 'root-run',
    assignmentId: 'root-run',
  }
}

/**
 * An out-of-process ledger of external effects, counted per name. The body
 * arrives from another process, so it is parsed as unknown and narrowed;
 * anything unrecognised is refused rather than counted.
 */
async function startEffectLedger(): Promise<{
  readonly url: string
  counts(): Record<string, number>
  close(): Promise<void>
}> {
  const counts = new Map<string, number>()
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mutate') {
      res.writeHead(404)
      res.end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const effect = effectNameOf(Buffer.concat(chunks).toString('utf8'))
      if (effect === null) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unrecognised effect' }))
        return
      }
      counts.set(effect, (counts.get(effect) ?? 0) + 1)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ effect, count: counts.get(effect) }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    counts: () => Object.fromEntries([...counts.entries()].sort()),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

function effectNameOf(body: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record: Record<string, unknown> = { ...parsed }
  return record['effect'] === 'dispatch' ? 'dispatch' : null
}
