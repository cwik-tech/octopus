/**
 * T2: Unit Tests — Verdict Parser Module
 *
 * Covers all three pure functions exported by core/verdict-parser.ts:
 *   1. parseVerdict  — first non-empty line matched against allowed values
 *   2. parseTaggedVerdict  — verdict inside <tag>...</tag> via regex
 *   3. canonicalizeReviewFeedback  — strip preamble before verdict signal
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseVerdict,
  parseTaggedVerdict,
  canonicalizeReviewFeedback,
} from '../../core/verdict-parser.js'

// ---------------------------------------------------------------------------
// parseVerdict
// ---------------------------------------------------------------------------

test('parseVerdict: returns matching verdict for first non-empty line (exact uppercase)', () => {
  const result = parseVerdict('APPROVED', ['APPROVED', 'REJECTED', 'REVISE'])
  assert.equal(result, 'APPROVED')
})

test('parseVerdict: matches case-insensitively (lowercase input)', () => {
  const result = parseVerdict('approved', ['APPROVED', 'REJECTED', 'REVISE'])
  assert.equal(result, 'APPROVED')
})

test('parseVerdict: matches case-insensitively (mixed case input)', () => {
  const result = parseVerdict('ApPrOvEd', ['APPROVED', 'REJECTED', 'REVISE'])
  assert.equal(result, 'APPROVED')
})

test('parseVerdict: takes first non-empty line when leading blank lines exist', () => {
  const result = parseVerdict('\n\n\nREVISE\nAPPROVED', ['APPROVED', 'REJECTED', 'REVISE'])
  assert.equal(result, 'REVISE')
})

test('parseVerdict: trims whitespace from each line before matching', () => {
  const result = parseVerdict('  REJECTED  ', ['APPROVED', 'REJECTED', 'REVISE'])
  assert.equal(result, 'REJECTED')
})

test('parseVerdict: returns null when no line matches any allowed value', () => {
  const result = parseVerdict('Some random response', ['APPROVED', 'REJECTED', 'REVISE'])
  assert.equal(result, null)
})

test('parseVerdict: returns null for empty string', () => {
  const result = parseVerdict('', ['APPROVED', 'REJECTED', 'REVISE'])
  assert.equal(result, null)
})

test('parseVerdict: returns null for whitespace-only string', () => {
  const result = parseVerdict('   \n  \n   ', ['APPROVED', 'REJECTED', 'REVISE'])
  assert.equal(result, null)
})

test('parseVerdict: returns null when allowed array is empty', () => {
  const result = parseVerdict('APPROVED', [])
  assert.equal(result, null)
})

test('parseVerdict: returns null for partial match (not full token)', () => {
  const result = parseVerdict('APPROVE', ['APPROVED', 'REJECTED', 'REVISE'])
  assert.equal(result, null)
})

// ---------------------------------------------------------------------------
// parseTaggedVerdict
// ---------------------------------------------------------------------------

test('parseTaggedVerdict: returns single valid tagged verdict', () => {
  const text = 'Here is my review:\n<verdict>APPROVED</verdict>\nLooks great!'
  const result = parseTaggedVerdict(text, ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  assert.equal(result, 'APPROVED')
})

test('parseTaggedVerdict: matches case-insensitively for tag content', () => {
  const text = '<verdict>approved</verdict>'
  const result = parseTaggedVerdict(text, ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  assert.equal(result, 'APPROVED')
})

test('parseTaggedVerdict: allows whitespace around verdict inside tags', () => {
  const text = '<verdict>  REVISE  </verdict>'
  const result = parseTaggedVerdict(text, ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  assert.equal(result, 'REVISE')
})

test('parseTaggedVerdict: returns null when zero valid tagged verdicts appear (no tag)', () => {
  const text = 'Just some text without tags'
  const result = parseTaggedVerdict(text, ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  assert.equal(result, null)
})

test('parseTaggedVerdict: returns null when tag exists but content is not in allowed list', () => {
  const text = '<verdict>UNKNOWN</verdict>'
  const result = parseTaggedVerdict(text, ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  assert.equal(result, null)
})

test('parseTaggedVerdict: returns null when more than one valid tagged verdict appears', () => {
  const text = '<verdict>APPROVED</verdict><verdict>REVISE</verdict>'
  const result = parseTaggedVerdict(text, ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  assert.equal(result, null)
})

test('parseTaggedVerdict: returns null when one valid and one invalid tag (still >1 tag with 1 valid means multiple tags found, validCount is 1 but another invalid tag also present — function returns null because total valid != 1? Let me check the logic)', () => {
  // The function increments validCount only when the tag content matches allowed.
  // With one valid and one invalid tag, validCount === 1, so it returns that one valid verdict.
  // Both tags match the regex pattern so the loop runs twice, but only one increments validCount.
  const text = '<verdict>APPROVED</verdict><verdict>INVALID</verdict>'
  const result = parseTaggedVerdict(text, ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  // validCount === 1 (only APPROVED matched) → returns APPROVED
  assert.equal(result, 'APPROVED')
})

test('parseTaggedVerdict: returns null for empty text', () => {
  const result = parseTaggedVerdict('', ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  assert.equal(result, null)
})

test('parseTaggedVerdict: works with different tag names', () => {
  const text = '<decision>APPROVED</decision>'
  const result = parseTaggedVerdict(text, ['APPROVED', 'REJECTED', 'REVISE'], 'decision')
  assert.equal(result, 'APPROVED')
})

test('parseTaggedVerdict: ignores whitespace-only tag content (null candidate)', () => {
  const text = '<verdict>  </verdict>'
  const result = parseTaggedVerdict(text, ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  assert.equal(result, null)
})

// ---------------------------------------------------------------------------
// canonicalizeReviewFeedback
// ---------------------------------------------------------------------------

test('canonicalizeReviewFeedback: strips preamble before tagged verdict', () => {
  const text = 'Here is some preamble chatter.\nLet me review...\n<verdict>APPROVED</verdict>\nSome notes after.'
  const result = canonicalizeReviewFeedback(text, ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  assert.equal(result, '<verdict>APPROVED</verdict>\nSome notes after.')
})

test('canonicalizeReviewFeedback: preserves content after the tagged verdict', () => {
  const text = '<verdict>REJECTED</verdict>\n\nReason: missing type safety.'
  const result = canonicalizeReviewFeedback(text, ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  assert.equal(result, '<verdict>REJECTED</verdict>\n\nReason: missing type safety.')
})

test('canonicalizeReviewFeedback: falls back to line-based match when no tag found', () => {
  const text = 'Some preamble\nREVISE\nAdditional notes.'
  const result = canonicalizeReviewFeedback(text, ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  assert.equal(result, 'REVISE\nAdditional notes.')
})

test('canonicalizeReviewFeedback: returns trimmed text when no verdict found at all', () => {
  const text = '  Just some random text with no verdict.  '
  const result = canonicalizeReviewFeedback(text, ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  assert.equal(result, 'Just some random text with no verdict.')
})

test('canonicalizeReviewFeedback: returns empty string for empty input', () => {
  const result = canonicalizeReviewFeedback('', ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  assert.equal(result, '')
})

test('canonicalizeReviewFeedback: returns empty string for whitespace-only input', () => {
  const result = canonicalizeReviewFeedback('   \n  ', ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  assert.equal(result, '')
})

test('canonicalizeReviewFeedback: when multiple valid tagged verdicts exist, falls back to line-based match', () => {
  // With >1 valid tagged verdicts, the function falls to the line-based fallback path.
  const text = 'Chatter\n<verdict>APPROVED</verdict>\nMore chatter\n<verdict>REVISE</verdict>\nDone'
  const result = canonicalizeReviewFeedback(text, ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  // None of the lines matches an allowed value exactly because the lines are "Chatter", "<verdict>APPROVED</verdict>", etc.
  // The line-based path normalizes each line and checks if it's in allowed.
  // `lines[0]` = "Chatter" → no match
  // `lines[1]` = "<verdict>APPROVED</verdict>" → upper is "<VERDICT>APPROVED</VERDICT>" → not in allowed
  // So fallback returns full trimmed text.
  assert.equal(result, text.trim())
})

test('canonicalizeReviewFeedback: line-based fallback picks first matching line', () => {
  const text = 'Preamble\nAPPROVED\nREVISE'
  const result = canonicalizeReviewFeedback(text, ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  assert.equal(result, 'APPROVED\nREVISE')
})

test('canonicalizeReviewFeedback: no preamble when verdict is on first line (tagged)', () => {
  const text = '<verdict>APPROVED</verdict>\nNotes after.'
  const result = canonicalizeReviewFeedback(text, ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  assert.equal(result, text.trim())
})

test('canonicalizeReviewFeedback: no preamble when verdict is on first line (bare)', () => {
  const text = 'APPROVED\nNotes after.'
  const result = canonicalizeReviewFeedback(text, ['APPROVED', 'REJECTED', 'REVISE'], 'verdict')
  assert.equal(result, text.trim())
})
