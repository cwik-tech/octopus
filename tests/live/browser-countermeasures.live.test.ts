import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import test from 'node:test'

import {
  isDeniedHostCohort,
  type DeniedHostCohort,
} from '../../scripts/extract-denied-browser-hosts.js'
import { resolveBrowserExecutablePath } from '../../domains/browser/browser-executable.js'
import {
  runCountermeasureBakeOff,
  startOfficialWidgetOrigin,
  startProtectedContentOrigin,
  verifyOfficialWidgetGate,
  writeCountermeasureReport,
  type CountermeasureRecord,
  type CountermeasureTarget,
  type CountermeasureVariant,
} from '../support/browser-countermeasure-fixture.js'
import type { BrowserLaunchProfile } from '../../domains/acquisition/acquisition-types.js'

/**
 * The opt-in local browser countermeasure measurement.
 *
 * Evidence, not a verdict. It never asserts that a public host is blocked or
 * recovered, because that is the source's decision on the day and asserting it
 * would make an unrelated change to a website fail this repository's tests.
 *
 * What it does assert is everything the harness itself owes: that the tracked
 * cohort is fully accounted for, that the deterministic gate still tells a pass
 * from a fail in the same run, that execution stays bounded and sequential, and
 * that nothing in the written artifact carries page content or a query string.
 *
 * Enable with `PIPELINE_LIVE_BROWSER_COUNTERMEASURES=1`. Narrow it with
 * `PIPELINE_LIVE_BROWSER_HOST_LIMIT=<n>`; every host past the limit is reported
 * as `untested` rather than quietly dropped, so a partial run cannot read as a
 * complete one.
 */

const VARIANTS: readonly CountermeasureVariant[] = [
  'stock',
  'automation-controlled-disabled',
  'warm-assignment',
]

const PER_TARGET_TIMEOUT_MS = Number(
  process.env.PIPELINE_LIVE_BROWSER_TIMEOUT_MS ?? 45_000,
)

test(
  'the local countermeasure measurement accounts for every tracked host',
  { skip: skipReason() },
  async (context) => {
    const cohort = await readTrackedCohort()
    const origin = await startProtectedContentOrigin()
    context.after(() => origin.close())

    const publicTargets: CountermeasureTarget[] = cohort.hosts.map((entry) => ({
      host: entry.host,
      probeUrl: entry.probeUrl,
    }))
    const deterministicTargets = [origin.passTarget, origin.failTarget]
    const limit = hostLimit()
    const targets = [
      ...deterministicTargets,
      ...publicTargets.slice(0, limit ?? publicTargets.length),
      ...publicTargets.slice(limit ?? publicTargets.length),
    ]
    const targetLimit =
      deterministicTargets.length + (limit ?? publicTargets.length)

    const report = await runCountermeasureBakeOff({
      variants: VARIANTS,
      targets,
      targetLimit,
      timeoutMs: PER_TARGET_TIMEOUT_MS,
      allowHttpLocalhost: true,
    })
    const written = await writeCountermeasureReport(report)

    // --- Every tracked host is accounted for, once per variant. -------------
    for (const entry of cohort.hosts) {
      for (const variant of VARIANTS) {
        const record = report.records.find(
          (candidate) =>
            candidate.variant === variant &&
            candidate.targetUrl === entry.probeUrl,
        )
        assert.ok(
          record,
          `${entry.host} has no ${variant} record; the cohort must be complete`,
        )
        assert.ok(
          ['tested', 'skipped', 'timed-out', 'untested'].includes(record.status),
          `${entry.host} (${variant}) has status ${record.status}`,
        )
      }
    }
    assert.equal(
      report.records.length,
      targets.length * VARIANTS.length,
      'one record per target per variant, with nothing dropped',
    )
    assert.equal(
      report.accounting.tested +
        report.accounting.skipped +
        report.accounting.timedOut +
        report.accounting.untested,
      report.records.length,
    )

    // --- The harness still distinguishes a passed gate from a failed one. ---
    for (const variant of VARIANTS) {
      const passed = recordFor(report.records, variant, origin.passTarget.probeUrl)
      const failed = recordFor(report.records, variant, origin.failTarget.probeUrl)
      assert.equal(passed.protectedContentUnlocked, true, `${variant} pass gate`)
      assert.equal(failed.protectedContentUnlocked, false, `${variant} fail gate`)
      assert.equal(failed.outcome, 'challenge', `${variant} fail gate outcome`)
    }

    // --- Bounded, redacted, and free of page content. -----------------------
    for (const record of report.records) {
      const url = new URL(record.targetUrl)
      assert.equal(url.search, '', record.targetHost)
      assert.equal(url.hash, '', record.targetHost)
      assert.equal(url.username, '', record.targetHost)
      assert.equal(
        record.durationMs <= PER_TARGET_TIMEOUT_MS * 2,
        true,
        `${record.targetHost} (${record.variant}) ran ${record.durationMs}ms`,
      )
    }
    assert.doesNotMatch(
      JSON.stringify(report),
      new RegExp(origin.protectedContentLiteral, 'u'),
      'the artifact records that content unlocked, never the content',
    )

    process.stdout.write(summarize(report, cohort, written))
  },
)

/**
 * The official anti-bot widget, which the local gate cannot stand in for.
 *
 * The local origin proves the harness can tell an unlocked gate from a locked
 * one; it does not prove anything about a real widget. This does: the sitekey
 * documented to always issue a token must reach its callback and reveal a unique
 * literal, and the sitekey documented to always refuse one must not, within the
 * configured bound. Merely rendering the widget counts as neither.
 */
test(
  'the official test widget unlocks protected content only when its callback succeeds',
  { skip: skipReason() },
  async (context) => {
    const origin = await startOfficialWidgetOrigin()
    context.after(() => origin.close())
    const profiles: readonly BrowserLaunchProfile[] = [
      'stock',
      'automation-controlled-disabled',
    ]

    for (const launchProfile of profiles) {
      const passed = await verifyOfficialWidgetGate({
        target: origin.passTarget,
        launchProfile,
        timeoutMs: PER_TARGET_TIMEOUT_MS,
      })
      const failed = await verifyOfficialWidgetGate({
        target: origin.failTarget,
        launchProfile,
        timeoutMs: PER_TARGET_TIMEOUT_MS,
      })

      process.stdout.write(
        `\nwidget[${launchProfile}] pass: callback=${passed.callback} unlocked=${passed.protectedContentUnlocked} ${passed.durationMs}ms` +
        ` | fail: callback=${failed.callback} unlocked=${failed.protectedContentUnlocked} ${failed.durationMs}ms\n`,
      )

      assert.equal(passed.callback, 'passed', `${launchProfile} pass callback`)
      assert.equal(
        passed.protectedContentUnlocked,
        true,
        `${launchProfile}: a succeeding widget callback must reveal the protected literal`,
      )
      assert.equal(passed.timedOut, false, `${launchProfile} pass bound`)

      assert.equal(failed.callback, 'failed', `${launchProfile} fail callback`)
      assert.equal(
        failed.protectedContentUnlocked,
        false,
        `${launchProfile}: a refused widget must leave the content locked`,
      )
      assert.equal(
        failed.timedOut,
        false,
        `${launchProfile}: the failing case must terminate within the bound`,
      )
    }
  },
)

function recordFor(
  records: readonly CountermeasureRecord[],
  variant: CountermeasureVariant,
  targetUrl: string,
): CountermeasureRecord {
  const record = records.find(
    (candidate) =>
      candidate.variant === variant && candidate.targetUrl === targetUrl,
  )
  assert.ok(record, `no ${variant} record for ${targetUrl}`)
  return record
}

async function readTrackedCohort(): Promise<DeniedHostCohort> {
  const file = path.join(
    process.cwd(),
    'tests',
    'fixtures',
    'browser-denied-hosts.json',
  )
  const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.ok(isDeniedHostCohort(parsed), `${file} is not a denied-host cohort`)
  return parsed
}

function hostLimit(): number | undefined {
  const raw = process.env.PIPELINE_LIVE_BROWSER_HOST_LIMIT?.trim()
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function skipReason(): string | false {
  if (process.env.PIPELINE_LIVE_BROWSER_COUNTERMEASURES !== '1') {
    return 'Set PIPELINE_LIVE_BROWSER_COUNTERMEASURES=1 to run the local browser measurement.'
  }
  return resolveBrowserExecutablePath()
    ? false
    : 'No local Chrome installation was found for the countermeasure measurement.'
}

/**
 * The operator-facing summary.
 *
 * It names every status, because "no recoveries" and "nothing ran" are different
 * results and a run that cannot tell them apart is not evidence.
 */
function summarize(
  report: {
    readonly runId: string
    readonly variantOrder: readonly CountermeasureVariant[]
    readonly records: readonly CountermeasureRecord[]
    readonly variantSamples: readonly {
      readonly variant: CountermeasureVariant
      readonly testedPairs: number
      readonly insufficientSample: boolean
    }[]
    readonly accounting: {
      readonly tested: number
      readonly skipped: number
      readonly timedOut: number
      readonly untested: number
    }
  },
  cohort: DeniedHostCohort,
  written: string,
): string {
  const publicRecords = report.records.filter((record) =>
    cohort.hosts.some((entry) => entry.probeUrl === record.targetUrl),
  )
  const lines = [
    '',
    '--- local browser countermeasure measurement ---',
    `run: ${report.runId}`,
    `variant order: ${report.variantOrder.join(' -> ')}`,
    `tracked hosts: ${cohort.hosts.length}; variants: ${report.variantOrder.length}`,
    `records: ${report.records.length} (tested ${report.accounting.tested}, skipped ${report.accounting.skipped}, timed out ${report.accounting.timedOut}, untested ${report.accounting.untested})`,
    `public recoveries (usable): ${publicRecords.filter((record) => record.outcome === 'usable').length}`,
    `public challenge subtypes: ${JSON.stringify(countBy(publicRecords, (record) => record.challengeType ?? '-'))}`,
    `public outcomes: ${JSON.stringify(countBy(publicRecords, (record) => record.outcome))}`,
    `public statuses: ${JSON.stringify(countBy(publicRecords, (record) => record.status))}`,
    ...report.variantSamples.map(
      (sample) =>
        `sample ${sample.variant}: ${sample.testedPairs} tested pairs${sample.insufficientSample ? ' (insufficient-sample)' : ''}`,
    ),
    'per host and variant:',
    ...publicRecords.map(
      (record) =>
        `  ${record.targetHost} [${record.variant}] ${record.status}/${record.outcome}${record.challengeType ? `/${record.challengeType}` : ''} ${record.durationMs}ms${record.protectedContentUnlocked ? ' unlocked' : ''}`,
    ),
    `artifact: ${written}`,
    '',
  ]
  return lines.join('\n')
}

function countBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) {
    const name = key(value)
    counts[name] = (counts[name] ?? 0) + 1
  }
  return counts
}
