/**
 * An acknowledged message is a durable message.
 *
 * `appendChatMessageIfAbsent` is what a turn is replayed against, so `appended`
 * is not "the bytes are visible" — it is a promise that the line survives power
 * loss. Flushing the file is only half of that: until the directory entry that
 * names the file is flushed too, the first message of a session can be on disk
 * with nothing pointing at it, and the transcript comes back as a conversation
 * that never said anything.
 *
 * The retry is the harder half. An attempt that wrote its bytes and then failed
 * at the barrier leaves a line that is visible and not durable. A retry that
 * sees it and answers `already-present` converts that failure into a success
 * nobody checked, which is worse than the original fault.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import type { ChatMessage } from '../../contracts/sessions.js'

const CASE_TIMEOUT_MS = 20_000

function makeWorkspace(prefix: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(workspacePath, { recursive: true })
  return { directory, workspacePath }
}

const line = (id: string): ChatMessage => ({
  id,
  role: 'assistant',
  text: 'answered',
  createdAt: '2026-08-26T00:00:00.000Z',
})

/**
 * A store whose only substitution is the durability barrier itself.
 *
 * Everything the transcript does — the lock, the no-follow open, the append,
 * the file flush, the read-back — is the real thing. The one boundary a test
 * cannot otherwise reach is whether the directory entry was flushed, because
 * no filesystem call reports that after the fact.
 */
function storeWithBarrier(workspacePath: string) {
  const synced: string[] = []
  let failing = false
  const store = new FileSystemSessionStore(workspacePath, {
    syncDirectoryOfFile: async (filePath: string) => {
      if (failing) throw new Error('the directory entry could not be flushed')
      synced.push(filePath)
    },
  })
  return {
    store,
    synced,
    fail: () => {
      failing = true
    },
    recover: () => {
      failing = false
    },
  }
}

test(
  'a first message is not acknowledged when its name cannot be made durable',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath } = makeWorkspace('transcript-barrier-')
    const barrier = storeWithBarrier(workspacePath)
    try {
      const session = await barrier.store.createSession({ title: 'barrier' })
      barrier.fail()
      await assert.rejects(
        barrier.store.appendChatMessageIfAbsent(session.id, line('message-1')),
        'a message whose name may not survive is not an appended message',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a retry does not acknowledge a line whose barrier never completed',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath } = makeWorkspace('transcript-retry-')
    const barrier = storeWithBarrier(workspacePath)
    try {
      const session = await barrier.store.createSession({ title: 'retry' })
      const message = line('message-1')

      barrier.fail()
      await assert.rejects(
        barrier.store.appendChatMessageIfAbsent(session.id, message),
      )
      // The bytes really are there — that is the whole difficulty.
      const chatPath = path.join(workspacePath, 'sessions', session.id, 'chat.jsonl')
      assert.match(fs.readFileSync(chatPath, 'utf8'), /message-1/)

      // The retry finds the line and must not simply agree that it is durable.
      await assert.rejects(
        barrier.store.appendChatMessageIfAbsent(session.id, message),
        'a retry inherits the barrier the first attempt did not clear',
      )

      // Once the barrier can complete, the retry is free to acknowledge.
      barrier.recover()
      const after = barrier.synced.length
      assert.equal(
        await barrier.store.appendChatMessageIfAbsent(session.id, message),
        'already-present',
      )
      assert.ok(
        barrier.synced.length > after,
        'and it acknowledges only after flushing what it found',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a later message needs no new directory barrier',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // The entry that names the transcript is created once. Paying for it on
    // every append would make the cost of a conversation grow with its length
    // for no added guarantee.
    const { directory, workspacePath } = makeWorkspace('transcript-later-')
    const barrier = storeWithBarrier(workspacePath)
    try {
      const session = await barrier.store.createSession({ title: 'later' })
      assert.equal(
        await barrier.store.appendChatMessageIfAbsent(session.id, line('message-1')),
        'appended',
      )
      const afterFirst = barrier.synced.length
      assert.ok(afterFirst > 0, 'the first message flushes the name')

      barrier.fail()
      assert.equal(
        await barrier.store.appendChatMessageIfAbsent(session.id, line('message-2')),
        'appended',
        'a second message writes into a name that is already durable',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
