import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { agentDialogueListSchema, agentDialogueRecordSchema, type AgentDialogueRecord } from '../../contracts/agent-dialogue.js'
import { FileSystemDialogueStore } from '../../services/agent-dialogue-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { createDialogueFixture } from '../helpers/agent-dialogue-fixture.js'

function makePriorDialogue(sessionId: string, overrides: Partial<AgentDialogueRecord> = {}): AgentDialogueRecord {
  return agentDialogueRecordSchema.parse({
    schemaVersion: 1, dialogueId: randomUUID(), sessionId, topic: 'Earlier pricing discussion', delivery: 'text',
    participants: [{ id: 'alpha-analyst', label: 'Alpha', active: true, consecutiveFailures: 0 }, { id: 'beta-builder', label: 'Beta', active: true, consecutiveFailures: 0 }],
    limits: { maxTurns: 12, runningMs: 0 }, status: 'stopped', endReason: 'stopped', nextSlot: 2, replyCount: 0,
    passStreak: 0, nextSpeaker: 0, epoch: 1, ownerLaunchId: randomUUID(), stopRequested: true,
    createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z',
    events: [], ...overrides,
  })
}

test('the active dialogue query includes running and paused work but excludes saved terminal and recovered records', { timeout: 20_000 }, async (t) => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let requested = () => {}
  const pending = new Promise<void>((resolve) => { requested = resolve })
  const fixture = await createDialogueFixture(t, [
    { match: (request) => { if (request.stream) return false; requested(); return true }, content: 'Pending current reply.', gate },
  ])
  t.after(release)
  const reopened = new FileSystemDialogueStore(fixture.workspacePath, new FileSystemSessionStore(fixture.workspacePath))
  const stopped = makePriorDialogue(fixture.session.id)
  const oldPaused = makePriorDialogue(fixture.session.id, { status: 'paused', stopRequested: false, endReason: undefined })
  await reopened.save(stopped)
  await reopened.save(oldPaused)
  const current = await fixture.start()
  await pending

  const runningResponse = await fetch(`${fixture.base}?status=active`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(runningResponse.status, 200)
  assert.deepEqual(agentDialogueListSchema.parse(await runningResponse.json()).dialogues.map((record) => ({ id: record.dialogueId, status: record.status })), [{ id: current.dialogueId, status: 'running' }])
  assert.equal((await fixture.post(`/${current.dialogueId}/pause`)).status, 200)
  const pausedResponse = await fetch(`${fixture.base}?status=active`, { signal: AbortSignal.timeout(5_000) })
  assert.deepEqual(agentDialogueListSchema.parse(await pausedResponse.json()).dialogues.map((record) => ({ id: record.dialogueId, status: record.status })), [{ id: current.dialogueId, status: 'paused' }])
  assert.equal((await fixture.post(`/${current.dialogueId}/stop`)).status, 200)
  const terminalResponse = await fetch(`${fixture.base}?status=active`, { signal: AbortSignal.timeout(5_000) })
  assert.deepEqual(agentDialogueListSchema.parse(await terminalResponse.json()).dialogues, [])
  const allResponse = await fetch(fixture.base, { signal: AbortSignal.timeout(5_000) })
  assert.equal(agentDialogueListSchema.parse(await allResponse.json()).dialogues.length, 3)
})

test('an unsupported dialogue status filter is refused before listing records', { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [])
  const response = await fetch(`${fixture.base}?status=surprise`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(response.status, 400)
})

for (const action of ['stop', 'pause', 'resume', 'interjections']) {
  test(`GET cannot execute or read the ${action} control route`, { timeout: 20_000 }, async (t) => {
    const fixture = await createDialogueFixture(t, [])
    const record = makePriorDialogue(fixture.session.id)
    await new FileSystemDialogueStore(fixture.workspacePath, fixture.store).save(record)

    const response = await fetch(`${fixture.base}/${record.dialogueId}/${action}`, { signal: AbortSignal.timeout(5_000) })
    assert.equal(response.status, 405)
    assert.deepEqual(await new FileSystemDialogueStore(fixture.workspacePath, fixture.store).get(fixture.session.id, record.dialogueId), record)
    assert.equal(fixture.provider.requests.length, 0)
  })
}

for (const prior of [
  { status: 'stopped', endReason: 'stopped', stopRequested: true, expectedStatus: 'stopped' },
  { status: 'ended', endReason: 'turn_limit', stopRequested: false, expectedStatus: 'ended' },
  { status: 'failed', endReason: 'too_few_speakers', stopRequested: false, expectedStatus: 'failed' },
  { status: 'interrupted', endReason: 'interrupted', stopRequested: false, expectedStatus: 'interrupted' },
  { status: 'running', stopRequested: false, expectedStatus: 'interrupted' },
  { status: 'paused', stopRequested: false, expectedStatus: 'interrupted' },
] as const) {
  test(`retried controls for a prior-launch ${prior.status} dialogue return its terminal record without restarting it`, { timeout: 20_000 }, async (t) => {
    const fixture = await createDialogueFixture(t, [])
    const { expectedStatus, ...fields } = prior
    const record = makePriorDialogue(fixture.session.id, fields)
    await new FileSystemDialogueStore(fixture.workspacePath, new FileSystemSessionStore(fixture.workspacePath)).save(record)

    const stop = await fixture.post(`/${record.dialogueId}/stop`)
    assert.equal(stop.status, 200, await stop.clone().text())
    const terminal = agentDialogueRecordSchema.parse(await stop.json())
    assert.equal(terminal.status, expectedStatus)
    const pause = await fixture.post(`/${record.dialogueId}/pause`)
    assert.equal(pause.status, 200, await pause.clone().text())
    assert.deepEqual(agentDialogueRecordSchema.parse(await pause.json()), terminal)
    const resume = await fixture.post(`/${record.dialogueId}/resume`)
    assert.equal(resume.status, 200, await resume.clone().text())
    assert.deepEqual(agentDialogueRecordSchema.parse(await resume.json()), terminal)
    assert.equal(fixture.provider.requests.length, 0)
    assert.deepEqual(await fixture.store.listSessionActivityClaims(fixture.session.id), [])
  })
}

test('a persisted interjection can be replayed after restart while reused and new identities are refused on the terminal dialogue', { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [])
  const record = makePriorDialogue(fixture.session.id)
  const reopened = new FileSystemSessionStore(fixture.workspacePath)
  await new FileSystemDialogueStore(fixture.workspacePath, reopened).save(record)
  await reopened.appendChatMessageIfAbsent(fixture.session.id, {
    id: `${record.dialogueId}:user:durable-client-id`, role: 'user', text: 'What about churn?', createdAt: record.createdAt,
    schemaVersion: 2, kind: 'chat', source: { kind: 'agent-dialogue', dialogueId: record.dialogueId, slot: 1 },
  })

  const replay = await fixture.post(`/${record.dialogueId}/interjections`, { messageId: 'durable-client-id', text: 'What about churn?' })
  assert.equal(replay.status, 200, await replay.clone().text())
  assert.deepEqual(agentDialogueRecordSchema.parse(await replay.json()), record)
  const reused = await fixture.post(`/${record.dialogueId}/interjections`, { messageId: 'durable-client-id', text: 'Different words.' })
  assert.equal(reused.status, 409)
  const newMessage = await fixture.post(`/${record.dialogueId}/interjections`, { messageId: 'another-client-id', text: 'Continue anyway.' })
  assert.equal(newMessage.status, 409)
  assert.deepEqual((await reopened.listChatMessages(fixture.session.id)).map((message) => message.text), ['What about churn?'])
  assert.equal(fixture.provider.requests.length, 0)
})

test('durable controls and interjection replays cannot address a dialogue through another session', { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [])
  const other = await fixture.store.createSession()
  const record = makePriorDialogue(other.id)
  await new FileSystemDialogueStore(fixture.workspacePath, fixture.store).save(record)

  assert.equal((await fixture.post(`/${record.dialogueId}/stop`)).status, 404)
  assert.equal((await fixture.post(`/${record.dialogueId}/pause`)).status, 404)
  assert.equal((await fixture.post(`/${record.dialogueId}/resume`)).status, 404)
  assert.equal((await fixture.post(`/${record.dialogueId}/interjections`, { messageId: 'cross-session', text: 'Wrong chat.' })).status, 404)
  assert.deepEqual(await new FileSystemDialogueStore(fixture.workspacePath, fixture.store).get(other.id, record.dialogueId), record)
})
