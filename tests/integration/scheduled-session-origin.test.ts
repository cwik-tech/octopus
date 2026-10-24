import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { isSessionOrigin } from '../../contracts/sessions.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

const scheduleId = 'sch_00000000-0000-4000-8000-000000000001'

test('scheduled session identity survives renaming and reopening without task admission data', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-session-origin-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const origin = { kind: 'scheduled', scheduleId } as const
  assert.ok(isSessionOrigin(origin), 'A scheduled origin must be accepted by the session boundary')
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({ title: 'Scheduled research', origin })

  await store.updateSessionTitle(session.id, 'Renamed research')
  const reopened = await new FileSystemSessionStore(workspacePath).getSession(session.id)

  assert.equal(reopened?.title, 'Renamed research')
  assert.deepEqual(reopened?.origin, { kind: 'scheduled', scheduleId })
})

for (const [name, origin] of [
  ['missing schedule id', { kind: 'scheduled' }],
  ['path instead of an id', { kind: 'scheduled', scheduleId: '../schedule' }],
  ['wrong id type', { kind: 'scheduled', scheduleId: 42 }],
  ['extra fields', { kind: 'scheduled', scheduleId, taskId: 'task-1' }],
] as const) {
  test(`session origin validation rejects ${name}`, () => {
    assert.equal(isSessionOrigin(origin), false)
  })
}
