import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { createDialogueFixture, DIALOGUE_ALPHA, DIALOGUE_BETA, waitForDialogueEvent } from '../helpers/agent-dialogue-fixture.js'
import { startVoiceLayerFixture } from '../helpers/voice-layer-fixture.js'
import { agentDialogueRecordSchema } from '../../contracts/agent-dialogue.js'
import type { AgentDialogueClock } from '../../services/agent-dialogue-service.js'
import { FileSystemDialogueStore } from '../../services/agent-dialogue-store.js'

function makeGate() {
  let resolve = () => {}
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

function makeClock(): AgentDialogueClock & { advance(milliseconds: number): void } {
  let time = 0
  const scheduled = new Map<() => void, number>()
  return {
    now: () => time,
    schedule: (callback, milliseconds) => { scheduled.set(callback, time + milliseconds); return () => { scheduled.delete(callback) } },
    advance: (milliseconds) => {
      time += milliseconds
      for (const [callback, deadline] of scheduled) {
        if (deadline > time) continue
        scheduled.delete(callback)
        callback()
      }
    },
  }
}

test('spoken replies appear at playback start, save after the receipt and prepare one next reply while speech plays', { timeout: 25_000 }, async (t) => {
  const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogue-speech-'))
  const firstReceived = makeGate()
  const startPlayback = makeGate()
  const finishPlayback = makeGate()
  const reserveRequested = makeGate()
  let closeDialogueServer = async () => {}
  t.after(() => { startPlayback.resolve(); finishPlayback.resolve() })
  // Physical speech is nondeterministic and unavailable in this integration
  // suite. Its authenticated MCP boundary is real; playback receipts are held.
  const voice = await startVoiceLayerFixture(discoveryDir, { onSay: async (input, context) => {
    assert.ok(input.utteranceId)
    assert.equal(input.subject?.type, 'dialogue')
    if (input.speaker?.id === 'alpha-analyst') {
      firstReceived.resolve()
      await startPlayback.promise
      await context.progress({ utteranceId: input.utteranceId, state: 'started', heardChars: 0, totalChars: input.text.length })
      await finishPlayback.promise
    } else {
      await context.progress({ utteranceId: input.utteranceId, state: 'started', heardChars: 0, totalChars: input.text.length })
    }
    return { utteranceId: input.utteranceId, outcome: 'spoken', heardChars: input.text.length }
  } })
  t.after(async () => { await closeDialogueServer(); await voice.close(); await fs.rm(discoveryDir, { recursive: true, force: true }) })
  const firstText = 'A pricing pilot will give us evidence.'
  const secondText = 'We should include people who declined to buy.'
  const fixture = await createDialogueFixture(t, [
    { match: (request) => !request.stream && request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: firstText },
    { match: (request) => { if (request.stream || !request.systemPrompt?.includes(DIALOGUE_BETA)) return false; reserveRequested.resolve(); return true }, content: secondText },
  ], undefined, { voiceControl: { mcpToken: 'dialogue-voice-fixture-token', discoveryDir, attentionIntervalMs: 60_000 } })
  closeDialogueServer = () => fixture.server.close()

  const record = await fixture.start({ delivery: 'voice', maxTurns: 2 })
  await firstReceived.promise
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.role), ['user'])
  assert.equal(fixture.provider.requests.filter((request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) || request.systemPrompt?.includes(DIALOGUE_BETA)).length, 1)
  startPlayback.resolve()
  const started = await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'turn_started')
  assert.ok(started.channelId)
  assert.equal(fixture.hub.read(started.channelId, 0)?.frames.find((frame) => frame.type === 'delta')?.text, firstText)
  await reserveRequested.promise
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.role), ['user'])
  assert.equal(voice.calls.filter((call) => call.name === 'say').length, 1)
  assert.ok(fixture.provider.requests.find((request) => request.systemPrompt?.includes(DIALOGUE_BETA))?.userMessage?.includes(firstText))

  finishPlayback.resolve()
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'ended')
  const messages = await fixture.store.listChatMessages(fixture.session.id)
  assert.deepEqual(messages.map((message) => message.text), ['Consider pricing.', firstText, secondText])
  assert.deepEqual(messages.slice(1).map((message) => message.speaker?.id), ['alpha-analyst', 'beta-builder'])
  assert.equal(voice.calls.filter((call) => call.name === 'say').length, 2)
})

test('an unavailable voice layer pauses with a reason and saves no silent Agent reply', { timeout: 20_000 }, async (t) => {
  const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogue-away-voice-'))
  t.after(() => fs.rm(discoveryDir, { recursive: true, force: true }))
  const fixture = await createDialogueFixture(t, [
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'This reply was never heard.' },
  ], undefined, { voiceControl: { mcpToken: 'away-dialogue-voice-token', discoveryDir, attentionIntervalMs: 60_000 } })
  const record = await fixture.start({ delivery: 'voice' })
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'paused')

  const response = await fetch(`${fixture.base}/${record.dialogueId}`, { signal: AbortSignal.timeout(5_000) })
  const paused: unknown = await response.json()
  assert.ok(typeof paused === 'object' && paused !== null && 'pauseReason' in paused)
  assert.equal(paused.pauseReason, 'voice_unavailable')
  const recordAfterPause = agentDialogueRecordSchema.parse(paused)
  assert.equal(recordAfterPause.status, 'paused')
  assert.equal(recordAfterPause.events.filter((event) => event.type === 'speaker_failed').length, 0, 'A voice outage must not blame the Agent')
  assert.deepEqual(recordAfterPause.participants.map((participant) => participant.consecutiveFailures), [0, 0])
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.role), ['user'])
})

test('a spoken interruption keeps heard words, drops the reserve and resumes on an interjection with a fresh utterance', { timeout: 25_000 }, async (t) => {
  const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogue-interrupted-speech-'))
  const interrupt = makeGate()
  const reserveRequested = makeGate()
  const heldReserve = makeGate()
  const utterances: string[] = []
  let closeDialogueServer = async () => {}
  t.after(() => { interrupt.resolve(); heldReserve.resolve() })
  const voice = await startVoiceLayerFixture(discoveryDir, { onSay: async (input, context) => {
    assert.ok(input.utteranceId)
    utterances.push(input.utteranceId)
    await context.progress({ utteranceId: input.utteranceId, state: 'started', heardChars: 0, totalChars: input.text.length })
    if (input.speaker?.id === 'alpha-analyst') {
      await interrupt.promise
      return { utteranceId: input.utteranceId, outcome: 'interrupted', heardChars: 14 }
    }
    return { utteranceId: input.utteranceId, outcome: 'spoken', heardChars: input.text.length }
  } })
  t.after(async () => { await closeDialogueServer(); await voice.close(); await fs.rm(discoveryDir, { recursive: true, force: true }) })
  const fixture = await createDialogueFixture(t, [
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'A useful pricing pilot needs evidence.' },
    { match: (request) => { if (!request.systemPrompt?.includes(DIALOGUE_BETA)) return false; reserveRequested.resolve(); return true }, content: 'Unheard reserve.', gate: heldReserve.promise },
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_BETA) === true, content: 'The new question needs a different answer.' },
  ], undefined, { voiceControl: { mcpToken: 'interrupt-dialogue-voice-token', discoveryDir, attentionIntervalMs: 60_000 } })
  closeDialogueServer = () => fixture.server.close()
  const record = await fixture.start({ delivery: 'voice', maxTurns: 2 })
  await reserveRequested.promise
  interrupt.resolve()
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'paused')
  const response = await fetch(`${fixture.base}/${record.dialogueId}`, { signal: AbortSignal.timeout(5_000) })
  const paused: unknown = await response.json()
  assert.ok(typeof paused === 'object' && paused !== null && 'pauseReason' in paused)
  assert.equal(paused.pauseReason, 'speech_interrupted')
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.text), ['Consider pricing.', 'A useful'])

  assert.equal((await fixture.post(`/${record.dialogueId}/interjections`, { messageId: 'new-question', text: 'What about churn?' })).status, 200)
  heldReserve.resolve()
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'ended')
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.text), [
    'Consider pricing.', 'A useful', 'What about churn?', 'The new question needs a different answer.',
  ])
  assert.deepEqual(utterances, [`${record.dialogueId}:turn:0:0`, `${record.dialogueId}:turn:2:2`])
  assert.ok(fixture.provider.requests.find((request) => request.systemPrompt?.includes(DIALOGUE_BETA) && request.userMessage?.includes('What about churn?'))?.userMessage?.includes('[cut off]'))
})

test('Stop cancels playing speech, keeps only its heard whole words and discards the reserved reply', { timeout: 25_000 }, async (t) => {
  const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogue-stop-speech-'))
  const finishPlayback = makeGate()
  const reserveRequested = makeGate()
  const cancelled = makeGate()
  let closeDialogueServer = async () => {}
  t.after(finishPlayback.resolve)
  // Playback is replaced only at its MCP boundary; cancellation reaches the
  // real SDK server request's AbortSignal.
  const voice = await startVoiceLayerFixture(discoveryDir, { onSay: async (input, context) => {
    assert.ok(input.utteranceId)
    await context.progress({ utteranceId: input.utteranceId, state: 'started', heardChars: 0, totalChars: input.text.length })
    await context.progress({ utteranceId: input.utteranceId, state: 'progress', heardChars: 14, totalChars: input.text.length })
    context.signal.addEventListener('abort', () => { cancelled.resolve(); finishPlayback.resolve() }, { once: true })
    await finishPlayback.promise
    // A late, overoptimistic receipt must not restore the unheard ending.
    return { utteranceId: input.utteranceId, outcome: 'spoken', heardChars: input.text.length }
  } })
  t.after(async () => { await closeDialogueServer(); await voice.close(); await fs.rm(discoveryDir, { recursive: true, force: true }) })
  const fixture = await createDialogueFixture(t, [
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'A useful pricing pilot needs evidence.' },
    { match: (request) => { if (!request.systemPrompt?.includes(DIALOGUE_BETA)) return false; reserveRequested.resolve(); return true }, content: 'This reserved answer was never heard.' },
  ], undefined, { voiceControl: { mcpToken: 'stop-dialogue-voice-token', discoveryDir, attentionIntervalMs: 60_000 } })
  closeDialogueServer = () => fixture.server.close()
  const record = await fixture.start({ delivery: 'voice', maxTurns: 3 })
  await reserveRequested.promise

  const stopped = await fixture.post(`/${record.dialogueId}/stop`)
  assert.equal(stopped.status, 200)
  assert.equal(agentDialogueRecordSchema.parse(await stopped.json()).status, 'stopped')
  const messages = await fixture.store.listChatMessages(fixture.session.id)
  assert.deepEqual(messages.map((message) => message.text), ['Consider pricing.', 'A useful'])
  assert.deepEqual(messages[1]?.cutOff, { heardChars: 14 })
  await cancelled.promise
  await fixture.server.close()
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.text), ['Consider pricing.', 'A useful'])
  assert.equal(voice.calls.filter((call) => call.name === 'say').length, 1)
})

test('a rapid Pause and Resume finishes playing speech and replaces its reserved turn with a fresh identity', { timeout: 25_000 }, async (t) => {
  const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogue-pause-speech-'))
  const finishPlayback = makeGate()
  const reserveRequested = makeGate()
  const utterances: string[] = []
  let closeDialogueServer = async () => {}
  t.after(finishPlayback.resolve)
  const voice = await startVoiceLayerFixture(discoveryDir, { onSay: async (input, context) => {
    assert.ok(input.utteranceId)
    utterances.push(input.utteranceId)
    await context.progress({ utteranceId: input.utteranceId, state: 'started', heardChars: 0, totalChars: input.text.length })
    if (input.speaker?.id === 'alpha-analyst') await finishPlayback.promise
    return { utteranceId: input.utteranceId, outcome: 'spoken', heardChars: input.text.length }
  } })
  t.after(async () => { await closeDialogueServer(); await voice.close(); await fs.rm(discoveryDir, { recursive: true, force: true }) })
  const fixture = await createDialogueFixture(t, [
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'A useful pricing pilot needs evidence.' },
    { match: (request) => { if (!request.systemPrompt?.includes(DIALOGUE_BETA)) return false; reserveRequested.resolve(); return true }, content: 'The old reserved answer.' },
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_BETA) === true, content: 'The fresh answer after Resume.' },
  ], undefined, { voiceControl: { mcpToken: 'pause-dialogue-voice-token', discoveryDir, attentionIntervalMs: 60_000 } })
  closeDialogueServer = () => fixture.server.close()
  const record = await fixture.start({ delivery: 'voice', maxTurns: 2 })
  await reserveRequested.promise

  const paused = agentDialogueRecordSchema.parse(await (await fixture.post(`/${record.dialogueId}/pause`)).json())
  assert.equal(paused.epoch, 1, 'Pause must invalidate the generation held in reserve')
  assert.equal(agentDialogueRecordSchema.parse(await (await fixture.post(`/${record.dialogueId}/pause`)).json()).epoch, 1)
  assert.equal((await fixture.post(`/${record.dialogueId}/resume`)).status, 200)
  finishPlayback.resolve()

  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'ended')
  const ended = agentDialogueRecordSchema.parse(await (await fetch(`${fixture.base}/${record.dialogueId}`, { signal: AbortSignal.timeout(5_000) })).json())
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.text), [
    'Consider pricing.', 'A useful pricing pilot needs evidence.', 'The fresh answer after Resume.',
  ])
  assert.deepEqual(utterances, [`${record.dialogueId}:turn:0:0`, `${record.dialogueId}:turn:2:1`])
  assert.equal(ended.events.filter((event) => event.type === 'speaker_failed').length, 0, 'Discarding a reserve is not an Agent failure')
})

test('a time limit cancels speech that has not started and discards a late playback receipt', { timeout: 25_000 }, async (t) => {
  const clock = makeClock()
  const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogue-queued-limit-'))
  const received = makeGate()
  const beginPlayback = makeGate()
  let closeDialogueServer = async () => {}
  t.after(beginPlayback.resolve)
  const voice = await startVoiceLayerFixture(discoveryDir, { onSay: async (input, context) => {
    assert.ok(input.utteranceId)
    received.resolve()
    await beginPlayback.promise
    await context.progress({ utteranceId: input.utteranceId, state: 'started', heardChars: 0, totalChars: input.text.length })
    return { utteranceId: input.utteranceId, outcome: 'spoken', heardChars: input.text.length }
  } })
  t.after(async () => { await closeDialogueServer(); await voice.close(); await fs.rm(discoveryDir, { recursive: true, force: true }) })
  const fixture = await createDialogueFixture(t, [
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'Queued words must never become a reply.' },
  ], clock, { voiceControl: { mcpToken: 'queued-limit-dialogue-token', discoveryDir, attentionIntervalMs: 60_000 } })
  closeDialogueServer = () => fixture.server.close()
  const record = await fixture.start({ delivery: 'voice', maxMinutes: 1 })
  await received.promise

  clock.advance(60_000)
  beginPlayback.resolve()
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'ended')
  const ended = agentDialogueRecordSchema.parse(await (await fetch(`${fixture.base}/${record.dialogueId}`, { signal: AbortSignal.timeout(5_000) })).json())
  assert.equal(ended.endReason, 'time_limit')
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.role), ['user'])
  assert.equal(ended.events.filter((event) => event.type === 'turn_started').length, 0)
})

test('a time limit lets speech already playing finish and discards its reserved reply', { timeout: 25_000 }, async (t) => {
  const clock = makeClock()
  const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogue-playing-limit-'))
  const finishPlayback = makeGate()
  const reserveRequested = makeGate()
  let wasCancelled = false
  let closeDialogueServer = async () => {}
  t.after(finishPlayback.resolve)
  const voice = await startVoiceLayerFixture(discoveryDir, { onSay: async (input, context) => {
    assert.ok(input.utteranceId)
    context.signal.addEventListener('abort', () => { wasCancelled = true }, { once: true })
    await context.progress({ utteranceId: input.utteranceId, state: 'started', heardChars: 0, totalChars: input.text.length })
    await finishPlayback.promise
    return { utteranceId: input.utteranceId, outcome: 'spoken', heardChars: input.text.length }
  } })
  t.after(async () => { await closeDialogueServer(); await voice.close(); await fs.rm(discoveryDir, { recursive: true, force: true }) })
  const fixture = await createDialogueFixture(t, [
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'The sentence already playing finishes.' },
    { match: (request) => { if (!request.systemPrompt?.includes(DIALOGUE_BETA)) return false; reserveRequested.resolve(); return true }, content: 'The reserve stays unheard.' },
  ], clock, { voiceControl: { mcpToken: 'playing-limit-dialogue-token', discoveryDir, attentionIntervalMs: 60_000 } })
  closeDialogueServer = () => fixture.server.close()
  const record = await fixture.start({ delivery: 'voice', maxMinutes: 1 })
  await reserveRequested.promise

  clock.advance(60_000)
  finishPlayback.resolve()
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'ended')
  const ended = agentDialogueRecordSchema.parse(await (await fetch(`${fixture.base}/${record.dialogueId}`, { signal: AbortSignal.timeout(5_000) })).json())
  assert.equal(ended.endReason, 'time_limit')
  assert.equal(wasCancelled, false)
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.text), ['Consider pricing.', 'The sentence already playing finishes.'])
  assert.equal(voice.calls.filter((call) => call.name === 'say').length, 1)
})

test('app shutdown cancels playing speech and saves only the words heard before shutdown', { timeout: 25_000 }, async (t) => {
  const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogue-shutdown-speech-'))
  const finishPlayback = makeGate()
  const reserveRequested = makeGate()
  let closeDialogueServer = async () => {}
  t.after(finishPlayback.resolve)
  const voice = await startVoiceLayerFixture(discoveryDir, { onSay: async (input, context) => {
    assert.ok(input.utteranceId)
    await context.progress({ utteranceId: input.utteranceId, state: 'started', heardChars: 0, totalChars: input.text.length })
    await context.progress({ utteranceId: input.utteranceId, state: 'progress', heardChars: 14, totalChars: input.text.length })
    context.signal.addEventListener('abort', finishPlayback.resolve, { once: true })
    await finishPlayback.promise
    return { utteranceId: input.utteranceId, outcome: 'spoken', heardChars: input.text.length }
  } })
  t.after(async () => { await closeDialogueServer(); await voice.close(); await fs.rm(discoveryDir, { recursive: true, force: true }) })
  const fixture = await createDialogueFixture(t, [
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'A useful pricing pilot needs evidence.' },
    { match: (request) => { if (!request.systemPrompt?.includes(DIALOGUE_BETA)) return false; reserveRequested.resolve(); return true }, content: 'The reserve stays unheard.' },
  ], undefined, { voiceControl: { mcpToken: 'shutdown-dialogue-voice-token', discoveryDir, attentionIntervalMs: 60_000 } })
  closeDialogueServer = () => fixture.server.close()
  const record = await fixture.start({ delivery: 'voice' })
  await reserveRequested.promise

  const closing = fixture.server.close()
  finishPlayback.resolve()
  await closing
  const saved = await new FileSystemDialogueStore(fixture.workspacePath, fixture.store).get(fixture.session.id, record.dialogueId)
  assert.equal(saved?.status, 'interrupted')
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.text), ['Consider pricing.', 'A useful'])
  assert.equal(voice.calls.filter((call) => call.name === 'say').length, 1)
})

test('a dropped utterance pauses without an Agent failure and Resume clears its old pause explanation', { timeout: 25_000 }, async (t) => {
  const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogue-dropped-speech-'))
  const heldRetry = makeGate()
  let closeDialogueServer = async () => {}
  t.after(heldRetry.resolve)
  const voice = await startVoiceLayerFixture(discoveryDir, { onSay: async (input) => {
    assert.ok(input.utteranceId)
    return { utteranceId: input.utteranceId, outcome: 'dropped', heardChars: 0 }
  } })
  t.after(async () => { await closeDialogueServer(); await voice.close(); await fs.rm(discoveryDir, { recursive: true, force: true }) })
  const fixture = await createDialogueFixture(t, [
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'These words never played.' },
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'The resumed attempt.', gate: heldRetry.promise },
  ], undefined, { voiceControl: { mcpToken: 'dropped-dialogue-voice-token', discoveryDir, attentionIntervalMs: 60_000 } })
  closeDialogueServer = () => fixture.server.close()
  const record = await fixture.start({ delivery: 'voice' })
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'paused')
  const paused = agentDialogueRecordSchema.parse(await (await fetch(`${fixture.base}/${record.dialogueId}`, { signal: AbortSignal.timeout(5_000) })).json())
  assert.equal(paused.pauseReason, 'speech_dropped')
  assert.equal(paused.events.filter((event) => event.type === 'speaker_failed').length, 0)
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.role), ['user'])

  const resumed = agentDialogueRecordSchema.parse(await (await fixture.post(`/${record.dialogueId}/resume`)).json())
  assert.equal(resumed.status, 'running')
  assert.equal(resumed.pauseReason, undefined, 'The running dialogue must not retain its previous pause explanation')
})

type DialogueFixture = Awaited<ReturnType<typeof createDialogueFixture>>

for (const scenario of [
  { name: 'an interjection accepted before its delayed interruption receipt is answered without a second Resume',
    control: async (fixture: DialogueFixture, id: string) => [(await fixture.post(`/${id}/interjections`, { messageId: 'question-before-receipt', text: 'What about churn?' })).status],
    expectedStatuses: [200], expectedTexts: ['Consider pricing.', 'What about churn?', 'A useful', 'The next Agent answers after the control.'] },
  { name: 'a rapid Pause and Resume before its delayed interruption receipt stays resumed',
    control: async (fixture: DialogueFixture, id: string) => [(await fixture.post(`/${id}/pause`)).status, (await fixture.post(`/${id}/resume`)).status],
    expectedStatuses: [200, 200], expectedTexts: ['Consider pricing.', 'A useful', 'The next Agent answers after the control.'] },
]) {
  test(scenario.name, { timeout: 25_000 }, async (t) => {
    const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogue-late-interruption-'))
    const interrupt = makeGate()
    const reserveRequested = makeGate()
    const heldReserve = makeGate()
    let closeDialogueServer = async () => {}
    t.after(() => { interrupt.resolve(); heldReserve.resolve() })
    const voice = await startVoiceLayerFixture(discoveryDir, { onSay: async (input, context) => {
      assert.ok(input.utteranceId)
      await context.progress({ utteranceId: input.utteranceId, state: 'started', heardChars: 0, totalChars: input.text.length })
      if (input.speaker?.id === 'alpha-analyst') {
        await interrupt.promise
        return { utteranceId: input.utteranceId, outcome: 'interrupted', heardChars: 14 }
      }
      return { utteranceId: input.utteranceId, outcome: 'spoken', heardChars: input.text.length }
    } })
    t.after(async () => { await closeDialogueServer(); await voice.close(); await fs.rm(discoveryDir, { recursive: true, force: true }) })
    const fixture = await createDialogueFixture(t, [
      { match: (request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'A useful pricing pilot needs evidence.' },
      { match: (request) => { if (!request.systemPrompt?.includes(DIALOGUE_BETA)) return false; reserveRequested.resolve(); return true }, content: 'The discarded reserve.', gate: heldReserve.promise },
      { match: (request) => request.systemPrompt?.includes(DIALOGUE_BETA) === true, content: 'The next Agent answers after the control.' },
    ], undefined, { voiceControl: { mcpToken: 'late-interruption-dialogue-token', discoveryDir, attentionIntervalMs: 60_000 } })
    closeDialogueServer = () => fixture.server.close()
    const record = await fixture.start({ delivery: 'voice', maxTurns: 2 })
    await reserveRequested.promise

    assert.deepEqual(await scenario.control(fixture, record.dialogueId), scenario.expectedStatuses)
    interrupt.resolve()
    await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'turn_saved' && event.slot === 0)
    const afterReceipt = agentDialogueRecordSchema.parse(await (await fetch(`${fixture.base}/${record.dialogueId}`, { signal: AbortSignal.timeout(5_000) })).json())
    assert.notEqual(afterReceipt.status, 'paused', 'An old speech receipt must not undo a newer accepted control')
    heldReserve.resolve()
    await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'ended')
    assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.text), scenario.expectedTexts)
  })
}
