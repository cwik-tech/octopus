import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ExecutionJournalScopeIdentity } from '../../contracts/execution-journal.js'

const WORKER_PATH = fileURLToPath(
  new URL('./capability-dispatch-restart-worker.js', import.meta.url),
)

const TEST_IDENTITY: ExecutionJournalScopeIdentity = {
  scopeKind: 'assignment',
  scopeId: 'assignment-scope-restart',
  tenantId: 'tenant-test',
  sessionId: 'session-restart',
  runId: 'run-restart',
  assignmentId: 'assignment-restart',
}

interface WorkerOutcome {
  readonly status: string
  readonly code?: string
  readonly value?: unknown
  readonly executions?: number
}

test('restart reuses an accepted result without re-entering the executor', async () => {
  const scopeRoot = makeScopeRoot()
  const counter = await startCounterServer()
  try {
    const firstOutcomePath = path.join(scopeRoot, 'outcome-first.json')
    const firstExit = await runWorker([
      scopeRoot,
      JSON.stringify(TEST_IDENTITY),
      'complete',
      counter.url,
      firstOutcomePath,
      JSON.stringify({ n: 1 }),
    ])
    assert.equal(firstExit, 0, readOutcome(firstOutcomePath))
    const first = readJson<WorkerOutcome>(firstOutcomePath)
    assert.equal(first.status, 'completed')
    assert.equal(counter.count(), 1)

    const reuseOutcomePath = path.join(scopeRoot, 'outcome-reuse.json')
    const reuseExit = await runWorker([
      scopeRoot,
      JSON.stringify(TEST_IDENTITY),
      'reuse',
      counter.url,
      reuseOutcomePath,
      JSON.stringify({ n: 1 }),
    ])
    assert.equal(reuseExit, 0, readOutcome(reuseOutcomePath))
    const reused = readJson<WorkerOutcome>(reuseOutcomePath)
    assert.equal(reused.status, 'completed')
    // The retained result is replayed without a second external execution.
    assert.equal(counter.count(), 1)
    assert.deepEqual(reused.value, first.value)
  } finally {
    await counter.close()
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

test('the same dispatch identity with changed arguments is rejected as a conflict', async () => {
  const scopeRoot = makeScopeRoot()
  const counter = await startCounterServer()
  try {
    const firstOutcomePath = path.join(scopeRoot, 'outcome-first.json')
    const firstExit = await runWorker([
      scopeRoot,
      JSON.stringify(TEST_IDENTITY),
      'complete',
      counter.url,
      firstOutcomePath,
      JSON.stringify({ n: 1 }),
    ])
    assert.equal(firstExit, 0, readOutcome(firstOutcomePath))
    assert.equal(counter.count(), 1)

    const conflictOutcomePath = path.join(scopeRoot, 'outcome-conflict.json')
    const conflictExit = await runWorker([
      scopeRoot,
      JSON.stringify(TEST_IDENTITY),
      'conflict',
      counter.url,
      conflictOutcomePath,
      JSON.stringify({ n: 999 }),
    ])
    assert.equal(conflictExit, 0, readOutcome(conflictOutcomePath))
    const conflicted = readJson<WorkerOutcome>(conflictOutcomePath)
    assert.equal(conflicted.status, 'rejected')
    assert.equal(conflicted.code, 'invocation_identity_conflict')
    assert.equal(counter.count(), 1)
  } finally {
    await counter.close()
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

test('a large result replays across a restart without any bytes in the journal directory', async () => {
  const scopeRoot = makeScopeRoot()
  const counter = await startCounterServer()
  try {
    const largeInput = JSON.stringify({ n: 1, large: true })
    const firstOutcomePath = path.join(scopeRoot, 'outcome-first.json')
    const firstExit = await runWorker([
      scopeRoot,
      JSON.stringify(TEST_IDENTITY),
      'complete',
      counter.url,
      firstOutcomePath,
      largeInput,
    ])
    assert.equal(firstExit, 0, readOutcome(firstOutcomePath))
    const first = readJson<WorkerOutcome>(firstOutcomePath)
    assert.equal(first.status, 'completed')
    assert.equal(counter.count(), 1)

    const reuseOutcomePath = path.join(scopeRoot, 'outcome-reuse.json')
    const reuseExit = await runWorker([
      scopeRoot,
      JSON.stringify(TEST_IDENTITY),
      'reuse',
      counter.url,
      reuseOutcomePath,
      largeInput,
    ])
    assert.equal(reuseExit, 0, readOutcome(reuseOutcomePath))
    const reused = readJson<WorkerOutcome>(reuseOutcomePath)
    assert.equal(reused.status, 'completed')
    assert.equal(counter.count(), 1)
    assert.deepEqual(reused.value, first.value)

    // The replay above proves the bytes came back. This proves where from:
    // the assignment's own content store, with nothing left in the journal
    // directory for the second process to have read them out of.
    const journalDirectory = path.join(
      scopeRoot,
      '.runtime',
      'execution-journal',
    )
    for (const filePath of listRegularFiles(journalDirectory)) {
      assert.ok(
        !fs.readFileSync(filePath, 'utf8').includes('x'.repeat(1_000)),
        `${path.relative(scopeRoot, filePath)} retains the result payload`,
      )
    }
    assert.equal(
      listRegularFiles(
        path.join(scopeRoot, '.runtime', 'capability-results'),
      ).length,
      1,
    )
  } finally {
    await counter.close()
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

function listRegularFiles(directory: string): readonly string[] {
  if (!fs.existsSync(directory)) return []
  const found: string[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...listRegularFiles(entryPath))
    else if (entry.isFile()) found.push(entryPath)
  }
  return found
}

function makeScopeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'capability-dispatch-restart-'))
}

function spawnWorker(args: readonly string[]): ChildProcess {
  const child = spawn(process.execPath, [WORKER_PATH, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk)
  })
  return child
}

async function runWorker(args: readonly string[]): Promise<number | null> {
  const child = spawnWorker(args)
  const [code] = (await once(child, 'exit')) as [number | null]
  return code
}

function readOutcome(outcomePath: string): string {
  try {
    return fs.readFileSync(outcomePath, 'utf8')
  } catch {
    return 'worker produced no outcome file'
  }
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

async function startCounterServer(): Promise<{
  readonly url: string
  count(): number
  close(): Promise<void>
}> {
  let counter = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/mutate') {
      counter += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ counter }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    count: () => counter,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
