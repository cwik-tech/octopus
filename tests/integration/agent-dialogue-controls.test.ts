import assert from 'node:assert/strict'
import test from 'node:test'
import { agentDialogueRecordSchema } from '../../contracts/agent-dialogue.js'
import { createDialogueFixture, DIALOGUE_ALPHA, DIALOGUE_BETA, waitForDialogueEvent } from '../helpers/agent-dialogue-fixture.js'

test('Stop returns while generation is pending and discards the unfinished reply', { timeout: 20_000 }, async (t) => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let requested = () => {}
  const streaming = new Promise<void>((resolve) => { requested = resolve })
  const fixture = await createDialogueFixture(t, [
    { match: (request) => !request.stream, content: 'Unfinished answer.' },
    { match: (request) => { if (!request.stream) return false; requested(); return true }, content: 'Unfinished answer.', gate },
  ])
  t.after(release)
  const record = await fixture.start()
  await streaming

  const response = await fixture.post(`/${record.dialogueId}/stop`)
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(agentDialogueRecordSchema.parse(await response.json()).status, 'stopped')
  release()
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'ended')
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.role), ['user'])
  assert.equal(fixture.provider.requests.filter((request) => request.stream).length, 1)
})

test('a typed interjection is saved once and the next Agent answers it after the current reply', { timeout: 20_000 }, async (t) => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let requested = () => {}
  const streaming = new Promise<void>((resolve) => { requested = resolve })
  const fixture = await createDialogueFixture(t, [
    { match: (request) => !request.stream && request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'Finish the current thought.' },
    { match: (request) => { if (!request.stream || !request.systemPrompt?.includes(DIALOGUE_ALPHA)) return false; requested(); return true }, content: 'Finish the current thought.', gate },
    { match: (request) => !request.stream && request.systemPrompt?.includes(DIALOGUE_BETA) === true, content: 'I will address the new question.' },
    { match: (request) => request.stream && request.systemPrompt?.includes(DIALOGUE_BETA) === true, content: 'I will address the new question.' },
  ])
  t.after(release)
  const record = await fixture.start({ maxTurns: 2 })
  await streaming

  const body = { messageId: 'interjection-1', text: 'What about people who declined?' }
  const first = await fixture.post(`/${record.dialogueId}/interjections`, body)
  assert.equal(first.status, 200, await first.clone().text())
  const replay = await fixture.post(`/${record.dialogueId}/interjections`, body)
  assert.equal(replay.status, 200, await replay.clone().text())
  release()
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'ended')

  const saved = await fixture.store.listChatMessages(fixture.session.id)
  assert.deepEqual(saved.map((message) => message.text), ['Consider pricing.', body.text, 'Finish the current thought.', 'I will address the new question.'])
  assert.equal(saved[1]?.id, `${record.dialogueId}:user:interjection-1`)
  const secondRequest = fixture.provider.requests.filter((request) => request.stream)[1]
  assert.ok(secondRequest?.userMessage?.includes(body.text), 'The next speaker must read the interjection')
  assert.ok(secondRequest?.userMessage?.includes('Finish the current thought.'), 'The interrupted topic still finishes before the next speaker')
})
