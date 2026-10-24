import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyModelCandidates,
  extractDeterministically,
  validateExtractionSchema,
  validateRequiredFields,
} from '../../domains/acquisition/source-extraction.js'
import {
  buildSourceRepresentations,
} from '../../domains/acquisition/source-representations.js'

test('HTML acquisition preserves structured representations and produces real Markdown', () => {
  const representations = buildSourceRepresentations(
    `<!doctype html>
    <html lang="en">
      <head>
        <title>Quarterly report</title>
        <meta name="description" content="Verified company results">
        <script type="application/ld+json">
          {"@type":"Report","headline":"Quarterly report","year":2026,"growth":12.5}
        </script>
      </head>
      <body>
        <main>
          <h1>Quarterly report</h1>
          <p>Verified company results are available from the primary source.</p>
          <ul><li><a href="/details">Detailed evidence</a></li></ul>
          <table><tr><th>Metric</th><th>Value</th></tr><tr><td>Growth</td><td>12.5%</td></tr></table>
        </main>
      </body>
    </html>`,
    'text/html',
    'https://example.com/report',
  )
  assert.match(representations.markdown, /^# Quarterly report/mu)
  assert.match(representations.markdown, /- \[Detailed evidence\]\(https:\/\/example\.com\/details\)/u)
  assert.match(representations.markdown, /\| Metric \| Value \|/u)
  assert.ok(representations.structured.some((entry) => entry.kind === 'json-ld'))
  assert.ok(representations.structured.some((entry) => entry.kind === 'table'))
  assert.ok(representations.structured.some((entry) => entry.kind === 'metadata'))
})

test('HTML acquisition suppresses unsupported CSS diagnostics without losing content', () => {
  const diagnostics: unknown[][] = []
  const originalConsoleError = console.error
  console.error = (...values: unknown[]) => {
    diagnostics.push(values)
  }
  let markdown = ''
  try {
    markdown = buildSourceRepresentations(
      `<!doctype html>
      <html>
        <head><style>.card { &:hover { color: red; } }</style></head>
        <body><main><h1>Nested CSS page</h1><p>Usable evidence remains readable.</p></main></body>
      </html>`,
      'text/html',
      'https://example.com/nested-css',
    ).markdown
  } finally {
    console.error = originalConsoleError
  }

  assert.deepEqual(diagnostics, [])
  assert.match(markdown, /Usable evidence remains readable\./u)
})

test('source representation parsing still rejects malformed XML', () => {
  assert.throws(
    () => buildSourceRepresentations(
      '<report>',
      'text/xml',
      'https://example.com/report.xml',
    ),
    /unclosed tag: report/u,
  )
})

test('deterministic extraction returns partial typed data, conflicts, and unmapped values', () => {
  const representations = buildSourceRepresentations(
    `<!doctype html><html><head>
      <title>Primary result</title>
      <script type="application/ld+json">
        {"headline":"Primary result","year":"2026","growth":12.5,"extra":"preserve me"}
      </script>
    </head><body><main><h1>Primary result</h1><p>
      The verified primary result describes the reporting period in detail.
    </p></main></body></html>`,
    'text/html',
    'https://example.com/result',
  )
  const schema = validateExtractionSchema({
    type: 'object',
    properties: {
      headline: { type: 'string' },
      year: { type: 'integer' },
      missing: { type: 'string' },
    },
  })
  const requiredFields = validateRequiredFields(schema.fields, ['headline', 'missing'])
  const extraction = extractDeterministically({
    extractionId: 'extract-1',
    sourceReceiptId: 'receipt-1',
    sourceContentSha256: 'a'.repeat(64),
    schema,
    requiredFields,
    mode: 'strict',
    representations: {
      schemaVersion: 1,
      sourceMediaType: 'text/html',
      normalizedMediaType: 'text/markdown',
      contentRelativePath: 'research/acquisitions/lane/receipt/content.md',
      contentSha256: 'a'.repeat(64),
      contentBytes: representations.markdown.length,
      representations: representations.structured,
      warnings: [],
    },
  })
  assert.deepEqual(extraction.result.data, {
    headline: 'Primary result',
    year: 2026,
  })
  assert.equal(extraction.result.complete, false)
  assert.equal(extraction.result.requirementsMet, false)
  assert.equal(extraction.result.mode, 'strict')
  assert.equal(
    extraction.result.fields.find((field) => field.path === 'missing')?.status,
    'missing',
  )
  assert.ok(extraction.result.unmappedData.some((entry) => entry.value === 'preserve me'))
})

test('array extraction validates and safely converts nested item schemas', () => {
  const schema = validateExtractionSchema({
    type: 'object',
    properties: {
      employees: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'age'],
          properties: {
            name: { type: 'string' },
            age: { type: 'integer' },
          },
        },
      },
    },
  })
  const extraction = extractDeterministically({
    extractionId: 'extract-array',
    sourceReceiptId: 'receipt-array',
    sourceContentSha256: 'c'.repeat(64),
    schema,
    requiredFields: ['employees'],
    mode: 'best-effort',
    representations: {
      schemaVersion: 1,
      sourceMediaType: 'application/json',
      normalizedMediaType: 'text/markdown',
      contentRelativePath: 'research/acquisitions/lane/receipt/content.md',
      contentSha256: 'c'.repeat(64),
      contentBytes: 100,
      representations: [{
        id: 'source-json',
        kind: 'json',
        mediaType: 'application/json',
        data: { employees: [{ name: 'Ada', age: '42' }] },
      }],
      warnings: [],
    },
  })
  assert.deepEqual(extraction.result.data, {
    employees: [{ name: 'Ada', age: 42 }],
  })
  assert.equal(extraction.result.requirementsMet, true)
})

test('deterministic extraction reads key-value and header-based HTML tables', () => {
  const representations = buildSourceRepresentations(
    `<html><body>
      <table>
        <tr><th>Metric</th><th>Value</th></tr>
        <tr><td>Revenue</td><td>125.5</td></tr>
      </table>
      <table>
        <tr><th>Company</th><th>Employees</th></tr>
        <tr><td>Acme</td><td>42</td></tr>
      </table>
    </body></html>`,
    'text/html',
    'https://example.com/tables',
  )
  const schema = validateExtractionSchema({
    type: 'object',
    properties: {
      revenue: { type: 'number' },
      employees: { type: 'integer' },
    },
  })
  const extraction = extractDeterministically({
    extractionId: 'extract-table',
    sourceReceiptId: 'receipt-table',
    sourceContentSha256: 'd'.repeat(64),
    schema,
    requiredFields: ['revenue', 'employees'],
    mode: 'best-effort',
    representations: {
      schemaVersion: 1,
      sourceMediaType: 'text/html',
      normalizedMediaType: 'text/markdown',
      contentRelativePath: 'research/acquisitions/lane/receipt/content.md',
      contentSha256: 'd'.repeat(64),
      contentBytes: representations.markdown.length,
      representations: representations.structured,
      warnings: representations.warnings,
    },
  })
  assert.deepEqual(extraction.result.data, {
    revenue: 125.5,
    employees: 42,
  })
  assert.equal(extraction.result.requirementsMet, true)
})

test('model-derived values require a matching source quote and never erase deterministic data', () => {
  const schema = validateExtractionSchema({
    type: 'object',
    properties: {
      company: { type: 'string' },
      headquarters: { type: 'string' },
    },
  })
  const base = extractDeterministically({
    extractionId: 'extract-2',
    sourceReceiptId: 'receipt-2',
    sourceContentSha256: 'b'.repeat(64),
    schema,
    requiredFields: ['company', 'headquarters'],
    mode: 'strict',
    representations: {
      schemaVersion: 1,
      sourceMediaType: 'text/html',
      normalizedMediaType: 'text/markdown',
      contentRelativePath: 'research/acquisitions/lane/receipt/content.md',
      contentSha256: 'b'.repeat(64),
      contentBytes: 100,
      representations: [{
        id: 'json-ld-1',
        kind: 'json-ld',
        mediaType: 'application/json',
        data: { company: 'Acme' },
      }],
      warnings: [],
    },
  }).result
  const result = applyModelCandidates({
    base,
    definitions: schema.fields.filter((field) => field.path === 'headquarters'),
    requiredFields: ['company', 'headquarters'],
    candidates: [{
      path: 'headquarters',
      status: 'present',
      value: 'Detroit',
      quote: 'The company is headquartered in Detroit.',
      confidence: 0.9,
    }],
    content: 'Acme profile\n\nThe company is headquartered in Detroit.',
    repaired: false,
  })
  assert.deepEqual(result.data, { company: 'Acme', headquarters: 'Detroit' })
  assert.equal(result.requirementsMet, true)
  assert.equal(
    result.fields.find((field) => field.path === 'headquarters')?.provenance[0]?.method,
    'model',
  )

  const invalid = applyModelCandidates({
    base,
    definitions: schema.fields.filter((field) => field.path === 'headquarters'),
    requiredFields: ['company', 'headquarters'],
    candidates: [{
      path: 'headquarters',
      status: 'present',
      value: 'London',
      quote: 'The company is headquartered in London.',
    }],
    content: 'Acme profile\n\nThe company is headquartered in Detroit.',
    repaired: false,
  })
  assert.deepEqual(invalid.data, { company: 'Acme' })
  assert.equal(
    invalid.fields.find((field) => field.path === 'headquarters')?.status,
    'invalid_evidence',
  )
})

test('schema validation rejects remote references, unknown fields, and unknown required paths', () => {
  assert.throws(
    () => validateExtractionSchema({
      type: 'object',
      properties: { result: { $ref: 'https://example.com/schema.json' } },
    }),
    /unsupported/u,
  )
  const schema = validateExtractionSchema({
    type: 'object',
    properties: { result: { type: 'string' } },
  })
  assert.throws(
    () => validateRequiredFields(schema.fields, ['unknown']),
    /not defined/u,
  )
  assert.throws(
    () => validateExtractionSchema({
      type: 'object',
      required: ['unknown'],
      properties: { result: { type: 'string' } },
    }),
    /must name defined properties/u,
  )
})
