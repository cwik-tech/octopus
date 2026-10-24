import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityExecutionContext,
  CapabilityInvocation,
} from '../../contracts/capability-dispatch.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { CapabilityDispatchRuntime } from '../../services/capability-dispatch-runtime.js'
import { readExecutionJournal } from '../../core/execution-journal.js'

/**
 * AC6: a transient failure must not permanently disable a journal (ADR A-2).
 *
 * Today every error raised inside the guarded commit sets `poisoned = true`,
 * and a poisoned journal rejects every later append. The registry keeps
 * handing out the same cached journal, so one recoverable I/O fault ends the
 * assignment's durable history for the life of the process — and, because the
 * workflow recorder shares that cached journal, every workflow transition on
 * the assignment with it.
 *
 * The fault here is a real one on a real filesystem, and it happens **inside
 * the commit**, after the in-memory index has already advanced: the journal
 * file is made unwritable, so reopening it for append fails with `EACCES` —
 * the transient row of the classification table, not the manifest permission
 * check that `validateEnvironmentLocked` performs before the commit begins.
 */

const SCOPE = {
  sessionId: 'session-transient',
  runId: 'run-transient',
  assignmentId: 'assignment-transient',
} as const

function makeWorkspace(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'journal-transient-')),
  )
}

function makeContext(requestId: string): CapabilityExecutionContext {
  return {
    contractVersion: 1,
    requestId,
    ...SCOPE,
    taskId: 'task-transient',
    agentPath: 'agents/transient',
    authority: { kind: 'runtime-assignment', processIdentity: 'transient' },
  }
}

function makeInvocation(toolCallId: string): CapabilityInvocation {
  return {
    capabilityId: 'test.mutate',
    source: { kind: 'builtin', id: 'transient', version: '1' },
    toolCallId,
    input: { target: 'counter' },
  }
}

/** Counts entries into the executor, so "failed closed" can be distinguished. */
function makeAdapter(entered: { count: number }): CapabilityAdapter {
  return {
    capabilityId: 'test.mutate',
    prepare: async () => ({
      effect: serialCapabilityEffect('mutating'),
      risk: 'test-mutating',
      argumentNames: ['target'],
      policyDecision: { kind: 'allow' },
      recoveryPolicy: 'non_retryable' as const,
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => {
        entered.count += 1
        return { ok: true }
      },
      acceptResult: async ({ value }) => ({ value }),
    }),
  }
}

function journalPath(workspacePath: string): string {
  const location = buildSessionRunAssignmentLocation(workspacePath, SCOPE)
  assert.ok(location)
  return path.join(
    location.assignmentPath,
    '.runtime',
    'execution-journal',
    'journal.jsonl',
  )
}

/**
 * Make the journal file unwritable for the next commit.
 *
 * The content is preserved and re-linked as a new inode, because the journal
 * caches its open descriptor and an already-open descriptor keeps the write
 * access it was opened with. Replacing the inode is what forces the commit to
 * reopen — and to meet the fault — rather than writing through a descriptor
 * obtained before the mode changed.
 */
function makeJournalUnwritable(workspacePath: string): void {
  const target = journalPath(workspacePath)
  const contents = fs.readFileSync(target)
  const replacement = `${target}.replacement`
  fs.writeFileSync(replacement, contents, { mode: 0o400 })
  fs.rmSync(target)
  fs.renameSync(replacement, target)
}

function makeJournalWritableAgain(workspacePath: string): void {
  fs.chmodSync(journalPath(workspacePath), 0o600)
}

test('a transient write fault fails one dispatch closed and the next one succeeds', async (t) => {
  const workspacePath = makeWorkspace()
  t.after(() => fs.rmSync(workspacePath, { recursive: true, force: true }))
  const location = buildSessionRunAssignmentLocation(workspacePath, SCOPE)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })

  const entered = { count: 0 }
  const runtime = new CapabilityDispatchRuntime({
    workspacePath,
    leaseResolver: () => null,
    runtimeAuthority: {
      authorize: async (claims) => ({
        taskId: claims.taskId,
        workflowId: claims.workflowId ?? 'workflow-transient',
        runPath: location.runPath,
        assignmentPath: location.assignmentPath,
      }),
    },
    executionJournal: { mode: 'authoritative', tenantId: 'tenant-transient' },
  })
  t.after(() => runtime.close())

  const first = await runtime.dispatcher.dispatch({
    context: makeContext('request-one'),
    invocation: makeInvocation('call-one'),
    adapter: makeAdapter(entered),
  })
  assert.equal(first.status, 'completed', JSON.stringify(first))
  assert.equal(entered.count, 1)

  const eventsAfterFirst = await journalEventCount(workspacePath)
  assert.ok(eventsAfterFirst > 0, 'the first dispatch must journal its barriers')

  makeJournalUnwritable(workspacePath)

  const second = await runtime.dispatcher.dispatch({
    context: makeContext('request-two'),
    invocation: makeInvocation('call-two'),
    adapter: makeAdapter(entered),
  })
  assert.equal(
    second.status,
    'failed',
    `an unwritable journal must fail the dispatch closed: ${JSON.stringify(second)}`,
  )
  assert.equal(
    second.status === 'failed' ? second.code : '',
    'durable_journal_unavailable',
    `and must say so as an unavailable durability barrier, which is the ` +
      `terminal code a caller retries on: ${JSON.stringify(second)}`,
  )
  assert.equal(
    entered.count,
    1,
    'and must not enter the executor without a durability barrier',
  )

  makeJournalWritableAgain(workspacePath)

  const third = await runtime.dispatcher.dispatch({
    context: makeContext('request-three'),
    invocation: makeInvocation('call-three'),
    adapter: makeAdapter(entered),
  })
  assert.equal(
    third.status,
    'completed',
    `the fault is gone, so the journal must reopen and the dispatch must ` +
      `succeed: ${JSON.stringify(third)}`,
  )
  assert.equal(entered.count, 2, 'and the executor must run this time')

  const read = await readExecutionJournal(location.assignmentPath)
  assert.equal(read.kind, 'ok', `the journal must still be readable: ${read.kind}`)
  if (read.kind !== 'ok') return
  assert.ok(
    read.events.length > eventsAfterFirst,
    `the recovered journal must hold the third dispatch's events too: ` +
      `${eventsAfterFirst} before, ${read.events.length} after`,
  )
})

async function journalEventCount(workspacePath: string): Promise<number> {
  const location = buildSessionRunAssignmentLocation(workspacePath, SCOPE)
  assert.ok(location)
  const read = await readExecutionJournal(location.assignmentPath)
  return read.kind === 'ok' ? read.events.length : 0
}
