import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { createDesktopAcquisitionSettingsService } from '../../server/tools/research-web.js'
import { startBrowserUseApiFixture } from '../support/browser-use-api-fixture.js'

/**
 * The composition the desktop actually uses, driven end to end.
 *
 * `createDesktopAcquisitionSettingsService` is the whole construction
 * `electron/main.ts` performs. Testing that function — rather than a
 * hand-written callback that resembles it — is what makes this fail if the
 * cleanup channel were dropped from the desktop's service.
 *
 * It opens a loopback server and runs a real provider session lifecycle, so it
 * belongs here rather than in the unit suite; the message's wording is checked
 * separately in `tests/unit/cloud-cleanup-warning.test.ts`.
 */

test('a settings service built the desktop way reports a session it could not name', async (t) => {
  const fixture = await startBrowserUseApiFixture()
  t.after(() => fixture.close())
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-composition-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const reported: string[] = []
  const service = createDesktopAcquisitionSettingsService({
    storagePath: path.join(root, 'acquisition-settings.json'),
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
    providerEndpoints: { 'browser-use': fixture.url },
    isTestRun: true,
    // Its own environment rather than the process one: a test that writes a
    // credential into `process.env` can erase a developer's real key and race
    // every other test in the suite.
    environment: {},
    // The only seam this test adds: where the diagnostic is written. Everything
    // else — including whether a cleanup channel exists at all — comes from the
    // factory the desktop calls.
    log: (scope, message) => reported.push(`${scope}|${message}`),
  })
  await service.update({
    providerPriority: ['exa', 'brave'],
    providers: {
      exa: { enabled: false },
      brave: { enabled: false },
      firecrawl: { enabled: false },
      'browser-use': { enabled: true, apiKey: 'bu_key' },
    },
    budgets: {
      maximumSearchCalls: 20,
      maximumBrowserFallbacks: 10,
      maximumManagedReaderCalls: 5,
      maximumModelExtractions: 20,
      maximumCloudBrowserCalls: 1,
      maximumCloudBrowserCostMicros: 1_000,
    },
    extractionModel: null,
  })

  // A create the provider answers with something unreadable: a session may
  // exist, cannot be named, and will bill until its timeout. That is precisely
  // the case an operator has to hear about.
  fixture.respondToCreate({ raw: '<html>gateway</html>' })
  const acquirer = await service.cloudBrowser()
  assert.ok(acquirer, 'an enabled, keyed provider must yield a rung')

  const result = await acquirer.acquire('https://example.com/report', {
    enabled: true,
    restrictDomains: true,
    domains: ['example.com'],
  })

  assert.equal(result.cleanup.stopped, false)
  assert.equal(reported.length, 1, 'the desktop service must report an unnameable session')
  assert.match(reported[0] ?? '', /research-web\/cloud-browser/u)
  assert.match(reported[0] ?? '', /cannot be named/u)
})
