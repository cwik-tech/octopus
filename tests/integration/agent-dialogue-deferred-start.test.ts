import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import test from 'node:test'
import { agentDialogueRecordSchema, startAgentDialogueRequestSchema } from '../../contracts/agent-dialogue.js'
import { AgentDialogueService, type AgentDialogueClock } from '../../services/agent-dialogue-service.js'
import { createDialogueFixture } from '../helpers/agent-dialogue-fixture.js'

test('a failed original chat interrupts its reserved dialogue without generating a turn', { timeout: 15_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [])
  const service = new AgentDialogueService({ sessionStore: fixture.store, workspacePath: fixture.workspacePath, repoRootPath: fixture.repoRootPath, agentTextStreamHub: fixture.hub })
  const claim = { kind: 'chat' as const, claimId: randomUUID(), ownerLaunchId: fixture.store.getInstanceId() }
  await fixture.store.claimSessionActivity(fixture.session.id, claim)
  let complete = (_published: boolean) => {}
  const completion = new Promise<boolean>((resolve) => { complete = resolve })
  t.after(() => complete(false))
  t.after(() => service.close())
  const record = await service.start(fixture.session.id, startAgentDialogueRequestSchema.parse({ agents: ['alpha-analyst', 'beta-builder'], topic: 'Never start this.' }), { claim, completion })
  let observed = () => {}
  let refused = (_error: unknown) => {}
  const ending = new Promise<void>((resolve, reject) => { observed = resolve; refused = reject })
  const unsubscribe = service.subscribe(record.dialogueId, () => {
    // A turn-start notification is not evidence the deferred dialogue has settled.
    void service.get(fixture.session.id, record.dialogueId).then((current) => {
      if (current?.events.some((event) => event.type === 'ended')) observed()
    }, refused)
  })
  t.after(unsubscribe)
  complete(false)
  await ending
  await service.close()
  assert.equal((await service.get(fixture.session.id, record.dialogueId))?.status, 'interrupted')
  assert.equal(fixture.provider.requests.length, 0)
  assert.deepEqual(await fixture.store.listSessionActivityClaims(fixture.session.id), [])
})

test('Stop marks a deferred dialogue stopped and retains ownership until the original chat has finished', { timeout: 15_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [])
  const service = new AgentDialogueService({ sessionStore: fixture.store, workspacePath: fixture.workspacePath, repoRootPath: fixture.repoRootPath, agentTextStreamHub: fixture.hub })
  const claim = { kind: 'chat' as const, claimId: randomUUID(), ownerLaunchId: fixture.store.getInstanceId() }
  await fixture.store.claimSessionActivity(fixture.session.id, claim)
  let complete = (_published: boolean) => {}
  const completion = new Promise<boolean>((resolve) => { complete = resolve })
  t.after(() => complete(false))
  t.after(() => service.close())
  const record = await service.start(fixture.session.id, startAgentDialogueRequestSchema.parse({ agents: ['alpha-analyst', 'beta-builder'], topic: 'Stop before publication.' }), { claim, completion })
  assert.equal((await service.stop(fixture.session.id, record.dialogueId)).status, 'stopped')
  assert.deepEqual((await fixture.store.listSessionActivityClaims(fixture.session.id)).map((entry) => entry.kind), ['dialogue'])
  assert.equal(await fixture.store.claimSessionActivity(fixture.session.id, { kind: 'dialogue', claimId: randomUUID(), ownerLaunchId: 'competitor' }), 'dialogue_active')
  complete(true)
  await service.close()
  assert.equal((await service.get(fixture.session.id, record.dialogueId))?.status, 'stopped')
  assert.equal(fixture.provider.requests.length, 0)
  assert.deepEqual(await fixture.store.listSessionActivityClaims(fixture.session.id), [])
})

test('a refused dialogue record write restores the original chat ownership before returning its error', { timeout: 15_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [])
  const service = new AgentDialogueService({ sessionStore: fixture.store, workspacePath: fixture.workspacePath, repoRootPath: fixture.repoRootPath, agentTextStreamHub: fixture.hub })
  t.after(() => service.close())
  const claim = { kind: 'chat' as const, claimId: randomUUID(), ownerLaunchId: fixture.store.getInstanceId() }
  await fixture.store.claimSessionActivity(fixture.session.id, claim)
  const sessionDirectory = path.join(fixture.workspacePath, 'sessions', fixture.session.id)
  await fs.mkdir(path.join(sessionDirectory, 'other-records'))
  await fs.symlink(path.join(sessionDirectory, 'other-records'), path.join(sessionDirectory, 'dialogues'))

  await assert.rejects(service.start(fixture.session.id, startAgentDialogueRequestSchema.parse({ agents: ['alpha-analyst', 'beta-builder'], topic: 'Refuse unsafe record location.' }), { claim, completion: Promise.resolve(false) }), { code: 'not_found' })
  assert.deepEqual((await fixture.store.listSessionActivityClaims(fixture.session.id)).map((entry) => entry.claimId), [claim.claimId])
  assert.equal(await fixture.store.claimSessionActivity(fixture.session.id, { kind: 'dialogue', claimId: randomUUID(), ownerLaunchId: 'competitor' }), 'chat_active')
  assert.equal(fixture.provider.requests.length, 0)
})

test('Pause and Resume before the original chat finishes do not consume dialogue running time', { timeout: 15_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [])
  let time = 0
  const deadlines = new Map<() => void, number>()
  const clock: AgentDialogueClock = {
    now: () => time,
    schedule: (callback, milliseconds) => { deadlines.set(callback, time + milliseconds); return () => { deadlines.delete(callback) } },
  }
  const service = new AgentDialogueService({ sessionStore: fixture.store, workspacePath: fixture.workspacePath, repoRootPath: fixture.repoRootPath, agentTextStreamHub: fixture.hub, clock })
  const claim = { kind: 'chat' as const, claimId: randomUUID(), ownerLaunchId: fixture.store.getInstanceId() }
  await fixture.store.claimSessionActivity(fixture.session.id, claim)
  let complete = (_published: boolean) => {}
  const completion = new Promise<boolean>((resolve) => { complete = resolve })
  t.after(() => complete(false))
  t.after(() => service.close())
  const record = await service.start(fixture.session.id, startAgentDialogueRequestSchema.parse({ agents: ['alpha-analyst', 'beta-builder'], topic: 'Wait for the original reply.', maxMinutes: 1 }), { claim, completion })
  await service.pause(fixture.session.id, record.dialogueId)
  await service.resume(fixture.session.id, record.dialogueId)
  time = 60_000
  for (const [callback, deadline] of deadlines) { if (deadline <= time) callback() }

  const pending = await service.get(fixture.session.id, record.dialogueId)
  assert.equal(pending?.status, 'running', 'The dialogue cannot expire before the original chat has published')
  assert.equal(pending?.limits.runningMs, 0)
  assert.equal(fixture.provider.requests.length, 0)
  complete(false)
  await service.close()
})

test('a topic publication failure leaves a terminal record and restores the original chat owner', { timeout: 15_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [])
  const service = new AgentDialogueService({ sessionStore: fixture.store, workspacePath: fixture.workspacePath, repoRootPath: fixture.repoRootPath, agentTextStreamHub: fixture.hub })
  t.after(() => service.close())
  const claim = { kind: 'chat' as const, claimId: randomUUID(), ownerLaunchId: fixture.store.getInstanceId() }
  await fixture.store.claimSessionActivity(fixture.session.id, claim)
  const sessionDirectory = path.join(fixture.workspacePath, 'sessions', fixture.session.id)
  await fs.mkdir(path.join(sessionDirectory, 'chat.jsonl'))
  await assert.rejects(service.start(fixture.session.id, startAgentDialogueRequestSchema.parse({ agents: ['alpha-analyst', 'beta-builder'], topic: 'Refuse unavailable transcript.' }), { claim, completion: Promise.resolve(false) }), { code: 'EISDIR' })
  const files = await fs.readdir(path.join(sessionDirectory, 'dialogues'))
  assert.equal(files.length, 1)
  const filename = files[0]
  assert.ok(filename)
  const raw: unknown = JSON.parse(await fs.readFile(path.join(sessionDirectory, 'dialogues', filename), 'utf8'))
  const record = agentDialogueRecordSchema.parse(raw)
  assert.equal(record.status, 'interrupted', 'A failed topic write must not leave a running record with no job')
  assert.equal(record.events.at(-1)?.type, 'ended')
  assert.deepEqual((await fixture.store.listSessionActivityClaims(fixture.session.id)).map((entry) => entry.claimId), [claim.claimId])
  assert.equal(fixture.provider.requests.length, 0)
})
