import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { agentDialogueRecordSchema } from '../../contracts/agent-dialogue.js'
import { FileSystemDialogueStore } from '../../services/agent-dialogue-store.js'
import { createDialogueFixture, DIALOGUE_ALPHA, DIALOGUE_BETA, waitForDialogueEvent } from '../helpers/agent-dialogue-fixture.js'

test('Pause lets the writing Agent finish and Resume starts the next Agent', { timeout: 20_000 }, async (t) => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let requested = () => {}
  const streaming = new Promise<void>((resolve) => { requested = resolve })
  const fixture = await createDialogueFixture(t, [
    { match: (request) => !request.stream && request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'Finish this thought.' },
    { match: (request) => { if (!request.stream || !request.systemPrompt?.includes(DIALOGUE_ALPHA)) return false; requested(); return true }, content: 'Finish this thought.', gate },
    { match: (request) => !request.stream && request.systemPrompt?.includes(DIALOGUE_BETA) === true, content: 'Now the next Agent.' },
    { match: (request) => request.stream && request.systemPrompt?.includes(DIALOGUE_BETA) === true, content: 'Now the next Agent.' },
  ])
  t.after(release)
  const record = await fixture.start({ maxTurns: 2 })
  await streaming
  const paused = await fixture.post(`/${record.dialogueId}/pause`)
  assert.equal(paused.status, 200, await paused.clone().text())
  assert.equal(agentDialogueRecordSchema.parse(await paused.json()).status, 'paused')
  release()
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'turn_saved')
  const settled = await fetch(`${fixture.base}/${record.dialogueId}`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(agentDialogueRecordSchema.parse(await settled.json()).status, 'paused')
  assert.equal(fixture.provider.requests.filter((request) => request.stream).length, 1)

  const resumed = await fixture.post(`/${record.dialogueId}/resume`)
  assert.equal(resumed.status, 200, await resumed.clone().text())
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'ended')
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).filter((message) => message.role === 'assistant').map((message) => message.speaker?.id), ['alpha-analyst', 'beta-builder'])
})

test('reopening an interrupted dialogue waits and Keep going uses a new run with the saved history', { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [
    { match: (request) => !request.stream, content: 'Build on the saved reply.' },
    { match: (request) => request.stream, content: 'Build on the saved reply.' },
  ])
  const old = agentDialogueRecordSchema.parse({
    schemaVersion: 1, dialogueId: randomUUID(), sessionId: fixture.session.id, topic: 'Earlier topic', delivery: 'text',
    participants: [{ id: 'alpha-analyst', label: 'alpha-analyst', active: true, consecutiveFailures: 0 }, { id: 'beta-builder', label: 'beta-builder', active: true, consecutiveFailures: 0 }],
    limits: { maxTurns: 12, runningMs: 0 }, status: 'running', nextSlot: 0, replyCount: 0, passStreak: 0, nextSpeaker: 0, epoch: 0,
    ownerLaunchId: randomUUID(), createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', stopRequested: false,
    events: [{ sequence: 0, type: 'turn_started', slot: 2, createdAt: '2026-10-09T00:00:00Z' }],
  })
  await fixture.store.appendChatMessageIfAbsent(fixture.session.id, {
    id: `${old.dialogueId}:reply:1`, role: 'assistant', text: 'The earlier reply is durable.', createdAt: old.createdAt,
    schemaVersion: 2, kind: 'chat', source: { kind: 'agent-dialogue', dialogueId: old.dialogueId, slot: 1 },
    turnId: randomUUID(), speaker: { id: 'alpha-analyst', name: 'alpha-analyst', type: 'agent' },
  })
  await new FileSystemDialogueStore(fixture.workspacePath, fixture.store).save(old)

  const response = await fetch(`${fixture.base}/${old.dialogueId}`, { signal: AbortSignal.timeout(5_000) })
  const recovered = agentDialogueRecordSchema.parse(await response.json())
  assert.equal(recovered.status, 'interrupted')
  assert.equal(recovered.replyCount, 1)
  assert.equal(recovered.nextSlot, 3)
  assert.equal(fixture.provider.requests.length, 0)

  const continued = await fixture.start({ maxTurns: 1, topic: old.topic, continues: old.dialogueId })
  assert.notEqual(continued.dialogueId, old.dialogueId)
  assert.equal(continued.continues, old.dialogueId)
  await waitForDialogueEvent(fixture.base, continued.dialogueId, (event) => event.type === 'ended')
  assert.ok(fixture.provider.requests.find((request) => request.stream)?.userMessage?.includes('The earlier reply is durable.'))
  assert.equal((await fixture.store.listChatMessages(fixture.session.id)).length, 3)
})
