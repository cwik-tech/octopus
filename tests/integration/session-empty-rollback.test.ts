import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import test from 'node:test'
import type { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { createDialogueFixture } from '../helpers/agent-dialogue-fixture.js'

type Prepare = (store: FileSystemSessionStore, sessionId: string, directory: string, workflowId: string) => Promise<void>

const savedWork: readonly { name: string; prepare: Prepare }[] = [
  ...(['chat', 'task', 'dialogue'] as const).map((kind) => ({
    name: `a live ${kind} claim`,
    prepare: async (store: FileSystemSessionStore, sessionId: string) => {
      assert.equal(await store.claimSessionActivity(sessionId, { kind, claimId: randomUUID(), ownerLaunchId: 'rollback-test' }), 'claimed')
    },
  })),
  { name: 'unreadable saved transcript bytes', prepare: async (_store, _id, directory) => { await fs.writeFile(path.join(directory, 'chat.jsonl'), '{unfinished message') } },
  { name: 'an uploaded attachment', prepare: async (store, sessionId) => { assert.ok(await store.saveUploadedFile(sessionId, { filename: 'keep.txt', contents: Buffer.from('Keep this attachment.') })) } },
  { name: 'a completed workflow task', prepare: async (store, sessionId, _directory, workflowId) => {
    const task = await store.createTaskRecord(sessionId, { workflowId, brief: 'Keep this workflow record after completion.' })
    assert.ok(task)
    assert.ok(await store.updateTaskRecord(sessionId, task.id, { status: 'failed' }))
  } },
  { name: 'other saved session work', prepare: async (_store, _id, directory) => { await fs.writeFile(path.join(directory, 'draft.md'), 'Keep this draft.') } },
]

for (const scenario of savedWork) test(`empty-chat rollback preserves ${scenario.name}`, { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [])
  const directory = path.join(fixture.workspacePath, 'sessions', fixture.session.id)
  await scenario.prepare(fixture.store, fixture.session.id, directory, fixture.workflowId)
  const entries = await fs.readdir(directory)

  const response = await fetch(`${fixture.server.url}/sessions/${fixture.session.id}?onlyIfEmpty=true`, { method: 'DELETE', signal: t.signal })

  assert.equal(response.status, 409, `${scenario.name} must block rollback deletion`)
  assert.deepEqual(await fs.readdir(directory), entries, 'Rollback must preserve every saved entry')
  assert.ok(await fixture.store.getSession(fixture.session.id))
})

test('empty-chat rollback deletes only a blank session and then reports not found', { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [])
  const url = `${fixture.server.url}/sessions/${fixture.session.id}?onlyIfEmpty=true`

  assert.equal((await fetch(url, { method: 'DELETE', signal: t.signal })).status, 204)
  assert.equal(await fixture.store.getSession(fixture.session.id), null)
  assert.equal((await fetch(url, { method: 'DELETE', signal: t.signal })).status, 404)
})

test('an invalid empty-chat rollback flag cannot delete a session', { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [])

  const response = await fetch(`${fixture.server.url}/sessions/${fixture.session.id}?onlyIfEmpty=false`, { method: 'DELETE', signal: t.signal })

  assert.equal(response.status, 400)
  assert.ok(await fixture.store.getSession(fixture.session.id))
})
