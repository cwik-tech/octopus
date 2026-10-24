import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { CanonicalJsonValue } from '../../contracts/canonical-json.js'
import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type {
  CapabilityResultContentRead,
  CapabilityResultContentReceipt,
  CapabilityResultContentStore,
  CapabilityResultContentWrite,
} from '../../contracts/durable-dispatch.js'
import type {
  ExecutionJournalAppendInput,
  ExecutionJournalAppendOutcome,
  ExecutionJournalEvent,
  ExecutionJournalManifest,
} from '../../contracts/execution-journal.js'
import type { ExecutionJournal } from '../../core/execution-journal.js'
import {
  createJournalBackedDurableDispatch,
  summarizeCapabilityResultRetention,
} from '../../core/durable-dispatch-journal.js'

/**
 * Phase 3: the retained-result payload names external content and carries
 * none. Written against the payload an operator or a replay reads back, not
 * against the writer's internals, so the same tests hold for the v1 forms this
 * still has to read and for the v2 form it now writes.
 */

const RESULT_SENTINEL = 'unit-result-sentinel-c4a19f'
/** Keys already sorted and ASCII-only, so this is its own canonical form. */
const RESULT_VALUE = { kind: 'browser.snapshot', text: RESULT_SENTINEL }
const RESULT_CANONICAL = `{"kind":"browser.snapshot","text":"${RESULT_SENTINEL}"}`
const RESULT_SHA256 = createHash('sha256')
  .update(RESULT_CANONICAL, 'utf8')
  .digest('hex')

const ARGUMENT_DIGEST = 'd'.repeat(64)

test('an accepted result is journaled as a content receipt and never as a value', async () => {
  const journal = makeJournal()
  const store = makeContentStore()
  const port = createJournalBackedDurableDispatch(journal.journal, {
    resultContentStore: store.store,
  })

  await recordAcceptedDispatch(port)

  const accepted = journal.find('capability.dispatch.accepted')
  assert.ok(accepted)
  assert.equal(accepted.payload['resultKind'], 'content')
  assert.deepEqual(accepted.payload['resultContent'], {
    contentId: RESULT_SHA256,
    contentSha256: RESULT_SHA256,
    byteLength: Buffer.byteLength(RESULT_CANONICAL, 'utf8'),
    mediaType: 'application/json',
    resultSchemaVersion: 2,
  })
  assert.equal(accepted.payload['resultValue'], undefined)
  assert.equal(accepted.payload['receipt'], undefined)
  assert.ok(!JSON.stringify(accepted.payload).includes(RESULT_SENTINEL))
})

test('a result-bearing event declares payload version 2 and a lifecycle event does not', async () => {
  const journal = makeJournal()
  const port = createJournalBackedDurableDispatch(journal.journal, {
    resultContentStore: makeContentStore().store,
  })

  await recordAcceptedDispatch(port)

  // The envelope version is what a reader dispatches on before it looks at a
  // payload, so the payload that changed shape is the one that has to declare
  // it. Nothing about `requested`, `prepared` or `started` changed, and
  // bumping them would tell every reader the whole stream is new.
  assert.equal(
    journal.find('capability.dispatch.accepted')?.payloadSchemaVersion,
    2,
  )
  for (const type of ['requested', 'prepared', 'started']) {
    assert.equal(
      journal.find(`capability.dispatch.${type}`)?.payloadSchemaVersion,
      1,
      `capability.dispatch.${type} carries no result and keeps version 1`,
    )
  }
})

test('a committed resolution that carries a result declares payload version 2', async () => {
  const journal = makeJournal()
  const port = createJournalBackedDurableDispatch(journal.journal, {
    resultContentStore: makeContentStore().store,
  })
  await recordPreparedDispatch(port)
  await port.recordIndeterminate({
    dispatchId: 'dispatch-one',
    attemptId: 'attempt-one',
    code: 'unproven',
  })

  const outcome = await port.recordOperatorResolution({
    dispatchId: 'dispatch-one',
    scope: {
      sessionId: 'session-one',
      runId: 'run-one',
      assignmentId: 'assignment-one',
    },
    decision: 'committed',
    principal: {
      credentialScope: 'operator',
      tenantId: 'tenant-unit',
      processInstanceId: 'process-one',
    },
    reason: 'reconciled by hand',
    recordedAtMs: 1,
    result: { kind: 'inline', value: RESULT_VALUE },
  })

  assert.equal(outcome.kind, 'recorded')
  const decided = journal.find('capability.dispatch.resolved.committed')
  assert.ok(decided)
  assert.equal(decided.payloadSchemaVersion, 2)
  assert.equal(decided.payload['resultKind'], 'content')
  assert.equal(decided.payload['resultValue'], undefined)
  assert.ok(!JSON.stringify(decided.payload).includes(RESULT_SENTINEL))
})

test('a decision that carries no result keeps payload version 1', async () => {
  const journal = makeJournal()
  const port = createJournalBackedDurableDispatch(journal.journal, {
    resultContentStore: makeContentStore().store,
  })
  await recordPreparedDispatch(port)
  await port.recordIndeterminate({
    dispatchId: 'dispatch-one',
    attemptId: 'attempt-one',
    code: 'unproven',
  })

  await port.recordOperatorResolution({
    dispatchId: 'dispatch-one',
    scope: {
      sessionId: 'session-one',
      runId: 'run-one',
      assignmentId: 'assignment-one',
    },
    decision: 'abandon',
    principal: {
      credentialScope: 'operator',
      tenantId: 'tenant-unit',
      processInstanceId: 'process-one',
    },
    reason: 'nothing committed',
    recordedAtMs: 1,
  })

  assert.equal(
    journal.find('capability.dispatch.resolved.abandoned')?.payloadSchemaVersion,
    1,
  )
})

test('a v1 stream is still readable rather than reported as an unsupported version', async () => {
  const journal = makeJournal()
  seedDispatchStream(journal, {
    resultKind: 'inline',
    resultValue: RESULT_VALUE,
  })
  const port = createJournalBackedDurableDispatch(journal.journal, {
    resultContentStore: makeContentStore().store,
  })

  const inspected = await port.inspectOutcome({ dispatchId: 'dispatch-one' })

  assert.equal(inspected.kind, 'outcome')
  if (inspected.kind !== 'outcome') return
  assert.equal(inspected.state, 'accepted')
})

test('a lifecycle payload claiming the result version is not a shape this build defines', async () => {
  const journal = makeJournal()
  seedDispatchStream(
    journal,
    { resultKind: 'inline', resultValue: RESULT_VALUE },
    { requestedPayloadSchemaVersion: 2 },
  )
  const port = createJournalBackedDurableDispatch(journal.journal, {
    resultContentStore: makeContentStore().store,
  })

  // Version 2 exists only for a payload that carries a retained result.
  // `requested` carries none, so reading it as version 2 would be reading a
  // shape nothing ever wrote.
  const inspected = await port.inspectOutcome({ dispatchId: 'dispatch-one' })

  assert.equal(inspected.kind, 'unsupported_version')
})

test('a v2 acceptance carrying a result value is refused rather than replayed', async () => {
  const journal = makeJournal()
  const store = makeContentStore()
  await store.store.write(RESULT_CANONICAL)
  // Everything about this record is usable except that it also carries the
  // result itself, which payload v2 forbids. Reading it would replay a value
  // from a field the format says is not there.
  seedDispatchStream(
    journal,
    {
      resultKind: 'content',
      resultContent: contentReceipt(),
      resultValue: RESULT_VALUE,
    },
    { acceptedPayloadSchemaVersion: 2 },
  )
  const port = createJournalBackedDurableDispatch(journal.journal, {
    resultContentStore: store.store,
  })

  const recovery = await port.recover({
    dispatchId: 'dispatch-one',
    argumentDigest: ARGUMENT_DIGEST,
  })

  assert.equal(recovery.kind, 'blocked')
})

test('a v1 acceptance claiming a content identity is refused rather than replayed', async () => {
  const journal = makeJournal()
  const store = makeContentStore()
  await store.store.write(RESULT_CANONICAL)
  seedDispatchStream(journal, {
    resultKind: 'content',
    resultContent: contentReceipt(),
  })
  const port = createJournalBackedDurableDispatch(journal.journal, {
    resultContentStore: store.store,
  })

  // The content is genuinely there. What is wrong is the record: a version 1
  // payload never named external content, so one that claims to is not a
  // record this build wrote.
  const recovery = await port.recover({
    dispatchId: 'dispatch-one',
    argumentDigest: ARGUMENT_DIGEST,
  })

  assert.equal(recovery.kind, 'blocked')
})

test('a payload that still carries result content is reported as content-bearing whatever version it claims', () => {
  const journal = makeJournal()
  seedDispatchStream(
    journal,
    {
      resultKind: 'content',
      resultContent: contentReceipt(),
      resultValue: RESULT_VALUE,
    },
    { acceptedPayloadSchemaVersion: 2 },
  )

  const summary = summarizeCapabilityResultRetention(journal.events)

  // The report answers "does this journal still hold result content", so it
  // is decided by the fields that are there, not by the version the record
  // claims for itself.
  assert.equal(summary.counts.legacy_inline_v1, 1)
  assert.equal(summary.counts.content_reference_v2, 0)
  assert.equal(summary.legacyContentBearing, true)
})

test('a v2 stream is readable by the same inspection path', async () => {
  const journal = makeJournal()
  const port = createJournalBackedDurableDispatch(journal.journal, {
    resultContentStore: makeContentStore().store,
  })
  await recordAcceptedDispatch(port)

  const inspected = await port.inspectOutcome({ dispatchId: 'dispatch-one' })

  assert.equal(inspected.kind, 'outcome')
  if (inspected.kind !== 'outcome') return
  assert.equal(inspected.state, 'accepted')
})

test('the injected content store receives the canonical result bytes', async () => {
  const journal = makeJournal()
  const store = makeContentStore()
  const port = createJournalBackedDurableDispatch(journal.journal, {
    resultContentStore: store.store,
  })

  await recordAcceptedDispatch(port)

  assert.deepEqual(store.writes, [RESULT_CANONICAL])
})

test('recovery replays a v2 result by reading the external content store', async () => {
  const journal = makeJournal()
  const store = makeContentStore()
  const port = createJournalBackedDurableDispatch(journal.journal, {
    resultContentStore: store.store,
  })
  await recordAcceptedDispatch(port)

  const recovery = await port.recover({
    dispatchId: 'dispatch-one',
    argumentDigest: ARGUMENT_DIGEST,
  })

  assert.equal(recovery.kind, 'retained')
  if (recovery.kind !== 'retained') return
  assert.equal(recovery.result.status, 'completed')
  if (recovery.result.status !== 'completed') return
  assert.deepEqual(recovery.result.value, RESULT_VALUE)
  assert.deepEqual(store.reads, [RESULT_SHA256])
})

test('a v1 inline acceptance stays readable', async () => {
  const journal = makeJournal()
  seedDispatchStream(journal, {
    resultKind: 'inline',
    resultValue: RESULT_VALUE,
  })
  const port = createJournalBackedDurableDispatch(journal.journal, {
    resultContentStore: makeContentStore().store,
  })

  const recovery = await port.recover({
    dispatchId: 'dispatch-one',
    argumentDigest: ARGUMENT_DIGEST,
  })

  assert.equal(recovery.kind, 'retained')
  if (recovery.kind !== 'retained') return
  assert.equal(recovery.result.status, 'completed')
  if (recovery.result.status !== 'completed') return
  assert.deepEqual(recovery.result.value, RESULT_VALUE)
})

test('a v1 journal-owned receipt stays readable', async () => {
  const journal = makeJournal()
  const resultsDirectory = path.join(journal.journalDirectory, 'results')
  fs.mkdirSync(resultsDirectory, { mode: 0o700, recursive: true })
  fs.writeFileSync(
    path.join(resultsDirectory, `${RESULT_SHA256}.json`),
    RESULT_CANONICAL,
    { mode: 0o600 },
  )
  seedDispatchStream(journal, {
    resultKind: 'receipt',
    receipt: {
      relativePath: `results/${RESULT_SHA256}.json`,
      contentSha256: RESULT_SHA256,
      byteLength: Buffer.byteLength(RESULT_CANONICAL, 'utf8'),
      mediaType: 'application/json',
      resultSchemaVersion: 1,
    },
  })
  const port = createJournalBackedDurableDispatch(journal.journal, {
    resultContentStore: makeContentStore().store,
  })

  const recovery = await port.recover({
    dispatchId: 'dispatch-one',
    argumentDigest: ARGUMENT_DIGEST,
  })

  assert.equal(recovery.kind, 'retained')
  if (recovery.kind !== 'retained') return
  assert.equal(recovery.result.status, 'completed')
  if (recovery.result.status !== 'completed') return
  assert.deepEqual(recovery.result.value, RESULT_VALUE)
})

test('content the store no longer holds blocks replay instead of inventing one', async () => {
  const journal = makeJournal()
  const store = makeContentStore()
  const port = createJournalBackedDurableDispatch(journal.journal, {
    resultContentStore: store.store,
  })
  await recordAcceptedDispatch(port)
  store.forget()

  const recovery = await port.recover({
    dispatchId: 'dispatch-one',
    argumentDigest: ARGUMENT_DIGEST,
  })

  assert.equal(recovery.kind, 'blocked')
  if (recovery.kind !== 'blocked') return
  assert.equal(recovery.state, 'indeterminate')
})

test('content that no longer matches its digest blocks replay', async () => {
  const journal = makeJournal()
  const store = makeContentStore()
  const port = createJournalBackedDurableDispatch(journal.journal, {
    resultContentStore: store.store,
  })
  await recordAcceptedDispatch(port)
  store.tamper()

  const recovery = await port.recover({
    dispatchId: 'dispatch-one',
    argumentDigest: ARGUMENT_DIGEST,
  })

  assert.equal(recovery.kind, 'blocked')
})

test('a result the store refuses is never recorded as accepted', async () => {
  const journal = makeJournal()
  const store = makeContentStore({
    write: async () => ({
      kind: 'too_large',
      byteLength: 1_000,
      maxByteLength: 10,
    }),
  })
  const port = createJournalBackedDurableDispatch(journal.journal, {
    resultContentStore: store.store,
  })
  await recordPreparedDispatch(port)

  await assert.rejects(() =>
    port.recordAccepted({
      dispatchId: 'dispatch-one',
      attemptId: 'attempt-one',
      result: {
        status: 'completed',
        dispatchId: 'dispatch-one',
        value: RESULT_VALUE,
        costTracked: false,
        budgetOverrun: false,
      },
    }),
  )
  assert.equal(journal.find('capability.dispatch.accepted'), undefined)
})

test('a value the canonical form rejects is retained as nothing at all', async () => {
  const journal = makeJournal()
  const store = makeContentStore()
  const port = createJournalBackedDurableDispatch(journal.journal, {
    resultContentStore: store.store,
  })
  await recordPreparedDispatch(port)
  await port.recordAccepted({
    dispatchId: 'dispatch-one',
    attemptId: 'attempt-one',
    result: {
      status: 'completed',
      dispatchId: 'dispatch-one',
      value: 'not an object',
      costTracked: false,
      budgetOverrun: false,
    },
  })

  const accepted = journal.find('capability.dispatch.accepted')
  assert.ok(accepted)
  assert.equal(accepted.payload['resultKind'], 'unserializable')
  assert.deepEqual(store.writes, [])
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function recordPreparedDispatch(
  port: ReturnType<typeof createJournalBackedDurableDispatch>,
): Promise<void> {
  await port.recordRequested({
    dispatchId: 'dispatch-one',
    attemptId: 'attempt-one',
  })
  await port.recordPrepared({
    dispatchId: 'dispatch-one',
    attemptId: 'attempt-one',
    argumentDigest: ARGUMENT_DIGEST,
    capabilityId: 'browser.snapshot',
    effect: serialCapabilityEffect('read-only'),
    recoveryPolicy: 'read_only_retryable',
  })
  await port.recordStarted({
    dispatchId: 'dispatch-one',
    attemptId: 'attempt-one',
  })
}

async function recordAcceptedDispatch(
  port: ReturnType<typeof createJournalBackedDurableDispatch>,
): Promise<void> {
  await recordPreparedDispatch(port)
  await port.recordAccepted({
    dispatchId: 'dispatch-one',
    attemptId: 'attempt-one',
    result: {
      status: 'completed',
      dispatchId: 'dispatch-one',
      value: RESULT_VALUE,
      costTracked: false,
      budgetOverrun: false,
    },
  })
}

function contentReceipt(): CanonicalJsonValue {
  return {
    contentId: RESULT_SHA256,
    contentSha256: RESULT_SHA256,
    byteLength: Buffer.byteLength(RESULT_CANONICAL, 'utf8'),
    mediaType: 'application/json',
    resultSchemaVersion: 2,
  }
}

interface TestJournal {
  readonly journal: ExecutionJournal
  readonly journalDirectory: string
  readonly events: ExecutionJournalEvent[]
  find(type: string): ExecutionJournalEvent | undefined
}

function makeJournal(): TestJournal {
  const scopeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'durable-dispatch-journal-unit-'),
  )
  const journalDirectory = path.join(
    scopeRoot,
    '.runtime',
    'execution-journal',
  )
  fs.mkdirSync(journalDirectory, { mode: 0o700, recursive: true })
  const events: ExecutionJournalEvent[] = []
  const journal: ExecutionJournal = {
    manifest: makeManifest(),
    journalDirectoryPath: journalDirectory,
    append: async (
      input: ExecutionJournalAppendInput,
    ): Promise<ExecutionJournalAppendOutcome> => {
      const event = makeEvent(input, events.length + 1)
      events.push(event)
      return { kind: 'appended', event }
    },
    scan: async () => ({
      eventCount: events.length,
      lastSequence: events[events.length - 1]?.sequence ?? 0,
      events: [...events],
      truncatedFragmentBytes: 0,
    }),
    scanStream: async (streamKind: string, streamId: string) => {
      const matched = events.filter(
        (event) =>
          event.streamKind === streamKind && event.streamId === streamId,
      )
      return {
        eventCount: matched.length,
        lastSequence: matched[matched.length - 1]?.sequence ?? 0,
        events: matched,
        truncatedFragmentBytes: 0,
      }
    },
    close: async () => undefined,
    getMetrics: () => {
      throw new Error('metrics are not part of this contract')
    },
    isRetired: () => false,
  }
  return {
    journal,
    journalDirectory,
    events,
    find: (type) => events.find((event) => event.type === type),
  }
}

/** A stream that already holds a v1 acceptance, as an older build wrote it. */
function seedDispatchStream(
  journal: TestJournal,
  retained: Record<string, CanonicalJsonValue>,
  versions: {
    readonly requestedPayloadSchemaVersion?: number
    readonly acceptedPayloadSchemaVersion?: number
  } = {},
): void {
  const append = (
    type: string,
    payload: Record<string, CanonicalJsonValue>,
    payloadSchemaVersion = 1,
  ): void => {
    journal.events.push(
      makeEvent(
        {
          eventId: `dispatch-one:${type}`,
          streamKind: 'capability.dispatch',
          streamId: 'dispatch-one',
          expectedStreamRevision: journal.events.length,
          type: `capability.dispatch.${type}`,
          payloadSchemaVersion,
          payload,
          correlationId: 'dispatch-one',
        },
        journal.events.length + 1,
      ),
    )
  }
  append(
    'requested',
    { attemptId: 'attempt-one' },
    versions.requestedPayloadSchemaVersion,
  )
  append('prepared', {
    attemptId: 'attempt-one',
    argumentDigest: ARGUMENT_DIGEST,
    capabilityId: 'browser.snapshot',
    effectKind: 'read-only',
    effectConcurrency: 'serial',
    recoveryPolicy: 'read_only_retryable',
  })
  append('started', { attemptId: 'attempt-one' })
  append(
    'accepted',
    {
      attemptId: 'attempt-one',
      dispatchId: 'dispatch-one',
      status: 'completed',
      costTracked: false,
      budgetOverrun: false,
      ...retained,
    },
    versions.acceptedPayloadSchemaVersion,
  )
}

function makeManifest(): ExecutionJournalManifest {
  return {
    schemaVersion: 1,
    scopeKind: 'assignment',
    scopeId: 'assignment-one',
    tenantId: 'tenant-unit',
    createdAt: '2026-08-26T00:00:00.000Z',
    journalRelativePath: 'journal.jsonl',
    initialSequence: 0,
    initialPreviousEventHash: '0'.repeat(64),
    createdBy: { implementation: 'test', version: 1 },
  }
}

function makeEvent(
  input: ExecutionJournalAppendInput,
  sequence: number,
): ExecutionJournalEvent {
  return {
    schemaVersion: 1,
    eventId: input.eventId,
    sequence,
    recordedAt: '2026-08-26T00:00:00.000Z',
    scopeKind: 'assignment',
    scopeId: 'assignment-one',
    tenantId: 'tenant-unit',
    streamKind: input.streamKind,
    streamId: input.streamId,
    streamRevision: input.expectedStreamRevision + 1,
    type: input.type,
    payloadSchemaVersion: input.payloadSchemaVersion,
    appendRequestDigest: 'e'.repeat(64),
    correlationId: input.correlationId,
    previousEventHash: '0'.repeat(64),
    eventHash: 'f'.repeat(64),
    payload: input.payload,
  }
}

interface TestContentStore {
  readonly store: CapabilityResultContentStore
  readonly writes: string[]
  readonly reads: string[]
  forget(): void
  tamper(): void
}

function makeContentStore(
  overrides: Partial<CapabilityResultContentStore> = {},
): TestContentStore {
  const held = new Map<string, string>()
  const writes: string[] = []
  const reads: string[] = []
  let tampered = false
  const store: CapabilityResultContentStore = {
    write:
      overrides.write ??
      (async (canonical: string): Promise<CapabilityResultContentWrite> => {
        writes.push(canonical)
        const contentId = createHash('sha256')
          .update(canonical, 'utf8')
          .digest('hex')
        held.set(contentId, canonical)
        return {
          kind: 'stored',
          receipt: {
            contentId,
            contentSha256: contentId,
            byteLength: Buffer.byteLength(canonical, 'utf8'),
            mediaType: 'application/json',
            resultSchemaVersion: 2,
          },
        }
      }),
    read:
      overrides.read ??
      (async (
        receipt: CapabilityResultContentReceipt,
      ): Promise<CapabilityResultContentRead> => {
        reads.push(receipt.contentId)
        if (tampered) return { kind: 'mismatched', reason: 'digest' }
        const canonical = held.get(receipt.contentId)
        return canonical === undefined
          ? { kind: 'absent' }
          : { kind: 'content', canonical }
      }),
  }
  return {
    store,
    writes,
    reads,
    forget: () => held.clear(),
    tamper: () => {
      tampered = true
    },
  }
}
