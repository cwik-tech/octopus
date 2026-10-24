import { whenDefined } from '../../core/optional-properties.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  GEMINI_PRICING_METADATA,
  evaluateGeminiAdmission,
  estimateGeminiVideoCost,
  type GeminiPricingMetadata,
} from '../../domains/youtube/youtube-gemini-cost.js'

test('runtime Gemini pricing matches the pinned application pricing file', () => {
  const pinned = JSON.parse(fs.readFileSync(path.resolve(
    'domains/youtube/gemini-pricing.json',
  ), 'utf8'))
  assert.deepEqual(GEMINI_PRICING_METADATA, pinned)
})

const pricing: GeminiPricingMetadata = {
  pricingSchemaVersion: 1,
  model: 'gemini-3.6-flash',
  currency: 'USD',
  inputUsdPerMillionTokens: 1.5,
  outputUsdPerMillionTokens: 7.5,
  estimatedVideoTokensPerSecond: 300,
  estimatedOutputTokens: 6_000,
  effectiveDate: '2026-07-21',
  verifiedAt: '2026-08-12T00:00:00.000Z',
  sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
}

test('every uncached Gemini run returns an approximate cost estimate', () => {
  const estimate = estimateGeminiVideoCost({
    durationSeconds: 600,
    model: 'gemini-3.6-flash',
    pricing,
    now: new Date('2026-08-20T00:00:00.000Z'),
  })

  assert.deepEqual(estimate, {
    available: true,
    currency: 'USD',
    estimatedInputTokens: 180_000,
    estimatedOutputTokens: 6_000,
    estimatedCost: 0.315,
    pricingVerifiedAt: '2026-08-12T00:00:00.000Z',
  })
})

test('confirmation is required above 30 minutes, above rolling budget, or with stale pricing', () => {
  const base = {
    durationSeconds: 1_800,
    rollingUsedMinutes: 80,
    dailyLimitMinutes: 120,
    confirmationThresholdMinutes: 30,
    model: 'gemini-3.6-flash',
    pricing,
    now: new Date('2026-08-20T00:00:00.000Z'),
  }
  assert.equal(evaluateGeminiAdmission(base).confirmationRequired, false)
  assert.deepEqual(evaluateGeminiAdmission({ ...base, durationSeconds: 1_801 }).reasons, [
    'long_video',
  ])
  assert.deepEqual(evaluateGeminiAdmission({ ...base, rollingUsedMinutes: 91 }).reasons, [
    'rolling_budget',
  ])
  assert.deepEqual(evaluateGeminiAdmission({
    ...base,
    now: new Date('2026-09-20T00:00:00.000Z'),
  }).reasons, ['pricing_unavailable'])
})

test('stale pricing reports a missing estimate without withholding the analysis', () => {
  const base = {
    durationSeconds: 1_800,
    rollingUsedMinutes: 80,
    dailyLimitMinutes: 120,
    confirmationThresholdMinutes: 30,
    model: 'gemini-3.6-flash',
    pricing,
    // A month past the pricing table's verifiedAt, so no estimate can be made.
    now: new Date('2026-09-20T00:00:00.000Z'),
  }
  const stale = evaluateGeminiAdmission(base)

  assert.deepEqual(stale.reasons, ['pricing_unavailable'])
  assert.equal(stale.confirmationRequired, false)
  assert.equal(stale.estimate, undefined)

  // The limits the operator actually set are counted in minutes, so they still
  // hold without pricing.
  const longVideo = evaluateGeminiAdmission({ ...base, durationSeconds: 1_801 })
  assert.equal(longVideo.confirmationRequired, true)
  assert.deepEqual(longVideo.reasons, ['long_video', 'pricing_unavailable'])
})

test('a verified cache hit requires neither estimate nor budget confirmation', () => {
  const admission = evaluateGeminiAdmission({
    durationSeconds: 7_200,
    rollingUsedMinutes: 120,
    dailyLimitMinutes: 120,
    confirmationThresholdMinutes: 30,
    model: 'gemini-3.6-flash',
    
    cacheHit: true,
    now: new Date('2026-08-20T00:00:00.000Z'),
  })

  assert.equal(admission.confirmationRequired, false)
  assert.equal(admission.estimate, undefined)
  assert.deepEqual(admission.reasons, [])
})
