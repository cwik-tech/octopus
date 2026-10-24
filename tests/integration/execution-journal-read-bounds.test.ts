import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import type { ExecutionJournalScopeIdentity } from '../../contracts/execution-journal.js'
import {
  CONVERSATION_JOURNAL_MAX_BYTES,
  CONVERSATION_JOURNAL_MAX_EVENTS,
  initializeExecutionJournal,
  readExecutionJournal,
} from '../../core/execution-journal.js'
import { writeOversizedConversationActivity } from '../support/bulk-conversation-activities.js'

async function makeJournal(
  context: TestContext,
  options: {
    readonly identity?: ExecutionJournalScopeIdentity
    readonly eventCount?: number
    readonly filler?: string
  } = {},
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'journal-read-bounds-')))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const journal = await initializeExecutionJournal({
    scopeRoot: root,
    identity: options.identity ?? {
      scopeKind: 'assignment',
      scopeId: 'assignment-1',
      tenantId: 'local',
      sessionId: 'session-1',
      runId: 'run-1',
      assignmentId: 'assignment-1',
    },
    clock: { now: () => 0 },
  })
  try {
    for (let index = 0; index < (options.eventCount ?? 2); index += 1) {
      await journal.append({
        eventId: `event-${index}`,
        streamKind: 'read-bound.example',
        streamId: 'example-1',
        expectedStreamRevision: index,
        type: 'example.noted',
        payloadSchemaVersion: 1,
        payload: { index, filler: options.filler ?? '' },
        correlationId: 'example-1',
      })
    }
  } finally {
    await journal.close()
  }
  return {
    root,
    journalPath: path.join(root, '.runtime', 'execution-journal', 'journal.jsonl'),
  }
}

test('an explicit byte limit refuses one byte over and accepts the exact boundary without changing the file', async (context) => {
  const fixture = await makeJournal(context)
  const before = await fs.readFile(fixture.journalPath)

  assert.deepEqual(
    await readExecutionJournal(fixture.root, { maxBytes: before.byteLength - 1, maxEvents: 2 }),
    { kind: 'corrupt', reason: 'journal_over_bound' },
  )
  const exact = await readExecutionJournal(fixture.root, { maxBytes: before.byteLength, maxEvents: 2 })
  assert.equal(exact.kind, 'ok')
  assert.deepEqual(await fs.readFile(fixture.journalPath), before)
})

test('an explicit event limit refuses one event over and accepts the exact boundary', async (context) => {
  const fixture = await makeJournal(context)

  assert.deepEqual(
    await readExecutionJournal(fixture.root, { maxBytes: 64 * 1024, maxEvents: 1 }),
    { kind: 'corrupt', reason: 'journal_over_bound' },
  )
  const exact = await readExecutionJournal(fixture.root, { maxBytes: 64 * 1024, maxEvents: 2 })
  assert.equal(exact.kind, 'ok')
  assert.ok(exact.kind === 'ok' && exact.events.length === 2)
})

test('explicit zero limits accept an empty journal', async (context) => {
  const fixture = await makeJournal(context, { eventCount: 0 })

  const result = await readExecutionJournal(fixture.root, { maxBytes: 0, maxEvents: 0 })

  assert.equal(result.kind, 'ok')
  assert.ok(result.kind === 'ok' && result.events.length === 0)
})

test('an explicitly bounded assignment read refuses a journal symlink', async (context) => {
  const fixture = await makeJournal(context)
  const elsewhere = path.join(fixture.root, 'elsewhere.jsonl')
  await fs.rename(fixture.journalPath, elsewhere)
  await fs.symlink(elsewhere, fixture.journalPath)

  assert.deepEqual(
    await readExecutionJournal(fixture.root, { maxBytes: 64 * 1024, maxEvents: 2 }),
    { kind: 'corrupt', reason: 'journal_over_bound' },
  )
})

test('omitting limits retains assignment reads beyond conversation byte and event bounds', async (context) => {
  const fixture = await makeJournal(context, {
    eventCount: CONVERSATION_JOURNAL_MAX_EVENTS + 1,
    filler: 'x'.repeat(8192),
  })
  assert.ok((await fs.stat(fixture.journalPath)).size > CONVERSATION_JOURNAL_MAX_BYTES)

  const result = await readExecutionJournal(fixture.root)

  assert.equal(result.kind, 'ok')
  assert.ok(result.kind === 'ok' && result.events.length === CONVERSATION_JOURNAL_MAX_EVENTS + 1)
})

test('explicit limits cannot raise the conversation byte bound', async (context) => {
  const fixture = await makeJournal(context, {
    eventCount: 0,
    identity: {
      scopeKind: 'conversation',
      scopeId: 'activity-1',
      tenantId: 'local',
      sessionId: 'session-1',
      conversationId: 'session-1',
      activityKind: 'turn',
    },
  })
  await fs.writeFile(fixture.journalPath, Buffer.alloc(CONVERSATION_JOURNAL_MAX_BYTES + 1, 'x'))

  assert.deepEqual(
    await readExecutionJournal(fixture.root, {
      maxBytes: CONVERSATION_JOURNAL_MAX_BYTES * 2,
      maxEvents: CONVERSATION_JOURNAL_MAX_EVENTS * 2,
    }),
    { kind: 'corrupt', reason: 'journal_over_bound' },
  )
})

test('explicit limits cannot raise the conversation event bound', async (context) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'journal-read-events-')))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const sessionId = '00000000-0000-4000-8000-000000000001'
  const activityId = '00000000-0000-4000-8000-000000000002'
  writeOversizedConversationActivity({
    workspacePath: root,
    sessionId,
    tenantId: 'local',
    activityId,
    eventCount: CONVERSATION_JOURNAL_MAX_EVENTS + 1,
  })

  assert.deepEqual(
    await readExecutionJournal(path.join(root, 'sessions', sessionId, '.conversation-activities', activityId), {
      maxBytes: CONVERSATION_JOURNAL_MAX_BYTES * 2,
      maxEvents: CONVERSATION_JOURNAL_MAX_EVENTS * 2,
    }),
    { kind: 'corrupt', reason: 'journal_over_bound' },
  )
})

for (const limits of [
  { maxBytes: -1, maxEvents: 2 },
  { maxBytes: Number.NaN, maxEvents: 2 },
  { maxBytes: 64 * 1024, maxEvents: -1 },
  { maxBytes: 64 * 1024, maxEvents: Number.POSITIVE_INFINITY },
]) {
  test(`invalid explicit limits are refused (${String(limits.maxBytes)} bytes, ${String(limits.maxEvents)} events)`, async (context) => {
    const fixture = await makeJournal(context)

    assert.deepEqual(await readExecutionJournal(fixture.root, limits), {
      kind: 'corrupt',
      reason: 'read_limits_invalid',
    })
  })
}
