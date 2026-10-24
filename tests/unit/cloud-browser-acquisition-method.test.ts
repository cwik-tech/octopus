import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SOURCE_OBSERVATION_RECEIPT_VERSION,
  SUPPORTED_SOURCE_OBSERVATION_RECEIPT_VERSIONS,
  isSupportedSourceObservationReceiptVersion,
  type AcquisitionMethod,
} from '../../domains/acquisition/acquisition-types.js'
import { isAcquisitionAttempt } from '../../domains/acquisition/acquisition-types.js'
import { isAcquisitionCloudBrowserRuntime } from '../../domains/browser/cloud-browser-types.js'
import { createDeepResearchEvidenceOutputSchema } from '../../domains/deep-research/deep-research-evidence-output-schema.js'
import { parseSourceRecord } from '../../domains/deep-research/deep-research-validation.js'
import { DEEP_RESEARCH_SCHEMA_VERSION } from '../../contracts/deep-research.js'

/**
 * A new acquisition method is not an additive change.
 *
 * Seven closed lists downstream of acquisition reject a method they do not
 * recognise, so a perfectly valid cloud receipt would be written, stored, and
 * then refused on the way into Deep Research. Each of them is checked here, at
 * the boundary a receipt actually crosses.
 */

const CLOUD: AcquisitionMethod = 'cloud-browser'

test('the receipt version admits the new method while older receipts stay readable', () => {
  assert.equal(SOURCE_OBSERVATION_RECEIPT_VERSION, 6)
  assert.deepEqual(SUPPORTED_SOURCE_OBSERVATION_RECEIPT_VERSIONS, [1, 2, 3, 4, 5, 6])
  for (const version of [1, 2, 3, 4, 5, 6]) {
    assert.equal(
      isSupportedSourceObservationReceiptVersion(version),
      true,
      `receipts written at v${version} must keep being readable`,
    )
  }
  assert.equal(isSupportedSourceObservationReceiptVersion(7), false)
})

test('the evidence schema offers the new method to the model', () => {
  const schema = createDeepResearchEvidenceOutputSchema()
  const serialized = JSON.stringify(schema)
  assert.ok(
    serialized.includes(`"${CLOUD}"`),
    'a method the model is never told about is one it can never report',
  )
})

test('a source record acquired through the cloud browser is accepted', () => {
  const record = parseSourceRecord({
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    sourceId: 'src-1',
    assignmentId: 'assignment-1',
    canonicalUrl: 'https://example.com/report',
    title: 'Report',
    publisher: 'Example',
    independenceKey: 'example.com',
    sourceType: 'primary',
    accessMethod: CLOUD,
    status: 'usable',
    observationReceiptId: 'receipt-1',
    observedAt: '2026-08-30T10:00:00.000Z',
  })
  assert.equal(record.accessMethod, CLOUD)
})

test('an unknown access method is still refused', () => {
  assert.throws(() =>
    parseSourceRecord({
      schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
      sourceId: 'src-1',
      assignmentId: 'assignment-1',
      canonicalUrl: 'https://example.com/report',
      title: 'Report',
      publisher: 'Example',
      independenceKey: 'example.com',
      sourceType: 'primary',
      accessMethod: 'psychic-transmission',
      status: 'usable',
      observationReceiptId: 'receipt-1',
      observedAt: '2026-08-30T10:00:00.000Z',
    }),
  )
})

const CLOUD_RUNTIME = {
  provider: 'browser-use',
  proxyCountry: 'none',
  browserCostMicros: 23_400,
  proxyCostMicros: 0,
  proxyUsedMilliMb: 0,
  sessionStatus: 'stopped',
  meterSource: 'stop-confirmed',
} as const

function makeAttempt(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    method: 'cloud-browser',
    outcome: 'usable',
    startedAt: '2026-08-30T10:00:00.000Z',
    durationMs: 1_200,
    contentBytes: 4_096,
    cloudBrowserRuntime: { ...CLOUD_RUNTIME },
    ...overrides,
  }
}

test('a cloud runtime is admitted by the shared attempt guard', () => {
  assert.equal(isAcquisitionAttempt(makeAttempt()), true)
})

test('a cloud runtime with an unknown meter source is refused', () => {
  assert.equal(
    isAcquisitionAttempt(
      makeAttempt({ cloudBrowserRuntime: { ...CLOUD_RUNTIME, meterSource: 'guessed' } }),
    ),
    false,
  )
})

test('an extra key on a cloud runtime is refused rather than ignored', () => {
  // The guarded object is the one that is kept, so an ignored extra key is how
  // an endpoint or a credential reaches telemetry documented as non-secret.
  assert.equal(
    isAcquisitionCloudBrowserRuntime({ ...CLOUD_RUNTIME, apiKey: 'bu_leaked' }),
    false,
  )
})

test('an unknown attempt key is refused rather than ignored', () => {
  assert.equal(
    isAcquisitionAttempt(makeAttempt({ smuggled: 'value' })),
    false,
  )
})

test('a malformed nested cloud runtime is refused', () => {
  assert.equal(
    isAcquisitionAttempt(
      makeAttempt({ cloudBrowserRuntime: { ...CLOUD_RUNTIME, browserCostMicros: -1 } }),
    ),
    false,
  )
})

test('a non-canonical timestamp is refused wherever an attempt is read', () => {
  // The two readers disagreed about this before they shared a guard: one
  // demanded the canonical ISO form a receipt is written in, the other took any
  // string at all.
  assert.equal(isAcquisitionAttempt(makeAttempt({ startedAt: '2026-08-30T10:00:00Z' })), false)
  assert.equal(isAcquisitionAttempt(makeAttempt({ startedAt: 'March 5, 2026' })), false)
})

test('a negative or fractional count is refused', () => {
  assert.equal(isAcquisitionAttempt(makeAttempt({ durationMs: -1 })), false)
  assert.equal(isAcquisitionAttempt(makeAttempt({ contentBytes: 1.5 })), false)
})

test('every acquisition method the union names is accepted', () => {
  for (const method of [
    'direct-http',
    'direct-http-proxied',
    'managed-browser',
    'managed-browser-proxied',
    'managed-reader',
    'document-parser',
  ] as const) {
    const { cloudBrowserRuntime: _unused, ...local } = makeAttempt({ method })
    assert.equal(isAcquisitionAttempt(local), true, method)
  }
  assert.equal(isAcquisitionAttempt(makeAttempt({ method: 'cloud-browser' })), true)
  assert.equal(isAcquisitionAttempt(makeAttempt({ method: 'telepathy' })), false)
})

test('a cloud runtime belongs to a cloud attempt and to no other', () => {
  // The session client produces this record on every cloud path, so a cloud
  // attempt without one was not written by this application; and a local rung
  // has no provider session to describe.
  const { cloudBrowserRuntime: _unused, ...withoutRuntime } = makeAttempt()
  assert.equal(isAcquisitionAttempt(withoutRuntime), false)
  assert.equal(isAcquisitionAttempt(makeAttempt({ method: 'managed-browser' })), false)
})

test('an optional key present but undefined is refused', () => {
  // `exactOptionalPropertyTypes` says an optional property is absent or holds
  // its type. An own key set to undefined is neither.
  assert.equal(isAcquisitionAttempt(makeAttempt({ provider: undefined })), false)
  assert.equal(isAcquisitionAttempt(makeAttempt({ httpStatus: undefined })), false)
})
