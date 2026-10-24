import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import {
  ACQUISITION_SETTINGS_SCHEMA_VERSION,
  DEFAULT_ACQUISITION_BUDGETS,
  validateAcquisitionSettingsUpdate,
  type AcquisitionSettingsUpdate,
} from '../../domains/acquisition/acquisition-settings.js'
import { AcquisitionSettingsService } from '../../services/acquisition-settings-service.js'

/**
 * The settings half of the cloud rung.
 *
 * Adding a provider id is not additive here: it feeds a total `Record`, a
 * hand-written validation list, two environment maps, a default state, a parse
 * loop and a label. The parse loop **throws** on a missing provider key, so a
 * new id without a migration makes every settings file already on disk
 * unreadable — which is a far worse failure than the feature not appearing.
 */

function update(
  overrides: Partial<AcquisitionSettingsUpdate> = {},
): AcquisitionSettingsUpdate {
  return {
    providerPriority: ['exa', 'brave'],
    providers: {
      exa: { enabled: false },
      brave: { enabled: false },
      firecrawl: { enabled: false },
      'browser-use': { enabled: false },
    },
    budgets: { ...DEFAULT_ACQUISITION_BUDGETS },
    extractionModel: null,
    ...overrides,
  }
}

/**
 * Storage that round-trips, which is all these cases need.
 *
 * The encryption itself is covered where it belongs, next to the real codec;
 * here a key only has to survive a write and come back.
 */
function reversibleCodec(): { encrypt(value: string): string; decrypt(value: string): string } {
  return {
    encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
    decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
  }
}

function makeStorage(t: TestContext, name: string): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `cloud-settings-${name}-`)),
  )
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return path.join(root, 'acquisition-settings.json')
}

function writeSettingsFile(t: TestContext, name: string, file: unknown): string {
  const storagePath = makeStorage(t, name)
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  fs.writeFileSync(storagePath, JSON.stringify(file), 'utf8')
  return storagePath
}

/** A complete current-schema file, which each rejection case then damages. */
function currentSchemaFile(): Record<string, unknown> {
  return {
    schemaVersion: ACQUISITION_SETTINGS_SCHEMA_VERSION,
    providerPriority: ['exa', 'brave'],
    providers: {
      exa: { enabled: true, status: 'connected' },
      brave: { enabled: false, status: 'unknown' },
      firecrawl: { enabled: false, status: 'unknown' },
      'browser-use': { enabled: false, status: 'unknown' },
    },
    budgets: { ...DEFAULT_ACQUISITION_BUDGETS },
    extractionModel: null,
  }
}

test('the schema version moves to 3', () => {
  assert.equal(ACQUISITION_SETTINGS_SCHEMA_VERSION, 3)
})

test('the cloud provider is part of a valid settings update', () => {
  assert.doesNotThrow(() => validateAcquisitionSettingsUpdate(update()))
})

test('an update that omits the cloud provider is refused', () => {
  const incomplete = update()
  const providers: Record<string, { enabled: boolean }> = { ...incomplete.providers }
  delete providers['browser-use']
  assert.throws(() =>
    validateAcquisitionSettingsUpdate({
      ...incomplete,
      // A provider the validator forgets is a provider nobody can configure and
      // nobody notices is unconfigured.
      providers: providers as AcquisitionSettingsUpdate['providers'],
    }),
  )
})

test('the cloud provider is reported, disabled, with no key', async (t) => {
  const service = new AcquisitionSettingsService({
    environment: {},
    storagePath: makeStorage(t, 'default'),
  })

  const snapshot = await service.snapshot()

  assert.equal(snapshot.providers['browser-use'].enabled, false)
  assert.equal(snapshot.providers['browser-use'].hasApiKey, false)
  assert.equal(snapshot.budgets.maximumCloudBrowserCalls, 0)
})

test('a provider with no key is reported off, whatever the file says', async (t) => {
  const storagePath = writeSettingsFile(t, 'keyless-enabled', {
    ...currentSchemaFile(),
    providers: {
      // The state a default install leaves behind: switched on, never given a
      // key, and unable to run a single search.
      exa: { enabled: true, status: 'unknown' },
      brave: { enabled: false, status: 'unknown' },
      firecrawl: { enabled: false, status: 'unknown' },
      'browser-use': { enabled: false, status: 'unknown' },
    },
  })
  const service = new AcquisitionSettingsService({ environment: {}, storagePath })

  const snapshot = await service.snapshot()

  assert.equal(snapshot.providers.exa.enabled, false)
  assert.equal(snapshot.providers.exa.hasApiKey, false)
})

test('an update cannot switch on a provider that has no key', async (t) => {
  const storagePath = makeStorage(t, 'enable-without-key')
  const service = new AcquisitionSettingsService({
    environment: {},
    storagePath,
    secretCodec: reversibleCodec(),
  })

  const refused = await service.update(
    update({
      providers: {
        exa: { enabled: true },
        brave: { enabled: false },
        firecrawl: { enabled: false },
        'browser-use': { enabled: false },
      },
    }),
  )

  assert.equal(refused.providers.exa.enabled, false, 'nothing to run means nothing to enable')

  const accepted = await service.update(
    update({
      providers: {
        exa: { enabled: true, apiKey: 'exa-key' },
        brave: { enabled: false },
        firecrawl: { enabled: false },
        'browser-use': { enabled: false },
      },
    }),
  )

  // The key arrives in the same request, so the enable has to be judged against
  // it rather than against the credential the file held a moment ago.
  assert.equal(accepted.providers.exa.enabled, true)
  assert.equal(accepted.providers.exa.hasApiKey, true)
})

test('the Browser Use environment key is reserved for live checks', async (t) => {
  const service = new AcquisitionSettingsService({
    environment: { BROWSER_USE_API_KEY: 'bu_from_environment' },
    storagePath: makeStorage(t, 'environment'),
  })

  const snapshot = await service.snapshot()

  assert.equal(snapshot.providers['browser-use'].hasApiKey, false)
  assert.equal(snapshot.providers['browser-use'].keyHint, undefined)
  // The key itself never crosses this boundary.
  assert.equal(JSON.stringify(snapshot).includes('bu_from_environment'), false)
  await assert.rejects(
    () => service.validateProvider('browser-use'),
    /Browser Use API key is required/iu,
  )
})

test('a current-schema file missing a provider is refused', async (t) => {
  // Migration tolerance is for files written before a provider existed. A
  // current file missing one is damaged, and reading it as "that provider is
  // off" would silently discard a setting somebody made.
  for (const missing of ['exa', 'firecrawl', 'browser-use']) {
    const file = currentSchemaFile()
    const providers: Record<string, unknown> = { ...(file.providers as object) }
    delete providers[missing]
    const storagePath = writeSettingsFile(t, `v3-missing-${missing}`, {
      ...file,
      providers,
    })
    const service = new AcquisitionSettingsService({ environment: {}, storagePath })
    await assert.rejects(() => service.snapshot(), /invalid/iu, missing)
  }
})

test('a current-schema file missing a budget is refused', async (t) => {
  for (const missing of ['maximumSearchCalls', 'maximumCloudBrowserCalls']) {
    const file = currentSchemaFile()
    const budgets: Record<string, unknown> = { ...(file.budgets as object) }
    delete budgets[missing]
    const storagePath = writeSettingsFile(t, `v3-budget-${missing}`, { ...file, budgets })
    const service = new AcquisitionSettingsService({ environment: {}, storagePath })
    await assert.rejects(() => service.snapshot(), /invalid/iu, missing)
  }
})

test('the obsolete billable-test warning is not shown as a provider error', async (t) => {
  const file = currentSchemaFile()
  const providers = { ...(file.providers as Record<string, unknown>) }
  providers['browser-use'] = {
    enabled: false,
    status: 'unknown',
    error:
      'Testing this provider would start a billable session, so it is not tested from here.',
    lastCheckedAt: '2026-08-30T17:00:00.000Z',
  }
  const storagePath = writeSettingsFile(t, 'obsolete-browser-use-warning', {
    ...file,
    providers,
  })

  const snapshot = await new AcquisitionSettingsService({
    environment: {},
    storagePath,
  }).snapshot()

  assert.equal(snapshot.providers['browser-use'].status, 'unknown')
  assert.equal(snapshot.providers['browser-use'].error, undefined)
  assert.equal(snapshot.providers['browser-use'].lastCheckedAt, undefined)
})

test('a version 2 settings file still loads, with the new provider disabled', async (t) => {
  const storagePath = makeStorage(t, 'v2')
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  fs.writeFileSync(
    storagePath,
    JSON.stringify({
      schemaVersion: 2,
      providerPriority: ['exa', 'brave'],
      providers: {
        exa: { enabled: true, encryptedApiKey: 'v2-exa-key', status: 'connected' },
        brave: { enabled: false, status: 'unknown' },
        firecrawl: { enabled: false, status: 'unknown' },
      },
      budgets: {
        maximumSearchCalls: 20,
        maximumBrowserFallbacks: 10,
        maximumManagedReaderCalls: 5,
        maximumModelExtractions: 20,
      },
      extractionModel: null,
    }),
    'utf8',
  )
  const service = new AcquisitionSettingsService({ environment: {}, storagePath })

  const snapshot = await service.snapshot()

  assert.equal(snapshot.source, 'persisted', 'a v2 file must still be read, not discarded')
  assert.equal(snapshot.providers.exa.enabled, true, 'its existing choices survive')
  assert.equal(snapshot.providers['browser-use'].enabled, false)
  assert.equal(snapshot.budgets.maximumCloudBrowserCalls, 0, 'the paid rung stays off')
})

test('a version 1 settings file still loads through its own migration', async (t) => {
  const storagePath = makeStorage(t, 'v1')
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  fs.writeFileSync(
    storagePath,
    JSON.stringify({
      schemaVersion: 1,
      providerPriority: ['exa', 'brave'],
      providers: {
        exa: { enabled: true, status: 'connected' },
        brave: { enabled: false, status: 'unknown' },
        firecrawl: { enabled: false, status: 'unknown' },
      },
      budgets: {
        maximumSearchCalls: 20,
        maximumBrowserFallbacks: 10,
        maximumManagedReaderCalls: 5,
        maximumModelExtractions: 20,
      },
    }),
    'utf8',
  )
  const service = new AcquisitionSettingsService({ environment: {}, storagePath })

  const snapshot = await service.snapshot()

  assert.equal(snapshot.source, 'persisted')
  assert.equal(snapshot.providers['browser-use'].enabled, false)
})

test('the Browser Use environment key cannot create an application cloud rung', async (t) => {
  const service = new AcquisitionSettingsService({
    environment: { BROWSER_USE_API_KEY: 'bu_key' },
    storagePath: makeStorage(t, 'validate'),
  })
  await service.update(update({
    providers: {
      exa: { enabled: false },
      brave: { enabled: false },
      firecrawl: { enabled: false },
      'browser-use': { enabled: true },
    },
  }))

  assert.equal(await service.cloudBrowser(), undefined)
})
