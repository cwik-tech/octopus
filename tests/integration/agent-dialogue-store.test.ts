import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { agentDialogueRecordSchema } from '../../contracts/agent-dialogue.js'
import { FileSystemDialogueStore } from '../../services/agent-dialogue-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

test('a saved dialogue remains discoverable after creating a new store', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogue-store-'))
  try {
    const sessions = new FileSystemSessionStore(directory)
    const session = await sessions.createSession({ title: 'Dialogue' })
    const record = agentDialogueRecordSchema.parse({
      schemaVersion: 1, dialogueId: randomUUID(), sessionId: session.id, topic: 'Pricing', delivery: 'text',
      participants: [{ id: 'alpha', label: 'Alpha', active: true, consecutiveFailures: 0 }, { id: 'beta', label: 'Beta', active: true, consecutiveFailures: 0 }],
      limits: { maxTurns: 12, runningMs: 0 }, status: 'running', nextSlot: 0, replyCount: 0, passStreak: 0, nextSpeaker: 0, epoch: 0,
      ownerLaunchId: randomUUID(), createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', stopRequested: false, events: [],
    })

    assert.equal(await new FileSystemDialogueStore(directory, sessions).save(record), true)
    const reloaded = new FileSystemDialogueStore(directory, new FileSystemSessionStore(directory))
    assert.deepEqual(await reloaded.get(session.id, record.dialogueId), record)
    assert.deepEqual(await reloaded.list(session.id), [record])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
