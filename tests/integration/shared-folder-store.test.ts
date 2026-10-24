import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { SHARED_FOLDERS_PER_OWNER_LIMIT } from '../../contracts/shared-folders.js'
import { SharedFolderStore } from '../../domains/shared-folders/shared-folder-store.js'

/**
 * A chat's own folder list (LF-18, session part).
 *
 * Real files in a temporary workspace: what matters is what survives a fresh
 * store reading the same disk, which is what an app restart does.
 */

function makeWorkspace(t: TestContext): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-folder-store-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  return workspace
}

test('a folder added to a chat is listed again by a store opened afterwards', async (t) => {
  const workspace = makeWorkspace(t)
  const sessionId = randomUUID()
  const owner = { kind: 'session' as const, sessionId }

  const added = await new SharedFolderStore(workspace).add(owner, {
    canonicalPath: '/Users/example/Contracts 2026',
    label: 'Contracts 2026',
  })
  assert.equal(added.kind, 'added')

  const reopened = await new SharedFolderStore(workspace).list(owner)
  assert.deepEqual(
    reopened.map((folder) => [folder.path, folder.label, folder.access]),
    [['/Users/example/Contracts 2026', 'Contracts 2026', 'read']],
  )
  assert.equal(reopened[0]?.id, added.kind === 'added' ? added.record.id : undefined)
})

test('adding the same folder twice keeps one entry and returns the existing one', async (t) => {
  const store = new SharedFolderStore(makeWorkspace(t))
  const owner = { kind: 'session' as const, sessionId: randomUUID() }
  const first = await store.add(owner, { canonicalPath: '/data/a', label: 'a' })

  const second = await store.add(owner, { canonicalPath: '/data/a', label: 'a' })

  assert.equal(second.kind, 'duplicate')
  assert.equal(second.kind === 'duplicate' ? second.record.id : '', first.kind === 'added' ? first.record.id : 'x')
  assert.equal((await store.list(owner)).length, 1)
})

test('a chat can hold up to the limit of its own folders, and the next one is refused', async (t) => {
  const store = new SharedFolderStore(makeWorkspace(t))
  const owner = { kind: 'session' as const, sessionId: randomUUID() }
  for (let index = 0; index < SHARED_FOLDERS_PER_OWNER_LIMIT; index += 1) {
    assert.equal((await store.add(owner, { canonicalPath: `/data/${index}`, label: `${index}` })).kind, 'added')
  }

  const refused = await store.add(owner, { canonicalPath: '/data/over', label: 'over' })

  assert.equal(refused.kind, 'limit')
  assert.equal((await store.list(owner)).length, SHARED_FOLDERS_PER_OWNER_LIMIT)
})

test('concurrent adds to one chat are all kept', async (t) => {
  const store = new SharedFolderStore(makeWorkspace(t))
  const owner = { kind: 'session' as const, sessionId: randomUUID() }

  await Promise.all(['/data/a', '/data/b', '/data/c'].map((canonicalPath) =>
    store.add(owner, { canonicalPath, label: path.basename(canonicalPath) })))

  assert.deepEqual((await store.list(owner)).map((folder) => folder.path).sort(), ['/data/a', '/data/b', '/data/c'])
})

test('a removed folder is gone, and removing an unknown ID changes nothing', async (t) => {
  const store = new SharedFolderStore(makeWorkspace(t))
  const owner = { kind: 'session' as const, sessionId: randomUUID() }
  const kept = await store.add(owner, { canonicalPath: '/data/keep', label: 'keep' })
  const dropped = await store.add(owner, { canonicalPath: '/data/drop', label: 'drop' })
  assert.ok(kept.kind === 'added' && dropped.kind === 'added')

  assert.equal(await store.remove(owner, dropped.record.id), true)
  assert.equal(await store.remove(owner, 'f_0000000000'), false)

  assert.deepEqual((await store.list(owner)).map((folder) => folder.id), [kept.record.id])
})

test('folder lists of different chats are separate', async (t) => {
  const store = new SharedFolderStore(makeWorkspace(t))
  const first = { kind: 'session' as const, sessionId: randomUUID() }
  const second = { kind: 'session' as const, sessionId: randomUUID() }
  await store.add(first, { canonicalPath: '/data/first', label: 'first' })

  assert.deepEqual(await store.list(second), [])
})

test('a session ID that is not a UUID is refused before any path is built', async (t) => {
  const workspace = makeWorkspace(t)
  const store = new SharedFolderStore(workspace)

  await assert.rejects(
    store.add({ kind: 'session', sessionId: '../escape' }, { canonicalPath: '/data/a', label: 'a' }),
    /session id/i,
  )
  assert.equal(fs.existsSync(path.join(workspace, 'escape')), false)
})

/*
 * A project's folder list (LF-18, project part). It lives beside the project's
 * brief, in `<workspace>/projects/<id>/context/folders.json`
 * (docs/feature-local-folder-access.md, "Where folder lists live").
 */

test('a folder added to a project is listed again by a store opened afterwards, from the project context folder', async (t) => {
  const workspace = makeWorkspace(t)
  const projectId = randomUUID()
  const owner = { kind: 'project' as const, projectId }

  const added = await new SharedFolderStore(workspace).add(owner, {
    canonicalPath: '/Users/example/Brand assets',
    label: 'Brand assets',
  })
  const reopened = await new SharedFolderStore(workspace).list(owner)

  assert.equal(added.kind, 'added')
  assert.deepEqual(
    reopened.map((folder) => [folder.path, folder.label, folder.access]),
    [['/Users/example/Brand assets', 'Brand assets', 'read']],
  )
  assert.equal(fs.existsSync(path.join(workspace, 'projects', projectId, 'context', 'folders.json')), true)
})

test('a project and a chat with the same ID keep separate folder lists', async (t) => {
  const store = new SharedFolderStore(makeWorkspace(t))
  const id = randomUUID()
  await store.add({ kind: 'project', projectId: id }, { canonicalPath: '/data/project-only', label: 'project-only' })

  const chatFolders = await store.list({ kind: 'session', sessionId: id })
  const added = await store.add({ kind: 'session', sessionId: id }, { canonicalPath: '/data/project-only', label: 'project-only' })

  assert.deepEqual(chatFolders, [])
  assert.equal(added.kind, 'added')
})

test('a project ID that is not a UUID is refused before any path is built', async (t) => {
  const workspace = makeWorkspace(t)
  const store = new SharedFolderStore(workspace)

  await assert.rejects(
    store.add({ kind: 'project', projectId: '../escape' }, { canonicalPath: '/data/a', label: 'a' }),
    /project id/i,
  )
  await assert.rejects(store.list({ kind: 'project', projectId: '../../outside' }), /project id/i)
  assert.equal(fs.existsSync(path.join(workspace, 'escape')), false)
  assert.equal(fs.existsSync(path.join(workspace, 'projects')), false)
})

test('a chat ID in another letter case is refused before any path is built', async (t) => {
  const store = new SharedFolderStore(makeWorkspace(t))

  await assert.rejects(
    store.add({ kind: 'session', sessionId: randomUUID().toUpperCase() }, { canonicalPath: '/data/a', label: 'a' }),
    /session id/i,
  )
})
