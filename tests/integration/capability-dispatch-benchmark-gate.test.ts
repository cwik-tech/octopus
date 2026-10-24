import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import test from 'node:test'
import { once } from 'node:events'

// The repository root, not this file's directory: compiled runs live under
// `.tests-dist`, where neither the TypeScript source nor the root
// `node_modules` exists. `process.cwd()` is the runner's repository root in
// both source and compiled runs, which is the house pattern.
const REPO_ROOT = process.cwd()
const SCRIPT_PATH = path.join(
  REPO_ROOT,
  'scripts',
  'benchmark-capability-dispatch.ts',
)
const TSX_PATH = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')

// Small but real: a durable journal is still built and driven, only briefly.
// The concurrency is 2, deliberately unlike the 8 D11 will gate on, and the
// report echoes it so these runs can never be mistaken for that measurement.
const FAST = ['--iterations', '4', '--warmup', '0', '--turn-concurrency', '2']

/**
 * AC14 — the durable budget has to be enforceable, not decorative.
 *
 * `provisionalBudget` reports two booleans and nothing reads them:
 * `process.exitCode` is assigned at exactly one place in the script, inside the
 * `.catch()` for a thrown benchmark. A run whose numbers are outside budget
 * therefore exits 0 today, which is true of the non-journal gate as well as the
 * durable one — broader than N13 records.
 *
 * These cases drive the CLI itself, because the exit code is the deliverable
 * and only the process boundary shows it.
 *
 * **A parse failure must not be mistaken for enforcement.** An unknown flag
 * also exits nonzero, so asserting the exit code alone would pass for entirely
 * the wrong reason. Every enforcement case here additionally requires the full
 * JSON report on stdout, which the parse-failure path never produces — and one
 * case pins that difference directly.
 */
test('the benchmark exits nonzero when an applied durable threshold fails, after reporting', {
  timeout: 120_000,
}, async () => {
  const run = await runBenchmark([
    ...FAST,
    '--durable-journal',
    // Deliberately unreachable, so the failure is the budget and not the machine.
    '--durable-serial-p50-ms', '1',
    '--durable-concurrent-per-call-p50-ms', '1',
  ])

  const report = parseReport(run.stdout)
  const durable = requireRecord(report, 'durableJournal')
  const budget = requireRecord(durable, 'budget')

  assert.equal(budget['serialP50Ms'], 1, 'the applied thresholds are echoed')
  assert.equal(budget['concurrentPerCallP50Ms'], 1)
  assert.equal(
    budget['turnConcurrency'],
    2,
    'and the width they were measured at, so a 2-wide run can never be read ' +
      'as the 8-wide gate D11 will decide',
  )
  assert.equal(budget['pass'], false, 'and the durable summary reports failure')
  assert.notEqual(
    run.code,
    0,
    `a failing applied threshold must fail the process: ${run.stderr}`,
  )
})

/**
 * The gate applies without being asked (D11, approved 2026-08-22).
 *
 * A durable run with no overrides is held to serial p50 ≤ 100 ms and a
 * normalized per-call p50 ≤ 65 ms, and the report echoes both so a reader never
 * has to guess which bounds a verdict came from.
 *
 * The width is 8 and must be: `concurrentPerCallMs` is a wave duration divided
 * by its width, so the approved 65 ms describes an 8-wide wave and nothing
 * else. This case therefore does not use the fast 2-wide invocation the others
 * share.
 *
 * What this proves is that the defaults are *applied*. That they are *enforced*
 * is proved by the override cases either side of it, which drive the identical
 * exit path — measured numbers on a healthy machine sit near 78 ms and cannot
 * be pushed past 100 ms on demand, so a default-exceeded run is not something a
 * test can stage honestly.
 */
test('a durable run with no overrides applies and echoes the approved defaults', {
  timeout: 120_000,
}, async () => {
  const run = await runBenchmark([
    '--iterations', '8',
    '--warmup', '0',
    '--turn-concurrency', '8',
    '--durable-journal',
  ])

  const budget = requireRecord(requireRecord(parseReport(run.stdout), 'durableJournal'), 'budget')
  assert.equal(budget['serialP50Ms'], 100, 'the approved serial bound')
  assert.equal(budget['concurrentPerCallP50Ms'], 65, 'the approved per-call bound')
  assert.equal(
    budget['turnConcurrency'],
    8,
    'measured at the width the concurrent bound was calibrated for',
  )
})

/**
 * A default gate at the wrong width would be a number pretending to mean
 * something. Rather than silently apply the 8-wide bound to a 2-wide wave, or
 * silently skip the gate, the invocation is refused and says what it needs.
 */
test('a durable run at another width refuses to apply the defaults', {
  timeout: 120_000,
}, async () => {
  const run = await runBenchmark([...FAST, '--durable-journal'])

  assert.notEqual(run.code, 0, 'the invocation is refused')
  assert.equal(run.stdout.trim(), '', 'and no report is produced')
  assert.match(
    run.stderr,
    /turn-concurrency|width/i,
    'naming the width the defaults are calibrated for',
  )
  assert.match(
    run.stderr,
    /--durable-serial-p50-ms|threshold/i,
    'and how to run this width anyway',
  )
})

test('the benchmark exits zero when the applied durable thresholds hold', {
  timeout: 120_000,
}, async () => {
  const run = await runBenchmark([
    ...FAST,
    '--durable-journal',
    // Generous enough that only a broken gate could fail here.
    '--durable-serial-p50-ms', '100000',
    '--durable-concurrent-per-call-p50-ms', '100000',
  ])

  const report = parseReport(run.stdout)
  const budget = requireRecord(requireRecord(report, 'durableJournal'), 'budget')
  assert.equal(budget['pass'], true)
  assert.equal(run.code, 0, `a satisfied budget must not fail the process: ${run.stderr}`)
})

test('an unknown flag fails without producing a report, so it cannot pass for enforcement', {
  timeout: 120_000,
}, async () => {
  const run = await runBenchmark([...FAST, '--durable-journal', '--not-a-real-flag', '1'])

  assert.notEqual(run.code, 0, 'an unusable invocation fails')
  assert.equal(
    run.stdout.trim(),
    '',
    'and emits no report — which is what separates a parse failure from a ' +
      'budget failure, since both exit nonzero',
  )
  assert.match(run.stderr, /Unknown or incomplete benchmark argument/)
})

test('durable thresholds are rejected unless supplied as a pair with --durable-journal', {
  timeout: 120_000,
}, async () => {
  const withoutJournal = await runBenchmark([
    ...FAST,
    '--durable-serial-p50-ms', '100',
    '--durable-concurrent-per-call-p50-ms', '100',
  ])
  assert.notEqual(withoutJournal.code, 0)
  assert.match(withoutJournal.stderr, /--durable-journal/)

  const halfPair = await runBenchmark([
    ...FAST,
    '--durable-journal',
    '--durable-serial-p50-ms', '100',
  ])
  assert.notEqual(halfPair.code, 0)
  assert.match(halfPair.stderr, /both|pair/i)
})

interface BenchmarkRun {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

async function runBenchmark(args: readonly string[]): Promise<BenchmarkRun> {
  const child = spawn(TSX_PATH, [SCRIPT_PATH, ...args], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out: Buffer[] = []
  const err: Buffer[] = []
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
  const payload: unknown = await once(child, 'exit')
  if (!Array.isArray(payload) || payload.length < 2) {
    throw new Error('the benchmark exit event carried an unexpected payload')
  }
  const [code] = payload
  if (code !== null && typeof code !== 'number') {
    throw new Error(`the benchmark exited with a non-numeric code: ${String(code)}`)
  }
  return {
    code,
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8'),
  }
}

/** The report crosses a process boundary, so it is narrowed, never asserted. */
function parseReport(stdout: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`the benchmark emitted no parsable report: ${stdout.slice(0, 400)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the benchmark report is not an object')
  }
  return { ...parsed }
}

function requireRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`the benchmark report is missing an object at ${key}`)
  }
  return { ...value }
}
