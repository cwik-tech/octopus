import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateAcquisitionQuality } from '../../domains/acquisition/acquisition-quality.js'
import { researchWebToolInputSchema } from '../../domains/acquisition/acquisition-types.js'
import { canonicalizeSourceUrl } from '../../domains/acquisition/acquisition-url.js'
import { parseResearchWebToolInput } from '../../services/research-web-tool-service.js'

test('source canonicalization preserves content queries and removes tracking state', () => {
  assert.equal(
    canonicalizeSourceUrl(
      'https://EXAMPLE.com:443/report/?year=2026&utm_source=test&b=2&a=1#section',
    ),
    'https://example.com/report?a=1&b=2&year=2026',
  )
  assert.throws(
    () => canonicalizeSourceUrl('https://user:secret@example.com/report'),
    /must not contain credentials/,
  )
  assert.throws(
    () => canonicalizeSourceUrl('file:///etc/passwd'),
    /HTTP or HTTPS/,
  )
})

test('quality gate separates transport success from usable evidence', () => {
  const challenged = evaluateAcquisitionQuality({
      title: 'Verify you are human',
      url: 'https://example.com/',
      text: 'Complete the security check and CAPTCHA.',
      httpStatus: 200,
      mediaType: 'text/html',
    })
  assert.equal(challenged.usable, false)
  if (!challenged.usable) {
    assert.equal(challenged.outcome, 'challenge')
    assert.equal(challenged.code, 'access_challenge')
    assert.equal(challenged.terminal, true)
    assert.equal(challenged.report.status, 'unusable')
  }
  assert.equal(
    evaluateAcquisitionQuality({
      title: 'Primary report',
      url: 'https://example.com/report',
      text: 'A'.repeat(500),
      httpStatus: 200,
      mediaType: 'text/html',
    }).usable,
    true,
  )
  const clientShell = evaluateAcquisitionQuality({
    title: 'Application',
    url: 'https://example.com/app',
    text: '# Application',
    httpStatus: 200,
    mediaType: 'text/html',
    clientRenderedShell: true,
  })
  assert.equal(clientShell.usable, false)
  if (!clientShell.usable) {
    assert.equal(clientShell.outcome, 'insufficient')
    assert.equal(clientShell.terminal, false)
    assert.ok(clientShell.report.signals.includes('client-rendering-required'))
  }
})

test('quality gate does not treat a long document discussing missing pages as an error page', () => {
  const decision = evaluateAcquisitionQuality({
    title: 'RFC 9110: HTTP Semantics',
    url: 'https://www.rfc-editor.org/rfc/rfc9110.html',
    text: [
      'HTTP Semantics defines the architecture and terminology shared by HTTP.',
      'This standards document contains detailed normative requirements.'.repeat(20),
      'A 404 response is commonly presented to a user as page not found.',
      'Further sections define methods, status codes, fields, and caching.'.repeat(20),
    ].join(' '),
    httpStatus: 200,
    mediaType: 'text/html',
  })

  assert.equal(decision.usable, true)
})

test('quality gate still rejects a soft 404 identified by its title', () => {
  const decision = evaluateAcquisitionQuality({
    title: 'Page Not Found',
    url: 'https://example.com/missing',
    text: 'Return to the site homepage to continue browsing.',
    httpStatus: 200,
    mediaType: 'text/html',
  })

  assert.equal(decision.usable, false)
  if (!decision.usable) assert.equal(decision.outcome, 'not-found')
})

test('direct acquisition recognizes a generic interactive verification wall', () => {
  const challenged = evaluateAcquisitionQuality({
    title: 'Verification Required',
    url: 'https://example.com/report',
    text: [
      'The visual verification might not be accessible to you.',
      'Use the audio verification to hear six digits.',
      'Slide right to secure your access.',
      'We detected unusual activity from your device or network.',
    ].join(' '),
    httpStatus: 403,
    mediaType: 'text/html',
  })

  assert.equal(challenged.usable, false)
  if (!challenged.usable) {
    assert.equal(challenged.outcome, 'challenge')
    assert.equal(challenged.code, 'access_challenge')
    assert.equal(challenged.challengeType, 'captcha')
  }
})

test('research web input is strict and action-specific', () => {
  assert.deepEqual(
    parseResearchWebToolInput({
      action: 'search',
      query: 'current primary research',
      maximumResults: 8,
    }),
    {
      action: 'search',
      query: 'current primary research',
      maximumResults: 8,
    },
  )
  assert.deepEqual(
    parseResearchWebToolInput({
      action: 'search',
      query: 'current primary research',
      includeDomains: ['*.Example.com/docs', '*.example.com/docs'],
    }).includeDomains,
    ['*.example.com/docs'],
  )
  assert.throws(
    () => parseResearchWebToolInput({ action: 'acquire' }),
    /Source URL is required/,
  )
  assert.throws(
    () => parseResearchWebToolInput({
      action: 'search',
      query: 'valid',
      unexpected: true,
    }),
    /unknown field/,
  )
  assert.throws(
    () => parseResearchWebToolInput({
      action: 'search',
      query: 'valid',
      publishedAfter: 'not-a-date',
    }),
    /valid date/,
  )
  assert.throws(
    () => parseResearchWebToolInput({
      action: 'acquire',
      url: 'https://example.com',
      allowBrowserFallback: 'yes',
    }),
    /must be a boolean/,
  )
  assert.throws(
    () => parseResearchWebToolInput({
      action: 'search',
      query: 'valid',
      includeDomains: ['example.com injected-query'],
    }),
    /domains are invalid/,
  )
  assert.deepEqual(
    parseResearchWebToolInput({
      action: 'extract',
      contentId: 'observation-1',
      schema: {
        type: 'object',
        properties: { headline: { type: 'string' } },
      },
      requiredFields: ['headline'],
    }),
    {
      action: 'extract',
      contentId: 'observation-1',
      schema: {
        type: 'object',
        properties: { headline: { type: 'string' } },
      },
      requiredFields: ['headline'],
    },
  )
})

/** Narrow one step of a JSON Schema without casting away its unknown shape. */
function schemaAt(
  value: unknown,
  ...path: readonly string[]
): Record<string, unknown> {
  let current = value
  for (const key of path) {
    assert.ok(isRecord(current), `Expected an object before '${key}'`)
    current = current[key]
  }
  assert.ok(isRecord(current), `Expected an object at '${path.join('.')}'`)
  return current
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `sourceValue` is a spending decision, and the agent is the one making it.
 *
 * The runtime already skips browser fallback for a `replaceable` source, and
 * `tests/integration/research-web-acquisition.test.ts` proves it. What the
 * agent could not see anywhere was when to say `replaceable`, so it never did,
 * and exploratory reads spent the cloud budget that a named unsupported field
 * needed. The rule has to be legible in the contract the agent is handed.
 */
test('the research_web contract says which sources earn browser and cloud budget', () => {
  const description = String(
    schemaAt(researchWebToolInputSchema(), 'properties', 'sourceValue').description ?? '',
  )

  assert.match(description, /`replaceable`/u)
  assert.match(description, /discovery, index, and browse pages/u)
  assert.match(description, /never spends browser or cloud budget/u)
  assert.match(description, /`important`/u)
  assert.match(description, /`unique-primary`/u)
  assert.match(description, /still lacks a required field/u)
  assert.match(description, /no adequate substitute source/u)
  assert.match(description, /Stop escalating once that field is supported/u)
})
