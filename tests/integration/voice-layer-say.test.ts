import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { voiceSayInputSchema, type VoiceSayProgress } from '../../contracts/voice-control.js'
import { createVoiceLayerLink } from '../../server/voice-control/voice-layer-link.js'
import { startVoiceLayerFixture } from '../helpers/voice-layer-fixture.js'

function makeSpeech() {
  return voiceSayInputSchema.parse({
    source: { appId: 'octopus', name: 'Octopus' },
    subject: { type: 'dialogue', id: 'dialogue-1', label: 'Pricing' },
    speaker: { id: 'alpha', label: 'Alpha' }, utteranceId: 'dialogue-1:turn:1:0', text: 'A monthly plan works.',
  })
}

test('dialogue speech authenticates with its own grant and returns validated progress and receipt', { timeout: 5_000 }, async () => {
  const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-say-'))
  const speech = makeSpeech()
  const voice = await startVoiceLayerFixture(discoveryDir, { onSay: async (input, context) => {
    assert.equal(input.utteranceId, speech.utteranceId)
    await context.progress({ utteranceId: 'dialogue-1:turn:1:0', state: 'started', heardChars: 0, totalChars: speech.text.length })
    await context.progress({ utteranceId: 'dialogue-1:turn:1:0', state: 'progress', heardChars: 7, totalChars: speech.text.length })
    return { utteranceId: 'dialogue-1:turn:1:0', outcome: 'spoken', heardChars: speech.text.length }
  } })
  const link = createVoiceLayerLink({ discoveryDir, appId: 'octopus' })
  try {
    await link.refresh()
    const progress: VoiceSayProgress[] = []
    const result = await link.say(speech, { signal: AbortSignal.timeout(3_000), onProgress: (value) => progress.push(value) })
    assert.deepEqual(result, { kind: 'delivered', result: { utteranceId: speech.utteranceId, outcome: 'spoken', heardChars: speech.text.length } })
    assert.deepEqual(progress.map((value) => ({ state: value.state, heardChars: value.heardChars })), [{ state: 'started', heardChars: 0 }, { state: 'progress', heardChars: 7 }])
    assert.equal(voice.calls[0]?.authorization, `Bearer ${voice.token}`)
  } finally { await link.close(); await voice.close(); await fs.rm(discoveryDir, { recursive: true, force: true }) }
})

test('a receipt for another utterance is refused', { timeout: 5_000 }, async () => {
  const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-say-wrong-'))
  const voice = await startVoiceLayerFixture(discoveryDir, { onSay: async () => ({ utteranceId: 'other-turn', outcome: 'spoken', heardChars: 2 }) })
  const link = createVoiceLayerLink({ discoveryDir, appId: 'octopus' })
  try {
    await link.refresh()
    assert.deepEqual(await link.say(makeSpeech(), { signal: AbortSignal.timeout(3_000), onProgress: () => {} }), { kind: 'refused' })
  } finally { await link.close(); await voice.close(); await fs.rm(discoveryDir, { recursive: true, force: true }) }
})

test('progress from an older utterance does not refuse the current spoken receipt', { timeout: 5_000 }, async () => {
  const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-say-stale-'))
  const speech = makeSpeech()
  const voice = await startVoiceLayerFixture(discoveryDir, { onSay: async (_input, context) => {
    await context.progress({ utteranceId: 'older-utterance', state: 'progress', heardChars: 2, totalChars: speech.text.length })
    await context.progress({ utteranceId: 'dialogue-1:turn:1:0', state: 'started', heardChars: 0, totalChars: speech.text.length })
    return { utteranceId: 'dialogue-1:turn:1:0', outcome: 'spoken', heardChars: speech.text.length }
  } })
  const link = createVoiceLayerLink({ discoveryDir, appId: 'octopus' })
  try {
    await link.refresh()
    const seen: string[] = []
    assert.deepEqual(await link.say(speech, { signal: AbortSignal.timeout(3_000), onProgress: (progress) => seen.push(progress.utteranceId) }), {
      kind: 'delivered', result: { utteranceId: speech.utteranceId, outcome: 'spoken', heardChars: speech.text.length },
    })
    assert.deepEqual(seen, ['dialogue-1:turn:1:0'])
  } finally { await link.close(); await voice.close(); await fs.rm(discoveryDir, { recursive: true, force: true }) }
})

test('cancelling dialogue speech reaches the real MCP handler and abandons its receipt', { timeout: 5_000 }, async (t) => {
  const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-say-abort-'))
  let markAborted = () => {}
  const aborted = new Promise<void>((resolve) => { markAborted = resolve })
  const voice = await startVoiceLayerFixture(discoveryDir, { onSay: async (_input, { signal }) => {
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { markAborted(); resolve() }, { once: true }) })
    return { utteranceId: 'dialogue-1:turn:1:0', outcome: 'cancelled', heardChars: 0 }
  } })
  const link = createVoiceLayerLink({ discoveryDir, appId: 'octopus' })
  try {
    await link.refresh()
    const controller = new AbortController()
    const call = link.say(makeSpeech(), { signal: controller.signal, onProgress: () => {} })
    await voice.waitFor((entry) => entry.name === 'say', t.signal)
    controller.abort()
    await aborted
    assert.deepEqual(await call, { kind: 'unreachable' })
  } finally { await link.close(); await voice.close(); await fs.rm(discoveryDir, { recursive: true, force: true }) }
})

test('cancelling one dialogue speech leaves another dialogue on the same link connected', { timeout: 5_000 }, async (t) => {
  const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-say-isolation-'))
  let releaseSecond = () => {}
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
  t.after(releaseSecond)
  const voice = await startVoiceLayerFixture(discoveryDir, { onSay: async (input, { signal }) => {
    if (input.utteranceId === 'dialogue-1:turn:1:0') {
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => resolve(), { once: true }) })
      return { utteranceId: 'dialogue-1:turn:1:0', outcome: 'cancelled', heardChars: 0 }
    }
    await secondGate
    return { utteranceId: 'dialogue-2:turn:1:0', outcome: 'spoken', heardChars: input.text.length }
  } })
  const link = createVoiceLayerLink({ discoveryDir, appId: 'octopus' })
  try {
    await link.refresh()
    const controller = new AbortController()
    const first = link.say(makeSpeech(), { signal: controller.signal, onProgress: () => {} })
    await voice.waitFor((entry) => entry.name === 'say', t.signal)
    const speech = voiceSayInputSchema.parse({ ...makeSpeech(), subject: { type: 'dialogue', id: 'dialogue-2', label: 'Annual pricing' }, utteranceId: 'dialogue-2:turn:1:0' })
    const second = link.say(speech, { signal: t.signal, onProgress: () => {} })
    controller.abort()
    assert.deepEqual(await first, { kind: 'unreachable' })
    releaseSecond()
    assert.deepEqual(await second, { kind: 'delivered', result: { utteranceId: speech.utteranceId, outcome: 'spoken', heardChars: speech.text.length } })
  } finally { releaseSecond(); await link.close(); await voice.close(); await fs.rm(discoveryDir, { recursive: true, force: true }) }
})
