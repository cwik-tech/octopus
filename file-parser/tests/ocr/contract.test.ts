import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OCR_CONTRACT_VERSION,
  OCR_ENGINE,
  OCR_LANGUAGE,
  ocrContractIdentity,
  ocrIndexProfile,
  parsePdfOcrSummary,
  parsedResultMatchesOcrContract,
} from '../../ocr/contract.js'

test('ocrIndexProfile: the recognition settings are the ones the measurement chose', () => {
  // Stated, not derived: 200 dpi with the engine's default page segmentation is the reading
  // that returns a tabled page one row per line, which is what column reconstruction needs.
  assert.deepEqual(ocrIndexProfile(), {
    engine: 'LSTM_ONLY',
    pageSegmentation: 'default',
    preserveInterwordSpaces: true,
    dpi: 200,
    regionRecognition: true,
  })
  assert.equal(OCR_LANGUAGE, 'eng')
  assert.equal(OCR_ENGINE, 'tesseract.js')
  // Version 2 is the first contract that recognizes qualifying image regions on text pages.
  assert.equal(OCR_CONTRACT_VERSION, 2)
})

test('ocrContractIdentity: every setting that changes a reading is part of the identity', () => {
  const identity = ocrContractIdentity()
  const profile = ocrIndexProfile()

  for (const part of [
    `v${OCR_CONTRACT_VERSION}`,
    OCR_ENGINE,
    OCR_LANGUAGE,
    profile.engine,
    profile.pageSegmentation,
    `${profile.dpi}dpi`,
    `regions=${profile.regionRecognition ? '1' : '0'}`,
  ]) {
    assert.ok(identity.includes(part), `The identity must carry ${part}`)
  }
})

test('parsedResultMatchesOcrContract: a result from another contract is not reusable', () => {
  assert.equal(parsedResultMatchesOcrContract({ ocr: { contractIdentity: ocrContractIdentity() } }), true)
  assert.equal(
    parsedResultMatchesOcrContract({ ocr: { contractIdentity: 'v0:tesseract.js:eng:LSTM_ONLY:default:144dpi:spaces=1' } }),
    false,
  )
  // The version 1 identity predates region recognition: a result recorded under it reparses
  // once, because enabling regions changed what recognition returns for the same page.
  assert.equal(
    parsedResultMatchesOcrContract({ ocr: { contractIdentity: 'v1:tesseract.js:eng:LSTM_ONLY:default:200dpi:spaces=1' } }),
    false,
  )
  // A result recorded before this package recognized anything carries no identity, and nothing
  // about it needs regenerating.
  assert.equal(parsedResultMatchesOcrContract({}), true)
  assert.equal(parsedResultMatchesOcrContract({ ocr: {} }), false)
  assert.equal(parsedResultMatchesOcrContract(null), true)
})

/** A record exactly in the shape `summarizeOcr` writes for every recognized document. */
function makeValidOcrRecord(): Record<string, unknown> {
  return {
    contractVersion: OCR_CONTRACT_VERSION,
    contractIdentity: ocrContractIdentity(),
    engine: OCR_ENGINE,
    status: 'partial',
    applied: true,
    requestedPages: [10, 12],
    readPages: [10],
    emptyPages: [],
    unresolvedPages: [12],
    elapsedMs: 42,
  }
}

test('parsePdfOcrSummary: a record in the shape the parser writes is trusted as written', () => {
  const record = makeValidOcrRecord()
  assert.deepEqual(parsePdfOcrSummary(record), {
    contractVersion: OCR_CONTRACT_VERSION,
    contractIdentity: ocrContractIdentity(),
    engine: OCR_ENGINE,
    status: 'partial',
    applied: true,
    requestedPages: [10, 12],
    readPages: [10],
    emptyPages: [],
    unresolvedPages: [12],
    elapsedMs: 42,
  })
})

test('parsePdfOcrSummary: malformed or incomplete records fail closed', () => {
  const without = (key: string): Record<string, unknown> => {
    const record = makeValidOcrRecord()
    delete record[key]
    return record
  }
  const cases: Array<[string, unknown]> = [
    ['not an object', 'complete'],
    ['null', null],
    ['an array', []],
    ['a status outside the declared union', { ...makeValidOcrRecord(), status: 'done' }],
    ['a missing status', without('status')],
    ['completion claimed without its page list', { ...makeValidOcrRecord(), status: 'complete', unresolvedPages: undefined }],
    ['unresolvedPages that is not a page list', { ...makeValidOcrRecord(), unresolvedPages: 'none' }],
    ['a negative page among the read pages', { ...makeValidOcrRecord(), readPages: [-3] }],
    ['page zero among the requested pages', { ...makeValidOcrRecord(), requestedPages: [0] }],
    ['a fractional unresolved page', { ...makeValidOcrRecord(), unresolvedPages: [10.5] }],
    ['a stale contract version', { ...makeValidOcrRecord(), contractVersion: OCR_CONTRACT_VERSION - 1 }],
    ['a stale contract identity', { ...makeValidOcrRecord(), contractIdentity: 'v1:tesseract.js:eng' }],
    ['a different engine', { ...makeValidOcrRecord(), engine: 'another-engine' }],
    ['a missing contract identity', without('contractIdentity')],
    ['applied that is not a boolean', { ...makeValidOcrRecord(), applied: 'yes' }],
    ['a negative elapsed time', { ...makeValidOcrRecord(), elapsedMs: -1 }],
  ]
  for (const [label, ocr] of cases) {
    assert.equal(
      parsePdfOcrSummary(ocr),
      null,
      `A record that is not the contract shape must be distrusted: ${label}`,
    )
  }
})
