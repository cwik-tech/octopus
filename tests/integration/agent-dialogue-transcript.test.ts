import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

test('dialogue user and heard assistant messages survive a new store instance', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogue-transcript-'))
  const store = new FileSystemSessionStore(directory)
  try {
    const session = await store.createSession({ title: 'Dialogue' })
    const dialogueId = randomUUID()
    const user = {
      id: `${dialogueId}:user:topic`, role: 'user' as const, text: 'Consider price', createdAt: '2026-10-09T00:00:00Z',
      schemaVersion: 2 as const, kind: 'chat' as const, source: { kind: 'agent-dialogue' as const, dialogueId, slot: 0 },
    }
    const assistant = {
      id: `${dialogueId}:reply:0`, role: 'assistant' as const, text: 'Start with costs', createdAt: '2026-10-09T00:00:01Z',
      schemaVersion: 2 as const, kind: 'chat' as const, source: { kind: 'agent-dialogue' as const, dialogueId, slot: 0 },
      turnId: `${dialogueId}:slot:0`, speaker: { id: 'alpha', name: 'Alpha', type: 'agent' as const }, cutOff: { heardChars: 16 },
    }

    assert.equal(await store.appendChatMessageIfAbsent(session.id, user), 'appended')
    assert.equal(await store.appendChatMessageIfAbsent(session.id, assistant), 'appended')
    assert.deepEqual(await new FileSystemSessionStore(directory).listChatMessages(session.id), [user, assistant])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
