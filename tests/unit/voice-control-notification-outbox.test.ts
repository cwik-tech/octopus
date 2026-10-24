import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { NotificationOutbox, type OutboxEntry } from '../../domains/voice-control/notification-outbox.js'

function makeEntry(key: string, speech: string): Omit<OutboxEntry, 'state' | 'settledAt'> {
  return {
    key,
    sessionId: 'session-1',
    taskId: 'task-1',
    taskStatus: 'done',
    notify: {
      source: { appId: 'octopus', name: 'Octopus' },
      subject: { type: 'task', id: 'task-1', label: 'Research' },
      kind: 'needs_review',
      title: 'Research is done',
      speech,
      priority: 'normal',
      actions: [],
      dedupeKey: key,
    },
    createdAt: '2026-10-09T10:00:00.000Z',
    taskChangedAt: '2026-10-09T10:00:00.000Z',
  }
}

test('an entry the contract refuses is not kept, and later entries are still recorded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-outbox-'))
  const file = path.join(dir, 'outbox.json')
  try {
    const outbox = await NotificationOutbox.open(file, new Date('2026-10-09T09:00:00.000Z'))

    await assert.rejects(outbox.record(makeEntry('too-long', 'x'.repeat(2_001))))
    assert.equal(outbox.has('too-long'), false)

    await outbox.record(makeEntry('fine', 'Research is finished.'))

    const reopened = await NotificationOutbox.open(file, new Date())
    assert.equal(reopened.has('fine'), true)
    assert.equal(reopened.has('too-long'), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
