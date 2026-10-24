import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { handleAcquisitionSettingsRoutes } from '../../server/routes/acquisition-settings.js'
import { AcquisitionSettingsService } from '../../services/acquisition-settings-service.js'

test('acquisition settings route persists budgets and never returns provider secrets', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acquisition-settings-route-'))
  const key = crypto.randomBytes(32)
  const service = new AcquisitionSettingsService({
    storagePath: path.join(directory, 'settings.json'),
    environment: {},
    secretCodec: {
      encrypt(value) {
        const iv = crypto.randomBytes(12)
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
      },
      decrypt(value) {
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
    },
  })
  const server = http.createServer((req, res) => {
    void handleAcquisitionSettingsRoutes({
      req,
      res,
      url: new URL(req.url ?? '/', 'http://127.0.0.1'),
      service,
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/settings/research-acquisition`
  try {
    const defaults = await fetch(url)
    assert.equal(defaults.status, 200)
    assert.equal(defaults.headers.get('cache-control'), 'no-store')

    const saved = await fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerPriority: ['brave', 'exa'],
        providers: {
          exa: { enabled: true, apiKey: 'private-exa' },
          brave: { enabled: true, apiKey: 'private-brave' },
          firecrawl: { enabled: false },
          'browser-use': { enabled: false },
        },
        budgets: {
          maximumSearchCalls: 24,
          maximumBrowserFallbacks: 7,
          maximumManagedReaderCalls: 2,
          maximumModelExtractions: 9,
          maximumCloudBrowserCalls: 0,
          maximumCloudBrowserCostMicros: 0,
        },
        extractionModel: null,
      }),
    })
    assert.equal(saved.status, 200)
    const text = await saved.text()
    assert.equal(text.includes('private-exa'), false)
    assert.equal(text.includes('private-brave'), false)
    const snapshot = JSON.parse(text) as {
      source: string
      budgets: { maximumSearchCalls: number }
      providers: { exa: { hasApiKey: boolean } }
    }
    assert.equal(snapshot.source, 'persisted')
    assert.equal(snapshot.budgets.maximumSearchCalls, 24)
    assert.equal(snapshot.providers.exa.hasApiKey, true)

    const invalid = await fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerPriority: ['exa', 'exa'],
        providers: {
          exa: { enabled: true },
          brave: { enabled: true },
          firecrawl: { enabled: false },
          'browser-use': { enabled: false },
        },
        budgets: {
          maximumSearchCalls: 0,
          maximumBrowserFallbacks: 0,
          maximumManagedReaderCalls: 0,
          maximumModelExtractions: 0,
          maximumCloudBrowserCalls: 0,
          maximumCloudBrowserCostMicros: 0,
        },
        extractionModel: null,
      }),
    })
    assert.equal(invalid.status, 400)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
