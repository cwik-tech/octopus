/**
 * D3 — strict product-workflow live gate.
 *
 * The provider matrix already has a strict lane, but it governs only tests built
 * on `liveTest()` (tests/live/live-provider-support.ts:34-41). The six shipped
 * product-workflow files use plain `node:test` with their own opt-in flags, so
 * `PIPELINE_LIVE_REQUIRE=all` cannot reach them and
 * `npm run test:live:providers:strict` exits 0 while every one of them skips.
 *
 * These tests exercise the real runner through a child process rather than
 * importing it, because the contract under test IS the CLI: its exit code, its
 * diagnostics, and its refusal to start costed work. They are deterministic and
 * make no paid or network calls — `--print-manifest` and `--preflight-only`
 * both return before any test is compiled or spawned.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// The compiled test runs from `.tests-dist`, so its own location is not the
// repo root. Every live test in this repository resolves the root from the
// working directory instead (tests/live/workflow-subscription-live.test.ts:12,
// tests/live/journal-cutover-live.test.ts:33); this follows that convention.
const REPO_ROOT = process.cwd()
const RUNNER = path.join(REPO_ROOT, 'tests', 'run-live-product-tests.mjs')

/** Every product-workflow live file the strict lane owns. */
const PRODUCT_TEST_FILES = [
  'workflow-subscription-live.test.ts',
  'deep-research-workflow-live.test.ts',
  'journal-cutover-live.test.ts',
  'youtube-extraction-live.test.ts',
  'youtube-workflow-live.test.ts',
  'youtube-manual-live.test.ts',
]

/**
 * Provider-matrix files. These stay governed by `PIPELINE_LIVE_REQUIRE` and
 * `npm run test:live:providers:strict`; the product lane must not absorb them.
 */
const PROVIDER_MATRIX_FILES = [
  'acquisition-providers-live.test.ts',
  'cli-mcp-providers-live.test.ts',
  'cli-providers-live.test.ts',
  'provider-connections-live.test.ts',
  'generate-excel-template-live.test.ts',
]

function runRunner(
  args: string[],
  overrides: Record<string, string | undefined> = {},
): { status: number | null; stdout: string; stderr: string } {
  // Start from a copy of the ambient environment so the child still has PATH and
  // HOME, then apply the controlled overrides. Deleting a key is how a missing
  // prerequisite is simulated — the runner must read process.env, not a file.
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  // Same pinned runtime as this test process, not whatever `node` resolves to.
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

test('the strict product runner exists at its published path', () => {
  // Anchors every other test in this file: a wrong path would otherwise make
  // them fail as MODULE_NOT_FOUND and read like contract failures.
  assert.ok(fs.existsSync(RUNNER), `expected a runner at ${RUNNER}`)
})

test('strict preflight fails non-zero and names the missing prerequisite before any live test starts', () => {
  const result = runRunner(['--preflight-only'], {
    PIPELINE_LIVE_PRODUCT_REQUIRE: '1',
    // The one prerequisite that is cheap to prove and genuinely blocking:
    // tests/live/youtube-manual-live.test.ts:10 gates both of its tests on it.
    GEMINI_API_KEY: undefined,
  })
  const output = `${result.stdout}\n${result.stderr}`

  assert.notEqual(
    result.status,
    0,
    `strict preflight must fail when a prerequisite is absent. Output:\n${output}`,
  )
  // Naming both the variable and the lane is the point: an operator has to know
  // what to fix and which family it blocks.
  assert.match(output, /GEMINI_API_KEY/)
  assert.match(output, /youtube-manual/)

  // It must not have started a live test. The product files are only reachable
  // after a `tsc` compile, so their compiled paths never appear on a preflight
  // failure, and no node:test output is produced.
  assert.doesNotMatch(output, /TAP version/)
  assert.doesNotMatch(output, /\.tests-dist/)
})

test('strict preflight passes when every cheaply-provable prerequisite is present', () => {
  // The complement of the test above: preflight must not be a blanket refusal.
  // A placeholder value is enough — preflight proves presence, never validity,
  // and never sends the value anywhere.
  const result = runRunner(['--preflight-only'], {
    PIPELINE_LIVE_PRODUCT_REQUIRE: '1',
    GEMINI_API_KEY: 'preflight-presence-check-only',
  })
  const output = `${result.stdout}\n${result.stderr}`

  assert.equal(result.status, 0, `preflight should pass. Output:\n${output}`)
  // A preflight that echoed the value would leak it into CI logs.
  assert.doesNotMatch(output, /preflight-presence-check-only/)
})

test('the strict lane manifest covers every product file and no provider-matrix file', () => {
  const result = runRunner(['--print-manifest'], {
    PIPELINE_LIVE_PRODUCT_REQUIRE: '1',
  })
  assert.equal(
    result.status,
    0,
    `--print-manifest must succeed. Output:\n${result.stdout}\n${result.stderr}`,
  )

  const manifest: unknown = JSON.parse(result.stdout)
  assert.ok(
    typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest),
    'manifest must be a JSON object',
  )
  const record: Record<string, unknown> = { ...manifest }
  const files = record.testFiles
  assert.ok(Array.isArray(files), 'manifest.testFiles must be an array')
  const names = files.map((entry) => String(entry))

  for (const expected of PRODUCT_TEST_FILES) {
    assert.ok(
      names.some((name) => name.endsWith(expected)),
      `strict lane must cover ${expected}. Manifest: ${JSON.stringify(names)}`,
    )
  }
  for (const excluded of PROVIDER_MATRIX_FILES) {
    assert.ok(
      !names.some((name) => name.endsWith(excluded)),
      `strict product lane must not absorb provider-matrix file ${excluded}`,
    )
  }
  // Exactly the product set — a stray extra file would mean the lane is globbing
  // rather than declaring, which is how the provider runner picked these up in
  // the first place (tests/run-live-provider-tests.mjs:20-23).
  assert.equal(names.length, PRODUCT_TEST_FILES.length)
})

test('the strict lane enables the opt-in flags itself, including the full manual lane', () => {
  const result = runRunner(['--print-manifest'], {
    PIPELINE_LIVE_PRODUCT_REQUIRE: '1',
  })
  const manifest: unknown = JSON.parse(result.stdout)
  assert.ok(typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest))
  const record: Record<string, unknown> = { ...manifest }
  const laneEnv = record.laneEnv
  assert.ok(
    typeof laneEnv === 'object' && laneEnv !== null && !Array.isArray(laneEnv),
    'manifest.laneEnv must be an object',
  )
  const env: Record<string, unknown> = { ...laneEnv }

  // Without these the files skip themselves and the lane exits 0 having run
  // nothing — the exact defect D3 exists to close.
  assert.equal(env.PIPELINE_LIVE_DEEP_RESEARCH, '1')
  assert.equal(env.PIPELINE_LIVE_YOUTUBE, '1')
  // The full manual lane is in scope and needs its own flag
  // (tests/live/youtube-manual-live.test.ts:49).
  assert.equal(env.PIPELINE_LIVE_YOUTUBE_FULL, '1')
  // Authoritative, not `control` — `control` runs with the journal OFF
  // (tests/live/journal-cutover-live.test.ts:36-42).
  assert.equal(env.PIPELINE_LIVE_JOURNAL_CUTOVER, '1')
  // The provider-matrix switch must not be repurposed to drive this lane.
  assert.equal(env.PIPELINE_LIVE_REQUIRE, undefined)
})

test('the strict runner refuses to start costed work without its explicit opt-in', () => {
  // A bare `node tests/run-live-product-tests.mjs` must not begin a paid run.
  const result = runRunner([], { PIPELINE_LIVE_PRODUCT_REQUIRE: undefined })
  const output = `${result.stdout}\n${result.stderr}`

  assert.notEqual(result.status, 0)
  assert.match(output, /PIPELINE_LIVE_PRODUCT_REQUIRE/)
  assert.doesNotMatch(output, /TAP version/)
})

// ─── Argument validation (paid-run safety) ───────────────────────────────────
//
// SAFETY RULE for every test below: an argument the current runner does not
// recognise must never be combined with the opt-in AND a present GEMINI_API_KEY.
// Before argument validation exists, an unrecognised flag falls through to a
// real, paid run — which is the defect under repair. `GEMINI_API_KEY` is
// therefore left ABSENT, so preflight halts the fall-through before any compile,
// spawn or network call. The assertions still discriminate: the unfixed runner
// reports the missing key, the fixed runner reports the unknown argument.

test('an unknown argument is rejected before any opt-in, preflight, compile or spawn', () => {
  // package.json arms PIPELINE_LIVE_PRODUCT_REQUIRE=1 for the strict script, so
  // `npm run test:live:product:strict -- --prefligth-only` would otherwise fall
  // through to a real paid run. A typo must never buy anything.
  const result = runRunner(['--prefligth-only'], {
    PIPELINE_LIVE_PRODUCT_REQUIRE: '1',
    GEMINI_API_KEY: undefined,
  })
  const output = `${result.stdout}\n${result.stderr}`

  assert.notEqual(result.status, 0, `unknown flag must fail. Output:\n${output}`)
  assert.match(output, /--prefligth-only/)
  // Argument validation precedes preflight, so the prerequisite check — which is
  // what stopped this invocation before the fix — must not be what reports.
  // Matched against the preflight FAILURE text specifically: the help line
  // legitimately lists `--preflight-only` as a supported mode.
  assert.doesNotMatch(output, /preflight FAILED/i)
  assert.doesNotMatch(output, /GEMINI_API_KEY/)
  assert.doesNotMatch(output, /TAP version/)
  assert.doesNotMatch(output, /\.tests-dist/)
})

test('mutually exclusive modes are rejected rather than silently ordered', () => {
  const result = runRunner(['--print-manifest', '--preflight-only'], {
    PIPELINE_LIVE_PRODUCT_REQUIRE: '1',
    GEMINI_API_KEY: undefined,
  })
  const output = `${result.stdout}\n${result.stderr}`

  assert.notEqual(result.status, 0, `combined modes must fail. Output:\n${output}`)
  assert.match(output, /--print-manifest/)
  assert.match(output, /--preflight-only/)
  // Precedence would have printed one of them; rejection prints neither.
  assert.doesNotMatch(output, /"testFiles"/)
})

test('--self-test does not swallow a following flag, so exclusivity is order-independent', () => {
  // The operand consumer must not treat `--print-manifest` as a fixture path.
  // If it does, the two-mode rejection silently depends on argument order.
  // Cost-safe: no credential, and both modes are free even when recognised.
  const result = runRunner(['--self-test', '--print-manifest'], {
    PIPELINE_LIVE_PRODUCT_REQUIRE: '1',
    GEMINI_API_KEY: undefined,
  })
  const output = `${result.stdout}\n${result.stderr}`

  assert.notEqual(result.status, 0, `Output:\n${output}`)
  assert.match(output, /--self-test/)
  assert.match(output, /--print-manifest/)
  // Neither mode may have executed: no manifest JSON, no self-test verdict.
  assert.doesNotMatch(output, /"testFiles"/)
  assert.doesNotMatch(output, /"attempted"/)
})

test('--self-test requires a fixture operand', () => {
  const result = runRunner(['--self-test'], {
    PIPELINE_LIVE_PRODUCT_REQUIRE: '1',
    GEMINI_API_KEY: undefined,
  })
  const output = `${result.stdout}\n${result.stderr}`

  assert.notEqual(result.status, 0, `Output:\n${output}`)
  assert.match(output, /--self-test/)
  assert.doesNotMatch(output, /"attempted"/)
  assert.doesNotMatch(output, /TAP version/)
})

test('--self-test fails closed on an unusable fixture directory and never reaches a costed run', () => {
  // This began as the interface Red for the mode (asserting it was allowlisted
  // and rejected explicitly rather than treated as an unknown argument). Now
  // that the mode exists, it asserts the durable property that assertion stood
  // in for: an unusable fixture directory is a failure, not a silent pass, and
  // nothing is compiled or spawned on the way there.
  const result = runRunner(['--self-test', '/nonexistent-fixture-dir'], {
    PIPELINE_LIVE_PRODUCT_REQUIRE: '1',
    GEMINI_API_KEY: undefined,
  })
  const output = `${result.stdout}\n${result.stderr}`

  assert.notEqual(result.status, 0, `Output:\n${output}`)
  // Absent TAP is classified as a failure rather than assumed to have passed.
  assert.match(output, /could not read TAP output/)
  // It stops at the first lane, so the remaining five are never attempted.
  assert.doesNotMatch(output, /youtube-manual/)
  assert.doesNotMatch(output, /TAP version/)
  assert.doesNotMatch(output, /\.tests-dist/)
})

// ─── TAP classification and lane sequencing ─────────────────────────────────
//
// These drive the SAME production functions the real lane uses. Only the
// child-process boundary is substituted with on-disk fixtures, the fake-child
// pattern used elsewhere in this repository. No detector is reimplemented for
// tests, and no assertion here can pass while production classifies differently.
//
// `--self-test` is a free mode: it neither requires the opt-in nor compiles nor
// spawns anything, so these need no credential and cannot start costed work.

const PASSING_TAP = [
  'TAP version 13',
  '# Subtest: a real live assertion',
  'ok 1 - a real live assertion',
  '1..1',
  '# tests 1',
  '# pass 1',
  '# fail 0',
  '# skipped 0',
].join('\n')

const SKIPPED_TAP = [
  'TAP version 13',
  '# Subtest: a live assertion that opted out',
  'ok 1 - a live assertion that opted out # SKIP Set PIPELINE_LIVE_YOUTUBE=1 to run.',
  '1..1',
  '# tests 1',
  '# pass 0',
  '# fail 0',
  '# skipped 1',
].join('\n')

const NO_TESTS_TAP = ['TAP version 13', '1..0', '# tests 0', '# pass 0'].join('\n')

/** Lane names in manifest order — the sequence fail-fast must respect. */
const LANE_NAMES = [
  'workflow-subscription',
  'deep-research',
  'journal-cutover',
  'youtube-extraction',
  'youtube-workflow',
  'youtube-manual',
]

type LaneFixture = { tap?: string; status?: number }

/** Write per-lane fixtures and run the runner's self-test over them. */
function runSelfTest(
  fixtures: Record<string, LaneFixture>,
): { status: number | null; report: Record<string, unknown>; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-product-selftest-'))
  try {
    for (const [lane, fixture] of Object.entries(fixtures)) {
      if (fixture.tap !== undefined) {
        fs.writeFileSync(path.join(dir, `${lane}.tap`), fixture.tap)
      }
      if (fixture.status !== undefined) {
        fs.writeFileSync(path.join(dir, `${lane}.status`), String(fixture.status))
      }
    }
    // Deliberately no opt-in and no credential: a free mode must need neither.
    const result = runRunner(['--self-test', dir], {
      PIPELINE_LIVE_PRODUCT_REQUIRE: undefined,
      GEMINI_API_KEY: undefined,
    })
    const output = `${result.stdout}\n${result.stderr}`
    let report: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(result.stdout)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        report = { ...parsed }
      }
    } catch {
      // Leave the report empty; assertions below surface the raw output.
    }
    return { status: result.status, report, output }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Every lane passing, in manifest order. */
function allPassing(): Record<string, LaneFixture> {
  return Object.fromEntries(LANE_NAMES.map((lane) => [lane, { tap: PASSING_TAP }]))
}

test('a passing TAP result is accepted by the production classification path', () => {
  const { status, report, output } = runSelfTest(allPassing())

  assert.equal(status, 0, `all-passing lanes must succeed. Output:\n${output}`)
  assert.deepEqual(report.attempted, LANE_NAMES)
  assert.equal(report.failure, null)
})

test('a TAP result containing a SKIP directive is rejected', () => {
  // The core guarantee, and the one the plan wrongly called unprovable without a
  // costed run: node:test exits 0 when a test skips, which is exactly how the
  // provider strict lane reported success while proving nothing.
  const fixtures = allPassing()
  fixtures['journal-cutover'] = { tap: SKIPPED_TAP }
  const { status, report, output } = runSelfTest(fixtures)

  assert.notEqual(status, 0, `a skip must fail the lane. Output:\n${output}`)
  assert.match(String(report.failure), /journal-cutover/)
  assert.match(String(report.failure), /skip/i)
})

test('a TAP result with no tests at all is rejected', () => {
  const fixtures = allPassing()
  fixtures['deep-research'] = { tap: NO_TESTS_TAP }
  const { status, report, output } = runSelfTest(fixtures)

  assert.notEqual(status, 0, `an empty lane must fail. Output:\n${output}`)
  assert.match(String(report.failure), /deep-research/)
  assert.match(String(report.failure), /no tests ran/i)
})

test('a non-zero test process status is rejected even when its TAP looks clean', () => {
  const fixtures = allPassing()
  fixtures['youtube-workflow'] = { tap: PASSING_TAP, status: 1 }
  const { status, report, output } = runSelfTest(fixtures)

  assert.notEqual(status, 0, `a failing process must fail the lane. Output:\n${output}`)
  assert.match(String(report.failure), /youtube-workflow/)
})

test('the lane fails fast: later lanes are never attempted after the first failure', () => {
  // Continuing would spend real money on lanes usually doomed by the same cause,
  // and the journal-cutover lane alone can take 20 minutes.
  const fixtures = allPassing()
  fixtures['deep-research'] = { tap: SKIPPED_TAP }
  const { status, report, output } = runSelfTest(fixtures)

  assert.notEqual(status, 0, `Output:\n${output}`)
  // Only lanes actually attempted are reported: up to and including the failure,
  // and nothing after it.
  assert.deepEqual(report.attempted, ['workflow-subscription', 'deep-research'])
  assert.match(String(report.failure), /deep-research/)
})

test('fail-fast reports the first failure only, not a collected list', () => {
  const fixtures = allPassing()
  fixtures['workflow-subscription'] = { tap: SKIPPED_TAP }
  fixtures['deep-research'] = { tap: NO_TESTS_TAP }
  const { status, report } = runSelfTest(fixtures)

  assert.notEqual(status, 0)
  assert.deepEqual(report.attempted, ['workflow-subscription'])
  assert.match(String(report.failure), /workflow-subscription/)
  // The second, never-attempted lane must not appear anywhere in the verdict.
  assert.doesNotMatch(String(report.failure), /deep-research/)
})
