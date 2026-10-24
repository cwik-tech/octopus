import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { getRuntimeDefaultModelState, setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { cliFixtureSettings, createCliDiscoveryFixture } from '../support/cli-discovery-fixture.js'

async function withFixture(run: (fixture: Awaited<ReturnType<typeof createCliDiscoveryFixture>>, storagePath: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discovery-cache-'))
  const fixture = await createCliDiscoveryFixture(root)
  const originalPath = process.env.PATH
  const originalFallback = process.env.PIPELINE_CLI_PATH_FALLBACK
  process.env.PATH = fixture.bin
  process.env.PIPELINE_CLI_PATH_FALLBACK = '0'
  const storagePath = path.join(root, 'settings.json')
  await fs.writeFile(storagePath, JSON.stringify(cliFixtureSettings()))
  try { await run(fixture, storagePath) }
  finally {
    fixture.release()
    await fixture.close()
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    if (originalFallback === undefined) delete process.env.PIPELINE_CLI_PATH_FALLBACK
    else process.env.PIPELINE_CLI_PATH_FALLBACK = originalFallback
    await fs.rm(root, { recursive: true, force: true })
  }
}

test('saved discovery uses current model preferences and does not claim fresh MCP readiness', async () => {
  await withFixture(async (_fixture, storagePath) => {
    await new ProviderSettingsService({ storagePath }).snapshot(true)
    const settings = cliFixtureSettings()
    settings.cliModelEnabled.qwen['saved-model'] = false
    await fs.writeFile(storagePath, JSON.stringify(settings))
    const display = await new ProviderSettingsService({ storagePath }).cachedSnapshot()
    assert.equal(display.catalog.some(group => group.models.some(model => model.id === 'saved-model')), false)
    assert.equal(display.defaultModelState.status, 'unavailable')
    assert.deepEqual(display.cliAgents.find(agent => agent.id === 'qwen')?.mcpBridge, { supported: false, reasonCode: 'cli_mcp_bridge_unavailable' })
  })
})

for (const [name, content] of [['absent', undefined], ['invalid JSON', '{'], ['invalid metadata', '{"version":1,"agents":[{"id":"qwen","models":"bad"}]}']] as const) {
  test(`first use still shows installed CLI fallback models with ${name} discovery cache`, async () => {
    await withFixture(async (_fixture, storagePath) => {
      if (content !== undefined) await fs.writeFile(`${storagePath}.cli-cache.json`, content)
      const snapshot = await new ProviderSettingsService({ storagePath }).cachedSnapshot()
      assert.equal(snapshot.cliAgents.find(agent => agent.id === 'qwen')?.available, true)
      assert.equal(snapshot.cliAgents.find(agent => agent.id === 'qwen')?.models.some(model => model.id === 'default'), true)
      assert.equal(snapshot.defaultModelState.status, 'unavailable')
    })
  })
}

test('a removed executable cannot remain available through its saved discovery cache', async () => {
  await withFixture(async (fixture, storagePath) => {
    await new ProviderSettingsService({ storagePath }).snapshot(true)
    await fs.rm(path.join(fixture.bin, 'qwen'))
    const snapshot = await new ProviderSettingsService({ storagePath }).cachedSnapshot()
    assert.equal(snapshot.cliAgents.find(agent => agent.id === 'qwen')?.available, false)
    assert.equal(snapshot.catalog.some(group => group.provider === 'qwen'), false)
  })
})

test('concurrent refreshes share one CLI discovery process', async () => {
  await withFixture(async (fixture, storagePath) => {
    const service = new ProviderSettingsService({ storagePath })
    await service.snapshot(true)
    const started = fixture.hold()
    const first = service.listCliAgents(true)
    const second = service.listCliAgents(true)
    await started
    fixture.release('new-model')
    const [one, two] = await Promise.all([first, second])
    assert.deepEqual(one, two)
    assert.equal(fixture.probeCount(), 2, 'one initial discovery and one shared refresh at the real CLI boundary')
  })
})


test('background discovery updates the runtime default when the saved model is no longer available', async () => {
  await withFixture(async (fixture, storagePath) => {
    const service = new ProviderSettingsService({ storagePath })
    try {
      await service.hydrateRuntime()
      assert.equal(getRuntimeDefaultModelState().status, 'available')
      fixture.release('new-model')
      const snapshot = await service.snapshot(true)
      assert.equal(snapshot.defaultModelState.status, 'unavailable')
      assert.equal(getRuntimeDefaultModelState().status, 'unavailable')
    } finally {
      setRuntimeDefaultModelState({ status: 'unset' })
    }
  })
})
