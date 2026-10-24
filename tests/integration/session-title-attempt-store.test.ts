/**
 * The durable record of which model was about to name something.
 *
 * Two rules do the work here, and both are about not destroying evidence.
 *
 * An attempt is *appended*. A later attempt on a changed default is a second
 * entry beside the first, because the first is an account of a model that
 * really was used and replacing it would erase that.
 *
 * And a record that cannot be rebuilt is refused *whole*, on the way in and on
 * the way out. Filtering out the entries this cannot read would look tidier and
 * would be worse: the next unrelated title or status update writes the
 * survivors back, and the corrupt history is gone with nothing to show it ever
 * existed. So a bad append writes nothing at all, and a session whose stored
 * history is corrupt reads as unreadable rather than as a shorter history.
 *
 * Driven against a real `FileSystemSessionStore` on a real filesystem, because
 * what is being proved is what ends up in the file.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { SessionTitleAttempt } from '../../contracts/sessions.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

interface Harness {
  readonly store: FileSystemSessionStore
  readonly sessionId: string
  readonly metadataPath: string
  cleanup(): void
}

async function makeHarness(): Promise<Harness> {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'session-title-attempt-store-')),
  )
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(workspacePath, { recursive: true })
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({ title: 'Untitled session' })
  return {
    store,
    sessionId: session.id,
    metadataPath: path.join(workspacePath, 'sessions', session.id, 'session.json'),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  }
}

function attempt(overrides: Partial<SessionTitleAttempt> = {}): SessionTitleAttempt {
  return {
    operation: 'selected-agent-chat',
    owner: 'turn-1',
    attemptId: randomUUID(),
    selection: {
      provider: 'openai',
      model: 'app-default-model',
      source: 'app-default',
      reason: 'agent-default',
      caller: 'title',
    },
    at: '2026-09-09T12:00:00.000Z',
    ...overrides,
  }
}

test('an appended attempt survives a reload, and a second one sits beside it', async () => {
  const harness = await makeHarness()
  try {
    const first = attempt({ owner: 'turn-1' })
    const second = attempt({
      owner: 'turn-2',
      selection: { ...first.selection, model: 'changed-default-model' },
    })

    assert.equal(await harness.store.appendSessionTitleAttempt(harness.sessionId, first), true)
    assert.equal(await harness.store.appendSessionTitleAttempt(harness.sessionId, second), true)

    // Read back through the ordinary session read, not from the return value.
    const reloaded = await harness.store.getSession(harness.sessionId)
    assert.ok(reloaded)
    assert.deepEqual(reloaded.titleAttempts, [first, second])
    // The earlier model is still there. This is the whole point of appending.
    assert.equal(reloaded.titleAttempts?.[0]?.selection.model, 'app-default-model')
  } finally {
    harness.cleanup()
  }
})

test('an unrelated title update keeps the attempts already recorded', async () => {
  // `readMetadata` rebuilds allowed metadata field by field, so it decides
  // whether these survive. A field it forgets is silently deleted by the next
  // ordinary write, which is exactly what this catches.
  const harness = await makeHarness()
  try {
    const recorded = attempt()
    assert.equal(await harness.store.appendSessionTitleAttempt(harness.sessionId, recorded), true)

    await harness.store.updateSessionTitle(harness.sessionId, 'Reviewing The Supply Agreement')

    const reloaded = await harness.store.getSession(harness.sessionId)
    assert.ok(reloaded)
    assert.equal(reloaded.title, 'Reviewing The Supply Agreement')
    assert.deepEqual(reloaded.titleAttempts, [recorded])
  } finally {
    harness.cleanup()
  }
})

test('a session that never recorded an attempt is left exactly as it was', async () => {
  const harness = await makeHarness()
  try {
    const before = fs.readFileSync(harness.metadataPath, 'utf8')
    const reloaded = await harness.store.getSession(harness.sessionId)

    assert.ok(reloaded)
    // Absent is not corrupt: it means nothing is known, and nothing is invented.
    assert.equal(reloaded.titleAttempts, undefined)
    assert.equal(fs.readFileSync(harness.metadataPath, 'utf8'), before)
  } finally {
    harness.cleanup()
  }
})

test('an attempt that cannot be validated is refused, and writes nothing', async () => {
  const harness = await makeHarness()
  try {
    const before = fs.readFileSync(harness.metadataPath, 'utf8')
    const valid = attempt()
    const refusals: Array<[string, SessionTitleAttempt]> = [
      ['unknown operation', { ...valid, operation: 'invented' as SessionTitleAttempt['operation'] }],
      ['blank owner', { ...valid, owner: '' }],
      ['padded owner', { ...valid, owner: ' turn-1 ' }],
      ['blank attempt id', { ...valid, attemptId: '' }],
      ['blank timestamp', { ...valid, at: '' }],
      ['not a timestamp', { ...valid, at: 'the other day' }],
      [
        'a selection that is not a title selection',
        { ...valid, selection: { ...valid.selection, caller: 'agent' } },
      ],
      [
        'a half-read selection',
        {
          ...valid,
          selection: { ...valid.selection, model: '' },
        },
      ],
    ]

    for (const [label, bad] of refusals) {
      assert.equal(
        await harness.store.appendSessionTitleAttempt(harness.sessionId, bad),
        false,
        label,
      )
      // Refused means nothing happened, not "wrote a shorter record".
      assert.equal(fs.readFileSync(harness.metadataPath, 'utf8'), before, label)
    }
  } finally {
    harness.cleanup()
  }
})

test('the same attempt identity cannot be recorded twice', async () => {
  // Two entries with one identity cannot be told apart afterwards, so the
  // history stops being able to say how many attempts there were.
  const harness = await makeHarness()
  try {
    const recorded = attempt()
    assert.equal(await harness.store.appendSessionTitleAttempt(harness.sessionId, recorded), true)
    const after = fs.readFileSync(harness.metadataPath, 'utf8')

    assert.equal(
      await harness.store.appendSessionTitleAttempt(harness.sessionId, {
        ...recorded,
        owner: 'turn-2',
      }),
      false,
    )
    assert.equal(fs.readFileSync(harness.metadataPath, 'utf8'), after)
  } finally {
    harness.cleanup()
  }
})

test('a stored history that cannot be rebuilt is refused whole, and never rewritten', async () => {
  const harness = await makeHarness()
  try {
    const stored = JSON.parse(fs.readFileSync(harness.metadataPath, 'utf8')) as Record<
      string,
      unknown
    >
    // One readable entry beside one that is not. Filtering would keep the first
    // and quietly lose the second on the next ordinary write.
    stored.titleAttempts = [attempt(), { operation: 'selected-agent-chat' }]
    fs.writeFileSync(harness.metadataPath, `${JSON.stringify(stored, null, 2)}\n`)
    const before = fs.readFileSync(harness.metadataPath, 'utf8')

    assert.equal(await harness.store.getSession(harness.sessionId), null)
    // And nothing may be appended on top of a history nobody can read.
    assert.equal(
      await harness.store.appendSessionTitleAttempt(harness.sessionId, attempt()),
      false,
    )
    // The failure this whole rule exists to prevent: an ordinary, unrelated
    // write persisting a rebuilt copy and taking the corrupt history with it.
    assert.equal(
      await harness.store.updateSessionTitle(harness.sessionId, 'A New Title For This'),
      null,
    )
    assert.equal(fs.readFileSync(harness.metadataPath, 'utf8'), before)
  } finally {
    harness.cleanup()
  }
})
