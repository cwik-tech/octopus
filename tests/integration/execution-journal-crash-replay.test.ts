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
import { initializeExecutionJournal } from '../../core/execution-journal.js'

const WORKER_PATH = fileURLToPath(
  new URL('./execution-journal-crash-replay-worker.js', import.meta.url),
)

const TEST_IDENTITY: ExecutionJournalScopeIdentity = {
  scopeKind: 'assignment',
  scopeId: 'assignment-scope-crash',
  tenantId: 'tenant-test',
  sessionId: 'session-crash',
  runId: 'run-crash',
  assignmentId: 'assignment-crash',
}

test('a crash after a committed mutating effect blocks replay without duplicating the effect', async () => {
  const scopeRoot = makeScopeRoot()
  const counter = await startCounterServer()
  try {
    const markerPath = path.join(scopeRoot, 'effect-marker')
    const gatePath = path.join(scopeRoot, 'acceptance-gate')
    const outcomePath = path.join(scopeRoot, 'outcome-run.json')
    const child = spawnWorker([
      scopeRoot,
      JSON.stringify(TEST_IDENTITY),
      'effect-run',
      counter.url,
      markerPath,
      gatePath,
      outcomePath,
    ])
    await waitForFile(markerPath, 15_000)
    assert.equal(counter.count(), 1)
    await killChild(child)

    const recoverOutcome = path.join(scopeRoot, 'outcome-recover.json')
    const recoverExit = await runWorker([
      scopeRoot,
      JSON.stringify(TEST_IDENTITY),
      'recover-run',
      counter.url,
      path.join(scopeRoot, 'recover-marker'),
      path.join(scopeRoot, 'recover-gate'),
      recoverOutcome,
    ])
    assert.equal(recoverExit, 0, readOutcome(recoverOutcome))
    const outcome = JSON.parse(fs.readFileSync(recoverOutcome, 'utf8')) as {
      status: string
      code?: string
    }
    assert.equal(outcome.status, 'indeterminate')
    assert.equal(outcome.code, 'durable_replay_blocked')
    assert.equal(counter.count(), 1)
  } finally {
    await counter.close()
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

test('a crash sealed before execution resumes safely and executes exactly once', async () => {
  const scopeRoot = makeScopeRoot()
  const counter = await startCounterServer()
  try {
    const markerPath = path.join(scopeRoot, 'prepared-marker')
    const gatePath = path.join(scopeRoot, 'prepared-gate')
    const outcomePath = path.join(scopeRoot, 'outcome-run.json')
    const child = spawnWorker([
      scopeRoot,
      JSON.stringify(TEST_IDENTITY),
      'prepared-run',
      counter.url,
      markerPath,
      gatePath,
      outcomePath,
    ])
    await waitForFile(markerPath, 15_000)

    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    const scan = await journal.scan()
    await journal.close()
    const preparedEvents = scan.events.filter(
      (event) => event.type === 'capability.dispatch.prepared',
    )
    const startedEvents = scan.events.filter(
      (event) => event.type === 'capability.dispatch.started',
    )
    assert.equal(preparedEvents.length, 1)
    assert.equal(startedEvents.length, 0)

    await killChild(child)
    assert.equal(counter.count(), 0)

    const recoverOutcome = path.join(scopeRoot, 'outcome-recover.json')
    const recoverExit = await runWorker([
      scopeRoot,
      JSON.stringify(TEST_IDENTITY),
      'recover-run',
      counter.url,
      path.join(scopeRoot, 'recover-marker'),
      path.join(scopeRoot, 'recover-gate'),
      recoverOutcome,
    ])
    assert.equal(recoverExit, 0, readOutcome(recoverOutcome))
    const outcome = JSON.parse(fs.readFileSync(recoverOutcome, 'utf8')) as {
      status: string
      code?: string
    }
    assert.equal(outcome.status, 'completed')
    assert.equal(counter.count(), 1)
  } finally {
    await counter.close()
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

function makeScopeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'execution-journal-crash-'))
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

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!fs.existsSync(filePath)) {
    if (Date.now() > deadline) {
      assert.fail(`Expected marker file did not appear: ${filePath}`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}

function readOutcome(outcomePath: string): string {
  try {
    return fs.readFileSync(outcomePath, 'utf8')
  } catch {
    return 'worker produced no outcome file'
  }
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
