import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { watch } from 'node:fs'
import { withFileMutationLock } from '../../core/file-mutation.js'
import { sessionActivityClaimsSchema } from '../../contracts/session-activity.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { withSessionChatActivity, type SessionChatActivity } from '../../services/session-activity-service.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'

test('two stores atomically give one dialogue ownership and reject the other', async (t) => {
  const fixture = createSchedulerFixture('session-activity-')
  t.after(fixture.cleanup)
  const first = new FileSystemSessionStore(fixture.workspacePath)
  const second = new FileSystemSessionStore(fixture.workspacePath)
  const session = await first.createSession()

  const results = await Promise.all([
    first.claimSessionActivity(session.id, { kind: 'dialogue', claimId: randomUUID(), ownerLaunchId: 'first-launch' }),
    second.claimSessionActivity(session.id, { kind: 'dialogue', claimId: randomUUID(), ownerLaunchId: 'second-launch' }),
  ])
  assert.deepEqual(results.sort(), ['claimed', 'dialogue_active'])
  assert.equal((await second.listSessionActivityClaims(session.id)).length, 1)
})

test('task snapshot preparation excludes dialogue before the durable task record exists', { timeout: 5_000 }, async (t) => {
  const fixture = createSchedulerFixture('session-activity-preparing-')
  t.after(fixture.cleanup)
  const store = new FileSystemSessionStore(fixture.workspacePath)
  const session = await store.createSession()
  const directory = path.join(fixture.workspacePath, 'sessions', session.id)
  let prepared = () => {}
  const preparationStarted = new Promise<void>((resolve) => { prepared = resolve })
  const watcher = watch(directory, (_event, filename) => { if (filename === 'tasks') prepared() })
  t.after(() => watcher.close())
  let pending: ReturnType<typeof store.createTaskRecord> | undefined

  try {
    await withFileMutationLock(store.inputsDir(session.id), async () => {
      pending = store.createTaskRecord(session.id, { workflowId: fixture.workflowId, brief: 'Prepare a task while inputs are busy.' })
      await preparationStarted
      assert.equal(await store.claimSessionActivity(session.id, { kind: 'dialogue', claimId: randomUUID(), ownerLaunchId: 'dialogue-launch' }), 'tasks_active')
    })
  } finally { await pending }
  assert.equal((await pending)?.status, 'queued')
  assert.deepEqual(await store.listSessionActivityClaims(session.id), [])
})

test('a dialogue record directory cannot alias another directory in its own session', async (t) => {
  const fixture = createSchedulerFixture('session-dialogue-path-')
  t.after(fixture.cleanup)
  const store = new FileSystemSessionStore(fixture.workspacePath)
  const session = await store.createSession()
  const directory = path.join(fixture.workspacePath, 'sessions', session.id)
  await fs.mkdir(path.join(directory, 'another-dialogue-directory'))
  await fs.symlink(path.join(directory, 'another-dialogue-directory'), path.join(directory, 'dialogues'))

  assert.equal(store.dialogueRecordDirectory(session.id), undefined)
})

test('a dangling dialogue directory link is rejected before it can redirect later writes', async (t) => {
  const fixture = createSchedulerFixture('session-dialogue-dangling-')
  t.after(fixture.cleanup)
  const store = new FileSystemSessionStore(fixture.workspacePath)
  const session = await store.createSession()
  const directory = path.join(fixture.workspacePath, 'sessions', session.id)
  await fs.symlink(path.join(directory, 'future-alias'), path.join(directory, 'dialogues'))

  assert.equal(store.dialogueRecordDirectory(session.id), undefined)
})

test('a session alias cannot claim activity or redirect new dialogue records into another session', async (t) => {
  const fixture = createSchedulerFixture('session-activity-alias-')
  t.after(fixture.cleanup)
  const store = new FileSystemSessionStore(fixture.workspacePath)
  const session = await store.createSession()
  const other = await store.createSession()
  const otherClaim = { kind: 'dialogue' as const, claimId: randomUUID(), ownerLaunchId: 'other-launch' }
  assert.equal(await store.claimSessionActivity(other.id, otherClaim), 'claimed')
  const directory = path.join(fixture.workspacePath, 'sessions', session.id)
  await fs.rm(directory, { recursive: true })
  await fs.symlink(path.join(fixture.workspacePath, 'sessions', other.id), directory)

  assert.equal(await store.claimSessionActivity(session.id, { kind: 'chat', claimId: randomUUID(), ownerLaunchId: 'alias-launch' }), 'not_found')
  assert.equal(store.dialogueRecordDirectory(session.id), undefined)
  await store.releaseSessionActivity(session.id, otherClaim)
  assert.deepEqual(await store.listSessionActivityClaims(session.id), [])
  assert.equal((await store.listSessionActivityClaims(other.id))[0]?.claimId, otherClaim.claimId)
})

test('a task preparation failure survives a second failure while releasing ownership', async (t) => {
  const fixture = createSchedulerFixture('session-activity-release-failure-')
  t.after(fixture.cleanup)
  const store = new FileSystemSessionStore(fixture.workspacePath)
  const session = await store.createSession()
  const cause = new Error('Task preparation was refused before commit.')
  const claimsPath = path.join(fixture.workspacePath, 'sessions', session.id, 'activity-claims.json')
  const outsideClaims = path.join(fixture.workspacePath, 'other-claims.json')
  await fs.writeFile(outsideClaims, '[]')

  await assert.rejects(
    store.createTaskRecord(session.id, { workflowId: fixture.workflowId, brief: 'Refuse this task before commit.' }, {
      beforeCommit: async () => {
        await fs.unlink(claimsPath)
        await fs.symlink(outsideClaims, claimsPath)
        throw cause
      },
    }),
    (error: unknown) => error === cause,
  )
})

test('a chat failure survives a second failure while releasing ownership', async (t) => {
  const fixture = createSchedulerFixture('session-chat-release-failure-')
  t.after(fixture.cleanup)
  const store = new FileSystemSessionStore(fixture.workspacePath)
  const session = await store.createSession()
  const cause = new Error('Chat generation failed.')
  const claimsPath = path.join(fixture.workspacePath, 'sessions', session.id, 'activity-claims.json')
  const outsideClaims = path.join(fixture.workspacePath, 'other-claims.json')
  await fs.writeFile(outsideClaims, '[]')

  await assert.rejects(
    withSessionChatActivity(store, session.id, async () => {
      await fs.unlink(claimsPath)
      await fs.symlink(outsideClaims, claimsPath)
      throw cause
    }),
    (error: unknown) => error === cause,
  )
})

test('a published chat survives failed cleanup while retaining ownership and refusing a deferred start', async (t) => {
  const fixture = createSchedulerFixture('session-chat-published-release-failure-')
  t.after(fixture.cleanup)
  const store = new FileSystemSessionStore(fixture.workspacePath)
  const session = await store.createSession()
  const locksPath = path.join(fixture.workspacePath, 'sessions', '.locks')
  const claimsPath = path.join(fixture.workspacePath, 'sessions', session.id, 'activity-claims.json')
  let exposeActivity = (_activity: SessionChatActivity) => {}
  const started = new Promise<SessionChatActivity>((resolve) => { exposeActivity = resolve })
  const reply = { id: 'published-reply', role: 'assistant' as const, text: 'The answer is already durable.', createdAt: '2026-10-10T00:00:00.000Z' }

  const result = await withSessionChatActivity(store, session.id, async (activity) => {
    exposeActivity(activity)
    assert.equal(await store.appendChatMessageIfAbsent(session.id, reply), 'appended')
    // The reply is durable before the shared lock directory becomes unusable.
    // Cleanup must remain fail-closed without erasing that published result.
    await fs.rm(locksPath, { recursive: true, force: true })
    await fs.writeFile(locksPath, '')
    return reply.text
  })

  const activity = await started
  assert.equal(result, 'The answer is already durable.')
  assert.equal(await activity.completion, false, 'failed cleanup must not authorize deferred dialogue generation')
  assert.deepEqual(sessionActivityClaimsSchema.parse(JSON.parse(await fs.readFile(claimsPath, 'utf8'))), [
    { ...activity.claim, processId: process.pid },
  ])
  assert.deepEqual((await store.listChatMessages(session.id)).map((message) => message.text), ['The answer is already durable.'])

  // Repairing the lock storage does not erase the exact unreleased claim.
  await fs.unlink(locksPath)
  assert.equal(await store.claimSessionActivity(session.id, { kind: 'dialogue', claimId: randomUUID(), ownerLaunchId: 'another-launch' }), 'chat_active')
  await store.releaseSessionActivity(session.id, activity.claim)
  assert.deepEqual(await store.listSessionActivityClaims(session.id), [])
})

test('an old dialogue release cannot clear a newer claim or let locked deletion remove its session', async (t) => {
  const fixture = createSchedulerFixture('session-activity-release-')
  t.after(fixture.cleanup)
  const store = new FileSystemSessionStore(fixture.workspacePath)
  const reopened = new FileSystemSessionStore(fixture.workspacePath)
  const session = await store.createSession()
  const old = { kind: 'dialogue' as const, claimId: randomUUID(), ownerLaunchId: 'old-launch' }
  const next = { kind: 'dialogue' as const, claimId: randomUUID(), ownerLaunchId: 'new-launch' }
  assert.equal(await store.claimSessionActivity(session.id, old), 'claimed')
  await store.releaseSessionActivity(session.id, old)
  assert.equal(await reopened.claimSessionActivity(session.id, next), 'claimed')

  await store.releaseSessionActivity(session.id, old)
  assert.deepEqual(await reopened.deleteSessionIfNoActiveTasks(session.id), { deleted: false, reason: 'dialogue_active' })
  assert.equal((await reopened.listSessionActivityClaims(session.id))[0]?.claimId, next.claimId)
  assert.ok(await reopened.getSession(session.id))
})

test('each in-flight chat keeps dialogue excluded until that exact request releases its claim', async (t) => {
  const fixture = createSchedulerFixture('session-activity-chat-')
  t.after(fixture.cleanup)
  const store = new FileSystemSessionStore(fixture.workspacePath)
  const session = await store.createSession()
  const first = { kind: 'chat' as const, claimId: randomUUID(), ownerLaunchId: 'chat-launch' }
  const second = { kind: 'chat' as const, claimId: randomUUID(), ownerLaunchId: 'chat-launch' }
  const dialogue = { kind: 'dialogue' as const, claimId: randomUUID(), ownerLaunchId: 'dialogue-launch' }
  assert.equal(await store.claimSessionActivity(session.id, first), 'claimed')
  assert.equal(await store.claimSessionActivity(session.id, second), 'claimed')
  assert.equal(await store.claimSessionActivity(session.id, dialogue), 'chat_active')
  await store.releaseSessionActivity(session.id, first)
  assert.equal(await store.claimSessionActivity(session.id, dialogue), 'chat_active')
  await store.releaseSessionActivity(session.id, second)
  assert.equal(await store.claimSessionActivity(session.id, dialogue), 'claimed')
})
