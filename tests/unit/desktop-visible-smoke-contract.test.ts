/**
 * D4 — one real visible-window Electron smoke as a mandatory macOS CI gate.
 *
 * Both Playwright configs default the desktop suite to hidden windows so routine
 * verification does not steal focus (`playwright.electron.config.ts:5`,
 * `playwright.electron.live.config.ts:3`, both using `??=` so an explicit
 * environment value survives). Electron honours that by only calling
 * `window.show()` when the run is not headless (`electron/main.ts:65`,
 * `:327-331`).
 *
 * The consequence is that nothing ever proves a window actually appears. The
 * oracle exists — `tests/electron/electron-smoke.spec.ts:20` derives
 * `expectsVisibleWindow` from the environment and `:493-498` polls
 * `BrowserWindow.isVisible()` against it — but no command and no CI step ever
 * runs it with `PIPELINE_DESKTOP_E2E_HEADLESS=0`, so the visible branch of that
 * assertion is dead in practice.
 *
 * These assertions read the real `package.json`, the real CI workflow and the
 * real smoke source. They are a configuration contract, not a simulation: if the
 * script or the CI step is removed or weakened, they fail.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

const REPO_ROOT = process.cwd()
const VISIBLE_SCRIPT = 'desktop:e2e:visible'
const SMOKE_SPEC = 'tests/electron/electron-smoke.spec.ts'
const NON_LIVE_CONFIG = 'playwright.electron.config.ts'
/** Tag identifying the single visible-window journey. */
const VISIBLE_TAG = '@visible-window'
const CI_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml')
const MACOS_JOB = 'desktop-package-smoke'

function readScripts(): Record<string, string> {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  )
  assert.ok(
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
    'package.json must be a JSON object',
  )
  const record: Record<string, unknown> = { ...parsed }
  const scripts = record.scripts
  assert.ok(
    typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts),
    'package.json must declare a scripts object',
  )
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...scripts })) {
    result[key] = String(value)
  }
  return result
}

/** Lines of the `desktop-package-smoke` job, up to the next job at the same indent. */
function macosJobLines(): string[] {
  const lines = fs.readFileSync(CI_WORKFLOW, 'utf8').split('\n')
  const start = lines.findIndex((line) => line.startsWith(`  ${MACOS_JOB}:`))
  assert.notEqual(start, -1, `CI workflow must declare the ${MACOS_JOB} job`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^ {2}[A-Za-z][\w-]*:/.test(line))
  return end === -1 ? rest : rest.slice(0, end)
}

/**
 * Just the visible smoke's own step block.
 *
 * A step's keys can appear either before or after its `run:`, so the block runs
 * from the step's leading `- ` to the next sibling `- ` at the same indent. This
 * has to be isolated rather than scanned job-wide: a job-wide search cannot tell
 * a disabling `if:` on *this* step from a legitimate conditional on some other
 * step, so it would either miss the first or forbid the second.
 */
function visibleStepBlock(): string[] {
  const jobLines = macosJobLines()
  const invocations = jobLines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes(`npm run ${VISIBLE_SCRIPT}`))

  assert.equal(
    invocations.length,
    1,
    `expected exactly one '${VISIBLE_SCRIPT}' invocation in ${MACOS_JOB}, ` +
      `found ${invocations.length}`,
  )
  const firstInvocation = invocations[0]
  assert.ok(firstInvocation, 'the single invocation asserted above must be readable')

  // Walk back to the `- ` that opens this step, then forward to the next one.
  let startIndex = firstInvocation.index
  for (; startIndex > 0; startIndex -= 1) {
    const line = jobLines[startIndex]
    if (line !== undefined && /^\s*- /.test(line)) break
  }
  const openingLine = jobLines[startIndex]
  assert.ok(
    openingLine,
    `could not locate the step opening for '${VISIBLE_SCRIPT}' in ${MACOS_JOB}`,
  )
  const openingIndent = openingLine.match(/^(\s*)- /)?.[1] ?? ''
  const siblingStep = new RegExp(`^${openingIndent}- `)

  let endIndex = startIndex + 1
  for (; endIndex < jobLines.length; endIndex += 1) {
    const line = jobLines[endIndex]
    if (line !== undefined && siblingStep.test(line)) break
  }
  return jobLines.slice(startIndex, endIndex)
}

test('a dedicated visible-window script exists and forces a visible run', () => {
  const scripts = readScripts()
  const command = scripts[VISIBLE_SCRIPT]

  assert.ok(
    command,
    `package.json must declare a '${VISIBLE_SCRIPT}' script. ` +
      `Found: ${JSON.stringify(Object.keys(scripts).filter((k) => k.startsWith('desktop:')))}`,
  )
  // Explicit, not inherited. Both configs use `??=`, so an unset variable
  // silently yields a hidden run and the visible assertion never fires.
  assert.match(command, /PIPELINE_DESKTOP_E2E_HEADLESS=0/)
  // Exactly the one smoke file, not the whole suite.
  assert.match(command, new RegExp(SMOKE_SPEC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  // ...and within that file, exactly the one visible-window journey. Running
  // the whole smoke under HEADLESS=0 turns every unrelated test into a
  // visible-mode test: the first real run failed on a task-resumption
  // assertion that has nothing to do with window visibility, while the
  // visibility oracle itself passed. D4 mandates one visible journey, not a
  // visible suite.
  assert.match(command, new RegExp(`--grep\\s+["']?${VISIBLE_TAG}`))
  // The non-live config: the live one gates on external providers.
  assert.match(command, new RegExp(`-c\\s+${NON_LIVE_CONFIG.replace(/\./g, '\\.')}`))
  assert.doesNotMatch(command, /playwright\.electron\.live\.config\.ts/)
  // It has to build what it launches.
  assert.match(command, /desktop:build/)
  // One spec only — no second `.spec.ts` target smuggled in.
  assert.equal((command.match(/\.spec\.ts/g) ?? []).length, 1)
})

test('the macOS desktop job runs the visible smoke as its own mandatory step', () => {
  const jobLines = macosJobLines()

  // A real macOS runner: a visible window cannot be proven on a Linux container.
  assert.match(jobLines.join('\n'), /runs-on:\s*macos-14/)

  // Exactly one invocation, asserted inside the helper.
  const step = visibleStepBlock()
  const block = step.join('\n')

  // Mandatory means unconditional, judged on THIS step only. An `if:` here can
  // disable the step while every job-wide check still passes, which is exactly
  // what a job-wide scan missed.
  assert.doesNotMatch(
    block,
    /^\s*(?:- )?if:/m,
    `the ${VISIBLE_SCRIPT} step must not be conditional. Step block:\n${block}`,
  )
  assert.doesNotMatch(
    block,
    /continue-on-error:\s*true/,
    `the ${VISIBLE_SCRIPT} step must not swallow its own failure. Step block:\n${block}`,
  )
})

test('the visible step is added alongside the packaged smoke, not instead of it', () => {
  const jobLines = macosJobLines()

  // Coverage must not shrink. The packaged smoke exercises a different thing —
  // an unpacked macOS application launched from its real executable.
  assert.ok(
    jobLines.some((line) => line.includes('npm run desktop:e2e:packaged')),
    'the packaged smoke step must remain',
  )
  assert.ok(
    jobLines.some((line) => line.includes(`npm run ${VISIBLE_SCRIPT}`)),
    'the visible smoke step must be present',
  )
})

test('exactly one smoke journey carries the visible-window tag, and it is the oracle', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, SMOKE_SPEC), 'utf8')
  const tagged = source.split('\n').filter((line) => line.includes(VISIBLE_TAG))

  // One journey, so `--grep` cannot silently widen into a visible suite again.
  assert.equal(
    tagged.length,
    1,
    `expected exactly one ${VISIBLE_TAG} journey. Found: ${JSON.stringify(tagged)}`,
  )
  // And it must be the journey that owns the visibility assertion, not some
  // other test that merely acquired the tag.
  const taggedIndex = source.indexOf(VISIBLE_TAG)
  const oracleIndex = source.indexOf('.toBe(expectsVisibleWindow)')
  assert.ok(oracleIndex > taggedIndex, 'the tag must precede the visibility assertion')
  const between = source.slice(taggedIndex, oracleIndex)
  assert.doesNotMatch(
    between,
    /\ntest\(/,
    'another test starts between the tag and the visibility assertion, so the tag is on the wrong journey',
  )
})

test('the smoke still asserts BrowserWindow.isVisible against the environment expectation', () => {
  // The real oracle. If this assertion is ever softened, a green visible run
  // would prove nothing, so the contract pins it rather than trusting the
  // script and CI step alone.
  const source = fs.readFileSync(path.join(REPO_ROOT, SMOKE_SPEC), 'utf8')

  assert.match(
    source,
    /const expectsVisibleWindow = process\.env\.PIPELINE_DESKTOP_E2E_HEADLESS !== "1"/,
  )
  assert.match(source, /window\.isVisible\(\)/)
  assert.match(source, /\.toBe\(expectsVisibleWindow\)/)
})

test('the default desktop commands remain hidden so routine runs do not steal focus', () => {
  // The visible run is additive. Routine verification must stay hidden, and the
  // configs must keep defaulting rather than hard-coding, or the new script
  // could not override them.
  const scripts = readScripts()
  assert.doesNotMatch(String(scripts['desktop:e2e']), /PIPELINE_DESKTOP_E2E_HEADLESS/)
  assert.doesNotMatch(String(scripts['desktop:e2e:packaged']), /PIPELINE_DESKTOP_E2E_HEADLESS/)

  const config = fs.readFileSync(path.join(REPO_ROOT, NON_LIVE_CONFIG), 'utf8')
  assert.match(config, /PIPELINE_DESKTOP_E2E_HEADLESS \?\?= "1"/)
})
