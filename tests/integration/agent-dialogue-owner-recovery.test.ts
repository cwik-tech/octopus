import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import test, { type TestContext } from 'node:test'
import { agentDialogueListSchema, agentDialogueRecordSchema, type AgentDialogueRecord } from '../../contracts/agent-dialogue.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { FileSystemDialogueStore } from '../../services/agent-dialogue-store.js'
import { createDialogueFixture, waitForDialogueEvent } from '../helpers/agent-dialogue-fixture.js'

function makeOwnedRecord(sessionId: string, overrides: Partial<AgentDialogueRecord> = {}): AgentDialogueRecord {
  return agentDialogueRecordSchema.parse({
    schemaVersion: 1, dialogueId: randomUUID(), sessionId, topic: 'Foreign owner pricing discussion', delivery: 'text',
    participants: [{ id: 'alpha-analyst', label: 'Alpha', active: true, consecutiveFailures: 0 }, { id: 'beta-builder', label: 'Beta', active: true, consecutiveFailures: 0 }],
    limits: { maxTurns: 12, runningMs: 0 }, status: 'running', nextSlot: 1, replyCount: 0,
    passStreak: 0, nextSpeaker: 1, epoch: 0, ownerLaunchId: randomUUID(), stopRequested: false,
    createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', events: [], ...overrides,
  })
}

async function ownLiveProcess(t: TestContext) {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] })
  await once(child, 'spawn')
  assert.ok(child.pid)
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(2_000) })
    child.kill('SIGTERM')
    await exited
  }
  t.after(stop)
  return { pid: child.pid, stop }
}

function exitedProcessId(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
  assert.equal(child.status, 0)
  assert.ok(child.pid > 0)
  return child.pid
}

test('a foreign live owner keeps its dialogue until its process exits, then recovery counts the saved reply and releases ownership', { timeout: 20_000 }, async (t) => {
  const owner = await ownLiveProcess(t)
  const fixture = await createDialogueFixture(t, [])
  const ownerStore = new FileSystemSessionStore(fixture.workspacePath, { processId: owner.pid })
  const record = makeOwnedRecord(fixture.session.id)
  const claim = { kind: 'dialogue' as const, claimId: record.dialogueId, ownerLaunchId: record.ownerLaunchId }
  await new FileSystemDialogueStore(fixture.workspacePath, ownerStore).save(record)
  assert.equal(await ownerStore.claimSessionActivity(fixture.session.id, claim), 'claimed')
  await ownerStore.appendChatMessageIfAbsent(fixture.session.id, {
    id: `${record.dialogueId}:reply:0`, role: 'assistant', text: 'The foreign owner already saved this reply.', createdAt: record.createdAt,
    schemaVersion: 2, kind: 'chat', source: { kind: 'agent-dialogue', dialogueId: record.dialogueId, slot: 0 },
    turnId: randomUUID(), speaker: { id: 'alpha-analyst', name: 'Alpha', type: 'agent' },
  })

  const live = await fetch(`${fixture.base}/${record.dialogueId}`, { signal: AbortSignal.timeout(5_000) })
  assert.deepEqual(agentDialogueRecordSchema.parse(await live.json()), record)
  const active = await fetch(`${fixture.base}?status=active`, { signal: AbortSignal.timeout(5_000) })
  assert.deepEqual(agentDialogueListSchema.parse(await active.json()).dialogues, [record])
  assert.equal((await fixture.store.listSessionActivityClaims(fixture.session.id))[0]?.processId, owner.pid)
  assert.equal((await fixture.post('', { agents: ['alpha-analyst', 'beta-builder'], topic: 'Competing start.' })).status, 409)
  assert.equal((await fixture.post(`/${record.dialogueId}/resume`)).status, 409)
  assert.equal((await fetch(`${fixture.server.url}/sessions/${fixture.session.id}`, { method: 'DELETE', signal: AbortSignal.timeout(5_000) })).status, 409)

  await owner.stop()
  const recovered = await fetch(`${fixture.base}/${record.dialogueId}`, { signal: AbortSignal.timeout(5_000) })
  const terminal = agentDialogueRecordSchema.parse(await recovered.json())
  assert.equal(terminal.status, 'interrupted')
  assert.equal(terminal.replyCount, 1)
  assert.equal(terminal.epoch, 1)
  assert.deepEqual(await fixture.store.listSessionActivityClaims(fixture.session.id), [])
  assert.equal(fixture.provider.requests.length, 0)
})

test('a live owner retains its terminal claim until its own cleanup finishes', { timeout: 20_000 }, async (t) => {
  const owner = await ownLiveProcess(t)
  const fixture = await createDialogueFixture(t, [])
  const ownerStore = new FileSystemSessionStore(fixture.workspacePath, { processId: owner.pid })
  const record = makeOwnedRecord(fixture.session.id, { status: 'stopped', endReason: 'stopped', stopRequested: true })
  const claim = { kind: 'dialogue' as const, claimId: record.dialogueId, ownerLaunchId: record.ownerLaunchId }
  await new FileSystemDialogueStore(fixture.workspacePath, ownerStore).save(record)
  assert.equal(await ownerStore.claimSessionActivity(fixture.session.id, claim), 'claimed')

  const read = await fetch(`${fixture.base}/${record.dialogueId}`, { signal: AbortSignal.timeout(5_000) })
  assert.deepEqual(agentDialogueRecordSchema.parse(await read.json()), record)
  assert.deepEqual(await fixture.store.listSessionActivityClaims(fixture.session.id), [{ ...claim, processId: owner.pid }])
  assert.equal((await fetch(`${fixture.server.url}/sessions/${fixture.session.id}`, { method: 'DELETE', signal: AbortSignal.timeout(5_000) })).status, 409)
})

test('discovery releases a dead dialogue claim with no record so its session can be deleted', { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [])
  const ownerStore = new FileSystemSessionStore(fixture.workspacePath, { processId: exitedProcessId() })
  assert.equal(await ownerStore.claimSessionActivity(fixture.session.id, { kind: 'dialogue', claimId: randomUUID(), ownerLaunchId: randomUUID() }), 'claimed')

  const read = await fetch(`${fixture.base}?status=active`, { signal: AbortSignal.timeout(5_000) })
  assert.deepEqual(agentDialogueListSchema.parse(await read.json()).dialogues, [])
  assert.deepEqual(await fixture.store.listSessionActivityClaims(fixture.session.id), [])
  assert.equal((await fetch(`${fixture.server.url}/sessions/${fixture.session.id}`, { method: 'DELETE', signal: AbortSignal.timeout(5_000) })).status, 204)
})

test('a dead orphaned dialogue claim cannot block a fresh dialogue start', { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [
    { match: (request) => !request.stream, content: 'A fresh pricing discussion.' },
    { match: (request) => request.stream, content: 'A fresh pricing discussion.' },
  ])
  const ownerStore = new FileSystemSessionStore(fixture.workspacePath, { processId: exitedProcessId() })
  const abandonedId = randomUUID()
  assert.equal(await ownerStore.claimSessionActivity(fixture.session.id, { kind: 'dialogue', claimId: abandonedId, ownerLaunchId: randomUUID() }), 'claimed')

  const response = await fixture.post('', { agents: ['alpha-analyst', 'beta-builder'], topic: 'Fresh start after the crash.', maxTurns: 1 })
  assert.equal(response.status, 202, await response.clone().text())
  const fresh = agentDialogueRecordSchema.parse(await response.json())
  assert.notEqual(fresh.dialogueId, abandonedId)
  await waitForDialogueEvent(fixture.base, fresh.dialogueId, (event) => event.type === 'ended')
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.text), ['Fresh start after the crash.', 'A fresh pricing discussion.'])
})

test('a live owner preparing its first dialogue record keeps its claim during discovery and deletion', { timeout: 20_000 }, async (t) => {
  const owner = await ownLiveProcess(t)
  const fixture = await createDialogueFixture(t, [])
  const ownerStore = new FileSystemSessionStore(fixture.workspacePath, { processId: owner.pid })
  const claim = { kind: 'dialogue' as const, claimId: randomUUID(), ownerLaunchId: randomUUID() }
  assert.equal(await ownerStore.claimSessionActivity(fixture.session.id, claim), 'claimed')

  const read = await fetch(`${fixture.base}?status=active`, { signal: AbortSignal.timeout(5_000) })
  assert.deepEqual(agentDialogueListSchema.parse(await read.json()).dialogues, [])
  assert.deepEqual(await fixture.store.listSessionActivityClaims(fixture.session.id), [{ ...claim, processId: owner.pid }])
  assert.equal((await fixture.post('', { agents: ['alpha-analyst', 'beta-builder'], topic: 'Competing start.' })).status, 409)
  assert.equal((await fetch(`${fixture.server.url}/sessions/${fixture.session.id}`, { method: 'DELETE', signal: AbortSignal.timeout(5_000) })).status, 409)
  assert.equal(fixture.provider.requests.length, 0)
})

for (const operation of [
  { name: 'ordinary chat', route: 'messages', body: { text: 'Reply after the crash.', target: { kind: 'agents', agentNames: ['alpha-analyst'] } }, status: 201 },
  { name: 'workflow admission', route: 'tasks', body: { workflowId: 'test-workflow', brief: 'Write a 200-word pricing proposal for small business owners comparing monthly and annual billing. Include a concrete recommendation and three tradeoffs using the provided pricing notes.' }, status: 202 },
]) {
  test(`${operation.name} recovers a crashed dialogue before claiming its session`, { timeout: 20_000 }, async (t) => {
    const fixture = await createDialogueFixture(t, [{ content: 'The chat is usable again.' }, { content: 'The chat is usable again.' }])
    const previous = new FileSystemSessionStore(fixture.workspacePath, { processId: exitedProcessId() })
    const record = makeOwnedRecord(fixture.session.id)
    const dialogues = new FileSystemDialogueStore(fixture.workspacePath, previous)
    await dialogues.save(record)
    assert.equal(await previous.claimSessionActivity(fixture.session.id, { kind: 'dialogue', claimId: record.dialogueId, ownerLaunchId: record.ownerLaunchId }), 'claimed')
    const response = await fetch(`${fixture.server.url}/sessions/${fixture.session.id}/${operation.route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(operation.body), signal: t.signal,
    })
    assert.equal(response.status, operation.status, await response.clone().text())
    assert.equal((await dialogues.get(fixture.session.id, record.dialogueId))?.status, 'interrupted')
    assert.equal((await fixture.store.listSessionActivityClaims(fixture.session.id)).some((claim) => claim.kind === 'dialogue'), false)
  })

  test(`${operation.name} preserves a live foreign dialogue owner`, { timeout: 20_000 }, async (t) => {
    const owner = await ownLiveProcess(t)
    const fixture = await createDialogueFixture(t, [])
    const previous = new FileSystemSessionStore(fixture.workspacePath, { processId: owner.pid })
    const record = makeOwnedRecord(fixture.session.id)
    await new FileSystemDialogueStore(fixture.workspacePath, previous).save(record)
    const claim = { kind: 'dialogue' as const, claimId: record.dialogueId, ownerLaunchId: record.ownerLaunchId }
    assert.equal(await previous.claimSessionActivity(fixture.session.id, claim), 'claimed')
    const response = await fetch(`${fixture.server.url}/sessions/${fixture.session.id}/${operation.route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(operation.body), signal: t.signal,
    })
    assert.equal(response.status, 409)
    assert.deepEqual(await fixture.store.listSessionActivityClaims(fixture.session.id), [{ ...claim, processId: owner.pid }])
    assert.equal(fixture.provider.requests.length, 0)
  })
}
