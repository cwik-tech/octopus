import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { ProviderSettingsService } from '../../services/provider-settings-service.js'

/**
 * The snapshot prompt assembly reads.
 *
 * Prompt assembly is synchronous and every settings read is not, so the service
 * keeps a map of connection id to kind. What matters is when it is populated:
 * the feature exists to stop a local connection being budgeted against a hosted
 * window, and a map that fills only once somebody lists connections leaves the
 * first turn after boot doing exactly that.
 */
async function withService(
  run: (service: ProviderSettingsService) => Promise<void>,
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-kind-'))
  try {
    await run(new ProviderSettingsService({
      storagePath: path.join(directory, 'provider-settings.json'),
    }))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('the connection-kind snapshot is available from boot, not only after a listing', async () => {
  await withService(async (service) => {
    const saved = await service.saveConnection({
      name: 'Local box',
      kind: 'lm-studio',
      baseUrl: 'http://localhost:1234/v1',
      enabled: true,
    })

    // A fresh service over the same file is what a restart looks like.
    const restarted = new ProviderSettingsService({
      storagePath: (service as unknown as { options: { storagePath: string } })
        .options.storagePath,
    })
    await restarted.hydrateRuntime()

    assert.equal(
      restarted.connectionKindFor(`connection:${saved.id}`),
      'lm-studio',
      'the kind was not known after boot, so the first turn would be budgeted wrong',
    )
  })
})

test('a provider that is not a connection has no kind', async () => {
  await withService(async (service) => {
    assert.equal(service.connectionKindFor('anthropic'), undefined)
    assert.equal(service.connectionKindFor('connection:missing'), undefined)
  })
})

test('the snapshot follows edits, and forgets a deleted connection', async () => {
  await withService(async (service) => {
    const saved = await service.saveConnection({
      name: 'Local box',
      kind: 'lm-studio',
      baseUrl: 'http://localhost:1234/v1',
      enabled: true,
    })
    await service.listConnections()
    assert.equal(service.connectionKindFor(`connection:${saved.id}`), 'lm-studio')

    await service.saveConnection({
      id: saved.id,
      name: 'Local box',
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:1234/v1',
      enabled: true,
    })
    await service.listConnections()
    assert.equal(
      service.connectionKindFor(`connection:${saved.id}`),
      'openai-compatible',
    )

    // And a deleted connection stops being known. A stale kind would budget a
    // speaker against a connection that no longer exists.
    await service.deleteConnection(saved.id)
    await service.listConnections()
    assert.equal(service.connectionKindFor(`connection:${saved.id}`), undefined)
  })
})
