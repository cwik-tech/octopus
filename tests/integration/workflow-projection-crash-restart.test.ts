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
import { createJournalBackedWorkflowRecorder } from '../../workflows/workflow-journal.js'

const WORKER_PATH = fileURLToPath(
  new URL('./workflow-projection-crash-worker.js', import.meta.url),
)

/**
 * AC13 capability 1 — a real process dies between the canonical append and the
 * projection write, and a second process finishes the job.
 *
 * `workflow-state.json` is a projection of the journal, written after the
 * append it describes (`workflows/workflow-state-store.ts`,
 * `publishWorkflowState`). A crash in that window leaves durable truth ahead of
 * the file every reader consults. AC9 made `load()` repair that from the
 * journal; this proves the repair holds across real process death rather than
 * an in-process error, and that recovery neither repeats a completed external
 * effect nor skips the work still owed.
 *
 * The workflow has two steps so those are different observable facts: the
 * crash lands with `research` completed and `publish` still pending. Effects
 * are counted per step by an ephemeral loopback ledger, so "research once,
 * publish once" is observed out of process rather than inferred from a total.
 */
test('a workflow killed between its journal append and its projection write is rebuilt and finished once', {
  timeout: 60_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-projection-crash-'))
  const ledger = await startEffectLedger()
  let child: ChildProcess | undefined
  try {
    const assignmentRoot = path.join(root, 'assignments', 'root-run')
    const markerPath = path.join(root, 'appended.json')
    const outcomePath = path.join(root, 'outcome.json')
    fs.mkdirSync(assignmentRoot, { recursive: true })

    // Registered before the spawn, so the event cannot be missed between the
    // worker publishing the marker and this process starting to look for it.
    const marker = watchForFile(root, path.basename(markerPath))

    // stdin is a pipe this process holds open and never writes to or ends. It
    // is what the worker blocks on after its append, so the child stays alive
    // to be killed rather than exiting when its event loop drains.
    child = spawn(
      process.execPath,
      [WORKER_PATH, 'crash', assignmentRoot, ledger.url, markerPath, outcomePath],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    )
    const stderrChunks: Buffer[] = []
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
      process.stderr.write(chunk)
    })
    assert.ok(child.stdin, 'the crash child holds an open stdin pipe')
    const exited = once(child, 'exit')

    // The marker and an early death are raced. Awaiting the marker alone would
    // hang until the test timeout on any worker failure, reporting a stall
    // instead of the error that caused it.
    let reachedSeam: boolean
    try {
      const first = await Promise.race([
        marker.ready.then(() => ({ kind: 'marker' } as const)),
        exited.then((value) => ({ kind: 'exited', value } as const)),
      ])
      reachedSeam = first.kind === 'marker'
      if (first.kind === 'exited') {
        const early = exitOutcomeOf(first.value)
        throw new Error(
          `the crash child exited before reaching the seam ` +
            `(code=${String(early.code)}, signal=${String(early.signal)}):\n` +
            Buffer.concat(stderrChunks).toString('utf8'),
        )
      }
    } finally {
      marker.close()
    }
    assert.ok(reachedSeam)

    assert.equal(
      child.exitCode,
      null,
      'the child is still alive at the seam, so the kill is what ends it',
    )
    child.kill('SIGKILL')
    const exit = exitOutcomeOf(await exited)

    assert.equal(exit.signal, 'SIGKILL', 'the first process died by SIGKILL')
    assert.equal(exit.code, null, 'and not by its own exit path')

    assert.deepEqual(
      ledger.counts(),
      { research: 1 },
      'research ran its effect once before the crash, and publish never ran',
    )

    const journaled = await readJournaledSteps(assignmentRoot)
    assert.equal(
      journaled.research,
      'completed',
      'the canonical journal carries the completed research transition',
    )
    assert.equal(
      journaled.publish,
      'pending',
      'and publish is still owed, so the remaining work is observable',
    )

    const projected = readProjectedSteps(assignmentRoot)
    assert.ok(
      projected !== null,
      'an earlier projection exists, so this is a stale file rather than an absent one',
    )
    assert.equal(
      projected.research,
      'running',
      'while the projection still shows research as it was before the append',
    )

    const resumeCode = await runWorker([
      'resume',
      assignmentRoot,
      ledger.url,
      markerPath,
      outcomePath,
    ])
    assert.equal(resumeCode, 0, 'the second process completed')

    const outcome = readOutcome(outcomePath)
    assert.equal(
      outcome.repeatedCompletedEffect,
      false,
      'recovery saw research as already completed, so it did not redo its effect',
    )
    assert.equal(
      outcome.recoveredResearchStatus,
      'completed',
      'the rebuilt projection carries the transition that only the journal held',
    )
    assert.equal(
      outcome.recoveredPublishStatus,
      'pending',
      'and still shows the work that was never done',
    )
    assert.equal(
      outcome.recoveredRevision,
      journaled.revision,
      'the rebuild replayed the journal to its end rather than to the stale file',
    )
    assert.equal(outcome.finalStatus, 'completed')

    const finalProjection = readProjectedSteps(assignmentRoot)
    assert.ok(finalProjection !== null)
    assert.equal(finalProjection.research, 'completed')
    assert.equal(finalProjection.publish, 'completed')

    assert.deepEqual(
      ledger.counts(),
      { publish: 1, research: 1 },
      'each step ran its effect exactly once across both processes: the ' +
        'completed one was not repeated and the pending one was not skipped',
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
    // The worker may publish before the watcher is armed on some platforms.
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

interface StepStatuses {
  readonly research: string
  readonly publish: string
}

function readProjectedSteps(assignmentRoot: string): StepStatuses | null {
  const statePath = path.join(assignmentRoot, '.runtime', 'workflow-state.json')
  let raw: string
  try {
    raw = fs.readFileSync(statePath, 'utf8')
  } catch {
    return null
  }
  const parsed: unknown = JSON.parse(raw)
  return stepStatusesOf(parsed)
}

async function readJournaledSteps(
  assignmentRoot: string,
): Promise<StepStatuses & { readonly revision: number }> {
  const journal = await initializeExecutionJournal({
    scopeRoot: assignmentRoot,
    identity: journalIdentity(),
  })
  try {
    const recorded = await createJournalBackedWorkflowRecorder(journal).readRecordedState({
      taskId: 'task-one',
      workflowId: 'research-workflow',
    })
    assert.ok(recorded, 'the canonical journal holds the workflow stream')
    const steps = stepStatusesOf(recorded.state)
    assert.ok(steps, 'the recorded state carries both steps')
    return { ...steps, revision: recorded.state.revision }
  } finally {
    await journal.close()
  }
}

/**
 * Both the projection file and the replayed state cross a boundary this test
 * does not own, so each is narrowed rather than trusted.
 */
function stepStatusesOf(value: unknown): StepStatuses | null {
  if (typeof value !== 'object' || value === null) return null
  const record: Record<string, unknown> = { ...value }
  const steps = record['steps']
  if (!Array.isArray(steps)) return null
  const research = statusOfStep(steps, 'research')
  const publish = statusOfStep(steps, 'publish')
  if (research === null || publish === null) return null
  return { research, publish }
}

function statusOfStep(steps: readonly unknown[], stepId: string): string | null {
  for (const entry of steps) {
    if (typeof entry !== 'object' || entry === null) continue
    const step: Record<string, unknown> = { ...entry }
    if (step['stepId'] !== stepId) continue
    const status = step['status']
    return typeof status === 'string' ? status : null
  }
  return null
}

interface ResumeOutcome {
  readonly recoveredRevision: number
  readonly recoveredResearchStatus: string
  readonly recoveredPublishStatus: string
  readonly repeatedCompletedEffect: boolean
  readonly finalRevision: number
  readonly finalStatus: string
}

/** The outcome crossed a process boundary, so every field is narrowed. */
function readOutcome(outcomePath: string): ResumeOutcome {
  const parsed: unknown = JSON.parse(fs.readFileSync(outcomePath, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('the worker produced no outcome object')
  }
  const record: Record<string, unknown> = { ...parsed }
  return {
    recoveredRevision: numberField(record, 'recoveredRevision'),
    recoveredResearchStatus: stringField(record, 'recoveredResearchStatus'),
    recoveredPublishStatus: stringField(record, 'recoveredPublishStatus'),
    repeatedCompletedEffect: booleanField(record, 'repeatedCompletedEffect'),
    finalRevision: numberField(record, 'finalRevision'),
    finalStatus: stringField(record, 'finalStatus'),
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
 * An out-of-process ledger of external effects, counted per step.
 *
 * A single total cannot distinguish "research twice" from "research once and
 * publish once", so the body names the effect and the ledger keeps one count
 * per name. The body arrives from another process, so it is parsed as unknown
 * and narrowed; anything unrecognised is refused rather than counted.
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
  const effect = record['effect']
  if (effect !== 'research' && effect !== 'publish') return null
  return effect
}
