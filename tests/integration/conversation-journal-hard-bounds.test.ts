/**
 * A conversation activity journal is small by contract, and the contract has to
 * be enforced where it costs something.
 *
 * The whole reason chat gets a journal per turn rather than per session is that
 * opening one reads the file, revalidates every line and indexes every event —
 * so an activity that grew without limit would put that cost back on every turn,
 * and the accepted ADR forbids compacting it away afterwards. The plan therefore
 * bounds one activity at 128 events and a mebibyte.
 *
 * A bound checked after the file is in memory is not a bound: by then the
 * allocation the limit exists to prevent has already happened. So the size is
 * decided from the file, before it is read — at open, when a handle catches up
 * with another writer, and before a batch is appended.
 *
 * Assignment and batch journals are deliberately untouched. They are bounded by
 * a run's shape rather than a conversation's, and quietly shrinking them to fit
 * a chat rule would break work that has nothing to do with chat.
 */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { ExecutionJournalScopeIdentity } from '../../contracts/execution-journal.js'
import { ExecutionJournalError } from '../../contracts/execution-journal.js'
import { writeOversizedConversationActivity } from '../support/bulk-conversation-activities.js'
import {
  CONVERSATION_JOURNAL_MAX_BYTES,
  CONVERSATION_JOURNAL_MAX_EVENTS,
  initializeExecutionJournal,
  readExecutionJournal,
} from '../../core/execution-journal.js'

const CASE_TIMEOUT_MS = 30_000

const CONVERSATION: ExecutionJournalScopeIdentity = {
  scopeKind: 'conversation',
  scopeId: 'activity-1',
  tenantId: 'local',
  sessionId: 'session-1',
  conversationId: 'session-1',
  activityKind: 'turn',
}

const ASSIGNMENT: ExecutionJournalScopeIdentity = {
  scopeKind: 'assignment',
  scopeId: 'assignment-1',
  tenantId: 'local',
  sessionId: 'session-1',
  runId: 'run-1',
  assignmentId: 'assignment-1',
}

function scopeRoot(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

function journalPath(root: string): string {
  return path.join(root, '.runtime', 'execution-journal', 'journal.jsonl')
}

async function appendOne(
  journal: Awaited<ReturnType<typeof initializeExecutionJournal>>,
  index: number,
  filler = '',
) {
  return journal.append({
    eventId: `event-${index}`,
    streamKind: 'conversation.turn',
    streamId: 'activity-1',
    expectedStreamRevision: index,
    type: 'conversation.turn.noted',
    payloadSchemaVersion: 1,
    payload: { index, filler },
    correlationId: 'activity-1',
  })
}

test(
  'the event bound is refused at the boundary, not somewhere past it',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const root = scopeRoot('bounds-events-')
    const journal = await initializeExecutionJournal({
      scopeRoot: root,
      identity: CONVERSATION,
    })
    try {
      for (let index = 0; index < CONVERSATION_JOURNAL_MAX_EVENTS; index += 1) {
        assert.equal((await appendOne(journal, index)).kind, 'appended')
      }
      // The last one inside the bound is durable, and the first one past it is
      // refused rather than accepted-and-regretted.
      const scan = await journal.scan()
      assert.equal(scan.events.length, CONVERSATION_JOURNAL_MAX_EVENTS)

      await assert.rejects(
        appendOne(journal, CONVERSATION_JOURNAL_MAX_EVENTS),
        (error: unknown) =>
          error instanceof ExecutionJournalError &&
          error.code === 'limit_exceeded',
        'one event past the bound is a refusal, not a bigger journal',
      )
      assert.equal(
        (await journal.scan()).events.length,
        CONVERSATION_JOURNAL_MAX_EVENTS,
        'and the refusal wrote nothing',
      )
    } finally {
      await journal.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'the byte bound is refused before the write, not after it',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const root = scopeRoot('bounds-bytes-')
    const journal = await initializeExecutionJournal({
      scopeRoot: root,
      identity: CONVERSATION,
    })
    try {
      // Sixty-four kibibytes a time: the byte bound is reached well before the
      // event bound, so this is the rule under test.
      const filler = 'x'.repeat(64 * 1024)
      let appended = 0
      let refused: unknown
      for (let index = 0; index < CONVERSATION_JOURNAL_MAX_EVENTS; index += 1) {
        try {
          await appendOne(journal, index, filler)
          appended += 1
        } catch (error) {
          refused = error
          break
        }
      }
      assert.ok(refused, 'a mebibyte of events must eventually be refused')
      assert.equal(
        refused instanceof ExecutionJournalError &&
          refused.code === 'limit_exceeded',
        true,
      )
      assert.equal(
        appended < CONVERSATION_JOURNAL_MAX_EVENTS,
        true,
        'the byte bound bit before the event bound',
      )
      assert.equal(
        fs.statSync(journalPath(root)).size <= CONVERSATION_JOURNAL_MAX_BYTES,
        true,
        'and the file never went over the line it is bounded at',
      )
    } finally {
      await journal.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'an oversized activity is refused without being read',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const root = scopeRoot('bounds-open-')
    const journal = await initializeExecutionJournal({
      scopeRoot: root,
      identity: CONVERSATION,
    })
    await journal.close()

    try {
      // Deliberately not valid journal content. If the size is decided from the
      // file, this is refused for being too large; if it is decided after
      // reading, the failure would be about the contents — which would mean the
      // allocation the bound exists to prevent had already happened.
      fs.writeFileSync(
        journalPath(root),
        Buffer.alloc(CONVERSATION_JOURNAL_MAX_BYTES * 2, 'z'),
      )

      await assert.rejects(
        initializeExecutionJournal({ scopeRoot: root, identity: CONVERSATION }),
        (error: unknown) =>
          error instanceof ExecutionJournalError &&
          error.code === 'limit_exceeded',
        'the size is decided from the file, before its contents are',
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'a handle catching up with another writer refuses an oversized tail',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const root = scopeRoot('bounds-resync-')
    const journal = await initializeExecutionJournal({
      scopeRoot: root,
      identity: CONVERSATION,
    })
    try {
      assert.equal((await appendOne(journal, 0)).kind, 'appended')

      // Another writer appended far more than this activity is allowed to hold.
      // Catching up must not begin by allocating all of it.
      fs.appendFileSync(
        journalPath(root),
        Buffer.alloc(CONVERSATION_JOURNAL_MAX_BYTES * 2, 'z'),
      )

      await assert.rejects(
        appendOne(journal, 1),
        (error: unknown) =>
          error instanceof ExecutionJournalError &&
          error.code === 'limit_exceeded',
      )
    } finally {
      await journal.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'assignment journals keep the behaviour they had',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const root = scopeRoot('bounds-assignment-')
    const journal = await initializeExecutionJournal({
      scopeRoot: root,
      identity: ASSIGNMENT,
    })
    try {
      // Past both conversation bounds, on purpose: a run's journal is bounded by
      // the run's shape, and shrinking it to fit a chat rule would break work
      // that has nothing to do with chat.
      const filler = 'x'.repeat(64 * 1024)
      for (let index = 0; index < CONVERSATION_JOURNAL_MAX_EVENTS + 8; index += 1) {
        const outcome = await journal.append({
          eventId: `event-${index}`,
          streamKind: 'assignment.dispatch',
          streamId: 'assignment-1',
          expectedStreamRevision: index,
          type: 'assignment.noted',
          payloadSchemaVersion: 1,
          payload: { index, filler },
          correlationId: 'assignment-1',
        })
        assert.equal(outcome.kind, 'appended')
      }
      assert.equal(
        fs.statSync(journalPath(root)).size > CONVERSATION_JOURNAL_MAX_BYTES,
        true,
        'an assignment journal is still allowed past a conversation’s bound',
      )
      const reopened = await initializeExecutionJournal({
        scopeRoot: root,
        identity: ASSIGNMENT,
      })
      assert.equal(
        (await reopened.scan()).events.length,
        CONVERSATION_JOURNAL_MAX_EVENTS + 8,
        'and it still reopens',
      )
      await reopened.close()
    } finally {
      await journal.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)


test(
  'a journal that is a link is refused rather than followed',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const root = scopeRoot('bounds-link-')
    const journal = await initializeExecutionJournal({
      scopeRoot: root,
      identity: CONVERSATION,
    })
    await journal.close()
    try {
      // Reading through a link is how something outside this activity answers a
      // question about what is inside it. The bound and the refusal are the same
      // read: an opened handle that will not follow a name.
      const elsewhere = path.join(root, 'elsewhere.jsonl')
      fs.writeFileSync(elsewhere, '', 'utf8')
      fs.rmSync(journalPath(root))
      fs.symlinkSync(elsewhere, journalPath(root))

      await assert.rejects(
        initializeExecutionJournal({ scopeRoot: root, identity: CONVERSATION }),
        'a journal that is a link is not this activity’s journal',
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'a manifest replaced under a live handle is bounded on every read',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const root = scopeRoot('bounds-manifest-')
    const journal = await initializeExecutionJournal({
      scopeRoot: root,
      identity: CONVERSATION,
    })
    try {
      assert.equal((await appendOne(journal, 0)).kind, 'appended')

      // The manifest is re-read on every operation while the journal is live,
      // so it is a small frequent read of a file another process can replace.
      // Valid JSON and four mebibytes of it: a parser would accept this, and
      // only a bounded read refuses it.
      const manifestPath = path.join(root, '.runtime', 'execution-journal', 'manifest.json')
      const current: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          ...(typeof current === 'object' && current !== null ? current : {}),
          padding: 'z'.repeat(4 * 1024 * 1024),
        }),
        'utf8',
      )

      await assert.rejects(
        appendOne(journal, 1),
        (error: unknown) =>
          error instanceof ExecutionJournalError &&
          error.code === 'limit_exceeded',
        'refused for its size, rather than failing later on its contents — ' +
          'a manifest that is parsed at all has already been read whole',
      )
    } finally {
      await journal.close().catch(() => undefined)
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)


test(
  'a manifest read outside a live handle is not followed through a link',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const root = scopeRoot('bounds-readonly-link-')
    const journal = await initializeExecutionJournal({
      scopeRoot: root,
      identity: CONVERSATION,
    })
    await journal.close()
    try {
      // The read-only path finds the manifest before it can know what kind of
      // scope this is, so it is the one read that cannot be guarded by anything
      // downstream of the scope kind. A link here would let a manifest from
      // somewhere else decide what this activity is.
      const journalDirectory = path.join(root, '.runtime', 'execution-journal')
      const manifestPath = path.join(journalDirectory, 'manifest.json')
      const planted = path.join(root, 'planted-manifest.json')
      fs.writeFileSync(planted, fs.readFileSync(manifestPath))
      fs.rmSync(manifestPath)
      fs.symlinkSync(planted, manifestPath)

      const outcome = await readExecutionJournal(root)
      assert.equal(
        outcome.kind,
        'corrupt',
        'a manifest that is a link is not this activity’s manifest',
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'a manifest larger than the read allows is refused before it is parsed',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const root = scopeRoot('bounds-readonly-size-')
    const journal = await initializeExecutionJournal({
      scopeRoot: root,
      identity: CONVERSATION,
    })
    await journal.close()
    try {
      // Valid JSON and a valid manifest, four mebibytes of it. A parser accepts
      // this; only a bounded read refuses it, which is the difference between
      // "we noticed afterwards" and "we never allocated it".
      const manifestPath = path.join(
        root,
        '.runtime',
        'execution-journal',
        'manifest.json',
      )
      const current: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          ...(typeof current === 'object' && current !== null ? current : {}),
          padding: 'z'.repeat(4 * 1024 * 1024),
        }),
        'utf8',
      )

      assert.equal((await readExecutionJournal(root)).kind, 'corrupt')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)


test(
  'a journal holding more events than the bound allows is refused when read',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'bounds-readonly-events-')),
    )
    const workspacePath = path.join(directory, 'workspace')
    const sessionId = '00000000-0000-4000-8000-000000000001'
    const activityId = '00000000-0000-4000-8000-000000000002'
    fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), { recursive: true })
    try {
      // Comfortably inside the byte bound and one event past the event bound.
      // The write path refuses to create this, but a journal can arrive at that
      // size another way — restored from elsewhere, or written by a build that
      // had no bound — and a read path that accepts it is a read path that has
      // not enforced the bound at all.
      writeOversizedConversationActivity({
        workspacePath,
        sessionId,
        tenantId: 'local',
        activityId,
        eventCount: CONVERSATION_JOURNAL_MAX_EVENTS + 1,
      })
      const scopeRootPath = path.join(
        workspacePath,
        'sessions',
        sessionId,
        '.conversation-activities',
        activityId,
      )
      assert.equal(
        fs.statSync(path.join(scopeRootPath, '.runtime', 'execution-journal', 'journal.jsonl'))
          .size < CONVERSATION_JOURNAL_MAX_BYTES,
        true,
        'the file is inside the byte bound, so only the event bound can refuse it',
      )

      const outcome = await readExecutionJournal(scopeRootPath)
      assert.equal(
        outcome.kind,
        'corrupt',
        'a read that returns an over-long conversation journal has not bounded it',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
