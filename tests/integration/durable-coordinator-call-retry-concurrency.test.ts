import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AgentRunResult } from '../../core/types.js'
import { ProviderError } from '../../domains/provider/provider-error.js'
import { executeDurableCoordinatorCall } from '../../team-runtime/durable-coordinator-call.js'

/**
 * Recovering a retryable coordinator slot is a paid operation, so it needs an
 * owner. These cases put several real processes on the same terminal receipt at
 * once and count the provider invocations they produce between them.
 *
 * Real processes rather than one process racing promises: the receipt is a file
 * and the guarantee is about two operating-system processes reading it, which
 * an in-process race cannot observe.
 */

const WORKER_PATH = fileURLToPath(
  new URL('./durable-coordinator-call-retry-concurrency-worker.js', import.meta.url),
)

/** Enough contenders that a lost race is loud rather than occasional. */
const CONTENDING_WORKERS = 8

const COORDINATOR_REQUEST = {
  provider: 'claude',
  model: 'claude-haiku-4-5',
  thinking: 'low',
  systemPrompt: 'Coordinate this task.',
  userMessage: 'Choose the next step.',
} as const

interface WorkerOutcome {
  readonly kind: string
  readonly workerId: string
  readonly value?: string
  readonly message?: string
}

function makeAssignment(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function providerResult(text: string): AgentRunResult {
  return {
    text,
    cost: 0.4,
    durationMs: 20,
    inputTokens: 10,
    outputTokens: 5,
    contextTokens: 15,
    model: 'claude-haiku-4-5',
    costTracked: true,
    costSource: 'reported',
  }
}

interface StartedWorker {
  readonly child: ChildProcess
  readonly ready: Promise<void>
  readonly exited: Promise<number | null>
  readonly outcomePath: string
  readonly workerId: string
}

function startWorker(input: {
  readonly assignmentPath: string
  readonly invocationId: string
  readonly workerId: string
  readonly invocationLogPath: string
  readonly outcomePath: string
  readonly baseTotalCost: number
}): StartedWorker {
  assert.ok(
    fs.existsSync(WORKER_PATH),
    `Missing compiled process fixture: ${WORKER_PATH}`,
  )
  const child = spawn(process.execPath, [WORKER_PATH, JSON.stringify(input)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  let stderr = ''
  child.stderr?.on('data', (chunk: string) => { stderr += chunk })
  const ready = new Promise<void>((resolve, reject) => {
    let stdout = ''
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.includes('ready\n')) resolve()
    })
    child.once('error', reject)
    child.once('exit', () => {
      reject(new Error(`Worker ${input.workerId} exited before readiness: ${stderr}`))
    })
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== 0 && stderr) process.stderr.write(stderr)
      resolve(code)
    })
  })
  return { child, ready, exited, outcomePath: input.outcomePath, workerId: input.workerId }
}

/**
 * Start every contender, wait for all of them to announce readiness, then open
 * the race with one write per worker. No sleeping and no polling: readiness and
 * release are both messages.
 */
async function raceForTheSlot(input: {
  readonly assignmentPath: string
  readonly fixtureRoot: string
  readonly invocationId: string
  readonly invocationLogPath: string
  readonly baseTotalCost: number
}): Promise<WorkerOutcome[]> {
  const workers = Array.from({ length: CONTENDING_WORKERS }, (_unused, index) =>
    startWorker({
      assignmentPath: input.assignmentPath,
      invocationId: input.invocationId,
      workerId: `worker-${index}`,
      invocationLogPath: input.invocationLogPath,
      outcomePath: path.join(input.fixtureRoot, `outcome-${index}.json`),
      baseTotalCost: input.baseTotalCost,
    }))
  try {
    await Promise.all(workers.map((worker) => worker.ready))
    for (const worker of workers) worker.child.stdin?.end('go\n')
    const codes = await Promise.all(workers.map((worker) => worker.exited))
    for (const [index, code] of codes.entries()) {
      assert.equal(code, 0, `worker-${index} exited with ${String(code)}`)
    }
    return workers.map((worker) => readOutcome(worker.outcomePath))
  } finally {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill('SIGKILL')
      }
    }
  }
}

function readOutcome(outcomePath: string): WorkerOutcome {
  const parsed: unknown = JSON.parse(fs.readFileSync(outcomePath, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Worker outcome is not an object: ${outcomePath}`)
  }
  const record: Record<string, unknown> = { ...parsed }
  return {
    kind: typeof record.kind === 'string' ? record.kind : 'unknown',
    workerId: typeof record.workerId === 'string' ? record.workerId : 'unknown',
    ...(typeof record.value === 'string' ? { value: record.value } : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
  }
}

function readInvocations(invocationLogPath: string): string[] {
  if (!fs.existsSync(invocationLogPath)) return []
  return fs.readFileSync(invocationLogPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
}

test('only one process re-buys a coordinator reply the runtime rejected', {
  timeout: 60_000,
}, async () => {
  const fixtureRoot = makeAssignment('durable-coordinator-retry-rejected-')
  const invocationLogPath = path.join(fixtureRoot, 'provider-invocations.txt')
  const invocationId = 'discussion:rejected-slot:recovered-by-many'
  try {
    // Arrange: reach a `rejected` attempt-1 receipt through the public API, so
    // the durable state under test is the one production actually writes.
    await assert.rejects(
      executeDurableCoordinatorCall({
        assignmentPath: fixtureRoot,
        invocationId,
        request: COORDINATOR_REQUEST,
        baseTotalCost: 0,
        now: () => '2026-09-07T11:00:00.000Z',
        invoke: async () => providerResult('prose where json was required'),
        accept: () => {
          throw new Error('response is not valid JSON')
        },
      }),
      /response is not valid JSON/,
    )
    assert.deepEqual(readInvocations(invocationLogPath), [])

    // Act
    const outcomes = await raceForTheSlot({
      assignmentPath: fixtureRoot,
      fixtureRoot,
      invocationId,
      invocationLogPath,
      baseTotalCost: 0.4,
    })

    // Assert: the slot was bought exactly once, however many processes recovered it.
    const invocations = readInvocations(invocationLogPath)
    assert.equal(
      invocations.length,
      1,
      `attempt 2 was bought ${invocations.length} times: ${JSON.stringify(invocations)}`,
    )
    const claimed = outcomes.filter((outcome) => outcome.kind === 'claimed')
    assert.equal(
      claimed.length,
      1,
      `expected one claimant, got ${JSON.stringify(outcomes)}`,
    )
    assert.equal(claimed[0]?.workerId, invocations[0])
    for (const outcome of outcomes) {
      assert.ok(
        ['claimed', 'replayed', 'indeterminate'].includes(outcome.kind),
        `unexpected worker outcome: ${JSON.stringify(outcome)}`,
      )
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('only one process re-buys a coordinator call that definitely cost nothing', {
  timeout: 60_000,
}, async () => {
  const fixtureRoot = makeAssignment('durable-coordinator-retry-failed-')
  const invocationLogPath = path.join(fixtureRoot, 'provider-invocations.txt')
  const invocationId = 'discussion:failed-slot:recovered-by-many'
  try {
    // Arrange: a refusal of the request itself, which is the failure this module
    // records as `failed` rather than leaving indeterminate.
    await assert.rejects(
      executeDurableCoordinatorCall({
        assignmentPath: fixtureRoot,
        invocationId,
        request: COORDINATOR_REQUEST,
        baseTotalCost: 0,
        now: () => '2026-09-07T11:00:00.000Z',
        invoke: async () => {
          throw new ProviderError({
            provider: 'claude',
            message: 'the request was malformed',
            kind: 'invalid_request',
            retryable: false,
          })
        },
        accept: (result) => result.text,
      }),
      /the request was malformed/,
    )
    assert.deepEqual(readInvocations(invocationLogPath), [])

    // Act
    const outcomes = await raceForTheSlot({
      assignmentPath: fixtureRoot,
      fixtureRoot,
      invocationId,
      invocationLogPath,
      baseTotalCost: 0,
    })

    // Assert
    const invocations = readInvocations(invocationLogPath)
    assert.equal(
      invocations.length,
      1,
      `attempt 2 was bought ${invocations.length} times: ${JSON.stringify(invocations)}`,
    )
    const claimed = outcomes.filter((outcome) => outcome.kind === 'claimed')
    assert.equal(
      claimed.length,
      1,
      `expected one claimant, got ${JSON.stringify(outcomes)}`,
    )
    assert.equal(claimed[0]?.workerId, invocations[0])
    for (const outcome of outcomes) {
      assert.ok(
        ['claimed', 'replayed', 'indeterminate'].includes(outcome.kind),
        `unexpected worker outcome: ${JSON.stringify(outcome)}`,
      )
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
