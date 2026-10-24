import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { AcquisitionSettingsService } from '../../services/acquisition-settings-service.js'

test('acquisition settings encrypt provider keys and expose only redacted status', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acquisition-settings-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const storagePath = path.join(directory, 'settings.json')
  const key = crypto.randomBytes(32)
  const codec = {
    encrypt(value: string): string {
      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
    },
    decrypt(value: string): string {
      const payload = Buffer.from(value, 'base64')
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        payload.subarray(0, 12),
      )
      decipher.setAuthTag(payload.subarray(12, 28))
      return Buffer.concat([
        decipher.update(payload.subarray(28)),
        decipher.final(),
      ]).toString('utf8')
    },
  }
  const service = new AcquisitionSettingsService({
    storagePath,
    secretCodec: codec,
    environment: {},
    providerSettings: {
      async snapshot() {
        return {
          connections: [],
          cliAgents: [],
          catalog: [{
            provider: 'codex',
            name: 'Codex',
            icon: 'codex',
            source: 'cli',
            models: [{
              id: 'gpt-extractor',
              name: 'GPT Extractor',
              enabled: true,
              capabilities: ['chat'],
            }],
          }],
          defaultModel: null,
          defaultModelState: { status: "unset" as const },
          effortCapabilities: [],
          defaultEffort: 'medium' as const,
        }
      },
    },
  })
  const saved = await service.update({
    providerPriority: ['brave', 'exa'],
    providers: {
      exa: { enabled: true, apiKey: 'exa-private-key' },
      brave: { enabled: true, apiKey: 'brave-private-key' },
      firecrawl: { enabled: true, apiKey: 'firecrawl-private-key' },
      'browser-use': { enabled: false },
    },
    budgets: {
      maximumSearchCalls: 30,
      maximumBrowserFallbacks: 8,
      maximumManagedReaderCalls: 3,
      maximumModelExtractions: 12,
      maximumCloudBrowserCalls: 0,
      maximumCloudBrowserCostMicros: 0,
    },
    extractionModel: { provider: 'codex', model: 'gpt-extractor' },
  })
  assert.deepEqual(saved.providerPriority, ['brave', 'exa'])
  assert.equal(saved.providers.exa.hasApiKey, true)
  assert.equal(saved.providers.exa.keyHint, 'Saved')
  assert.equal('apiKey' in saved.providers.exa, false)
  const persisted = await fs.readFile(storagePath, 'utf8')
  assert.equal(persisted.includes('exa-private-key'), false)
  assert.equal(persisted.includes('brave-private-key'), false)
  assert.equal(persisted.includes('firecrawl-private-key'), false)
  assert.match(persisted, /encryptedApiKey/)

  const reloaded = new AcquisitionSettingsService({
    storagePath,
    secretCodec: codec,
    environment: {},
    providerSettings: {
      async snapshot() {
        return {
          connections: [],
          cliAgents: [],
          catalog: [],
          defaultModel: null,
          defaultModelState: { status: "unset" as const },
          effortCapabilities: [],
          defaultEffort: 'medium' as const,
        }
      },
    },
  })
  assert.deepEqual((await reloaded.snapshot()).budgets, saved.budgets)
  assert.deepEqual((await reloaded.snapshot()).extractionModel, {
    provider: 'codex',
    model: 'gpt-extractor',
  })
  assert.deepEqual(
    (await reloaded.searchProviders()).map((provider) => provider.id),
    ['brave', 'exa'],
  )
  assert.equal((await reloaded.managedReader())?.id, 'firecrawl')
})

test('environment acquisition keys are usable without persistent secret storage', async () => {
  const service = new AcquisitionSettingsService({
    environment: {
      EXA_API_KEY: 'exa-environment',
      BRAVE_SEARCH_API_KEY: 'brave-environment',
      FIRECRAWL_API_KEY: 'firecrawl-environment',
    },
  })
  const snapshot = await service.snapshot()
  assert.equal(snapshot.editable, false)
  assert.equal(snapshot.providers.exa.keyHint, 'Environment')
  assert.deepEqual(
    (await service.searchProviders()).map((provider) => provider.id),
    ['exa', 'brave'],
  )
  assert.equal(await service.managedReader(), undefined)
})

test('concurrent cold reads all observe the persisted acquisition settings', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acquisition-settings-cold-read-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const storagePath = path.join(directory, 'settings.json')
  const environment = { EXA_API_KEY: 'test-exa-key' }
  const writer = new AcquisitionSettingsService({ storagePath, environment })
  await writer.update({
    providerPriority: ['exa', 'brave'],
    providers: {
      exa: { enabled: false },
      brave: { enabled: false },
      firecrawl: { enabled: false },
      'browser-use': { enabled: false },
    },
    budgets: {
      maximumSearchCalls: 1,
      maximumBrowserFallbacks: 2,
      maximumManagedReaderCalls: 3,
      maximumModelExtractions: 4,
      maximumCloudBrowserCalls: 0,
      maximumCloudBrowserCostMicros: 0,
    },
    extractionModel: null,
  })
  const reader = new AcquisitionSettingsService({ storagePath, environment })

  const [budgets, providers, snapshot] = await Promise.all([
    reader.budgets(),
    reader.searchProviders(),
    reader.snapshot(),
  ])

  assert.deepEqual(budgets, {
    maximumSearchCalls: 1,
    maximumBrowserFallbacks: 2,
    maximumManagedReaderCalls: 3,
    maximumModelExtractions: 4,
      maximumCloudBrowserCalls: 0,
      maximumCloudBrowserCostMicros: 0,
  })
  assert.deepEqual(providers, [])
  assert.equal(snapshot.source, 'persisted')
  assert.equal(snapshot.providers.exa.enabled, false)
})
