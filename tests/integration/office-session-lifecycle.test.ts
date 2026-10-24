import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { beginSessionWork } from '../../domains/sessions/session-work-lifecycle.js'

test('single, bulk and direct deletion cancel owned work before removing its session', async (t) => {
  for (const mode of ['single', 'bulk', 'direct'] as const) await t.test(mode, async (t) => {
    const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'office-delete-')))
    t.after(() => fs.rm(workspace, { recursive: true, force: true }))
    const store = new FileSystemSessionStore(workspace)
    const session = await store.createSession({ title: 'Owned work' })
    const work = beginSessionWork(workspace, session.id, new AbortController().signal)
    assert.ok(work)
    const aborted = new Promise<void>((resolve) => work.signal.addEventListener('abort', () => resolve(), { once: true }))
    const deletion = mode === 'single' ? store.deleteSessionIfNoActiveTasks(session.id) : mode === 'bulk' ? store.deleteSessionsIfNoActiveTasks([session.id]) : store.deleteSession(session.id)
    await Promise.race([aborted, deletion.then(() => assert.fail('Deletion completed without cancelling owned work'))])
    assert.ok(await store.getSession(session.id), 'Session must exist until cleanup completes')
    assert.equal(beginSessionWork(workspace, session.id, new AbortController().signal), undefined)
    work.finish()
    await deletion
    assert.equal(await store.getSession(session.id), null)
  })
})

test('direct deletion returns false for an invalid session ID without creating lifecycle state', async (t) => {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'office-delete-invalid-')))
  t.after(() => fs.rm(workspace, { recursive: true, force: true }))
  const store = new FileSystemSessionStore(workspace)

  assert.equal(await store.deleteSession('not-a-session-id'), false)
  assert.deepEqual(await fs.readdir(workspace), [])
})
