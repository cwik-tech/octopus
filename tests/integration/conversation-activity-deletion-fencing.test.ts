/**
 * Deleting an activity is an ownership operation, not a filesystem one.
 *
 * The sweep used to read an activity through a lease, release it, and then
 * remove the directory. Between the release and the removal anything could
 * acquire the same activity, and it would come back holding a journal whose
 * files were about to be deleted underneath it. A turn would then append into
 * a tree that no longer exists and believe it was durable.
 *
 * So removal belongs to the registry, which is the only thing that knows
 * whether an activity is in use. These tests pin that: a busy activity refuses
 * to be deleted, an open still in flight counts as busy, and an acquisition
 * that arrives mid-deletion waits for it rather than racing it.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'

const CASE_TIMEOUT_MS = 5_000

function makeWorkspace(prefix: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  const sessionId = randomUUID()
  fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), { recursive: true })
  return { directory, workspacePath, sessionId }
}

const owner = (sessionId: string) => ({
  kind: 'run-session' as const,
  conversationId: sessionId,
  sessionId,
})

function activityPath(
  workspacePath: string,
  sessionId: string,
  activityId: string,
): string {
  return path.join(
    workspacePath,
    'sessions',
    sessionId,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    activityId,
  )
}

function manifestPath(
  workspacePath: string,
  sessionId: string,
  activityId: string,
): string {
  return path.join(
    activityPath(workspacePath, sessionId, activityId),
    '.runtime',
    'execution-journal',
    'manifest.json',
  )
}

/**
 * A gate the test opens by hand, around the real opener.
 *
 * Two signals, not one. `entered` proves the open has actually begun, so the
 * assertion below is made inside the window it is about rather than before it;
 * `release` is a separate resolver, so opening the gate never depends on
 * whichever callback happened to be installed last. Releasing is idempotent
 * because the test has to be able to release it from a `finally` whether or not
 * the body got that far.
 */
function makeOpenerGate() {
  let signalEntered: () => void = () => undefined
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve
  })
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let armed = false
  return {
    entered,
    arm: () => {
      armed = true
    },
    release: () => {
      armed = false
      release()
    },
    opener: async (options: Parameters<typeof initializeExecutionJournal>[0]) => {
      if (armed) {
        armed = false
        signalEntered()
        await held
      }
      return initializeExecutionJournal(options)
    },
  }
}

test(
  'an activity someone is holding refuses to be deleted',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('delete-busy-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const activityId = randomUUID()
      const lease = await registry.acquire({
        owner: owner(sessionId),
        activityId,
        activityKind: 'turn',
      })
      assert.ok(lease)

      assert.equal(
        await registry.deleteActivity({
          owner: owner(sessionId),
          activityId,
          activityKind: 'turn',
        }),
        'busy',
      )
      assert.equal(
        fs.existsSync(manifestPath(workspacePath, sessionId, activityId)),
        true,
      )

      await lease.release()
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'an open still in flight counts as holding the activity',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('delete-opening-')
    const gate = makeOpenerGate()
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
      journalOpener: gate.opener,
    })
    let opening: ReturnType<typeof registry.acquire> | undefined
    try {
      const activityId = randomUUID()
      gate.arm()
      opening = registry.acquire({
        owner: owner(sessionId),
        activityId,
        activityKind: 'turn',
      })
      // The assertion below is only about the in-flight window, so wait until
      // the open is provably inside it.
      await gate.entered

      // No lease is counted yet — the open has not resolved — but the activity
      // is very much in use, and deleting it now is the race this guards.
      assert.equal(
        await registry.deleteActivity({
          owner: owner(sessionId),
          activityId,
          activityKind: 'turn',
        }),
        'busy',
      )
    } finally {
      // Before anything that could await the gated open. A failed assertion
      // above must not leave the opener parked forever with `close` behind it.
      gate.release()
      const lease = await opening?.catch(() => undefined)
      await lease?.release()
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'an activity nobody holds is removed whole',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('delete-idle-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const activityId = randomUUID()
      const lease = await registry.acquire({
        owner: owner(sessionId),
        activityId,
        activityKind: 'turn',
      })
      assert.ok(lease)
      await lease.release()

      assert.equal(
        await registry.deleteActivity({
          owner: owner(sessionId),
          activityId,
          activityKind: 'turn',
        }),
        'deleted',
      )
      assert.equal(
        fs.existsSync(activityPath(workspacePath, sessionId, activityId)),
        false,
        'the directory is the unit of forgetting',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'deleting an activity that was never there reports absent',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('delete-absent-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      assert.equal(
        await registry.deleteActivity({
          owner: owner(sessionId),
          activityId: randomUUID(),
          activityKind: 'turn',
        }),
        'absent',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'an acquisition that arrives during a deletion waits for it',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('delete-race-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const activityId = randomUUID()
      const first = await registry.acquire({
        owner: owner(sessionId),
        activityId,
        activityKind: 'turn',
      })
      assert.ok(first)
      await first.release()

      // Started, not awaited: the acquisition below is issued in the same tick,
      // which is precisely the window where an unfenced delete would remove the
      // tree out from under a freshly opened handle.
      const deleting = registry.deleteActivity({
        owner: owner(sessionId),
        activityId,
        activityKind: 'turn',
      })
      const reacquiring = registry.acquire({
        owner: owner(sessionId),
        activityId,
        activityKind: 'turn',
      })

      assert.equal(await deleting, 'deleted')
      const second = await reacquiring
      assert.ok(second)
      assert.equal(
        fs.existsSync(manifestPath(workspacePath, sessionId, activityId)),
        true,
        'the reopened journal is backed by files that exist',
      )
      // And it is usable, not a handle over a removed inode.
      const scan = await second.journal.scan()
      assert.equal(scan.events.length, 0)
      await second.release()
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)


test(
  'only a directory is evidence of an activity worth deleting',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('delete-shape-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      // A file, and a link, standing where an activity belongs. Removing either
      // and reporting it deleted lets retention forget the entry and move on —
      // so tampered or half-written state disappears with the record that it
      // was ever there.
      const activities = path.join(
        workspacePath,
        'sessions',
        sessionId,
        CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
      )
      fs.mkdirSync(activities, { recursive: true })
      const asFile = randomUUID()
      fs.writeFileSync(path.join(activities, asFile), 'not an activity', 'utf8')
      const asLink = randomUUID()
      const elsewhere = path.join(directory, 'elsewhere')
      fs.mkdirSync(elsewhere, { recursive: true })
      fs.symlinkSync(elsewhere, path.join(activities, asLink))

      for (const activityId of [asFile, asLink]) {
        assert.equal(
          await registry.deleteActivity({
            owner: owner(sessionId),
            activityId,
            activityKind: 'turn',
          }),
          'busy',
          'something that is not an activity is not this to forget',
        )
        assert.equal(
          fs.existsSync(path.join(activities, activityId)),
          true,
          'and it is still there',
        )
      }
      assert.equal(
        fs.existsSync(elsewhere),
        true,
        'nor was anything the link pointed at removed',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
