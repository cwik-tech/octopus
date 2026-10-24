import assert from 'node:assert/strict'
import test from 'node:test'
import { agentDialogueRecordSchema } from '../../contracts/agent-dialogue.js'
import { createDialogueFixture, DIALOGUE_ALPHA, DIALOGUE_BETA, waitForDialogueEvent } from '../helpers/agent-dialogue-fixture.js'

test('split and trailing pass tokens stay out of every live frame and saved contribution', { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [
    { match: (request) => !request.stream && request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'A useful point. [pass]' },
    { match: (request) => request.stream && request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, deltas: ['A useful point. [Pa', 'SS]'] },
    { match: (request) => !request.stream && request.systemPrompt?.includes(DIALOGUE_BETA) === true, content: ' [PASS] ' },
    { match: (request) => request.stream && request.systemPrompt?.includes(DIALOGUE_BETA) === true, deltas: ['  [Pa', 'SS] '] },
    { match: (request) => !request.stream && request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: '[pass]' },
    { match: (request) => request.stream && request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, deltas: ['[', 'pass', ']'] },
  ])
  const started = await fixture.start()
  const terminal = await waitForDialogueEvent(fixture.base, started.dialogueId, (event) => event.type === 'ended')
  assert.equal(terminal.endReason, 'passes')
  const response = await fetch(`${fixture.base}/${started.dialogueId}`, { signal: AbortSignal.timeout(5_000) })
  const record = agentDialogueRecordSchema.parse(await response.json())

  const frames = record.events.flatMap((event) => event.channelId ? fixture.hub.read(event.channelId, 0)?.frames ?? [] : [])
  assert.deepEqual(frames.filter((frame) => frame.type === 'delta').map((frame) => frame.text), ['A useful point.'])
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.text), ['Consider pricing.', 'A useful point.'])
  assert.equal(record.replyCount, 1)
  assert.equal(record.nextSlot, 3)
})

test('failed provider turns never enter chat and a twice-failed Agent leaves', { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, failStatus: 400 },
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, failStatus: 400 },
    { match: (request) => !request.stream && request.systemPrompt?.includes(DIALOGUE_BETA) === true, content: 'Keep the real evidence.' },
    { match: (request) => request.stream && request.systemPrompt?.includes(DIALOGUE_BETA) === true, content: 'Keep the real evidence.' },
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, failStatus: 400 },
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, failStatus: 400 },
  ])
  const started = await fixture.start()
  const terminal = await waitForDialogueEvent(fixture.base, started.dialogueId, (event) => event.type === 'ended')
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.endReason, 'too_few_speakers')
  const response = await fetch(`${fixture.base}/${started.dialogueId}`, { signal: AbortSignal.timeout(5_000) })
  const record = agentDialogueRecordSchema.parse(await response.json())
  assert.equal(record.participants[0]?.active, false)
  assert.equal(record.events.filter((event) => event.type === 'speaker_failed').length, 2)
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.text), ['Consider pricing.', 'Keep the real evidence.'])
  assert.equal(record.replyCount, 1)
})
