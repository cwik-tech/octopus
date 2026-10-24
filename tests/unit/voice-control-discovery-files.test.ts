import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  appDescriptorPath,
  defaultVoiceControlDir,
  readVoiceLayerEndpoint,
  removeAppDescriptor,
  writeAppDescriptor,
} from '../../domains/voice-control/discovery-files.js'
import type { VoiceControlDescriptor } from '../../contracts/voice-control.js'

function makeDescriptor(pid: number): VoiceControlDescriptor {
  return {
    contract: 'voice-control/1',
    appId: 'octopus',
    name: 'Octopus',
    role: 'app',
    pid,
    mcp: {
      type: 'http',
      url: 'http://127.0.0.1:53211/_pipeline-mcp',
      headers: { Authorization: 'Bearer token' },
    },
    updatedAt: '2026-10-09T10:00:00.000Z',
  }
}

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voice-discovery-'))
}

test('shutdown leaves a descriptor that a later copy of the app wrote', async () => {
  const dir = makeDir()
  try {
    // Arrange: the first copy wrote its descriptor, then a second copy replaced it.
    await writeAppDescriptor(dir, makeDescriptor(1001))
    await writeAppDescriptor(dir, makeDescriptor(1002))

    // Act: the first copy shuts down.
    await removeAppDescriptor(dir, 'octopus', 1001)

    // Assert: the second copy is still advertised.
    const current = JSON.parse(fs.readFileSync(appDescriptorPath(dir, 'octopus'), 'utf8')) as { pid: number }
    assert.equal(current.pid, 1002)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('shutdown removes the descriptor this process wrote', async () => {
  const dir = makeDir()
  try {
    await writeAppDescriptor(dir, makeDescriptor(1001))
    await removeAppDescriptor(dir, 'octopus', 1001)
    assert.equal(fs.existsSync(appDescriptorPath(dir, 'octopus')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('writing a descriptor tightens an existing apps folder to owner-only access', async () => {
  const dir = makeDir()
  try {
    fs.mkdirSync(path.join(dir, 'apps'), { mode: 0o755 })
    fs.chmodSync(path.join(dir, 'apps'), 0o755)
    await writeAppDescriptor(dir, makeDescriptor(1001))
    assert.equal(fs.statSync(path.join(dir, 'apps')).mode & 0o777, 0o700)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the discovery folder can be moved with OCTOPUS_VOICE_CONTROL_DIR', () => {
  assert.equal(
    defaultVoiceControlDir({ OCTOPUS_VOICE_CONTROL_DIR: '/tmp/voice-test' }, 'darwin'),
    '/tmp/voice-test',
  )
  assert.equal(
    defaultVoiceControlDir({}, 'darwin'),
    path.join(os.homedir(), 'Library', 'Application Support', 'voice-control'),
  )
})

function writeVoiceFiles(dir: string, input: { url?: string; pid?: number; grant?: boolean } = {}): void {
  fs.mkdirSync(path.join(dir, 'voice'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'voice.json'), JSON.stringify({
    contract: 'voice-control/1',
    appId: 'hexa-puffs',
    name: 'Hexa Puffs',
    role: 'voice',
    pid: input.pid ?? process.pid,
    mcp: { type: 'http', url: input.url ?? 'http://127.0.0.1:4100/mcp' },
    updatedAt: '2026-10-09T10:00:00.000Z',
  }))
  if (input.grant !== false) {
    fs.writeFileSync(path.join(dir, 'voice', 'octopus.json'), JSON.stringify({
      contract: 'voice-control/1',
      appId: 'octopus',
      headers: { Authorization: 'Bearer granted' },
    }))
  }
}

test('the voice layer is reached at its loopback URL with the grant it issued', async () => {
  const dir = makeDir()
  try {
    writeVoiceFiles(dir)
    assert.deepEqual(await readVoiceLayerEndpoint(dir, 'octopus'), {
      url: 'http://127.0.0.1:4100/mcp',
      headers: { Authorization: 'Bearer granted' },
      pid: process.pid,
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('without a grant for this app the voice layer is not reached', async () => {
  const dir = makeDir()
  try {
    writeVoiceFiles(dir, { grant: false })
    assert.equal(await readVoiceLayerEndpoint(dir, 'octopus'), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a voice descriptor that points off loopback is ignored', async () => {
  const dir = makeDir()
  try {
    writeVoiceFiles(dir, { url: 'http://10.0.0.4:4100/mcp' })
    assert.equal(await readVoiceLayerEndpoint(dir, 'octopus'), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a voice descriptor left by a process that has ended is ignored', async () => {
  const dir = makeDir()
  try {
    writeVoiceFiles(dir, { pid: 2_147_483_647 })
    assert.equal(await readVoiceLayerEndpoint(dir, 'octopus'), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
