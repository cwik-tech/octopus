/**
 * The transcript as a durability boundary.
 *
 * `appendChatMessage` is a bare `fs.appendFile` with no duplicate check and no
 * flush, which is fine for a display transcript and not fine for anything a
 * replay depends on. `appendChatMessageIfAbsent` is the version a turn can be
 * replayed against, and these tests are what make that claim checkable.
 *
 * Also covered: a legacy line written before the conversation pointer existed
 * still reloads, because a transcript is read for the life of its session and
 * old lines outnumber new ones for a long time.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { withFileLock } from '../../domains/sessions/session-file-locks.js'
import { enrichHistoryWithDeliveryContent } from '../../services/delivery-context.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import type { ChatMessage } from '../../contracts/sessions.js'

function makeWorkspace(prefix: string): { directory: string; workspacePath: string } {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(workspacePath, { recursive: true })
  return { directory, workspacePath }
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message-1',
    role: 'user',
    text: 'hello',
    createdAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  }
}

test('the same message id with the same content is recognised as a replay', async () => {
  const { directory, workspacePath } = makeWorkspace('transcript-idempotent-')
  const store = new FileSystemSessionStore(workspacePath)
  try {
    const session = await store.createSession({ title: 'idempotent' })
    const line = message({ turnId: 'turn-1' })

    assert.equal(await store.appendChatMessageIfAbsent(session.id, line), 'appended')
    assert.equal(
      await store.appendChatMessageIfAbsent(session.id, line),
      'already-present',
    )
    assert.equal((await store.listChatMessages(session.id)).length, 1)

    // Key order alone is not a conflict; the content is what matters.
    const reordered: ChatMessage = {
      turnId: 'turn-1',
      createdAt: line.createdAt,
      text: line.text,
      role: line.role,
      id: line.id,
    }
    assert.equal(
      await store.appendChatMessageIfAbsent(session.id, reordered),
      'already-present',
    )
    assert.equal((await store.listChatMessages(session.id)).length, 1)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('reusing a message id for different content fails closed', async () => {
  const { directory, workspacePath } = makeWorkspace('transcript-conflict-')
  const store = new FileSystemSessionStore(workspacePath)
  try {
    const session = await store.createSession({ title: 'conflict' })
    assert.equal(
      await store.appendChatMessageIfAbsent(session.id, message()),
      'appended',
    )
    assert.equal(
      await store.appendChatMessageIfAbsent(
        session.id,
        message({ text: 'something else entirely' }),
      ),
      'conflict',
      'history is never overwritten',
    )

    const reloaded = await store.listChatMessages(session.id)
    assert.equal(reloaded.length, 1)
    assert.equal(reloaded[0]?.text, 'hello', 'the original line is untouched')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('concurrent duplicates cannot both append', async () => {
  const { directory, workspacePath } = makeWorkspace('transcript-concurrent-')
  const store = new FileSystemSessionStore(workspacePath)
  try {
    const session = await store.createSession({ title: 'concurrent' })
    const line = message()

    const outcomes = await Promise.all(
      new Array(8).fill(0).map(() => store.appendChatMessageIfAbsent(session.id, line)),
    )
    assert.equal(
      outcomes.filter((outcome) => outcome === 'appended').length,
      1,
      'exactly one writer may win',
    )
    assert.equal(
      outcomes.filter((outcome) => outcome === 'already-present').length,
      7,
    )
    assert.equal((await store.listChatMessages(session.id)).length, 1)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a conversation pointer survives a reload, and a legacy line still reads', async () => {
  const { directory, workspacePath } = makeWorkspace('transcript-pointer-')
  const store = new FileSystemSessionStore(workspacePath)
  try {
    const session = await store.createSession({ title: 'pointers' })

    // A line from before the conversation pointer existed, written straight to
    // the file the way the old append did.
    const chatPath = path.join(workspacePath, 'sessions', session.id, 'chat.jsonl')
    fs.appendFileSync(
      chatPath,
      `${JSON.stringify({
        id: 'legacy-1',
        role: 'assistant',
        text: 'written before conversations existed',
        createdAt: '2026-08-01T00:00:00.000Z',
      })}\n`,
      'utf8',
    )

    const activityId = randomUUID()
    assert.equal(
      await store.appendChatMessageIfAbsent(
        session.id,
        message({
          id: 'message-2',
          role: 'assistant',
          text: 'answered',
          // A pointer is a version-2 field, so the line has to say so. A line
          // that carries one without declaring the version is read one way by
          // an old build and another by this one.
          schemaVersion: 2,
          conversationId: session.id,
          kind: 'chat',
          source: { kind: 'conversation-turn', turnId: activityId },
          turnId: activityId,
          conversation: {
            conversationId: session.id,
            activityId,
            turnId: activityId,
          },
        }),
      ),
      'appended',
    )

    const reloaded = await store.listChatMessages(session.id)
    assert.equal(reloaded.length, 2, 'a legacy line is still readable')
    assert.equal(reloaded[0]?.id, 'legacy-1')
    assert.equal(reloaded[0]?.conversation, undefined)
    assert.deepEqual(reloaded[1]?.conversation, {
      conversationId: session.id,
      activityId,
      turnId: activityId,
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a malformed conversation pointer is refused, not quietly dropped', async () => {
  const { directory, workspacePath } = makeWorkspace('transcript-bad-pointer-')
  const store = new FileSystemSessionStore(workspacePath)
  try {
    const session = await store.createSession({ title: 'bad pointer' })
    const chatPath = path.join(workspacePath, 'sessions', session.id, 'chat.jsonl')
    fs.appendFileSync(
      chatPath,
      `${[
        // A real version-1 line, so what follows is not refused by a reader
        // that simply refuses everything.
        JSON.stringify({
          id: 'message-legacy',
          role: 'assistant',
          text: 'written before conversations existed',
          createdAt: '2026-08-26T00:00:00.000Z',
        }),
        JSON.stringify({
          id: 'message-3',
          role: 'assistant',
          text: 'carries a pointer it never declared',
          createdAt: '2026-08-26T00:00:00.000Z',
          conversation: { conversationId: '', activityId: 5, turnId: null },
        }),
      ].join('\n')}\n`,
      'utf8',
    )

    // Keeping the text and dropping the pointer looks safe and is not: the
    // line then reads as an ordinary reply with no evidence behind it, which is
    // exactly what a caller checking a replay would conclude. Whatever wrote
    // this knew about conversations and did not say so, and there is no reading
    // of that which is safe to hand on.
    const reloaded = await store.listChatMessages(session.id)
    assert.deepEqual(
      reloaded.map((entry) => entry.id),
      ['message-legacy'],
      'a line carrying an undeclared pointer is not read at all',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('an unknown session is reported rather than silently succeeding', async () => {
  const { directory, workspacePath } = makeWorkspace('transcript-unknown-')
  const store = new FileSystemSessionStore(workspacePath)
  try {
    assert.equal(
      await store.appendChatMessageIfAbsent(randomUUID(), message()),
      'unknown-session',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a v2 line round-trips and a v1 line beside it is unchanged', async () => {
  const { directory, workspacePath } = makeWorkspace('transcript-v2-')
  const store = new FileSystemSessionStore(workspacePath)
  try {
    const session = await store.createSession({ title: 'v2' })
    const chatPath = path.join(workspacePath, 'sessions', session.id, 'chat.jsonl')

    // A line from before versions existed.
    fs.appendFileSync(
      chatPath,
      `${JSON.stringify({
        id: 'v1-line',
        role: 'user',
        text: 'older than the contract',
        createdAt: '2026-08-01T00:00:00.000Z',
      })}\n`,
      'utf8',
    )

    assert.equal(
      await store.appendChatMessageIfAbsent(
        session.id,
        message({
          id: 'v2-line',
          role: 'assistant',
          text: 'newer',
          schemaVersion: 2,
          conversationId: session.id,
          kind: 'chat',
          source: { kind: 'conversation-turn', turnId: 'turn-1' },
          turnId: 'turn-1',
        }),
      ),
      'appended',
    )

    const reloaded = await store.listChatMessages(session.id)
    assert.equal(reloaded.length, 2)

    const legacy = reloaded[0]
    assert.equal(legacy?.schemaVersion, undefined, 'absence means version 1')
    assert.equal(legacy?.kind, undefined)
    assert.equal(legacy?.source, undefined)

    const current = reloaded[1]
    assert.equal(current?.schemaVersion, 2)
    assert.equal(current?.conversationId, session.id)
    assert.equal(current?.kind, 'chat')
    assert.deepEqual(current?.source, {
      kind: 'conversation-turn',
      turnId: 'turn-1',
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a version-2 line this build cannot fully understand is not read at all', async () => {
  const { directory, workspacePath } = makeWorkspace('transcript-v2-bad-')
  const store = new FileSystemSessionStore(workspacePath)
  try {
    const session = await store.createSession({ title: 'bad v2' })
    const chatPath = path.join(workspacePath, 'sessions', session.id, 'chat.jsonl')

    // Dropping the fields nobody understood and keeping the message was the
    // dangerous half-measure. Every reader downstream selects by role, so a
    // line whose kind said it was not ordinary chat came back looking exactly
    // like ordinary chat and went into the next prompt — which is precisely the
    // silent context change the kind exists to prevent.
    const suspect: readonly [string, Record<string, unknown>][] = [
      [
        'a kind from a later phase',
        { kind: 'a-kind-from-a-later-phase', source: { kind: 'conversation-turn', turnId: 't' }, conversationId: 'c', turnId: 't' },
      ],
      [
        'a source with no turn',
        { kind: 'chat', source: { kind: 'conversation-turn' }, conversationId: 'c', turnId: 't' },
      ],
      [
        'no conversation at all',
        { kind: 'chat', source: { kind: 'conversation-turn', turnId: 't' }, turnId: 't' },
      ],
      [
        'a source naming a different turn',
        { kind: 'chat', source: { kind: 'conversation-turn', turnId: 'another' }, conversationId: 'c', turnId: 't' },
      ],
    ]
    for (const [why, fields] of suspect) {
      fs.appendFileSync(
        chatPath,
        `${JSON.stringify({
          id: `suspect-${why.replace(/\s+/g, '-')}`,
          role: 'assistant',
          text: 'this must not reach a prompt',
          createdAt: '2026-08-26T00:00:00.000Z',
          schemaVersion: 2,
          ...fields,
        })}\n`,
        'utf8',
      )
    }
    // A version this build has never heard of is the same problem in a more
    // obvious form: whatever it means, it is not something to guess at.
    fs.appendFileSync(
      chatPath,
      `${JSON.stringify({
        id: 'from-the-future',
        role: 'assistant',
        text: 'this must not reach a prompt',
        createdAt: '2026-08-26T00:00:00.000Z',
        schemaVersion: 3,
        conversationId: 'c',
        kind: 'chat',
        source: { kind: 'conversation-turn', turnId: 't' },
        turnId: 't',
      })}\n`,
      'utf8',
    )
    // And one line from before any of this existed, which must still read.
    fs.appendFileSync(
      chatPath,
      `${JSON.stringify({
        id: 'v1-line',
        role: 'user',
        text: 'older than the contract',
        createdAt: '2026-08-01T00:00:00.000Z',
      })}\n`,
      'utf8',
    )

    const reloaded = await store.listChatMessages(session.id)
    assert.deepEqual(
      reloaded.map((message) => message.id),
      ['v1-line'],
      'a v2 line that is not completely understood is refused whole',
    )

    // The assertion that matters is not about the store. It is that nothing a
    // prompt is built from ever sees these lines, so this goes through the same
    // enrichment a real turn's history goes through.
    const forPrompt = await enrichHistoryWithDeliveryContent(
      reloaded,
      async () => undefined as never,
    )
    assert.equal(
      forPrompt.some((message) =>
        message.text.includes('this must not reach a prompt'),
      ),
      false,
      'nothing unreadable reaches the model’s view of the conversation',
    )
    assert.deepEqual(
      forPrompt.map((message) => message.text),
      ['older than the contract'],
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a pointer that disagrees with the line it sits on is not followed', async () => {
  const { directory, workspacePath } = makeWorkspace('transcript-pointer-v2-')
  const store = new FileSystemSessionStore(workspacePath)
  try {
    const session = await store.createSession({ title: 'pointer agreement' })
    const chatPath = path.join(workspacePath, 'sessions', session.id, 'chat.jsonl')

    // The pointer is optional. What it cannot be is wrong: it is what an
    // operator follows from a message to the durable evidence behind it, so one
    // that disagrees with the line it sits on is worse than none at all —
    // it leads somewhere, and somewhere is a different turn.
    const disagreements: readonly [string, Record<string, unknown>][] = [
      [
        'another conversation',
        { conversationId: 'a-different-conversation', activityId: 'turn-1', turnId: 'turn-1' },
      ],
      [
        'another activity',
        { conversationId: session.id, activityId: 'another-activity', turnId: 'turn-1' },
      ],
      [
        'another turn',
        { conversationId: session.id, activityId: 'turn-1', turnId: 'another-turn' },
      ],
    ]
    for (const [why, conversation] of disagreements) {
      fs.appendFileSync(
        chatPath,
        `${JSON.stringify({
          id: `pointing-at-${why.replace(/\s+/g, '-')}`,
          role: 'assistant',
          text: 'this must not reach a prompt',
          createdAt: '2026-08-26T00:00:00.000Z',
          schemaVersion: 2,
          conversationId: session.id,
          kind: 'chat',
          source: { kind: 'conversation-turn', turnId: 'turn-1' },
          turnId: 'turn-1',
          conversation,
        })}\n`,
        'utf8',
      )
    }
    // And the agreeing one, which must survive.
    assert.equal(
      await store.appendChatMessageIfAbsent(
        session.id,
        message({
          id: 'agreeing',
          role: 'assistant',
          text: 'kept',
          schemaVersion: 2,
          conversationId: session.id,
          kind: 'chat',
          source: { kind: 'conversation-turn', turnId: 'turn-1' },
          turnId: 'turn-1',
          conversation: {
            conversationId: session.id,
            activityId: 'turn-1',
            turnId: 'turn-1',
          },
        }),
      ),
      'appended',
    )

    assert.deepEqual(
      (await store.listChatMessages(session.id)).map((line) => line.id),
      ['agreeing'],
      'only the line whose pointer agrees with it is read',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a session deleted while an append waits is not brought back by it', async () => {
  const { directory, workspacePath } = makeWorkspace('transcript-resurrect-')
  const store = new FileSystemSessionStore(workspacePath)
  try {
    const session = await store.createSession({ title: 'about to be deleted' })
    const sessionDir = path.join(workspacePath, 'sessions', session.id)
    const lockPath = path.join(workspacePath, 'sessions', '.locks', `${session.id}.lock`)

    // Checking that the session exists outside the lock, and creating its
    // directory outside the lock, means an append can decide a session is there,
    // wait, and then act on an answer that stopped being true — recreating the
    // directory and rewriting the metadata of a session someone deleted. The
    // transcript that comes back has no session, and the session that comes back
    // has no history.
    let releaseLock: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    let lockAcquired: () => void = () => undefined
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve
    })
    const holding = withFileLock(lockPath, async () => {
      lockAcquired()
      await held
    })
    await acquired

    const appending = store.appendChatMessageIfAbsent(
      session.id,
      message({ id: 'written-after-the-end', turnId: 'turn-1' }),
    )
    // The deletion lands while the append is waiting for the lock.
    fs.rmSync(sessionDir, { recursive: true, force: true })
    releaseLock()
    await holding

    assert.equal(
      await appending,
      'unknown-session',
      'an append must re-decide under the lock, not act on what it saw before it',
    )
    assert.equal(
      fs.existsSync(sessionDir),
      false,
      'and it leaves nothing behind: no directory, no transcript, no metadata',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})


test('a version-2 line this build could not read back is never written', async () => {
  const { directory, workspacePath } = makeWorkspace('transcript-writer-')
  const store = new FileSystemSessionStore(workspacePath)
  try {
    const session = await store.createSession({ title: 'writer guard' })
    const chatPath = path.join(workspacePath, 'sessions', session.id, 'chat.jsonl')

    // The reader refuses a v2 line it cannot understand whole. The writer did
    // not, so a caller could be told `appended` — and be told it after an
    // fsync — for a line that vanishes on the next reload. Reporting durability
    // for something no reader will return is the worst of the options.
    const rejected: readonly [string, Partial<ChatMessage>][] = [
      ['no conversation', { schemaVersion: 2, kind: 'chat', source: { kind: 'conversation-turn', turnId: 't' }, turnId: 't' }],
      ['no kind', { schemaVersion: 2, conversationId: 'c', source: { kind: 'conversation-turn', turnId: 't' }, turnId: 't' }],
      ['no source', { schemaVersion: 2, conversationId: 'c', kind: 'chat', turnId: 't' }],
      ['no turn', { schemaVersion: 2, conversationId: 'c', kind: 'chat', source: { kind: 'conversation-turn', turnId: 't' } }],
      [
        'a source naming another turn',
        { schemaVersion: 2, conversationId: 'c', kind: 'chat', source: { kind: 'conversation-turn', turnId: 'other' }, turnId: 't' },
      ],
      [
        'a pointer naming another conversation',
        {
          schemaVersion: 2,
          conversationId: 'c',
          kind: 'chat',
          source: { kind: 'conversation-turn', turnId: 't' },
          turnId: 't',
          conversation: { conversationId: 'elsewhere', activityId: 't', turnId: 't' },
        },
      ],
    ]

    for (const [why, fields] of rejected) {
      const before = fs.existsSync(chatPath) ? fs.statSync(chatPath).size : 0
      const outcome = await store.appendChatMessageIfAbsent(
        session.id,
        message({ id: `rejected-${why.replace(/\s+/g, '-')}`, ...fields }),
      )
      assert.notEqual(outcome, 'appended', `'${why}' was reported as durable`)
      assert.equal(
        fs.existsSync(chatPath) ? fs.statSync(chatPath).size : 0,
        before,
        `'${why}' left bytes behind`,
      )
    }

    // A line from before any of this still appends exactly as it did.
    assert.equal(
      await store.appendChatMessageIfAbsent(
        session.id,
        message({ id: 'v1-still-fine', text: 'older than the contract' }),
      ),
      'appended',
    )
    assert.deepEqual(
      (await store.listChatMessages(session.id)).map((line) => line.id),
      ['v1-still-fine'],
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
