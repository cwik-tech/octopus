import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExecutionJournalEvent } from '../../contracts/execution-journal.js'
import {
  buildWebEvidenceValidationPayload,
  readWebEvidenceValidationPayload,
  reduceWebEvidenceValidationEvents,
  WEB_EVIDENCE_VALIDATION_PAYLOAD_SCHEMA_VERSION,
  WEB_EVIDENCE_VALIDATION_RECORDED_EVENT_TYPE,
  WEB_EVIDENCE_VALIDATION_STREAM_KIND,
  webEvidenceValidationEventId,
  WebEvidenceValidationPayloadError,
  type WebEvidenceValidationInput,
} from '../../domains/browser/web-evidence-validation-journal.js'

function makeValidationInput(
  overrides: Partial<WebEvidenceValidationInput> = {},
): WebEvidenceValidationInput {
  return {
    stage: 'links',
    mode: 'shadow',
    providerKind: 'openai',
    providerRoute: 'mcp-native',
    observedUrlCount: 2,
    citedUrlCount: 3,
    unobservedUrlCount: 1,
    legacyDecision: 'accepted',
    decision: 'unobserved_url',
    displayedDiffersFromCandidate: false,
    persistedDiffersFromCandidate: false,
    enforcementWouldDiffer: true,
    durationMs: 3,
    ...overrides,
  }
}

test('a validation payload round-trips through the strict reader', () => {
  const payload = buildWebEvidenceValidationPayload(makeValidationInput())
  assert.deepEqual(readWebEvidenceValidationPayload(payload), makeValidationInput())
})

test('the payload builder enforces every closed union and count', () => {
  assert.throws(
    () =>
      buildWebEvidenceValidationPayload(
        makeValidationInput({ stage: 'claims' as never }),
      ),
    WebEvidenceValidationPayloadError,
    'the claims stage is reserved until capability B exists',
  )
  assert.throws(
    () =>
      buildWebEvidenceValidationPayload(
        makeValidationInput({ mode: 'off' as never }),
      ),
    WebEvidenceValidationPayloadError,
  )
  assert.throws(
    () =>
      buildWebEvidenceValidationPayload(
        makeValidationInput({ decision: 'partial' as never }),
      ),
    WebEvidenceValidationPayloadError,
  )
  assert.throws(
    () =>
      buildWebEvidenceValidationPayload(
        makeValidationInput({ providerRoute: 'direct-provider' as never }),
      ),
    WebEvidenceValidationPayloadError,
  )
  assert.throws(
    () =>
      buildWebEvidenceValidationPayload(
        makeValidationInput({ observedUrlCount: -1 }),
      ),
    WebEvidenceValidationPayloadError,
  )
  assert.throws(
    () =>
      buildWebEvidenceValidationPayload(
        makeValidationInput({ durationMs: 1.5 }),
      ),
    WebEvidenceValidationPayloadError,
  )
  assert.throws(
    () =>
      buildWebEvidenceValidationPayload(
        makeValidationInput({ providerKind: '  ' }),
      ),
    WebEvidenceValidationPayloadError,
  )
})

test('the strict reader rejects payloads the builder would never write', () => {
  assert.equal(readWebEvidenceValidationPayload(null), null)
  assert.equal(readWebEvidenceValidationPayload({}), null)
  assert.equal(
    readWebEvidenceValidationPayload({
      ...buildWebEvidenceValidationPayload(makeValidationInput()),
      decision: 'partial',
    }),
    null,
  )
  assert.equal(
    readWebEvidenceValidationPayload({
      ...buildWebEvidenceValidationPayload(makeValidationInput()),
      unobservedUrlCount: 'one',
    }),
    null,
  )
})

test('validation telemetry carries no question, answer, URLs, titles, content, receipt IDs, or prompts', () => {
  // Deliberately smuggle content-bearing fields past the type boundary, the
  // way a future caller mistake would: the builder must pick only its declared
  // keys, so none of these values can reach the journal.
  const payload = buildWebEvidenceValidationPayload({
    ...makeValidationInput(),
    question: 'What is the secret launch date?',
    answer: 'The answer cites https://leak.example/confidential-page',
    urls: ['https://leak.example/confidential-page'],
    title: 'Confidential launch plans',
    content: 'full page text of the acquired source',
    observationReceiptId: 'receipt-secret-123',
    prompt: 'system prompt text',
  } as unknown as WebEvidenceValidationInput)
  const serialized = JSON.stringify(payload)
  for (const forbidden of [
    'secret launch date',
    'leak.example',
    'Confidential launch plans',
    'full page text',
    'receipt-secret-123',
    'system prompt text',
  ]) {
    assert.ok(
      !serialized.includes(forbidden),
      `telemetry must not contain '${forbidden}'`,
    )
  }
  assert.deepEqual(
    Object.keys(payload).sort(),
    [
      'citedUrlCount',
      'decision',
      'displayedDiffersFromCandidate',
      'durationMs',
      'persistedDiffersFromCandidate',
      'enforcementWouldDiffer',
      'legacyDecision',
      'mode',
      'observedUrlCount',
      'providerKind',
      'providerRoute',
      'stage',
      'unobservedUrlCount',
    ].sort(),
  )
})

function makeEvent(
  streamRevision: number,
  payload: unknown,
): ExecutionJournalEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${streamRevision}`,
    sequence: streamRevision,
    recordedAt: '2026-08-26T00:00:00.000Z',
    scopeKind: 'assignment',
    scopeId: 'assignment-1',
    tenantId: 'local',
    streamKind: WEB_EVIDENCE_VALIDATION_STREAM_KIND,
    streamId: 'assignment-1',
    streamRevision,
    type: WEB_EVIDENCE_VALIDATION_RECORDED_EVENT_TYPE,
    payloadSchemaVersion: WEB_EVIDENCE_VALIDATION_PAYLOAD_SCHEMA_VERSION,
    appendRequestDigest: 'digest',
    correlationId: 'turn-1',
    previousEventHash: 'previous',
    eventHash: 'hash',
    payload: payload as ExecutionJournalEvent['payload'],
  }
}

test('the reducer summarizes outcomes, would-change rates, and invalid rows', () => {
  const events = [
    makeEvent(1, buildWebEvidenceValidationPayload(makeValidationInput())),
    makeEvent(
      2,
      buildWebEvidenceValidationPayload(
        makeValidationInput({
          mode: 'enforce',
          decision: 'accepted',
          unobservedUrlCount: 0,
          citedUrlCount: 2,
          enforcementWouldDiffer: false,
          displayedDiffersFromCandidate: true,
        }),
      ),
    ),
    makeEvent(3, { decision: 'not-a-decision' }),
  ]
  assert.deepEqual(reduceWebEvidenceValidationEvents(events), {
    recordedCount: 2,
    acceptedCount: 1,
    insufficientCount: 1,
    wouldDifferCount: 1,
    invalidCount: 1,
    byDecision: { unobserved_url: 1, accepted: 1 },
  })
})

test('validation event identity is derived from the assignment and turn', () => {
  assert.equal(
    webEvidenceValidationEventId('assignment-1', 'turn-9'),
    'assignment-1:web-evidence-validation:turn-9',
  )
})
