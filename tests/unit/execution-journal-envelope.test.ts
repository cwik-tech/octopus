import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXECUTION_JOURNAL_SCHEMA_VERSION,
  ExecutionJournalError,
  type ExecutionJournalEvent,
  type ExecutionJournalManifest,
} from '../../contracts/execution-journal.js'
import {
  canonicalizeAppendRequest,
  classifyJournalTail,
  computeAppendRequestDigest,
  parseJournalEnvelope,
  recomputeAppendRequestDigest,
  recomputeEventHash,
  validateJournalContent,
  verifyStreamRevision,
  type JournalAppendRequestFields,
} from '../../core/execution-journal.js'

function makeManifest(
  overrides: Partial<ExecutionJournalManifest> = {},
): ExecutionJournalManifest {
  return {
    schemaVersion: EXECUTION_JOURNAL_SCHEMA_VERSION,
    scopeKind: 'assignment',
    scopeId: 'scope-1',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    createdAt: '2026-08-16T00:00:00.000Z',
    journalRelativePath: 'journal.jsonl',
    initialSequence: 0,
    initialPreviousEventHash: 'ab'.repeat(32),
    createdBy: { implementation: 'pipeline-execution-journal', version: 1 },
    ...overrides,
  }
}

function makeAppendRequest(
  overrides: Partial<JournalAppendRequestFields> = {},
): JournalAppendRequestFields {
  return {
    eventId: 'event-1',
    streamKind: 'capability.dispatch',
    streamId: 'dispatch-1',
    expectedStreamRevision: 0,
    type: 'capability.dispatch.requested',
    payloadSchemaVersion: 1,
    payload: { alpha: 1 },
    correlationId: 'correlation-1',
    ...overrides,
  }
}

function makeEvent(
  overrides: Partial<ExecutionJournalEvent> = {},
): ExecutionJournalEvent {
  return {
    schemaVersion: EXECUTION_JOURNAL_SCHEMA_VERSION,
    eventId: 'event-1',
    sequence: 1,
    recordedAt: '2026-08-16T00:00:01.000Z',
    scopeKind: 'assignment',
    scopeId: 'scope-1',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    streamKind: 'test',
    streamId: 'stream-1',
    streamRevision: 1,
    type: 'test.observation',
    payloadSchemaVersion: 1,
    appendRequestDigest: 'cd'.repeat(32),
    correlationId: 'correlation-1',
    previousEventHash: 'ab'.repeat(32),
    eventHash: 'ef'.repeat(32),
    payload: { value: 1 },
    ...overrides,
  }
}

test('canonical append digest ignores key order but not field values', () => {
  const base = makeAppendRequest({
    payload: { alpha: 1, beta: { nested: 'x' } },
  })
  const reordered = makeAppendRequest({
    payload: { beta: { nested: 'x' }, alpha: 1 },
  })
  assert.equal(
    computeAppendRequestDigest(base),
    computeAppendRequestDigest(reordered),
  )
  assert.equal(canonicalizeAppendRequest(base), canonicalizeAppendRequest(reordered))

  for (const changed of [
    makeAppendRequest({ eventId: 'event-2', payload: base.payload }),
    makeAppendRequest({ payload: { alpha: 2, beta: { nested: 'x' } } }),
    makeAppendRequest({ expectedStreamRevision: 1, payload: base.payload }),
    makeAppendRequest({ correlationId: 'correlation-2', payload: base.payload }),
    makeAppendRequest({ type: 'test.other', payload: base.payload }),
    makeAppendRequest({ payloadSchemaVersion: 2, payload: base.payload }),
    makeAppendRequest({ streamId: 'stream-2', payload: base.payload }),
    makeAppendRequest({ streamKind: 'other', payload: base.payload }),
  ]) {
    assert.notEqual(
      computeAppendRequestDigest(changed),
      computeAppendRequestDigest(base),
    )
  }
})

test('append digest treats optional fields as present-or-absent pairs', () => {
  const withSource = makeAppendRequest({
    sourceSequenceId: 'turn-1',
    sourceOrdinal: 2,
  })
  const withoutSource = makeAppendRequest()
  assert.notEqual(
    computeAppendRequestDigest(withSource),
    computeAppendRequestDigest(withoutSource),
  )
  assert.notEqual(
    canonicalizeAppendRequest(withSource),
    canonicalizeAppendRequest(withoutSource),
  )

  const withCausation = makeAppendRequest({ causationEventId: 'cause-1' })
  assert.notEqual(
    computeAppendRequestDigest(withCausation),
    computeAppendRequestDigest(withoutSource),
  )

  const withAttempt = makeAppendRequest({ executionAttemptId: 'attempt-1' })
  assert.notEqual(
    computeAppendRequestDigest(withAttempt),
    computeAppendRequestDigest(withoutSource),
  )
})

test('event hash excludes only the eventHash field and covers the chain link', () => {
  const event = makeEvent()
  const recomputed = recomputeEventHash(event)
  assert.match(recomputed, /^[a-f0-9]{64}$/)
  assert.equal(recomputed, recomputeEventHash({ ...event }))

  assert.notEqual(recomputeEventHash(makeEvent({ payload: { value: 2 } })), recomputed)
  assert.notEqual(recomputeEventHash(makeEvent({ sequence: 2 })), recomputed)
  assert.notEqual(
    recomputeEventHash(makeEvent({ previousEventHash: '00'.repeat(32) })),
    recomputed,
  )
  assert.notEqual(
    recomputeEventHash(makeEvent({ recordedAt: '2026-08-16T00:00:02.000Z' })),
    recomputed,
  )
  assert.notEqual(
    recomputeEventHash(makeEvent({ appendRequestDigest: '99'.repeat(32) })),
    recomputed,
  )
  assert.notEqual(
    recomputeEventHash(
      makeEvent({ sourceSequenceId: 'turn-1', sourceOrdinal: 0 }),
    ),
    recomputed,
  )
})

test('envelope parsing accepts a valid record and rejects envelope violations', () => {
  const manifest = makeManifest()
  const event = makeEvent()
  const parsed = parseJournalEnvelope(JSON.parse(JSON.stringify(event)), manifest)
  assert.deepEqual(parsed, event)

  assertRejectsEnvelope({ schemaVersion: 2 }, manifest)
  assertRejectsEnvelope({ sequence: 0 }, manifest)
  assertRejectsEnvelope({ sequence: 1.5 }, manifest)
  assertRejectsEnvelope({ streamRevision: 0 }, manifest)
  assertRejectsEnvelope({ eventHash: 'not-a-hash' }, manifest)
  assertRejectsEnvelope({ previousEventHash: 'zz' }, manifest)
  assertRejectsEnvelope({ appendRequestDigest: 'short' }, manifest)
  assertRejectsEnvelope({ sourceOrdinal: 3 }, manifest)
  assertRejectsEnvelope({ sourceSequenceId: 'turn-1' }, manifest)
  assertRejectsEnvelope(
    { sourceSequenceId: 'turn-1', sourceOrdinal: -1 },
    manifest,
  )
  assertRejectsEnvelope({ payload: 'not-an-object' }, manifest)
  assertRejectsEnvelope(
    { payload: JSON.parse('{"__proto__":{"hidden":true}}') },
    manifest,
  )
  assertRejectsEnvelope({ payloadSchemaVersion: 0 }, manifest)
  assertRejectsEnvelope({ eventId: '' }, manifest)
  assertRejectsEnvelope({ eventId: 'bad\u0000id' }, manifest)
  assertRejectsEnvelope({ type: 'x'.repeat(513) }, manifest)
  assertRejectsEnvelope({ recordedAt: 'not-a-date' }, manifest)

  assertRejectsEnvelope({ scopeId: 'different-scope' }, manifest)
  assertRejectsEnvelope({ tenantId: 'different-tenant' }, manifest)
  assertRejectsEnvelope({ scopeKind: 'batch' }, manifest)
  assertRejectsEnvelope({ sessionId: 'different-session' }, manifest)
  assertRejectsEnvelope({ runId: 'different-run' }, manifest)
  assertRejectsEnvelope({ assignmentId: 'different-assignment' }, manifest)
})

test('stream revision transition admits only the exact expected revision', () => {
  assert.equal(verifyStreamRevision(0, 0), true)
  assert.equal(verifyStreamRevision(3, 3), true)
  assert.equal(verifyStreamRevision(1, 0), false)
  assert.equal(verifyStreamRevision(0, 1), false)
})

test('journal tail classification distinguishes empty, terminated, and fragment tails', () => {
  assert.equal(classifyJournalTail(''), 'empty')
  assert.equal(classifyJournalTail('{"a":1}\n'), 'terminated')
  assert.equal(classifyJournalTail('{"a":1}\n{"b":2}\n'), 'terminated')
  assert.equal(classifyJournalTail('{"a":1}'), 'unterminated')
  assert.equal(classifyJournalTail('{"a":1}\n{"b":2}'), 'unterminated')
})

test('journal content validation accepts a hash-linked chain', () => {
  const manifest = makeManifest()
  const first = buildLinkedEvent({
    manifest,
    eventId: 'event-1',
    sequence: 1,
    previousEventHash: manifest.initialPreviousEventHash,
    streamId: 'stream-1',
    streamRevision: 1,
  })
  const second = buildLinkedEvent({
    manifest,
    eventId: 'event-2',
    sequence: 2,
    previousEventHash: first.eventHash,
    streamId: 'stream-1',
    streamRevision: 2,
  })
  const result = validateJournalContent(
    manifest,
    `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
  )
  assert.equal(result.events.length, 2)
  assert.equal(result.fragment, undefined)
  assert.deepEqual(result.events.map((event) => event.eventId), [
    'event-1',
    'event-2',
  ])
})

test('journal content validation returns an unterminated final fragment separately', () => {
  const manifest = makeManifest()
  const first = buildLinkedEvent({
    manifest,
    eventId: 'event-1',
    sequence: 1,
    previousEventHash: manifest.initialPreviousEventHash,
    streamId: 'stream-1',
    streamRevision: 1,
  })
  const result = validateJournalContent(
    manifest,
    `${JSON.stringify(first)}\n{"schemaVersion":1,"eventId":"frag`,
  )
  assert.equal(result.events.length, 1)
  assert.equal(result.fragment, '{"schemaVersion":1,"eventId":"frag')
})

test('journal content validation fails closed on terminated corruption', () => {
  const manifest = makeManifest()
  const first = buildLinkedEvent({
    manifest,
    eventId: 'event-1',
    sequence: 1,
    previousEventHash: manifest.initialPreviousEventHash,
    streamId: 'stream-1',
    streamRevision: 1,
  })

  const corruptHash = { ...first, eventHash: '00'.repeat(32) }
  assertValidationCorrupt(manifest, `${JSON.stringify(corruptHash)}\n`)

  const brokenChain = {
    ...first,
    eventId: 'event-2',
    sequence: 2,
    streamRevision: 2,
    previousEventHash: '11'.repeat(32),
  }
  assertValidationCorrupt(
    manifest,
    `${JSON.stringify(first)}\n${JSON.stringify(brokenChain)}\n`,
  )

  assertValidationCorrupt(
    manifest,
    `${JSON.stringify(first)}\n${JSON.stringify({ ...first, sequence: 3 })}\n`,
  )

  const skippedSequence = {
    ...first,
    eventId: 'event-2',
    sequence: 3,
    streamRevision: 2,
    previousEventHash: first.eventHash,
  }
  assertValidationCorrupt(
    manifest,
    `${JSON.stringify(first)}\n${JSON.stringify(skippedSequence)}\n`,
  )

  const duplicateEventId = rebuildLinkedEvent(first, {
    eventId: 'event-1',
    sequence: 2,
    streamRevision: 2,
    previousEventHash: first.eventHash,
  })
  assertValidationCorrupt(
    manifest,
    `${JSON.stringify(first)}\n${JSON.stringify(duplicateEventId)}\n`,
  )

  const wrongRevision = rebuildLinkedEvent(first, {
    eventId: 'event-2',
    sequence: 2,
    streamRevision: 3,
    previousEventHash: first.eventHash,
  })
  assertValidationCorrupt(
    manifest,
    `${JSON.stringify(first)}\n${JSON.stringify(wrongRevision)}\n`,
  )

  const secondForTamper = rebuildLinkedEvent(first, {
    eventId: 'event-2',
    sequence: 2,
    streamRevision: 2,
    previousEventHash: first.eventHash,
  })
  const tamperedFields = {
    ...secondForTamper,
    correlationId: 'tampered-correlation',
  }
  const tamperedCallerField = {
    ...tamperedFields,
    eventHash: recomputeEventHash(tamperedFields),
  }
  assertValidationCorrupt(
    manifest,
    `${JSON.stringify(first)}\n${JSON.stringify(tamperedCallerField)}\n`,
  )

  assertValidationCorrupt(manifest, 'not-json-at-all\n')
})

test('journal content validation checks locally resolvable causation order', () => {
  const manifest = makeManifest()
  const first = buildLinkedEvent({
    manifest,
    eventId: 'event-1',
    sequence: 1,
    previousEventHash: manifest.initialPreviousEventHash,
    streamId: 'stream-1',
    streamRevision: 1,
  })
  const selfCause = rebuildLinkedEvent(first, {
    eventId: 'event-2',
    sequence: 2,
    streamRevision: 2,
    previousEventHash: first.eventHash,
    causationEventId: 'event-2',
  })
  assertValidationCorrupt(
    manifest,
    `${JSON.stringify(first)}\n${JSON.stringify(selfCause)}\n`,
  )

  const forwardCause = rebuildLinkedEvent(first, {
    eventId: 'event-2',
    sequence: 2,
    streamRevision: 2,
    previousEventHash: first.eventHash,
    causationEventId: 'event-3',
  })
  const forwardCauseTarget = rebuildLinkedEvent(forwardCause, {
    eventId: 'event-3',
    sequence: 3,
    streamRevision: 3,
    previousEventHash: forwardCause.eventHash,
    causationEventId: 'event-1',
  })
  assertValidationCorrupt(
    manifest,
    `${JSON.stringify(first)}\n${JSON.stringify(forwardCause)}\n${JSON.stringify(forwardCauseTarget)}\n`,
  )

  const validCausation = rebuildLinkedEvent(first, {
    eventId: 'event-2',
    sequence: 2,
    streamRevision: 2,
    previousEventHash: first.eventHash,
    causationEventId: 'event-1',
  })
  const externalCausation = rebuildLinkedEvent(validCausation, {
    eventId: 'event-3',
    sequence: 3,
    streamRevision: 3,
    previousEventHash: validCausation.eventHash,
    causationEventId: 'parent-scope-event',
  })
  const result = validateJournalContent(
    manifest,
    `${JSON.stringify(first)}\n${JSON.stringify(validCausation)}\n${JSON.stringify(externalCausation)}\n`,
  )
  assert.equal(result.events.length, 3)
})

function assertRejectsEnvelope(
  overrides: Record<string, unknown>,
  manifest: ExecutionJournalManifest,
): void {
  const raw = JSON.parse(JSON.stringify({ ...makeEvent(), ...overrides }))
  assert.throws(
    () => parseJournalEnvelope(raw, manifest),
    ExecutionJournalError,
  )
}

function assertValidationCorrupt(
  manifest: ExecutionJournalManifest,
  content: string,
): void {
  assert.throws(
    () => validateJournalContent(manifest, content),
    (error: unknown) =>
      error instanceof ExecutionJournalError && error.code === 'corrupt',
  )
}

function buildLinkedEvent(input: {
  readonly manifest: ExecutionJournalManifest
  readonly eventId: string
  readonly sequence: number
  readonly previousEventHash: string
  readonly streamId: string
  readonly streamRevision: number
  readonly correlationId?: string
  readonly causationEventId?: string
}): ExecutionJournalEvent {
  const base = makeEvent({
    eventId: input.eventId,
    sequence: input.sequence,
    previousEventHash: input.previousEventHash,
    streamId: input.streamId,
    streamRevision: input.streamRevision,
    scopeKind: input.manifest.scopeKind,
    scopeId: input.manifest.scopeId,
    tenantId: input.manifest.tenantId,
    ...(input.manifest.sessionId === undefined
      ? {}
      : { sessionId: input.manifest.sessionId }),
    ...(input.manifest.runId === undefined
      ? {}
      : { runId: input.manifest.runId }),
    ...(input.manifest.assignmentId === undefined
      ? {}
      : { assignmentId: input.manifest.assignmentId }),
    ...(input.correlationId === undefined
      ? {}
      : { correlationId: input.correlationId }),
    ...(input.causationEventId === undefined
      ? {}
      : { causationEventId: input.causationEventId }),
  })
  const digested = {
    ...base,
    appendRequestDigest: recomputeAppendRequestDigest(base),
  }
  return { ...digested, eventHash: recomputeEventHash(digested) }
}

function rebuildLinkedEvent(
  template: ExecutionJournalEvent,
  overrides: Partial<ExecutionJournalEvent>,
): ExecutionJournalEvent {
  const changed = { ...template, ...overrides }
  const digested = {
    ...changed,
    appendRequestDigest: recomputeAppendRequestDigest(changed),
  }
  return { ...digested, eventHash: recomputeEventHash(digested) }
}

/**
 * A conversation activity is a third scope kind. Its journal is owned by a
 * conversation rather than an assignment, so it carries no run or assignment
 * identity; instead the envelope names the conversation it belongs to and the
 * kind of activity it records. Both additions are optional, so existing
 * assignment and batch bytes parse unchanged.
 */
function conversationManifest(
  overrides: Partial<ExecutionJournalManifest> = {},
): ExecutionJournalManifest {
  return {
    schemaVersion: EXECUTION_JOURNAL_SCHEMA_VERSION,
    scopeKind: 'conversation',
    scopeId: 'activity-1',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    conversationId: 'conversation-1',
    activityKind: 'turn',
    createdAt: '2026-08-26T00:00:00.000Z',
    journalRelativePath: 'journal.jsonl',
    initialSequence: 0,
    initialPreviousEventHash: 'ab'.repeat(32),
    createdBy: { implementation: 'pipeline-execution-journal', version: 1 },
    ...overrides,
  }
}

function sealConversationEvent(
  overrides: Partial<ExecutionJournalEvent> = {},
): ExecutionJournalEvent {
  const event: ExecutionJournalEvent = {
    schemaVersion: EXECUTION_JOURNAL_SCHEMA_VERSION,
    eventId: 'event-1',
    sequence: 1,
    recordedAt: '2026-08-26T00:00:01.000Z',
    scopeKind: 'conversation',
    scopeId: 'activity-1',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    conversationId: 'conversation-1',
    activityKind: 'turn',
    streamKind: 'conversation.turn',
    streamId: 'turn-1',
    streamRevision: 1,
    type: 'conversation.turn.started',
    payloadSchemaVersion: 1,
    appendRequestDigest: 'cd'.repeat(32),
    correlationId: 'turn-1',
    previousEventHash: 'ab'.repeat(32),
    eventHash: 'ef'.repeat(32),
    payload: { value: 1 },
    ...overrides,
  }
  const digested = {
    ...event,
    appendRequestDigest: recomputeAppendRequestDigest(event),
  }
  return { ...digested, eventHash: recomputeEventHash(digested) }
}

test('a conversation envelope round-trips with its conversation identity', () => {
  const parsed = parseJournalEnvelope(
    sealConversationEvent(),
    conversationManifest(),
  )
  assert.equal(parsed.scopeKind, 'conversation')
  assert.equal(parsed.conversationId, 'conversation-1')
  assert.equal(parsed.activityKind, 'turn')
  assert.equal(parsed.runId, undefined)
  assert.equal(parsed.assignmentId, undefined)
})

test('a conversation envelope must agree with its manifest conversation', () => {
  assert.throws(
    () =>
      parseJournalEnvelope(
        sealConversationEvent({ conversationId: 'a-different-conversation' }),
        conversationManifest(),
      ),
    (error: unknown) =>
      error instanceof ExecutionJournalError && error.code === 'corrupt',
    'an event that claims another conversation is corruption, not a new scope',
  )
})
