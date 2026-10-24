import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { readExecutionJournal } from '../../core/execution-journal.js'
import { reconcileWorkspaceTenantPin } from '../../services/execution-journal-tenant-pin.js'

/**
 * Branch 1, Package 1a — the inner seam test. One coherent outcome: a
 * mutating dispatch constructed through the Team Runtime capability dispatch
 * factory lands on the assignment's durable journal authority.
 *
 * The worker builds its dispatcher through
 * `createTeamRuntimeCapabilityDispatcher`, the same construction factory
 * `ensureCapabilityDispatcher` delegates to, so this proves the journaled
 * construction path in isolation. That the real runtime reaches dispatch
 * through that path is covered by the public-boundary test
 * (`tests/integration/team-runtime-journal-public-boundary.test.ts`), which
 * boots the actual extension and invokes a registered governed tool.
 *
 * With the durable port wired, a journaled dispatch's evidence rows are
 * derived from the journal with the independent compatibility write
 * suppressed, so the legacy view must hold exactly one row per barrier,
 * consistent with the canonical record.
 */

const WORKER_PATH = fileURLToPath(
  new URL('./team-runtime-journal-barriers-worker.js', import.meta.url),
)
const EXIT_DEADLINE_MS = 30_000

const SESSION_ID = 'session-barriers'
const RUN_ID = 'run-barriers'
const ASSIGNMENT_ID = 'assignment-barriers'
const TASK_ID = 'task-barriers'
const PROCESS_IDENTITY = 'barriers-worker'

test('a Team Runtime dispatch through the capability dispatch factory is journaled on the assignment', {
  timeout: 60_000,
}, async () => {
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'team-runtime-journal-barriers-')),
  )
  const assignmentPath = path.join(
    workspacePath,
    'sessions',
    SESSION_ID,
    'runs',
    RUN_ID,
    'assignments',
    ASSIGNMENT_ID,
  )
  fs.mkdirSync(assignmentPath, { recursive: true })
  await reconcileWorkspaceTenantPin({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  const ledger = await startEffectLedger()
  const outcomePath = path.join(workspacePath, 'outcome.json')
  let child: ChildProcess | undefined
  try {
    child = spawn(
      process.execPath,
      [
        WORKER_PATH,
        workspacePath,
        SESSION_ID,
        RUN_ID,
        ASSIGNMENT_ID,
        TASK_ID,
        PROCESS_IDENTITY,
        ledger.url,
        outcomePath,
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PIPELINE_DURABLE_JOURNAL: 'authoritative',
          TEAM_TENANT_ID: 'local',
          TEAM_RUNTIME_SESSION_ID: SESSION_ID,
          TEAM_RUNTIME_RUN_ID: RUN_ID,
          TEAM_RUNTIME_ASSIGNMENT_ID: ASSIGNMENT_ID,
          TEAM_RUNTIME_TASK_ID: TASK_ID,
          TEAM_RUNTIME_PROCESS_IDENTITY: PROCESS_IDENTITY,
        },
      },
    )
    const stderrChunks: Buffer[] = []
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })
    const [code, signal] = (await withDeadline(
      once(child, 'exit'),
      EXIT_DEADLINE_MS,
      'the Team Runtime barriers worker to exit',
    )) as [number | null, NodeJS.Signals | null]
    const stderr = Buffer.concat(stderrChunks).toString('utf8')
    assert.equal(signal, null, `the worker must not be signalled; stderr:\n${stderr}`)
    assert.equal(code, 0, `the worker must exit cleanly; stderr:\n${stderr}`)

    const outcome = readOutcome(outcomePath)
    assert.equal(outcome.status, 'completed', 'the dispatch itself completes today')
    assert.equal(outcome.executions, 1, 'the effect ran exactly once')
    assert.deepEqual(ledger.counts(), { dispatch: 1 }, 'the ledger counted the same effect')

    // The acceptance contract: the dispatch reached the assignment's durable
    // journal authority.
    const journal = await readExecutionJournal(assignmentPath)
    assert.equal(
      journal.kind,
      'ok',
      'a Team Runtime dispatch must be under the assignment durable journal ' +
        `authority, but the journal read returned '${journal.kind}'` +
        (journal.kind === 'corrupt' ? ` (${journal.reason})` : '') +
        ' — the dispatcher construction path provides no durable port',
    )
    if (journal.kind !== 'ok') return

    const dispatchTypes = journal.events
      .filter((event) => event.streamKind === 'capability.dispatch')
      .map((event) => event.type)
    for (const barrier of [
      'capability.dispatch.prepared',
      'capability.dispatch.started',
      'capability.dispatch.accepted',
    ]) {
      assert.ok(
        dispatchTypes.includes(barrier),
        `the assignment journal must carry ${barrier} for the dispatch; ` +
          `recorded dispatch events: ${JSON.stringify(dispatchTypes)}`,
      )
    }

    // With the durable port wired, the journaled dispatch's evidence rows
    // are derived from the journal with the independent compatibility write
    // suppressed: exactly one row per barrier, consistent with the canonical
    // record.
    const evidenceRows = readEvidenceRows(
      path.join(assignmentPath, 'logs', 'capability-dispatch-events.jsonl'),
    )
    for (const row of [
      'capability.dispatch.requested',
      'capability.dispatch.started',
      'capability.dispatch.completed',
    ]) {
      assert.equal(
        evidenceRows.filter((type) => type === row).length,
        1,
        `the evidence view must be consistent with the canonical record: ` +
          `exactly one ${row} row; recorded rows: ${JSON.stringify(evidenceRows)}`,
      )
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    await ledger.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

function readOutcome(outcomePath: string): {
  readonly status: string
  readonly code?: string
  readonly executions: number
} {
  const parsed: unknown = JSON.parse(fs.readFileSync(outcomePath, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('the worker outcome is not an object')
  }
  const record: Record<string, unknown> = { ...parsed }
  const status = record['status']
  const executions = record['executions']
  if (typeof status !== 'string') {
    throw new Error('the worker outcome is missing a string status')
  }
  if (typeof executions !== 'number' || !Number.isFinite(executions)) {
    throw new Error('the worker outcome is missing a numeric executions')
  }
  return {
    status,
    ...(typeof record['code'] === 'string' ? { code: record['code'] } : {}),
    executions,
  }
}

function readEvidenceRows(evidencePath: string): string[] {
  return fs
    .readFileSync(evidencePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('an evidence row is not an object')
      }
      const record: Record<string, unknown> = { ...parsed }
      const type = record['type']
      if (typeof type !== 'string') {
        throw new Error('an evidence row is missing a string type')
      }
      return type
    })
}

async function withDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
  description: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}.`)),
          deadlineMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
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
