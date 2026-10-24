import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import * as z from 'zod/v4'
import { startApiServer } from '../../server/api-server.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { cliFixtureSettings, createCliDiscoveryFixture } from '../support/cli-discovery-fixture.js'

test('after restart Settings shows saved models before discovery completes, then publishes refreshed models', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-startup-'))
  const fixture = await createCliDiscoveryFixture(root)
  const originalPath = process.env.PATH
  const originalFallback = process.env.PIPELINE_CLI_PATH_FALLBACK
  process.env.PATH = fixture.bin
  process.env.PIPELINE_CLI_PATH_FALLBACK = '0'
  const storagePath = path.join(root, 'provider-settings.json')
  await fs.writeFile(storagePath, JSON.stringify(cliFixtureSettings()))
  const service = new ProviderSettingsService({ storagePath })
  try {
    await service.snapshot(true)
    const discoveryStarted = fixture.hold()
    const server = await startApiServer({
      store: new FileSystemRunStore(root),
      launcher: { async startRun(request) { return { launched: true, pid: 1, cwd: request.cwd } } },
      providerSettingsService: new ProviderSettingsService({ storagePath }),
    })
    try {
      const initial = fetch(`${server.url}/settings/providers`, { signal: AbortSignal.timeout(5_000) })
      const first = await Promise.race([
        initial.then(response => ({ kind: 'snapshot', response }) as const),
        discoveryStarted.then(() => ({ kind: 'blocked-on-discovery' }) as const),
      ])
      assert.equal(first.kind, 'snapshot', 'saved Settings must arrive while CLI discovery is held')
      assert.ok(first.kind === 'snapshot')
      const payload: unknown = await first.response.json()
      assert.deepEqual(modelIds(payload), ['default', 'saved-model'])
      const refresh = fetch(`${server.url}/settings/model-catalog?refresh=1`, { signal: AbortSignal.timeout(5_000) })
      await discoveryStarted
      fixture.release('new-model')
      const refreshed: unknown = await (await refresh).json()
      assert.deepEqual(modelIds(refreshed), ['default', 'new-model'])
      const subsequent: unknown = await (await fetch(`${server.url}/settings/model-catalog`)).json()
      assert.deepEqual(modelIds(subsequent), ['default', 'new-model'])
    } finally {
      fixture.release()
      await server.close()
    }
  } finally {
    fixture.release()
    await fixture.close()
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    if (originalFallback === undefined) delete process.env.PIPELINE_CLI_PATH_FALLBACK
    else process.env.PIPELINE_CLI_PATH_FALLBACK = originalFallback
    await fs.rm(root, { recursive: true, force: true })
  }
})

function modelIds(value: unknown): string[] {
  const snapshot = z.object({ catalog: z.array(z.object({
    provider: z.string(), models: z.array(z.object({ id: z.string() })),
  })) }).parse(value)
  return snapshot.catalog.filter(group => group.provider === 'qwen').flatMap(group => group.models.map(model => model.id))
}
