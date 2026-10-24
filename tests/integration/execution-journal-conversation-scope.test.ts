/**
 * The conversation activity registry against real files.
 *
 * Three things are proven here that a unit test cannot: the physical layout and
 * its private modes, that one activity never holds two journals even when a
 * close and an acquisition race, and that inspection never provisions.
 *
 * The lease semantics are copied from `WorkspaceExecutionJournalRegistry`
 * because they were paid for — commit 388a4e3f exists because an acquisition
 * arriving during a close could briefly open a second handle. The last test in
 * this file is that regression, expressed for conversations.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { ExecutionJournalError } from '../../contracts/execution-journal.js'
import {
  buildConversationActivityLocation,
  CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
} from '../../core/conversation-activity-location.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import { resolveConversationTurnJournalRecorder } from '../../services/conversation-turn-journal-recorder.js'
import {
  ConversationJournalUnavailableError,
  WorkspaceConversationJournalRegistry,
  type ConversationActivityScope,
} from '../../services/workspace-conversation-journal-registry.js'

function makeWorkspace(prefix: string): { directory: string; workspacePath: string } {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(workspacePath, { recursive: true })
  return { directory, workspacePath }
}

function makeScope(sessionId: string, activityId: string): ConversationActivityScope {
  return {
    owner: { kind: 'run-session', conversationId: sessionId, sessionId },
    activityId,
    activityKind: 'turn',
  }
}

function makeRegistry(workspacePath: string, overrides: {
  readonly mode?: 'authoritative' | 'disabled'
  readonly journalOpener?: typeof initializeExecutionJournal
} = {}) {
  return new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: overrides.mode ?? 'authoritative',
    ...(overrides.journalOpener ? { journalOpener: overrides.journalOpener } : {}),
  })
}

/** Sessions exist as durable directories before a turn ever runs. */
function seedSession(workspacePath: string, sessionId: string): void {
  fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), { recursive: true })
}

test('an activity journal lands under its session, sealed to its conversation', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-scope-')
  const sessionId = randomUUID()
  const activityId = randomUUID()
  seedSession(workspacePath, sessionId)
  const registry = makeRegistry(workspacePath)
  try {
    const lease = await registry.acquire(makeScope(sessionId, activityId))
    assert.ok(lease)

    const expected = path.join(
      workspacePath,
      'sessions',
      sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
      activityId,
      '.runtime',
      'execution-journal',
    )
    assert.equal(lease.journal.journalDirectoryPath, expected)

    const manifest = lease.journal.manifest
    assert.equal(manifest.scopeKind, 'conversation')
    assert.equal(manifest.scopeId, activityId)
    assert.equal(manifest.conversationId, sessionId)
    assert.equal(manifest.activityKind, 'turn')
    assert.equal(manifest.sessionId, sessionId)
    assert.equal(manifest.runId, undefined)
    assert.equal(manifest.assignmentId, undefined)

    // Private, like every other journal directory.
    assert.equal(fs.statSync(expected).mode & 0o777, 0o700)
    assert.equal(
      fs.statSync(path.join(expected, 'manifest.json')).mode & 0o777,
      0o600,
    )
    await lease.release()
  } finally {
    await registry.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the root is derived from the owner, never from a caller-supplied path', () => {
  const { directory, workspacePath } = makeWorkspace('conversation-traversal-')
  try {
    for (const unsafe of ['..', '../escape', 'a/b', '', '.']) {
      assert.equal(
        buildConversationActivityLocation(workspacePath, {
          owner: { kind: 'run-session', conversationId: 'c', sessionId: unsafe },
          activityId: 'activity-1',
        }),
        null,
        `session id ${JSON.stringify(unsafe)} must not resolve`,
      )
      assert.equal(
        buildConversationActivityLocation(workspacePath, {
          owner: { kind: 'run-session', conversationId: 'c', sessionId: 's' },
          activityId: unsafe,
        }),
        null,
        `activity id ${JSON.stringify(unsafe)} must not resolve`,
      )
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('two holders share one journal and the last one out closes it', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-lease-')
  const sessionId = randomUUID()
  const activityId = randomUUID()
  seedSession(workspacePath, sessionId)
  const opens: string[] = []
  const registry = makeRegistry(workspacePath, {
    journalOpener: async (options) => {
      opens.push(options.identity.scopeId)
      return initializeExecutionJournal(options)
    },
  })
  try {
    const scope = makeScope(sessionId, activityId)
    const first = await registry.acquire(scope)
    const second = await registry.acquire(scope)
    assert.ok(first)
    assert.ok(second)
    assert.equal(first.journal, second.journal, 'one activity, one handle')
    assert.equal(opens.length, 1)

    await first.release()
    // Still held by the second reader, so a third acquisition reuses it.
    const third = await registry.acquire(scope)
    assert.ok(third)
    assert.equal(opens.length, 1, 'a live activity is not reopened')
    await third.release()
    await second.release()

    // Now everyone let go, so the next acquisition reads from disk again.
    const reopened = await registry.acquire(scope)
    assert.ok(reopened)
    assert.equal(opens.length, 2, 'a released activity reopens from disk')
    await reopened.release()
  } finally {
    await registry.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('releasing twice is harmless and does not close another holder’s journal', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-double-release-')
  const sessionId = randomUUID()
  const activityId = randomUUID()
  seedSession(workspacePath, sessionId)
  const registry = makeRegistry(workspacePath)
  try {
    const scope = makeScope(sessionId, activityId)
    const first = await registry.acquire(scope)
    const second = await registry.acquire(scope)
    assert.ok(first)
    assert.ok(second)

    await first.release()
    await first.release()

    // The second holder's journal must still be usable.
    const outcome = await second.journal.append({
      eventId: 'event-1',
      streamKind: 'conversation.turn',
      streamId: 'turn-1',
      expectedStreamRevision: 0,
      type: 'conversation.turn.started',
      payloadSchemaVersion: 1,
      payload: { value: 1 },
      correlationId: 'turn-1',
    })
    assert.equal(outcome.kind, 'appended')
    await second.release()
  } finally {
    await registry.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('an acquisition arriving during a close waits and reopens instead of racing', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-close-race-')
  const sessionId = randomUUID()
  const activityId = randomUUID()
  seedSession(workspacePath, sessionId)

  let liveHandles = 0
  let peakLiveHandles = 0
  const registry = makeRegistry(workspacePath, {
    journalOpener: async (options) => {
      const journal = await initializeExecutionJournal(options)
      liveHandles += 1
      peakLiveHandles = Math.max(peakLiveHandles, liveHandles)
      return {
        ...journal,
        manifest: journal.manifest,
        append: (input) => journal.append(input),
        scan: () => journal.scan(),
        scanStream: (kind, id) => journal.scanStream(kind, id),
        getMetrics: () => journal.getMetrics(),
        close: async () => {
          // Give a concurrent acquisition a real window to slip through.
          await new Promise((resolve) => setTimeout(resolve, 25))
          await journal.close()
          liveHandles -= 1
        },
      }
    },
  })

  try {
    const scope = makeScope(sessionId, activityId)
    const holder = await registry.acquire(scope)
    assert.ok(holder)

    // Start the close, then acquire while it is still draining.
    const closing = holder.release()
    const reacquired = await registry.acquire(scope)
    await closing
    assert.ok(reacquired)
    assert.equal(
      peakLiveHandles,
      1,
      'one activity must never hold two journals at once',
    )
    await reacquired.release()
  } finally {
    await registry.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a close that fails keeps failing closed rather than reopening over it', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-close-fail-')
  const sessionId = randomUUID()
  const activityId = randomUUID()
  seedSession(workspacePath, sessionId)

  const registry = makeRegistry(workspacePath, {
    journalOpener: async (options) => {
      const journal = await initializeExecutionJournal(options)
      return {
        ...journal,
        manifest: journal.manifest,
        append: (input) => journal.append(input),
        scan: () => journal.scan(),
        scanStream: (kind, id) => journal.scanStream(kind, id),
        getMetrics: () => journal.getMetrics(),
        close: async () => {
          await journal.close()
          throw new Error('close failed')
        },
      }
    },
  })

  try {
    const scope = makeScope(sessionId, activityId)
    const holder = await registry.acquire(scope)
    assert.ok(holder)
    await assert.rejects(holder.release())

    // The registry cannot prove the old handle is gone, so it must not hand
    // out a new one.
    await assert.rejects(
      registry.acquire(scope),
      ConversationJournalUnavailableError,
    )
  } finally {
    await registry.close().catch(() => undefined)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('inspection never provisions an activity that does not exist', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-peek-')
  const sessionId = randomUUID()
  const activityId = randomUUID()
  seedSession(workspacePath, sessionId)
  const registry = makeRegistry(workspacePath)
  try {
    const scope = makeScope(sessionId, activityId)
    assert.equal((await registry.snapshot(scope)).kind, 'absent')
    assert.equal(
      fs.existsSync(
        path.join(
          workspacePath,
          'sessions',
          sessionId,
          CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
          activityId,
        ),
      ),
      false,
      'looking at an absent activity must not create it',
    )

    const lease = await registry.acquire(scope)
    assert.ok(lease)
    await lease.release()

    assert.equal(
      (await registry.snapshot(scope)).kind,
      'read',
      'an existing activity is readable',
    )
  } finally {
    await registry.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a disabled registry hands out nothing rather than half a barrier', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-disabled-')
  const sessionId = randomUUID()
  seedSession(workspacePath, sessionId)
  const registry = makeRegistry(workspacePath, { mode: 'disabled' })
  try {
    assert.equal(
      await registry.acquire(makeScope(sessionId, randomUUID())),
      undefined,
    )
  } finally {
    await registry.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('an unsafe activity identity fails closed before touching the disk', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-unsafe-')
  const registry = makeRegistry(workspacePath)
  try {
    await assert.rejects(
      registry.acquire({
        owner: { kind: 'run-session', conversationId: 'c', sessionId: '../escape' },
        activityId: 'activity-1',
        activityKind: 'turn',
      }),
      (error: unknown) =>
        error instanceof ConversationJournalUnavailableError ||
        (error instanceof ExecutionJournalError && error.code === 'scope_invalid'),
    )
  } finally {
    await registry.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a symlinked activities directory is refused before anything outside is touched', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-symlink-')
  const sessionId = randomUUID()
  const activityId = randomUUID()
  seedSession(workspacePath, sessionId)

  // Somewhere the workspace has no business writing.
  const outside = path.join(directory, 'outside')
  fs.mkdirSync(outside, { recursive: true })

  // Replace `.conversation-activities` with a link to it, the way a hostile or
  // careless local process could.
  fs.symlinkSync(
    outside,
    path.join(
      workspacePath,
      'sessions',
      sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    ),
  )

  const registry = makeRegistry(workspacePath)
  try {
    await assert.rejects(
      registry.acquire(makeScope(sessionId, activityId)),
      (error: unknown) =>
        error instanceof ConversationJournalUnavailableError ||
        (error instanceof ExecutionJournalError && error.code === 'path_unsafe'),
      'a path that leaves the workspace is refused',
    )

    assert.deepEqual(
      fs.readdirSync(outside),
      [],
      'and nothing was created outside the workspace before it was refused',
    )
  } finally {
    await registry.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('an in-workspace symlink alias is refused, not followed', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-alias-')
  const realSession = randomUUID()
  const aliasSession = randomUUID()
  seedSession(workspacePath, realSession)

  // A session directory that is really a link to another session. It stays
  // inside the workspace, so a containment check passes — and yet following it
  // writes one conversation's activities into another's directory.
  fs.symlinkSync(
    path.join(workspacePath, 'sessions', realSession),
    path.join(workspacePath, 'sessions', aliasSession),
  )

  const registry = makeRegistry(workspacePath)
  try {
    await assert.rejects(
      registry.acquire(makeScope(aliasSession, randomUUID())),
      'a path segment that is a link is refused however it resolves',
    )
    assert.deepEqual(
      fs.readdirSync(path.join(workspacePath, 'sessions', realSession)),
      [],
      'and nothing was written through the alias',
    )
  } finally {
    await registry.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the admission index is not written through a symlinked activities root', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-alias-index-')
  const sessionId = randomUUID()
  seedSession(workspacePath, sessionId)

  const outside = path.join(directory, 'outside')
  fs.mkdirSync(outside, { recursive: true })
  fs.symlinkSync(
    outside,
    path.join(
      workspacePath,
      'sessions',
      sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    ),
  )

  const registry = makeRegistry(workspacePath)
  try {
    // The reservation runs before the registry opens anything, so it is the
    // first writer and therefore the first thing that can be redirected.
    await assert.rejects(
      resolveConversationTurnJournalRecorder({
        registry,
        owner: { kind: 'run-session', conversationId: sessionId, sessionId },
        turnId: randomUUID(),
        workspacePath,
      }),
      'admission must not write through a redirected root',
    )
    assert.deepEqual(
      fs.readdirSync(outside),
      [],
      'and nothing reached the symlink target',
    )
  } finally {
    await registry.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
