/**
 * A transcript line means what its version says it means.
 *
 * `schemaVersion` is absent on every line written before conversations
 * existed, and the reader treats absence as version 1. That only holds if a
 * line cannot carry version-2 fields without declaring version 2: a line with a
 * conversation pointer and no version is one that two readers disagree about —
 * an old build ignores the pointer, a new build follows it — and the pointer is
 * what leads an operator from a reply to its durable evidence.
 *
 * So an undeclared conversation field is not a field to ignore. It is a line
 * whose meaning depends on rules it never claimed, and the only safe reading of
 * it is none.
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

/** Every field a version-1 reader could not have understood. */
function undeclaredConversationFields(
  turnId: string,
  conversationId: string,
): readonly { readonly name: string; readonly line: Record<string, unknown> }[] {
  return [
    { name: 'conversationId', line: { conversationId } },
    { name: 'kind', line: { kind: 'chat' } },
    {
      name: 'source',
      line: { source: { kind: 'conversation-turn', turnId } },
    },
    {
      name: 'conversation',
      line: {
        conversation: { conversationId, activityId: turnId, turnId },
      },
    },
  ]
}

test(
  'a transcript line carrying conversation fields without the version is not read',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath } = makeWorkspace('transcript-v1-mix-')
    const store = new FileSystemSessionStore(workspacePath)
    try {
      const session = await store.createSession({ title: 'mixing' })
      const turnId = randomUUID()
      const chatPath = path.join(workspacePath, 'sessions', session.id, 'chat.jsonl')
      const fields = undeclaredConversationFields(turnId, session.id)
      fs.writeFileSync(
        chatPath,
        `${[
          // A genuine version-1 line, so the reader is not simply refusing
          // everything.
          JSON.stringify({
            id: 'plain-v1',
            role: 'user',
            text: 'written before conversations existed',
            createdAt: '2026-08-26T00:00:00.000Z',
          }),
          ...fields.map((field) =>
            JSON.stringify({
              id: `undeclared-${field.name}`,
              role: 'assistant',
              text: 'a line whose meaning depends on a version it never claimed',
              createdAt: '2026-08-26T00:00:01.000Z',
              turnId,
              ...field.line,
            }),
          ),
        ].join('\n')}\n`,
      )

      const read = (await store.listChatMessages(session.id)).map(
        (message) => message.id,
      )
      assert.deepEqual(
        read,
        ['plain-v1'],
        `every undeclared conversation field must be refused; saw ${read.join(', ')}`,
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'the writer refuses a message carrying conversation fields without the version',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath } = makeWorkspace('transcript-v1-write-')
    const store = new FileSystemSessionStore(workspacePath)
    try {
      const session = await store.createSession({ title: 'refusal' })
      const turnId = randomUUID()
      for (const field of undeclaredConversationFields(turnId, session.id)) {
        // Type-legal — every conversation field is optional on `ChatMessage` —
        // and that is the point: the version is what makes them meaningful, so
        // the store is where the pairing has to be enforced.
        const message: ChatMessage = {
          id: `undeclared-${field.name}`,
          role: 'assistant',
          text: 'a reply the reader would have to guess at',
          createdAt: '2026-08-26T00:00:01.000Z',
          turnId,
          ...field.line,
        }
        assert.equal(
          await store.appendChatMessageIfAbsent(session.id, message),
          'invalid-message',
          `a message carrying ${field.name} without schemaVersion must be refused`,
        )
      }
      assert.equal(
        (await store.listChatMessages(session.id)).length,
        0,
        'and nothing a refused write carried reaches the transcript',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a declared version-2 line is still written and read whole',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath } = makeWorkspace('transcript-v2-')
    const store = new FileSystemSessionStore(workspacePath)
    try {
      const session = await store.createSession({ title: 'v2' })
      const turnId = randomUUID()
      const message: ChatMessage = {
        id: `${turnId}:assistant:0`,
        role: 'assistant',
        text: 'answered',
        createdAt: '2026-08-26T00:00:01.000Z',
        turnId,
        schemaVersion: 2,
        conversationId: session.id,
        kind: 'chat',
        source: { kind: 'conversation-turn', turnId },
        conversation: {
          conversationId: session.id,
          activityId: turnId,
          turnId,
        },
      }
      assert.equal(
        await store.appendChatMessageIfAbsent(session.id, message),
        'appended',
      )
      assert.deepEqual(await store.listChatMessages(session.id), [message])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)


test(
  'a version-2 line carrying a field it cannot read is refused, not stripped',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // Dropping the unreadable field and keeping the line is the dangerous half
    // measure the version-2 rule already rejects elsewhere: a reply whose
    // pointer was quietly discarded reads as a reply with no durable evidence,
    // which is precisely what a caller checking a replay concludes about a
    // turn that never ran.
    const { directory, workspacePath } = makeWorkspace('transcript-v2-broken-')
    const store = new FileSystemSessionStore(workspacePath)
    try {
      const session = await store.createSession({ title: 'broken fields' })
      const turnId = randomUUID()
      const v2 = (extra: Record<string, unknown>): Record<string, unknown> => ({
        role: 'assistant',
        text: 'answered',
        createdAt: '2026-08-26T00:00:01.000Z',
        turnId,
        schemaVersion: 2,
        conversationId: session.id,
        kind: 'chat',
        source: { kind: 'conversation-turn', turnId },
        ...extra,
      })
      const broken = [
        {
          name: 'conversation',
          extra: {
            conversation: { conversationId: 1, activityId: turnId, turnId },
          },
        },
        { name: 'execution', extra: { execution: { runId: turnId } } },
        { name: 'turnRequest', extra: { turnRequest: { fingerprint: 'f' } } },
        { name: 'speaker', extra: { speaker: { type: 'agent' } } },
        {
          name: 'delivery',
          extra: { delivery: { taskId: 'task-1', artifacts: 'not a list' } },
        },
        {
          name: 'outcome',
          extra: {
            outcome: { taskId: 'task-1', status: 'nope', workflowId: 'w' },
          },
        },
      ]
      const chatPath = path.join(workspacePath, 'sessions', session.id, 'chat.jsonl')
      fs.writeFileSync(
        chatPath,
        `${[
          JSON.stringify(v2({ id: 'sound-v2' })),
          ...broken.map((entry) =>
            JSON.stringify(v2({ id: `broken-${entry.name}`, ...entry.extra })),
          ),
        ].join('\n')}\n`,
      )

      const read = (await store.listChatMessages(session.id)).map(
        (message) => message.id,
      )
      assert.deepEqual(
        read,
        ['sound-v2'],
        `a version-2 line is all or nothing; saw ${read.join(', ')}`,
      )

      // And the writer will not create one. An empty pointer field is
      // type-legal and unreadable, which is exactly the shape a partial write
      // or a wrong caller produces.
      assert.equal(
        await store.appendChatMessageIfAbsent(session.id, {
          id: 'written-broken-pointer',
          role: 'assistant',
          text: 'answered',
          createdAt: '2026-08-26T00:00:01.000Z',
          turnId,
          schemaVersion: 2,
          conversationId: session.id,
          kind: 'chat',
          source: { kind: 'conversation-turn', turnId },
          conversation: { conversationId: '', activityId: turnId, turnId },
        }),
        'invalid-message',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a version-2 line that does not name what produced it is refused',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // Phase 1 writes only `kind: 'chat'` with a `conversation-turn` source, and
    // the source is what the turn agreement is checked against. A version-2
    // line without one is a conversation line that cannot say which turn it
    // belongs to, which no reader can safely place.
    const { directory, workspacePath } = makeWorkspace('transcript-v2-source-')
    const store = new FileSystemSessionStore(workspacePath)
    try {
      const session = await store.createSession({ title: 'no source' })
      const turnId = randomUUID()
      const chatPath = path.join(workspacePath, 'sessions', session.id, 'chat.jsonl')
      fs.writeFileSync(
        chatPath,
        `${JSON.stringify({
          id: 'sourceless-v2',
          role: 'assistant',
          text: 'answered',
          createdAt: '2026-08-26T00:00:01.000Z',
          turnId,
          schemaVersion: 2,
          conversationId: session.id,
          kind: 'chat',
        })}\n`,
      )
      assert.deepEqual(await store.listChatMessages(session.id), [])

      assert.equal(
        await store.appendChatMessageIfAbsent(session.id, {
          id: 'sourceless-v2',
          role: 'assistant',
          text: 'answered',
          createdAt: '2026-08-26T00:00:01.000Z',
          turnId,
          schemaVersion: 2,
          conversationId: session.id,
          kind: 'chat',
        }),
        'invalid-message',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
