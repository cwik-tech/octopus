import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_DEEP_RESEARCH_DURATION_MINUTES,
  DEFAULT_MAXIMUM_RESEARCHER_AGENTS,
  parseDeepResearchSettingsFile,
} from '../../domains/deep-research/deep-research-settings.js'
import {
  DeepResearchSettingsService,
  DeepResearchSettingsServiceError,
} from '../../services/deep-research-settings-service.js'

function createStorage(): {
  readonly directory: string
  readonly controlDirectory: string
  readonly storagePath: string
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-settings-'))
  const controlDirectory = path.join(directory, 'deep-research')
  return {
    directory,
    controlDirectory,
    storagePath: path.join(controlDirectory, 'settings.json'),
  }
}

function assertServiceError(
  error: unknown,
  code: DeepResearchSettingsServiceError['code'],
): boolean {
  assert.ok(error instanceof DeepResearchSettingsServiceError)
  assert.equal(error.code, code)
  return true
}

test('Deep Research settings schema enforces version, exact fields, and both ranges', () => {
  assert.deepEqual(
    parseDeepResearchSettingsFile({
      schemaVersion: 3,
      maxDurationMinutes: 20,
      maxResearcherAgents: 8,
    }),
    {
      schemaVersion: 3,
      maxDurationMinutes: 20,
      maxResearcherAgents: 8,
    },
  )

  for (const invalid of [
    null,
    [],
    { schemaVersion: 4, maxDurationMinutes: 20, maxResearcherAgents: 8 },
    { schemaVersion: 3, maxDurationMinutes: 4, maxResearcherAgents: 8 },
    { schemaVersion: 3, maxDurationMinutes: 121, maxResearcherAgents: 8 },
    { schemaVersion: 3, maxDurationMinutes: 20.5, maxResearcherAgents: 8 },
    { schemaVersion: 3, maxDurationMinutes: 20, maxResearcherAgents: 0 },
    { schemaVersion: 3, maxDurationMinutes: 20, maxResearcherAgents: 9 },
    { schemaVersion: 3, maxDurationMinutes: 20, maxResearcherAgents: 2.5 },
    {
      schemaVersion: 3,
      maxDurationMinutes: 20,
      maxResearcherAgents: 8,
      unknown: true,
    },
  ]) {
    assert.throws(() => parseDeepResearchSettingsFile(invalid))
  }
})

test('Deep Research settings schema migrates v1 and disconnected v2 files to limits only', () => {
  for (const legacy of [
    { schemaVersion: 1, maxDurationMinutes: 20, maxResearcherAgents: 8 },
    {
      schemaVersion: 2,
      maxDurationMinutes: 20,
      maxResearcherAgents: 8,
      browserMode: 'headless',
    },
  ]) {
    assert.deepEqual(parseDeepResearchSettingsFile(legacy), {
      schemaVersion: 3,
      maxDurationMinutes: 20,
      maxResearcherAgents: 8,
    })
  }

  for (const invalid of [
    { schemaVersion: 1, maxDurationMinutes: 4, maxResearcherAgents: 8 },
    { schemaVersion: 1, maxDurationMinutes: 20, maxResearcherAgents: 9 },
    { schemaVersion: 1, maxDurationMinutes: 20, maxResearcherAgents: 8, unknown: true },
    { schemaVersion: 2, maxDurationMinutes: 20, maxResearcherAgents: 8 },
    { schemaVersion: 2, maxDurationMinutes: 20, maxResearcherAgents: 8, browserMode: 'visible' },
  ]) {
    assert.throws(() => parseDeepResearchSettingsFile(invalid))
  }
})

test('defaults save atomically with private permissions and survive service restart', async () => {
  const storage = createStorage()
  try {
    const service = new DeepResearchSettingsService({
      storagePath: storage.storagePath,
    })
    assert.deepEqual(await service.snapshot(), {
      schemaVersion: 3,
      maxDurationMinutes: DEFAULT_DEEP_RESEARCH_DURATION_MINUTES,
      maxResearcherAgents: DEFAULT_MAXIMUM_RESEARCHER_AGENTS,
      constraints: {
        maxDurationMinutes: { minimum: 5, maximum: 120 },
        maxResearcherAgents: { minimum: 1, maximum: 8 },
      },
      source: 'default',
      editable: true,
    })
    assert.equal(fs.existsSync(storage.storagePath), false)

    const saved = await service.update({
      maxDurationMinutes: 45,
      maxResearcherAgents: 4,
    })
    assert.equal(saved.source, 'persisted')
    assert.deepEqual(JSON.parse(fs.readFileSync(storage.storagePath, 'utf8')), {
      schemaVersion: 3,
      maxDurationMinutes: 45,
      maxResearcherAgents: 4,
    })
    assert.equal(fs.statSync(storage.controlDirectory).mode & 0o777, 0o700)
    assert.equal(fs.statSync(storage.storagePath).mode & 0o777, 0o600)
    assert.deepEqual(
      fs.readdirSync(storage.controlDirectory).filter((entry) => entry.endsWith('.tmp')),
      [],
    )

    const firstInode = fs.statSync(storage.storagePath).ino
    assert.deepEqual(await service.update({
      maxDurationMinutes: 45,
      maxResearcherAgents: 4,
    }), saved)
    assert.equal(fs.statSync(storage.storagePath).ino, firstInode)

    const restarted = new DeepResearchSettingsService({
      storagePath: storage.storagePath,
    })
    assert.deepEqual(await restarted.snapshot(), saved)
  } finally {
    fs.rmSync(storage.directory, { recursive: true, force: true })
  }
})

test('invalid requests and invalid persisted settings fail closed', async () => {
  const storage = createStorage()
  try {
    const service = new DeepResearchSettingsService({
      storagePath: storage.storagePath,
    })
    await assert.rejects(
      service.update({ maxDurationMinutes: 4, maxResearcherAgents: 8 }),
      (error: unknown) => assertServiceError(error, 'invalid_request'),
    )

    fs.mkdirSync(storage.controlDirectory, { recursive: true })
    fs.writeFileSync(storage.storagePath, JSON.stringify({
      schemaVersion: 3,
      maxDurationMinutes: 20,
      maxResearcherAgents: 9,
    }))
    const restarted = new DeepResearchSettingsService({
      storagePath: storage.storagePath,
    })
    await assert.rejects(
      restarted.snapshot(),
      (error: unknown) => assertServiceError(error, 'configuration_invalid'),
    )
  } finally {
    fs.rmSync(storage.directory, { recursive: true, force: true })
  }
})

test('failed persistence keeps the prior effective value and concurrent writes serialize', async () => {
  const storage = createStorage()
  try {
    const service = new DeepResearchSettingsService({
      storagePath: storage.storagePath,
    })
    const [first, second] = await Promise.all([
      service.update({ maxDurationMinutes: 30, maxResearcherAgents: 3 }),
      service.update({ maxDurationMinutes: 60, maxResearcherAgents: 6 }),
    ])
    assert.equal(first.maxDurationMinutes, 30)
    assert.equal(second.maxDurationMinutes, 60)
    assert.equal((await service.snapshot()).maxResearcherAgents, 6)

    const movedControlDirectory = `${storage.controlDirectory}-moved`
    fs.renameSync(storage.controlDirectory, movedControlDirectory)
    fs.writeFileSync(storage.controlDirectory, 'blocks-directory-recreation')

    await assert.rejects(
      service.update({ maxDurationMinutes: 90, maxResearcherAgents: 7 }),
      (error: unknown) => assertServiceError(error, 'settings_persistence_failed'),
    )
    assert.equal((await service.snapshot()).maxDurationMinutes, 60)
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(path.join(movedControlDirectory, 'settings.json'), 'utf8'),
      ),
      {
        schemaVersion: 3,
        maxDurationMinutes: 60,
        maxResearcherAgents: 6,
      },
    )
  } finally {
    fs.rmSync(storage.directory, { recursive: true, force: true })
  }
})
