/**
 * A scope kind is a shape, not a label.
 *
 * Every identity field was checked on its own: is this a valid identifier, if
 * it is present at all. Nothing checked whether the *set* of fields made sense
 * together, so an assignment could carry a conversation id, a conversation
 * journal could be opened with no conversation at all, and a batch could claim
 * to belong to an assignment. Each of those is a journal whose identity says
 * one thing and whose contents assume another — and because the genesis hash
 * seals whatever it was given, the mismatch becomes permanent the moment the
 * manifest is written.
 *
 * So the rules are stated per kind, and stated once for both directions: what a
 * new journal may be opened with, and what an existing manifest may be read as.
 * A file that could never have been written by this build must not be accepted
 * by it either.
 *
 * Deliberately not asserted: that an assignment's `scopeId` equals its
 * `assignmentId`. Existing journals were written under contracts where it does
 * not, and rejecting them would make old workspaces unreadable to make a new
 * rule tidy.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { ExecutionJournalScopeIdentity } from '../../contracts/execution-journal.js'
import {
  initializeExecutionJournal,
  parseExecutionJournalManifest,
} from '../../core/execution-journal.js'

const ASSIGNMENT: ExecutionJournalScopeIdentity = {
  scopeKind: 'assignment',
  scopeId: 'assignment-1',
  tenantId: 'local',
  sessionId: 'session-1',
  runId: 'run-1',
  assignmentId: 'assignment-1',
}

const BATCH: ExecutionJournalScopeIdentity = {
  scopeKind: 'batch',
  scopeId: 'execution-1',
  tenantId: 'local',
}

const CONVERSATION: ExecutionJournalScopeIdentity = {
  scopeKind: 'conversation',
  scopeId: 'activity-1',
  tenantId: 'local',
  sessionId: 'session-1',
  conversationId: 'session-1',
  activityKind: 'turn',
}

/** The same identity with one field genuinely absent, not present-and-undefined. */
function without(
  identity: ExecutionJournalScopeIdentity,
  field: keyof ExecutionJournalScopeIdentity,
): ExecutionJournalScopeIdentity {
  const copy: Record<string, unknown> = { ...identity }
  delete copy[field]
  return copy as unknown as ExecutionJournalScopeIdentity
}

function manifestFor(identity: ExecutionJournalScopeIdentity): unknown {
  return {
    schemaVersion: 1,
    ...identity,
    createdAt: '2026-08-26T00:00:00.000Z',
    journalRelativePath: 'journal.jsonl',
    initialSequence: 0,
    initialPreviousEventHash: 'ab'.repeat(32),
    createdBy: { implementation: 'pipeline-execution-journal', version: 1 },
  }
}

/** Open a journal with this identity, reporting only whether it was accepted. */
async function opens(identity: ExecutionJournalScopeIdentity): Promise<boolean> {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'scope-shape-')),
  )
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot: directory,
      identity,
    })
    await journal.close()
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function parses(identity: ExecutionJournalScopeIdentity): boolean {
  try {
    parseExecutionJournalManifest(manifestFor(identity))
    return true
  } catch {
    return false
  }
}

const REFUSED: readonly {
  readonly why: string
  readonly identity: ExecutionJournalScopeIdentity
}[] = [
  {
    why: 'an assignment with no session',
    identity: without(ASSIGNMENT, 'sessionId'),
  },
  { why: 'an assignment with no run', identity: without(ASSIGNMENT, 'runId') },
  {
    why: 'an assignment with no assignment',
    identity: without(ASSIGNMENT, 'assignmentId'),
  },
  {
    why: 'an assignment carrying a conversation',
    identity: { ...ASSIGNMENT, conversationId: 'session-1' },
  },
  {
    why: 'an assignment carrying an activity kind',
    identity: { ...ASSIGNMENT, activityKind: 'turn' },
  },
  { why: 'a batch carrying a session', identity: { ...BATCH, sessionId: 'session-1' } },
  { why: 'a batch carrying a run', identity: { ...BATCH, runId: 'run-1' } },
  {
    why: 'a batch carrying an assignment',
    identity: { ...BATCH, assignmentId: 'assignment-1' },
  },
  {
    why: 'a batch carrying a conversation',
    identity: { ...BATCH, conversationId: 'session-1' },
  },
  {
    why: 'a batch carrying an activity kind',
    identity: { ...BATCH, activityKind: 'turn' },
  },
  {
    why: 'a conversation with no session',
    identity: without(CONVERSATION, 'sessionId'),
  },
  {
    why: 'a conversation with no conversation',
    identity: without(CONVERSATION, 'conversationId'),
  },
  {
    why: 'a conversation with no activity kind',
    identity: without(CONVERSATION, 'activityKind'),
  },
  {
    why: 'a conversation carrying a run',
    identity: { ...CONVERSATION, runId: 'run-1' },
  },
  {
    why: 'a conversation carrying an assignment',
    identity: { ...CONVERSATION, assignmentId: 'assignment-1' },
  },
]

test('a journal cannot be opened with an identity of the wrong shape', async () => {
  for (const { why, identity } of REFUSED) {
    assert.equal(await opens(identity), false, `${why} was accepted`)
  }
})

test('a manifest of the wrong shape is not read as one of the right shape', () => {
  for (const { why, identity } of REFUSED) {
    assert.equal(parses(identity), false, `${why} parsed`)
  }
})

test('the shapes this build actually writes are all still accepted', async () => {
  for (const [why, identity] of [
    ['an assignment', ASSIGNMENT],
    ['a batch', BATCH],
    ['a conversation', CONVERSATION],
  ] as const) {
    assert.equal(await opens(identity), true, `${why} was refused`)
    assert.equal(parses(identity), true, `${why} did not parse`)
  }
})

test('an assignment whose scope id is not its assignment id still reads', () => {
  // Older journals were written this way. Rejecting them would make existing
  // workspaces unreadable in exchange for a tidier rule.
  const legacy: ExecutionJournalScopeIdentity = {
    ...ASSIGNMENT,
    scopeId: 'a-scope-that-is-not-the-assignment',
  }
  assert.equal(parses(legacy), true)
})
