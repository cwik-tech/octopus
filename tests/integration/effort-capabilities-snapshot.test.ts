/**
 * The path the editor's effort menu actually reads.
 *
 * The menu is only as good as what reaches it. Two pairs proved that: an Agent
 * on `claude`/`opus` and one on `openai`/`gpt-5.6-sol` both showed nothing but
 * the two defaults, because the catalogue carries CLI groups and configured
 * connections and neither of those describes a native API provider or a Claude
 * Code alias's effort range.
 *
 * So this asserts the snapshot a real `ProviderSettingsService` produces,
 * rather than a fixture that hands the component the answer.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { ProviderSettingsService } from '../../services/provider-settings-service.js'

/**
 * A settings file with one connected connection, written rather than created.
 *
 * Creating one through the service would validate it, and validation means a
 * request to the endpoint. These tests are about what the snapshot says, so
 * the stored state is seeded directly and no vendor is contacted.
 */
function seedConnection(
  directory: string,
  connection: {
    readonly id: string
    readonly baseUrl: string
    readonly models: readonly Record<string, unknown>[]
  },
): void {
  fs.writeFileSync(
    path.join(directory, 'provider-settings.json'),
    JSON.stringify({
      version: 3,
      connections: [
        {
          id: connection.id,
          kind: 'openai-compatible',
          name: 'Seeded connection',
          baseUrl: connection.baseUrl,
          enabled: true,
          status: 'connected',
          models: connection.models,
        },
      ],
      cliEnabled: {},
      cliModelEnabled: {},
    }),
  )
}

function service(directory: string): ProviderSettingsService {
  return new ProviderSettingsService({
    storagePath: path.join(directory, 'provider-settings.json'),
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
  })
}

function levelsFor(
  capabilities: readonly { provider: string; model: string; levels: string[] }[],
  provider: string,
  model: string,
): string[] | undefined {
  return capabilities.find(
    (entry) => entry.provider === provider && entry.model === model,
  )?.levels
}

test('the snapshot carries an effort range for a Claude Code alias', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-capabilities-'))
  try {
    const snapshot = await service(directory).snapshot()
    assert.deepEqual(levelsFor(snapshot.effortCapabilities, 'claude', 'opus'), [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the snapshot carries an effort range for a native OpenAI model', async () => {
  // This provider has no catalogue group at all — it is neither a local CLI nor
  // a configured connection — so a capability carried only inside the catalogue
  // could never reach an Agent that names it.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-capabilities-'))
  try {
    const snapshot = await service(directory).snapshot()
    assert.deepEqual(levelsFor(snapshot.effortCapabilities, 'openai', 'gpt-5.6-sol'), [
      'off',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the snapshot claims nothing for a pair nobody has described', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-capabilities-'))
  try {
    const snapshot = await service(directory).snapshot()
    assert.equal(levelsFor(snapshot.effortCapabilities, 'claude', 'haiku'), undefined)
    assert.equal(
      levelsFor(snapshot.effortCapabilities, 'openai', 'gpt-made-up'),
      undefined,
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a connection to the vendor\'s own endpoint gets that vendor\'s documented range', async () => {
  // The native `/models` listing carries no reasoning block, so this model
  // publishes nothing. The endpoint is OpenAI's own, and the model is one
  // OpenAI documents, so the menu has an answer that does not depend on the
  // provider being spelled `openai` in the persona.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-capabilities-'))
  try {
    seedConnection(directory, {
      id: 'openai-review',
      baseUrl: 'https://api.openai.com/v1',
      models: [
        { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', enabled: true, capabilities: ['chat'] },
      ],
    })
    const snapshot = await service(directory).snapshot()
    assert.deepEqual(
      levelsFor(snapshot.effortCapabilities, 'connection:openai-review', 'gpt-5.6-sol'),
      ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('an OpenAI-compatible server that is not the vendor gets nothing', async () => {
  // The same model name behind somebody else's endpoint is somebody else's
  // model. Lending OpenAI's documented range to it would be a claim about a
  // server nobody has described.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-capabilities-'))
  try {
    seedConnection(directory, {
      id: 'lookalike',
      baseUrl: 'https://models.example.invalid/v1',
      models: [
        { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', enabled: true, capabilities: ['chat'] },
      ],
    })
    const snapshot = await service(directory).snapshot()
    assert.equal(
      levelsFor(snapshot.effortCapabilities, 'connection:lookalike', 'gpt-5.6-sol'),
      undefined,
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('what a connection publishes about itself still wins', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-capabilities-'))
  try {
    seedConnection(directory, {
      id: 'openai-review',
      baseUrl: 'https://api.openai.com/v1',
      models: [
        {
          id: 'gpt-5.6-sol',
          name: 'GPT-5.6 Sol',
          enabled: true,
          capabilities: ['chat'],
          supportedEfforts: ['low', 'high'],
        },
      ],
    })
    const snapshot = await service(directory).snapshot()
    assert.deepEqual(
      levelsFor(snapshot.effortCapabilities, 'connection:openai-review', 'gpt-5.6-sol'),
      ['low', 'high'],
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the snapshot carries the native aliases the editor matches exactly', async () => {
  // The editor looks this list up by the exact id a persona names, so an alias
  // the documentation recognises has to be in the list under that spelling.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-capabilities-'))
  try {
    const snapshot = await service(directory).snapshot()
    assert.deepEqual(levelsFor(snapshot.effortCapabilities, 'openai', 'gpt-5.6'), [
      'off',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
