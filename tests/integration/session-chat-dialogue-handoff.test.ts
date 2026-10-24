import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'

test('two stores atomically promote the same sole chat claim to only one dialogue', async (t) => {
  const fixture = createSchedulerFixture('chat-dialogue-handoff-')
  t.after(fixture.cleanup)
  const first = new FileSystemSessionStore(fixture.workspacePath)
  const second = new FileSystemSessionStore(fixture.workspacePath)
  const session = await first.createSession()
  const chat = { kind: 'chat' as const, claimId: randomUUID(), ownerLaunchId: 'chat-owner' }
  assert.equal(await first.claimSessionActivity(session.id, chat), 'claimed')
  const results = await Promise.all([
    first.promoteSessionChatToDialogue(session.id, chat, { kind: 'dialogue', claimId: randomUUID(), ownerLaunchId: 'dialogue-first' }),
    second.promoteSessionChatToDialogue(session.id, chat, { kind: 'dialogue', claimId: randomUUID(), ownerLaunchId: 'dialogue-second' }),
  ])
  assert.deepEqual(results.sort(), ['claimed', 'dialogue_active'])
  await first.releaseSessionActivity(session.id, chat)
  assert.deepEqual((await second.listSessionActivityClaims(session.id)).map((claim) => claim.kind), ['dialogue'])
  assert.equal(await first.claimSessionActivity(session.id, { kind: 'chat', claimId: randomUUID(), ownerLaunchId: 'new-chat' }), 'dialogue_active')
})

test('chat promotion refuses another live chat and leaves both owners unchanged', async (t) => {
  const fixture = createSchedulerFixture('chat-dialogue-other-owner-')
  t.after(fixture.cleanup)
  const store = new FileSystemSessionStore(fixture.workspacePath)
  const session = await store.createSession()
  const chat = { kind: 'chat' as const, claimId: randomUUID(), ownerLaunchId: 'chat-owner' }
  const other = { kind: 'chat' as const, claimId: randomUUID(), ownerLaunchId: 'other-owner' }
  await store.claimSessionActivity(session.id, chat)
  await store.claimSessionActivity(session.id, other)
  assert.equal(await store.promoteSessionChatToDialogue(session.id, chat, { kind: 'dialogue', claimId: randomUUID(), ownerLaunchId: 'dialogue-owner' }), 'chat_active')
  assert.deepEqual((await store.listSessionActivityClaims(session.id)).map((claim) => claim.claimId), [chat.claimId, other.claimId])
})

test('failed dialogue setup atomically restores only its original chat owner', async (t) => {
  const fixture = createSchedulerFixture('chat-dialogue-rollback-')
  t.after(fixture.cleanup)
  const store = new FileSystemSessionStore(fixture.workspacePath)
  const session = await store.createSession()
  const chat = { kind: 'chat' as const, claimId: randomUUID(), ownerLaunchId: 'chat-owner' }
  const dialogue = { kind: 'dialogue' as const, claimId: randomUUID(), ownerLaunchId: 'dialogue-owner' }
  await store.claimSessionActivity(session.id, chat)
  await store.promoteSessionChatToDialogue(session.id, chat, dialogue)
  assert.equal(await store.restoreSessionChatFromDialogue(session.id, { ...dialogue, ownerLaunchId: 'foreign-owner' }, chat), false)
  assert.deepEqual((await store.listSessionActivityClaims(session.id)).map((claim) => claim.claimId), [dialogue.claimId])
  assert.equal(await store.restoreSessionChatFromDialogue(session.id, dialogue, chat), true)
  await store.releaseSessionActivity(session.id, dialogue)
  assert.deepEqual((await store.listSessionActivityClaims(session.id)).map((claim) => claim.claimId), [chat.claimId])
  assert.equal(await store.claimSessionActivity(session.id, { kind: 'dialogue', claimId: randomUUID(), ownerLaunchId: 'competitor' }), 'chat_active')
})
