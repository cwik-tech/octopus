import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import test from 'node:test'

import { chromeSkipReason } from '../support/research-web-proxy-fixture.js'
import {
  runCountermeasureBakeOff,
  startProtectedContentOrigin,
  writeCountermeasureReport,
} from '../support/browser-countermeasure-fixture.js'

/**
 * The bake-off harness, proved against pages whose answer is known.
 *
 * Nothing here measures a public site. It establishes that the comparison can
 * tell a gate that was passed from one that was not, that the injected launch
 * profile actually reaches Chrome, and that the record it writes is complete
 * and carries no page content.
 */

test(
  'the bake-off tells an unlocked gate from a locked one and accounts for every pair',
  { skip: chromeSkipReason() },
  async (context) => {
    const origin = await startProtectedContentOrigin()
    context.after(() => origin.close())

    const report = await runCountermeasureBakeOff({
      variants: ['stock', 'automation-controlled-disabled'],
      targets: [origin.passTarget, origin.failTarget],
      timeoutMs: 30_000,
      allowHttpLocalhost: true,
    })

    assert.equal(report.records.length, 4)
    assert.deepEqual(report.accounting, {
      tested: 4,
      skipped: 0,
      timedOut: 0,
      untested: 0,
    })

    const passRecords = report.records.filter(
      (record) => record.targetHost === origin.passTarget.host &&
        record.targetUrl === origin.passTarget.probeUrl,
    )
    assert.equal(passRecords.length, 2)
    for (const record of passRecords) {
      assert.equal(record.outcome, 'usable', JSON.stringify(record))
      assert.equal(record.protectedContentUnlocked, true)
    }

    const failRecords = report.records.filter(
      (record) => record.targetUrl === origin.failTarget.probeUrl,
    )
    assert.equal(failRecords.length, 2)
    for (const record of failRecords) {
      assert.equal(record.outcome, 'challenge', JSON.stringify(record))
      assert.equal(record.challengeType, 'browser-verification')
      assert.equal(record.protectedContentUnlocked, false)
    }

    // Every record names the build that produced it, and carries no page text.
    for (const record of report.records) {
      assert.match(record.browserVersion, /Chrom/u)
      assert.equal(record.mode, 'headless')
      assert.equal(record.driverVersion.length > 0, true)
      assert.equal(new URL(record.targetUrl).search, '')
      assert.equal(new URL(record.targetUrl).hash, '')
      assert.equal(record.proxyMode, 'none')
      assert.equal(record.proxyTier, 'none')
    }
    assert.doesNotMatch(
      JSON.stringify(report),
      new RegExp(origin.protectedContentLiteral, 'u'),
      'a report must record that content unlocked, never the content itself',
    )

    // Four pairs is not a sample. The report has to say so rather than imply a
    // result.
    for (const sample of report.variantSamples) {
      assert.equal(sample.insufficientSample, true, sample.variant)
    }

    const written = await writeCountermeasureReport(report)
    context.after(() => fs.rm(written, { force: true }))
    assert.equal(
      written.startsWith(process.cwd()),
      false,
      'the run artifact is written outside source control',
    )
    assert.deepEqual(
      JSON.parse(await fs.readFile(written, 'utf8')),
      JSON.parse(JSON.stringify(report)),
    )
  },
)

test(
  'the injected launch profile reaches Chrome',
  { skip: chromeSkipReason() },
  async (context) => {
    const origin = await startProtectedContentOrigin()
    context.after(() => origin.close())

    const report = await runCountermeasureBakeOff({
      variants: ['stock', 'automation-controlled-disabled'],
      targets: [origin.webdriverTarget],
      timeoutMs: 30_000,
      allowHttpLocalhost: true,
    })

    const byVariant = new Map(
      report.records.map((record) => [record.variant, record]),
    )
    assert.equal(
      byVariant.get('stock')?.protectedContentUnlocked,
      false,
      'the stock profile still announces automation',
    )
    assert.equal(
      byVariant.get('automation-controlled-disabled')?.protectedContentUnlocked,
      true,
      'the compared profile must actually change what the page sees',
    )
  },
)

test(
  'a warm assignment reads the same source twice inside one context',
  { skip: chromeSkipReason() },
  async (context) => {
    const origin = await startProtectedContentOrigin()
    context.after(() => origin.close())

    const report = await runCountermeasureBakeOff({
      variants: ['warm-assignment'],
      targets: [origin.passTarget],
      timeoutMs: 30_000,
      allowHttpLocalhost: true,
    })

    assert.equal(report.records.length, 1)
    assert.equal(report.records[0]?.variant, 'warm-assignment')
    assert.equal(report.records[0]?.readsInAssignment, 2)
    assert.equal(report.records[0]?.launchProfile, 'stock')
    assert.equal(origin.requestCounts.get(origin.passTarget.probeUrl) ?? 0, 2)
  },
)
