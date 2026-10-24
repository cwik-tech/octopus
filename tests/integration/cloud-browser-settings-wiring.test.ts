import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { DEFAULT_ACQUISITION_BUDGETS } from '../../domains/acquisition/acquisition-settings.js'
import { AcquisitionSettingsService } from '../../services/acquisition-settings-service.js'
import {
  activeSession,
  startBrowserUseApiFixture,
  type BrowserUseApiFixture,
} from '../support/browser-use-api-fixture.js'

/**
 * That the configured runtime inputs actually reach the provider.
 *
 * The parser is unit-tested on its own; this proves the value it produces is
 * the value the provider is asked for, observed on the wire rather than read
 * back out of the service through an accessor that exists only for tests.
 */

const POLICY = { enabled: true, restrictDomains: false, domains: [] } as const

const TEST_SECRET_CODEC = {
  encrypt(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64')
  },
  decrypt(value: string): string {
    return Buffer.from(value, 'base64').toString('utf8')
  },
}

async function acquirerFrom(
  t: TestContext,
  fixture: BrowserUseApiFixture,
  environment: NodeJS.ProcessEnv,
): Promise<NonNullable<Awaited<ReturnType<AcquisitionSettingsService['cloudBrowser']>>>> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-wiring-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const service = new AcquisitionSettingsService({
    environment,
    storagePath: path.join(root, 'acquisition-settings.json'),
    secretCodec: TEST_SECRET_CODEC,
    providerEndpoints: { 'browser-use': fixture.url },
    allowHttpLocalhost: true,
  })
  await service.update({
    providerPriority: ['exa', 'brave'],
    providers: {
      exa: { enabled: false },
      brave: { enabled: false },
      firecrawl: { enabled: false },
      'browser-use': { enabled: true, apiKey: 'bu_key' },
    },
    budgets: { ...DEFAULT_ACQUISITION_BUDGETS, maximumCloudBrowserCalls: 1 },
    extractionModel: null,
  })
  const acquirer = await service.cloudBrowser()
  assert.ok(acquirer, 'an enabled, keyed provider must yield a rung')
  return acquirer
}

/** The create request body, narrowed rather than asserted. */
function createBody(fixture: BrowserUseApiFixture): Readonly<Record<string, unknown>> {
  const create = fixture.requests.find((request) => request.method === 'POST')
  assert.ok(create, 'the provider must have been asked to create a session')
  const parsed: unknown = JSON.parse(create.body)
  if (!isRecord(parsed)) {
    throw new Error('the create body must be a JSON object')
  }
  return parsed
}

function localTarget(fixture: BrowserUseApiFixture): string {
  return new URL('/report', fixture.url).toString()
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

test('settings hide the live-test key and validate the saved Browser Use key', async (t) => {
  const fixture = await startBrowserUseApiFixture()
  try {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-key-settings-')))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const service = new AcquisitionSettingsService({
      environment: { BROWSER_USE_API_KEY: 'live-test-key' },
      storagePath: path.join(root, 'acquisition-settings.json'),
      secretCodec: TEST_SECRET_CODEC,
      providerEndpoints: { 'browser-use': fixture.url },
    })
    await service.update({
      providerPriority: ['exa', 'brave'],
      providers: {
        exa: { enabled: false },
        brave: { enabled: false },
        firecrawl: { enabled: false },
        'browser-use': { enabled: true, apiKey: 'settings-key' },
      },
      budgets: { ...DEFAULT_ACQUISITION_BUDGETS },
      extractionModel: null,
    })

    const validated = await service.validateProvider('browser-use')

    assert.equal(validated.providers['browser-use'].keyHint, 'Saved')
    assert.equal(validated.providers['browser-use'].status, 'connected')
    assert.equal(validated.providers['browser-use'].error, undefined)
    assert.deepEqual(
      fixture.requests.map((request) => request.method),
      ['GET'],
      'credential validation must not create a billable session',
    )
    assert.equal(fixture.requests[0]?.headers['x-browser-use-api-key'], 'settings-key')
  } finally {
    await fixture.close()
  }
})

test('the cloud runtime uses the saved key instead of the live-test key', async (t) => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: null }) })
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-key-runtime-')))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const service = new AcquisitionSettingsService({
      environment: { BROWSER_USE_API_KEY: 'live-test-key' },
      storagePath: path.join(root, 'acquisition-settings.json'),
      secretCodec: TEST_SECRET_CODEC,
      providerEndpoints: { 'browser-use': fixture.url },
      allowHttpLocalhost: true,
    })
    await service.update({
      providerPriority: ['exa', 'brave'],
      providers: {
        exa: { enabled: false },
        brave: { enabled: false },
        firecrawl: { enabled: false },
        'browser-use': { enabled: true, apiKey: 'settings-key' },
      },
      budgets: { ...DEFAULT_ACQUISITION_BUDGETS, maximumCloudBrowserCalls: 1 },
      extractionModel: null,
    })

    const acquirer = await service.cloudBrowser()
    assert.ok(acquirer)
    await acquirer.acquire(localTarget(fixture), POLICY)

    const create = fixture.requests.find((request) => request.method === 'POST')
    assert.equal(create?.headers['x-browser-use-api-key'], 'settings-key')
    assert.equal(JSON.stringify(fixture.requests).includes('live-test-key'), false)
  } finally {
    await fixture.close()
  }
})

test('the configured proxy country is what the provider is asked for', async (t) => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: null }) })
    const acquirer = await acquirerFrom(t, fixture, { BROWSER_USE_PROXY_COUNTRY: 'gb' })

    await acquirer.acquire(localTarget(fixture), POLICY)

    assert.equal(createBody(fixture).proxyCountryCode, 'gb')
  } finally {
    await fixture.close()
  }
})

test('a proxy country of none asks the provider to run unproxied', async (t) => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: null }) })
    const acquirer = await acquirerFrom(t, fixture, { BROWSER_USE_PROXY_COUNTRY: 'none' })

    await acquirer.acquire(localTarget(fixture), POLICY)

    // Explicit null, not an omitted field: they mean different things.
    assert.equal(createBody(fixture).proxyCountryCode, null)
  } finally {
    await fixture.close()
  }
})

test('a control endpoint outside the default allowlist is refused', async (t) => {
  const fixture = await startBrowserUseApiFixture()
  try {
    const loopbackCdp = `ws://127.0.0.1:${new URL(fixture.url).port}/devtools/browser/abc`
    fixture.respondToCreate({ body: activeSession({ cdpUrl: loopbackCdp }) })
    const acquirer = await acquirerFrom(t, fixture, {})

    const result = await acquirer.acquire(localTarget(fixture), POLICY)

    assert.equal(
      result.failure?.code,
      'provider_session_unusable',
      'the default allowlist must not admit an arbitrary host',
    )
  } finally {
    await fixture.close()
  }
})

test('a configured allowlist admits the host it names', async (t) => {
  const fixture = await startBrowserUseApiFixture()
  try {
    const loopbackCdp = `ws://127.0.0.1:${new URL(fixture.url).port}/devtools/browser/abc`
    fixture.respondToCreate({ body: activeSession({ cdpUrl: loopbackCdp }) })
    const acquirer = await acquirerFrom(t, fixture, {
      BROWSER_USE_CDP_HOST_ALLOWLIST: '127.0.0.1',
    })

    const result = await acquirer.acquire(localTarget(fixture), POLICY)

    // Admitted, so the failure is the connection to a plain HTTP server rather
    // than a refusal to try. That difference is the wiring.
    assert.equal(result.failure?.code, 'provider_session_failed')
  } finally {
    await fixture.close()
  }
})

test('a malformed runtime input fails before the provider is contacted', async (t) => {
  const fixture = await startBrowserUseApiFixture()
  try {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-wiring-bad-')))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const service = new AcquisitionSettingsService({
      environment: { BROWSER_USE_PROXY_COUNTRY: 'gbr' },
      storagePath: path.join(root, 'acquisition-settings.json'),
      secretCodec: TEST_SECRET_CODEC,
      providerEndpoints: { 'browser-use': fixture.url },
    })
    await service.update({
      providerPriority: ['exa', 'brave'],
      providers: {
        exa: { enabled: false },
        brave: { enabled: false },
        firecrawl: { enabled: false },
        'browser-use': { enabled: true, apiKey: 'bu_key' },
      },
      budgets: { ...DEFAULT_ACQUISITION_BUDGETS, maximumCloudBrowserCalls: 1 },
      extractionModel: null,
    })

    await assert.rejects(() => service.cloudBrowser(), /cloud browser proxy country/iu)
    assert.deepEqual(fixture.requests, [], 'nothing may be sent on a bad configuration')
  } finally {
    await fixture.close()
  }
})
