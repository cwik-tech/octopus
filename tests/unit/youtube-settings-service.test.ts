import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import { YoutubeSettingsService } from '../../services/youtube-settings-service.js'

const secretCodec = {
  encrypt: (value: string) => Buffer.from(`sealed:${value}`).toString('base64'),
  decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8').slice('sealed:'.length),
}

test('downloaded videos are retained by default and deletion can be persisted independently', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-video-retention-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const storagePath = path.join(directory, 'youtube-settings.json')
  const defaults = new YoutubeSettingsService({ environment: {} })

  assert.equal((await defaults.snapshot()).deleteVideosAfterInfoExtraction, false)

  const service = new YoutubeSettingsService({
    storagePath,
    secretCodec,
    environment: { GEMINI_API_KEY: 'environment-key' },
  })
  const saved = await service.update({
    proxyEnabled: false,
    credentialMode: 'username-password',
    proxyHost: 'p.webshare.io',
    proxyPort: 80,
    countries: ['us'],
    username: '',
    deleteVideosAfterInfoExtraction: true,
  })

  assert.equal(saved.deleteVideosAfterInfoExtraction, true)
  assert.equal((await new YoutubeSettingsService({
    storagePath,
    secretCodec,
    environment: {},
  }).snapshot()).deleteVideosAfterInfoExtraction, true)
})

test('YouTube settings persist encrypted secrets and return only redacted snapshots', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-settings-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const storagePath = path.join(directory, 'youtube-settings.json')
  const service = new YoutubeSettingsService({
    storagePath,
    secretCodec,
    environment: {},
  })

  const snapshot = await service.update({
    proxyEnabled: true,
    credentialMode: 'username-password',
    proxyHost: 'p.webshare.io',
    proxyPort: 80,
    countries: ['US', 'gb', 'us'],
    username: 'workspace-user',
    password: 'private-password',
  })
  assert.equal(snapshot.passwordConfigured, true)
  assert.equal('password' in snapshot, false)
  assert.deepEqual(snapshot.countries, ['us', 'gb'])

  const persisted = await fs.readFile(storagePath, 'utf8')
  assert.equal(persisted.includes('private-password'), false)
  assert.match(persisted, /encryptedPassword/)

  const reloaded = new YoutubeSettingsService({
    storagePath,
    secretCodec,
    environment: {},
  })
  assert.equal((await reloaded.runtimeProxy()).password, 'private-password')
})

test('Gemini settings persist an encrypted API key and expose it only to the parent runtime', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-gemini-settings-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const storagePath = path.join(directory, 'youtube-settings.json')
  const service = new YoutubeSettingsService({
    storagePath,
    secretCodec,
    environment: {},
  })

  const snapshot = await service.update({
    proxyEnabled: false,
    credentialMode: 'username-password',
    proxyHost: 'p.webshare.io',
    proxyPort: 80,
    countries: ['us'],
    username: '',
    geminiApiKey: 'private-gemini-key',
    geminiModel: 'gemini-3.6-pro',
    geminiDailyVideoMinutesLimit: 120,
    geminiConfirmationThresholdMinutes: 30,
  })

  assert.equal(snapshot.settingsSchemaVersion, 2)
  assert.equal(snapshot.geminiApiKeyConfigured, true)
  assert.equal(snapshot.geminiSource, 'persisted')
  assert.equal(snapshot.geminiModel, 'gemini-3.6-pro')
  assert.equal(snapshot.geminiBudgetWindow, 'rolling_24_hours')
  assert.equal('geminiApiKey' in snapshot, false)

  const persisted = await fs.readFile(storagePath, 'utf8')
  assert.equal(persisted.includes('private-gemini-key'), false)
  assert.match(persisted, /encryptedGeminiApiKey/)
  assert.equal(JSON.parse(persisted).settingsSchemaVersion, 2)

  const reloaded = new YoutubeSettingsService({
    storagePath,
    secretCodec,
    environment: {},
  })
  assert.deepEqual(await reloaded.runtimeGemini(), {
    apiKey: 'private-gemini-key',
    model: 'gemini-3.6-pro',
    source: 'persisted',
  })
})

test('a previously saved incompatible Gemini specialization resets to the default model', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-gemini-old-model-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const storagePath = path.join(directory, 'youtube-settings.json')
  await fs.writeFile(storagePath, JSON.stringify({
    settingsSchemaVersion: 2,
    proxyEnabled: false,
    credentialMode: 'username-password',
    proxyHost: 'p.webshare.io',
    proxyPort: 80,
    countries: ['us'],
    username: '',
    geminiModel: 'gemini-3.1-flash-lite-preview',
    geminiDailyVideoMinutesLimit: 120,
    geminiConfirmationThresholdMinutes: 30,
  }))

  const snapshot = await new YoutubeSettingsService({
    storagePath,
    secretCodec,
    environment: {},
  }).snapshot()

  assert.equal(snapshot.geminiModel, 'gemini-3.6-flash')
  assert.equal(snapshot.source, 'persisted')
  assert.equal(snapshot.error, undefined)
})

test('Gemini settings reject a model specialization that cannot analyze YouTube video', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-gemini-invalid-model-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const service = new YoutubeSettingsService({
    storagePath: path.join(directory, 'youtube-settings.json'),
    secretCodec,
    environment: {},
  })

  await assert.rejects(
    service.update({
      proxyEnabled: false,
      credentialMode: 'username-password',
      proxyHost: 'p.webshare.io',
      proxyPort: 80,
      countries: ['us'],
      username: '',
      geminiModel: 'gemini-3.7-flash-image',
    }),
    /not compatible with YouTube video analysis/,
  )
})

test('a saved Gemini key is removed only by an explicit clear update', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-gemini-clear-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const storagePath = path.join(directory, 'youtube-settings.json')
  const service = new YoutubeSettingsService({ storagePath, secretCodec, environment: {} })
  const base = { proxyEnabled: false, credentialMode: 'username-password' as const,
    proxyHost: 'p.webshare.io', proxyPort: 80, countries: ['us'], username: '' }
  await service.update({ ...base, geminiApiKey: 'saved-key' })
  await service.update(base)
  assert.equal((await service.runtimeGemini()).apiKey, 'saved-key')

  const cleared = await service.update({ ...base, clearGeminiApiKey: true })
  assert.equal(cleared.geminiApiKeyConfigured, false)
  assert.equal((await service.runtimeGemini()).apiKey, undefined)
  assert.equal('encryptedGeminiApiKey' in JSON.parse(await fs.readFile(storagePath, 'utf8')), false)
})

test('GEMINI_API_KEY overrides only Gemini while Webshare remains independently persisted', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-gemini-env-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const storagePath = path.join(directory, 'youtube-settings.json')
  const persisted = new YoutubeSettingsService({
    storagePath,
    secretCodec,
    environment: {},
  })
  await persisted.update({
    proxyEnabled: false,
    credentialMode: 'username-password',
    proxyHost: 'proxy.example.test',
    proxyPort: 8080,
    countries: ['ca'],
    username: '',
  })

  const service = new YoutubeSettingsService({
    storagePath,
    secretCodec,
    environment: { GEMINI_API_KEY: 'environment-gemini-key' },
  })
  const snapshot = await service.snapshot()

  assert.equal(snapshot.source, 'persisted')
  assert.equal(snapshot.proxyHost, 'proxy.example.test')
  assert.equal(snapshot.geminiSource, 'environment')
  assert.equal(snapshot.geminiApiKeyConfigured, true)
  assert.equal((await service.runtimeGemini()).apiKey, 'environment-gemini-key')
})

test('environment Gemini configuration rejects persisted Gemini changes while allowing Webshare updates', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-gemini-env-readonly-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const storagePath = path.join(directory, 'youtube-settings.json')
  const service = new YoutubeSettingsService({
    storagePath,
    secretCodec,
    environment: { GEMINI_API_KEY: 'environment-gemini-key' },
  })
  const proxyUpdate = {
    proxyEnabled: false,
    credentialMode: 'username-password' as const,
    proxyHost: 'proxy.example.test',
    proxyPort: 8080,
    countries: ['ca'],
    username: '',
  }

  await assert.rejects(service.update({
    ...proxyUpdate,
    geminiApiKey: 'stale-persisted-key',
  }), /read-only.*GEMINI_API_KEY/i)
  for (const update of [
    { clearGeminiApiKey: true },
    { geminiModel: 'gemini-3.6-pro' },
    { geminiDailyVideoMinutesLimit: 240 },
    { geminiConfirmationThresholdMinutes: 60 },
  ]) {
    await assert.rejects(service.update({ ...proxyUpdate, ...update }), /read-only.*GEMINI_API_KEY/i)
  }
  await service.update(proxyUpdate)

  const persisted = JSON.parse(await fs.readFile(storagePath, 'utf8'))
  assert.equal(persisted.proxyHost, 'proxy.example.test')
  assert.equal('encryptedGeminiApiKey' in persisted, false)
})

test('an environment Gemini key uses the persisted model selection', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-gemini-env-model-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const storagePath = path.join(directory, 'youtube-settings.json')
  const persisted = new YoutubeSettingsService({ storagePath, secretCodec, environment: {} })
  await persisted.update({
    proxyEnabled: false,
    credentialMode: 'username-password',
    proxyHost: 'p.webshare.io',
    proxyPort: 80,
    countries: ['us'],
    username: '',
    geminiApiKey: 'old-persisted-key',
    geminiModel: 'gemini-3.6-pro',
  })

  const environmentOwned = new YoutubeSettingsService({
    storagePath,
    secretCodec,
    environment: { GEMINI_API_KEY: 'environment-key' },
  })

  assert.deepEqual(await environmentOwned.runtimeGemini(), {
    apiKey: 'environment-key',
    model: 'gemini-3.6-pro',
    source: 'environment',
  })
  assert.equal((await environmentOwned.snapshot()).geminiModel, 'gemini-3.6-pro')
})

test('snapshot exposes the verification date for pinned Gemini pricing', async () => {
  const snapshot = await new YoutubeSettingsService({ environment: {} }).snapshot()
  assert.equal(snapshot.geminiPricingVerifiedAt, '2026-08-12T00:00:00.000Z')
})

test('Gemini validation authenticates the configured model once and reports safe status', async () => {
  const calls: Array<{ apiKey?: string; model: string }> = []
  const service = new YoutubeSettingsService({
    environment: { GEMINI_API_KEY: 'invalid-environment-key' },
    validateGemini: async (config) => {
      calls.push(config)
      throw new Error('provider payload containing sensitive diagnostics')
    },
  })

  const snapshot = await service.validateGemini()

  assert.deepEqual(calls, [{
    apiKey: 'invalid-environment-key',
    model: 'gemini-3.6-flash',
    source: 'environment',
  }])
  assert.equal(snapshot.geminiStatus, 'error')
  assert.equal(snapshot.geminiError, 'Gemini API key validation failed.')
  assert.equal(snapshot.geminiError?.includes('sensitive diagnostics'), false)
})

test('Webshare environment variables override persisted settings without exposing secrets', async () => {
  const service = new YoutubeSettingsService({
    environment: {
      WEBSHARE_API_KEY: 'environment-token',
      WEBSHARE_PROXY_COUNTRIES: 'ca,us',
    },
  })
  const snapshot = await service.snapshot()
  assert.equal(snapshot.source, 'environment')
  assert.equal(snapshot.credentialMode, 'api-token')
  assert.equal(snapshot.apiTokenConfigured, true)
  assert.equal('apiToken' in snapshot, false)
  assert.deepEqual(snapshot.countries, ['ca', 'us'])
})

test('credential mode changes preserve the inactive saved credential until explicitly cleared', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-settings-modes-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const service = new YoutubeSettingsService({
    storagePath: path.join(directory, 'youtube-settings.json'),
    secretCodec,
    environment: {},
  })
  await service.update({
    proxyEnabled: true,
    credentialMode: 'username-password',
    proxyHost: 'p.webshare.io',
    proxyPort: 80,
    countries: ['us'],
    username: 'workspace-user',
    password: 'private-password',
  })
  await service.update({
    proxyEnabled: true,
    credentialMode: 'api-token',
    proxyHost: 'p.webshare.io',
    proxyPort: 80,
    countries: ['us'],
    username: 'workspace-user',
    apiToken: 'private-token',
  })
  assert.equal((await service.runtimeProxy()).password, 'private-password')
  await service.update({
    proxyEnabled: true,
    credentialMode: 'username-password',
    proxyHost: 'p.webshare.io',
    proxyPort: 80,
    countries: ['us'],
    username: 'workspace-user',
  })
  assert.equal((await service.runtimeProxy()).apiToken, 'private-token')
  assert.equal((await service.runtimeProxy()).password, 'private-password')

  await service.update({
    proxyEnabled: true,
    credentialMode: 'username-password',
    proxyHost: 'p.webshare.io',
    proxyPort: 80,
    countries: ['us'],
    username: 'workspace-user',
    clearApiToken: true,
  })
  assert.equal((await service.runtimeProxy()).apiToken, undefined)
})

test('invalid persisted settings are quarantined and can be replaced through update', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-settings-corrupt-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const storagePath = path.join(directory, 'youtube-settings.json')
  await fs.writeFile(storagePath, '{broken')
  const service = new YoutubeSettingsService({ storagePath, secretCodec, environment: {} })

  const recovered = await service.snapshot()
  assert.equal(recovered.source, 'default')
  assert.equal(recovered.proxyStatus, 'error')
  assert.match(recovered.error ?? '', /quarantined and reset/i)
  assert.equal((await fs.readdir(directory)).some((name) => name.startsWith('youtube-settings.corrupt-')), true)

  const saved = await service.update({
    proxyEnabled: false,
    credentialMode: 'username-password',
    proxyHost: 'p.webshare.io',
    proxyPort: 80,
    countries: ['us'],
    username: '',
  })
  assert.equal(saved.source, 'persisted')
  assert.equal(saved.proxyStatus, 'unverified')
  assert.equal(JSON.parse(await fs.readFile(storagePath, 'utf8')).settingsSchemaVersion, 2)
})

test('partially written current settings are quarantined instead of being partially loaded', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-settings-partial-v2-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const storagePath = path.join(directory, 'youtube-settings.json')
  await fs.writeFile(storagePath, JSON.stringify({
    settingsSchemaVersion: 2,
    proxyEnabled: true,
    credentialMode: 'api-token',
    proxyHost: 'legacy.example.test',
  }))

  const snapshot = await new YoutubeSettingsService({
    storagePath,
    secretCodec,
    environment: {},
  }).snapshot()

  assert.equal(snapshot.source, 'default')
  assert.match(snapshot.error ?? '', /quarantined and reset/i)
  assert.equal((await fs.readdir(directory)).some((name) => name.includes('.corrupt-')), true)
})

test('an undecryptable saved Gemini key quarantines the settings file', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-settings-bad-secret-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const storagePath = path.join(directory, 'youtube-settings.json')
  await fs.writeFile(storagePath, JSON.stringify({
    settingsSchemaVersion: 2,
    proxyEnabled: false,
    credentialMode: 'username-password',
    proxyHost: 'p.webshare.io',
    proxyPort: 80,
    countries: ['us'],
    username: '',
    geminiDailyVideoMinutesLimit: 120,
    geminiConfirmationThresholdMinutes: 30,
    encryptedGeminiApiKey: 'corrupt-ciphertext',
  }))
  const service = new YoutubeSettingsService({
    storagePath,
    environment: {},
    secretCodec: {
      encrypt: secretCodec.encrypt,
      decrypt: () => { throw new Error('ciphertext authentication failed') },
    },
  })

  const snapshot = await service.snapshot()

  assert.equal(snapshot.source, 'default')
  assert.match(snapshot.error ?? '', /quarantined and reset/i)
  assert.equal((await fs.readdir(directory)).some((name) => name.includes('.corrupt-')), true)
})

test('persist does not chmod a pre-existing parent directory', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-settings-mode-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  if (process.platform === 'win32') return
  await fs.chmod(directory, 0o755)
  const service = new YoutubeSettingsService({
    storagePath: path.join(directory, 'youtube-settings.json'),
    secretCodec,
    environment: {},
  })
  await service.update({
    proxyEnabled: false,
    credentialMode: 'username-password',
    proxyHost: 'p.webshare.io',
    proxyPort: 80,
    countries: ['us'],
    username: '',
  })
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o755)
})

test('malformed environment port is returned as a field error instead of throwing', async () => {
  const service = new YoutubeSettingsService({
    environment: { WEBSHARE_PROXY_PORT: 'invalid' },
  })
  const snapshot = await service.snapshot()
  assert.equal(snapshot.source, 'environment')
  assert.equal(snapshot.proxyStatus, 'error')
  assert.equal(snapshot.proxyPort, 80)
  assert.match(snapshot.error ?? '', /WEBSHARE_PROXY_PORT/)
})

test('validation is serialized with settings updates and has a bounded deadline', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-settings-validation-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  let releaseValidation!: () => void
  let validationStarted!: () => void
  const started = new Promise<void>((resolve) => { validationStarted = resolve })
  const gate = new Promise<void>((resolve) => { releaseValidation = resolve })
  const service = new YoutubeSettingsService({
    storagePath: path.join(directory, 'youtube-settings.json'),
    secretCodec,
    environment: {},
    validateProxy: async () => {
      validationStarted()
      await gate
    },
  })
  const initial = {
    proxyEnabled: true,
    credentialMode: 'api-token' as const,
    proxyHost: 'p.webshare.io',
    proxyPort: 80,
    countries: ['us'],
    username: '',
    apiToken: 'first-token',
  }
  await service.update(initial)
  const validating = service.validate()
  await started
  const updating = service.update({ ...initial, countries: ['gb'] })
  releaseValidation()
  await validating
  await updating
  const final = await service.snapshot()
  assert.deepEqual(final.countries, ['gb'])
  assert.equal(final.proxyStatus, 'unverified')

  const timeoutService = new YoutubeSettingsService({
    environment: { WEBSHARE_API_KEY: 'token' },
    validationTimeoutMs: 20,
    validateProxy: async (_config, signal) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  })
  const timedOut = await timeoutService.validate()
  assert.equal(timedOut.proxyStatus, 'error')
})
