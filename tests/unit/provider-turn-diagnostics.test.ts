/**
 * The rule that makes a provider diagnostic safe to keep.
 *
 * Not "we remember not to put prompts in it" but "there is nowhere for a
 * prompt to go". Every field is either an enumerated kind, a number, or a
 * stated identifier — and an identifier is a short machine-made token, which
 * is the check these tests exist to hold in place.
 *
 * Stated at the pure boundary on purpose. This is the half of the record that
 * has nothing to do with files, and the half most worth being able to check
 * without one.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseProviderTurnDiagnosticRecords,
  readProviderTurnDiagnosticRecord,
  sanitizeProviderTurnDiagnosticRecord,
  type ProviderTurnDiagnosticEntry,
} from '../../domains/runtime/provider-turn-diagnostics.js'

const AT = '2026-08-31T09:00:00.000Z'

test('a record is rebuilt from its own fields, never spread', () => {
  // Whatever else is attached to the object handed in — and in the real
  // system a caller could attach anything — only the declared fields survive.
  const smuggled = {
    kind: 'provider-process-started',

    provider: 'codex',
    model: 'gpt-5.6-sol',
    systemPrompt: 'You are a helpful assistant. SECRET',
  } as unknown as ProviderTurnDiagnosticEntry

  assert.deepEqual(sanitizeProviderTurnDiagnosticRecord(smuggled, AT), {
    kind: 'provider-process-started',
    at: AT,
    provider: 'codex',
    model: 'gpt-5.6-sol',
  })
})

test('a model or provider id with a namespace survives, prose does not', () => {
  // Real identifiers carry separators — `openai/gpt-4o-mini`,
  // `connection:8c3c7288`. Rejecting those would drop the one field an
  // operator needs to reproduce the turn.
  for (const model of ['openai/gpt-4o-mini', 'connection:local', 'fake/model']) {
    const record = sanitizeProviderTurnDiagnosticRecord(
      { kind: 'provider-process-started',  provider: 'codex', model },
      AT,
    )
    assert.equal(
      record?.kind === 'provider-process-started' ? record.model : undefined,
      model,
      `a namespaced model is kept: ${model}`,
    )
  }

  for (const prose of [
    'Provider failed: connection reset by peer at /Users/someone/workspace',
    'sk-proj-abcdef ghijkl',
    'the user asked about their salary',
  ]) {
    const record = sanitizeProviderTurnDiagnosticRecord(
      { kind: 'provider-failure',  failureCode: prose, retryable: true },
      AT,
    )
    assert.deepEqual(
      record,
      { kind: 'provider-failure', at: AT, retryable: true },
      `prose is dropped rather than stored: ${prose}`,
    )
  }
})

test('an exit is described by its code, its signal, and how far the stream got', () => {
  assert.deepEqual(
    sanitizeProviderTurnDiagnosticRecord(
      {
        kind: 'provider-process-exited',

        exitCode: 3,
        signal: 'SIGTERM',
        lastEventType: 'item.completed',
      },
      AT,
    ),
    {
      kind: 'provider-process-exited',
      at: AT,
      exitCode: 3,
      signal: 'SIGTERM',
      lastEventType: 'item.completed',
    },
  )
})

test('a line this build cannot read is skipped, not fatal', () => {
  const text = [
    JSON.stringify({
      kind: 'provider-protocol-event',
      at: AT,
      eventType: 'turn.started',
      sequence: 1,
    }),
    'not json at all',
    JSON.stringify({ kind: 'invented-kind', at: AT }),
    JSON.stringify({ kind: 'bridge-cleanup', at: AT, outcome: 'closed' }),
    // A torn tail, exactly as a crash mid-append leaves one.
    '{"kind":"provider-process-exit',
  ].join('\n')

  assert.deepEqual(
    parseProviderTurnDiagnosticRecords(text).map((record) => record.kind),
    ['provider-protocol-event', 'bridge-cleanup'],
    'the readable records before a damaged line are still returned',
  )
})

test('a record read back from disk is validated, not trusted', () => {
  assert.equal(
    readProviderTurnDiagnosticRecord({
      kind: 'provider-protocol-event',
      at: AT,
      eventType: 'Here is the whole assistant answer, which is not an event type',
      sequence: 1,
    }),
    undefined,
    'an event type that is prose is refused on read as well as on write',
  )
  assert.equal(readProviderTurnDiagnosticRecord({ kind: 'bridge-cleanup' }), undefined)
  assert.equal(readProviderTurnDiagnosticRecord(null), undefined)
  assert.equal(readProviderTurnDiagnosticRecord(['bridge-cleanup']), undefined)
})

test('a truncation marker is a record in its own right', () => {
  assert.deepEqual(
    sanitizeProviderTurnDiagnosticRecord(
      { kind: 'protocol-events-truncated',  limit: 200 },
      AT,
    ),
    { kind: 'protocol-events-truncated', at: AT, limit: 200 },
  )
  assert.deepEqual(
    readProviderTurnDiagnosticRecord({
      kind: 'protocol-events-truncated',
      at: AT,
      limit: 200,
    }),
    { kind: 'protocol-events-truncated', at: AT, limit: 200 },
  )
})

test('a timestamp read back from disk is a timestamp, not free text', () => {
  // `at` is the one field the record could not rebuild from an enumeration, so
  // it is the one place prose could ride out of a corrupt or hostile file. The
  // reader treats these bytes as external input, so it has to be checked like
  // any other external value.
  for (const at of [
    'Error: ECONNRESET at /Users/someone/secret-project',
    'sk-proj-abcdef',
    'yesterday',
    '',
    '2026-13-45T99:99:99.000Z',
  ]) {
    assert.equal(
      readProviderTurnDiagnosticRecord({
        kind: 'bridge-cleanup',
        at,
        outcome: 'closed',
      }),
      undefined,
      `a record timestamped ${JSON.stringify(at)} is refused`,
    )
  }

  // A real instant survives, normalized to the one form this writes.
  assert.deepEqual(
    readProviderTurnDiagnosticRecord({
      kind: 'bridge-cleanup',
      at: '2026-08-31T09:00:00.000Z',
      outcome: 'closed',
    }),
    { kind: 'bridge-cleanup', at: '2026-08-31T09:00:00.000Z', outcome: 'closed' },
  )
})

test('a record missing a required field is refused, not completed with a default', () => {
  // These are external bytes. Filling in `0` for an absent `idleMs`, or `false`
  // for an absent `retryable`, makes the reader state facts the file does not
  // contain — and a diagnostic that invents its own content is worse than one
  // that admits it cannot be read.
  for (const record of [
    { kind: 'provider-stalled', at: AT, aborted: true },
    { kind: 'provider-stalled', at: AT, idleMs: 'a while', aborted: true },
    { kind: 'provider-stalled', at: AT, idleMs: 1_000, aborted: 'yes' },
    { kind: 'provider-stalled', at: AT, idleMs: -1, aborted: true },
    { kind: 'provider-failure', at: AT, failureKind: 'process_failed' },
    { kind: 'provider-failure', at: AT, retryable: 'no' },
  ]) {
    assert.equal(
      readProviderTurnDiagnosticRecord(record),
      undefined,
      `refused: ${JSON.stringify(record)}`,
    )
  }

  // Complete records still read.
  assert.deepEqual(
    readProviderTurnDiagnosticRecord({
      kind: 'provider-stalled',
      at: AT,
      idleMs: 60_000,
      aborted: true,
    }),
    { kind: 'provider-stalled', at: AT, idleMs: 60_000, aborted: true },
  )
  assert.deepEqual(
    readProviderTurnDiagnosticRecord({
      kind: 'provider-failure',
      at: AT,
      failureKind: 'process_failed',
      retryable: false,
    }),
    {
      kind: 'provider-failure',
      at: AT,
      failureKind: 'process_failed',
      retryable: false,
    },
  )
})

test('cancellation diagnostics retain a validated source and reject arbitrary reasons', () => {
  assert.deepEqual(readProviderTurnDiagnosticRecord({ kind: 'provider-cancellation', at: AT, source: 'user-stop', phase: 'turn' }),
    { kind: 'provider-cancellation', at: AT, source: 'user-stop', phase: 'turn' })
  assert.equal(readProviderTurnDiagnosticRecord({ kind: 'provider-cancellation', at: AT, source: 'private account token', phase: 'turn' }), undefined)
})

test('CLI diagnostics retain classifications and retry numbers while dropping raw stderr', () => {
  assert.deepEqual(readProviderTurnDiagnosticRecord({ kind: 'provider-cli-diagnostic', at: AT,
    channel: 'stderr', category: 'rate_limit', statusCode: 429, attempt: 3, retryDelayMs: 2000, raw: 'private account token' }),
    { kind: 'provider-cli-diagnostic', at: AT, channel: 'stderr', category: 'rate_limit', statusCode: 429, attempt: 3, retryDelayMs: 2000 })
  assert.equal(readProviderTurnDiagnosticRecord({ kind: 'provider-cli-diagnostic', at: AT, channel: 'stderr', category: 'private account token' }), undefined)
})

test('CLI diagnostic readers omit fractional and implausible retry counters', () => {
  assert.deepEqual(readProviderTurnDiagnosticRecord({ kind: 'provider-cli-diagnostic', at: AT,
    channel: 'stderr', category: 'retry', attempt: 1.5, retryDelayMs: 999999999999 }),
    { kind: 'provider-cli-diagnostic', at: AT, channel: 'stderr', category: 'retry' })
})
