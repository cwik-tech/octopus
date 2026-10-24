import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { BrowserManager } from '../../domains/browser/browser-manager.js'
import { BrowserSettingsService } from '../../services/browser-settings-service.js'

test('browser settings persist mode without starting Chrome and hydrate a new manager', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-settings-')))
  const storagePath = path.join(root, 'browser-settings.json')
  const firstManager = new BrowserManager({ profilePath: path.join(root, 'profile') })
  const firstSettings = new BrowserSettingsService(firstManager, storagePath)

  try {
    const changed = await firstSettings.setMode('headless')
    assert.equal(changed.mode, 'headless')
    assert.notEqual(changed.status, 'running')
    assert.deepEqual(JSON.parse(fs.readFileSync(storagePath, 'utf8')), {
      version: 1,
      mode: 'headless',
    })
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600)
    }

    const secondManager = new BrowserManager({ profilePath: path.join(root, 'profile') })
    const secondSettings = new BrowserSettingsService(secondManager, storagePath)
    try {
      await secondSettings.hydrateRuntime()
      assert.equal((await secondManager.status()).mode, 'headless')
      assert.equal((await secondSettings.snapshot()).mode, 'headless')
    } finally {
      await secondManager.close()
    }
  } finally {
    await firstManager.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
