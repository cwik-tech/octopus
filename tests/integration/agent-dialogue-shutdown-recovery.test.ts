import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { agentDialogueRecordSchema, startAgentDialogueRequestSchema } from '../../contracts/agent-dialogue.js'
import { FileSystemDialogueStore } from '../../services/agent-dialogue-store.js'
import { AgentDialogueService } from '../../services/agent-dialogue-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { createDialogueFixture } from '../helpers/agent-dialogue-fixture.js'

function makeStoppedRecord(sessionId: string) {
  return agentDialogueRecordSchema.parse({
    schemaVersion: 1, dialogueId: randomUUID(), sessionId, topic: 'Earlier topic', delivery: 'text',
    participants: [{ id: 'alpha-analyst', label: 'Alpha', active: true, consecutiveFailures: 0 }, { id: 'beta-builder', label: 'Beta', active: true, consecutiveFailures: 0 }],
    limits: { maxTurns: 12, runningMs: 0 }, status: 'stopped', endReason: 'stopped', nextSlot: 0, replyCount: 0,
    passStreak: 0, nextSpeaker: 0, epoch: 1, ownerLaunchId: randomUUID(), stopRequested: true,
    createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z',
    events: [{ sequence: 0, type: 'ended', status: 'stopped', endReason: 'stopped', createdAt: '2026-10-09T00:00:00Z' }],
  })
}

test('reopening a stopped prior-launch dialogue releases its abandoned session claim', { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [])
  const record = makeStoppedRecord(fixture.session.id)
  await new FileSystemDialogueStore(fixture.workspacePath, fixture.store).save(record)
  const previousProcess = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
  assert.equal(previousProcess.status, 0)
  const previousStore = new FileSystemSessionStore(fixture.workspacePath, { processId: previousProcess.pid })
  assert.equal(await previousStore.claimSessionActivity(fixture.session.id, { kind: 'dialogue', claimId: record.dialogueId, ownerLaunchId: record.ownerLaunchId }), 'claimed')

  const response = await fetch(`${fixture.base}/${record.dialogueId}`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(agentDialogueRecordSchema.parse(await response.json()).status, 'stopped')
  assert.deepEqual(await fixture.store.listSessionActivityClaims(fixture.session.id), [])
  assert.equal(fixture.provider.requests.length, 0)
})

test('closing the app leaves an unfinished dialogue interrupted without saving its pending reply', { timeout: 20_000 }, async (t) => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let requested = () => {}
  const pending = new Promise<void>((resolve) => { requested = resolve })
  const fixture = await createDialogueFixture(t, [
    { match: (request) => !request.stream, content: 'Unfinished at shutdown.' },
    { match: (request) => { if (!request.stream) return false; requested(); return true }, content: 'Unfinished at shutdown.', gate },
  ])
  t.after(release)
  const record = await fixture.start()
  await pending

  const closing = fixture.server.close()
  release()
  await closing
  const saved = await new FileSystemDialogueStore(fixture.workspacePath, fixture.store).get(fixture.session.id, record.dialogueId)
  assert.equal(saved?.status, 'interrupted')
  assert.equal(saved?.endReason, 'interrupted')
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.role), ['user'])
})

test('shutdown bars a dialogue whose start is still reading its chat', { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [])
  const service = new AgentDialogueService({
    workspacePath: fixture.workspacePath, repoRootPath: fixture.repoRootPath,
    sessionStore: fixture.store, agentTextStreamHub: fixture.hub,
  })
  t.after(() => service.close())
  const starting = service.start(fixture.session.id, startAgentDialogueRequestSchema.parse({ agents: ['alpha-analyst', 'beta-builder'], topic: 'Too late.' }))
  service.beginShutdown()

  await assert.rejects(starting, { code: 'conflict' })
  assert.deepEqual(await fixture.store.listChatMessages(fixture.session.id), [])
  assert.deepEqual(await fixture.store.listSessionActivityClaims(fixture.session.id), [])
})

test('a reopened dialogue can be located by its durable identity without a session hint', { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [])
  const record = makeStoppedRecord(fixture.session.id)
  await new FileSystemDialogueStore(fixture.workspacePath, fixture.store).save(record)
  const service = new AgentDialogueService({ workspacePath: fixture.workspacePath, repoRootPath: fixture.repoRootPath, sessionStore: fixture.store, agentTextStreamHub: fixture.hub })
  t.after(() => service.close())

  assert.equal(await service.findSessionId(record.dialogueId), fixture.session.id)
})
