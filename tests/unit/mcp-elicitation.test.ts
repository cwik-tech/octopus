import assert from 'node:assert/strict'
import test from 'node:test'

import {
  McpElicitationError,
  hashMcpElicitationFormValues,
  normalizeMcpElicitationFormSchema,
  normalizeMcpElicitationMessage,
  normalizeMcpElicitationUrl,
  validateMcpElicitationFormValues,
  type McpElicitationFormSchema,
} from '../../domains/mcp/mcp-elicitation.js'

function hasCode(code: McpElicitationError['code']) {
  return (error: unknown): boolean =>
    error instanceof McpElicitationError && error.code === code
}

function fullSchema(): McpElicitationFormSchema {
  return normalizeMcpElicitationFormSchema({
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        title: 'Enable feature',
        default: true,
      },
      launchDate: {
        type: 'string',
        format: 'date',
      },
      priority: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        default: 3,
      },
      region: {
        type: 'string',
        enum: ['us', 'eu'],
        default: 'us',
      },
      role: {
        type: 'string',
        oneOf: [
          { const: 'admin', title: 'Administrator' },
          { const: 'reader', title: 'Reader' },
        ],
      },
      scopes: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: {
          anyOf: [
            { const: 'read', title: 'Read' },
            { const: 'write', title: 'Write' },
          ],
        },
      },
      summary: {
        type: 'string',
        minLength: 2,
        maxLength: 32,
      },
    },
    required: ['summary', 'enabled', 'priority'],
  })
}

test('restricted MCP form schemas normalize every supported primitive shape', () => {
  const schema = fullSchema()
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ['enabled', 'priority', 'summary'])
  assert.deepEqual(Object.keys(schema.properties), [
    'enabled',
    'launchDate',
    'priority',
    'region',
    'role',
    'scopes',
    'summary',
  ])

  const values = validateMcpElicitationFormValues(schema, {
    summary: 'Ship safely',
    enabled: false,
    priority: 4,
    launchDate: '2026-07-12',
    region: 'eu',
    role: 'reader',
    scopes: ['read', 'write'],
  })
  assert.deepEqual(values, {
    enabled: false,
    launchDate: '2026-07-12',
    priority: 4,
    region: 'eu',
    role: 'reader',
    scopes: ['read', 'write'],
    summary: 'Ship safely',
  })

  const first = hashMcpElicitationFormValues(schema, values)
  const reordered = hashMcpElicitationFormValues(schema, {
    scopes: ['read', 'write'],
    role: 'reader',
    region: 'eu',
    priority: 4,
    launchDate: '2026-07-12',
    enabled: false,
    summary: 'Ship safely',
  })
  const changed = hashMcpElicitationFormValues(schema, {
    ...values,
    priority: 5,
  })
  assert.deepEqual(first.valuesHash, reordered.valuesHash)
  assert.notEqual(first.valuesHash.value, changed.valuesHash.value)
  assert.match(first.valuesHash.value, /^[a-f0-9]{64}$/)
})

test('form values are exact, constraint-checked, and never coerced or defaulted', () => {
  const schema = fullSchema()
  for (const invalid of [
    { enabled: true, priority: 1 },
    { enabled: true, priority: 1, summary: 'ok', extra: 'blocked' },
    { enabled: 'true', priority: 1, summary: 'ok' },
    { enabled: true, priority: '1', summary: 'ok' },
    { enabled: true, priority: 0, summary: 'ok' },
    { enabled: true, priority: 1.5, summary: 'ok' },
    { enabled: true, priority: 1, summary: 'x' },
    {
      enabled: true,
      priority: 1,
      summary: 'ok',
      launchDate: '2026-02-30',
    },
    { enabled: true, priority: 1, summary: 'ok', region: 'apac' },
    {
      enabled: true,
      priority: 1,
      summary: 'ok',
      scopes: ['read', 'read'],
    },
    {
      enabled: true,
      priority: 1,
      summary: 'ok',
      scopes: ['delete'],
    },
  ]) {
    assert.throws(
      () => validateMcpElicitationFormValues(schema, invalid),
      hasCode('invalid_request'),
    )
  }

  const accepted = validateMcpElicitationFormValues(schema, {
    enabled: true,
    priority: 2,
    summary: 'ok',
  })
  assert.equal('region' in accepted, false)
  assert.equal('launchDate' in accepted, false)

  const unicodeSchema = normalizeMcpElicitationFormSchema({
    type: 'object',
    properties: {
      glyph: { type: 'string', minLength: 1, maxLength: 1 },
      timestamp: { type: 'string', format: 'date-time' },
    },
    required: ['glyph', 'timestamp'],
  })
  assert.deepEqual(
    validateMcpElicitationFormValues(unicodeSchema, {
      glyph: '😀',
      timestamp: '2026-07-12T20:00:00Z',
    }),
    { glyph: '😀', timestamp: '2026-07-12T20:00:00Z' },
  )
  assert.throws(
    () =>
      validateMcpElicitationFormValues(unicodeSchema, {
        glyph: '😀',
        timestamp: '2026-02-30T20:00:00Z',
      }),
    hasCode('invalid_request'),
  )
})

test('unsafe, secret, nested, ambiguous, and pollution-shaped schemas fail closed', () => {
  const invalidSchemas: unknown[] = [
    {
      type: 'object',
      properties: { password: { type: 'string', format: 'password' } },
    },
    {
      type: 'object',
      properties: { token: { type: 'string', format: 'secret' } },
    },
    {
      type: 'object',
      properties: { nested: { type: 'object', properties: {} } },
    },
    {
      type: 'object',
      properties: { arbitrary: { type: 'string', pattern: '.*' } },
    },
    {
      type: 'object',
      properties: {
        legacy: {
          type: 'string',
          enum: ['a'],
          enumNames: ['A'],
        },
      },
    },
    {
      type: 'object',
      properties: { choice: { type: 'string', enum: ['a', 'a'] } },
    },
    {
      type: 'object',
      properties: { count: { type: 'number', minimum: 2, maximum: 1 } },
    },
    {
      type: 'object',
      properties: { field: { type: 'string' } },
      required: ['missing'],
    },
    {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
    {
      type: 'object',
      properties: JSON.parse('{"__proto__":{"type":"string"}}') as unknown,
    },
  ]

  const accessor = {
    type: 'object',
    properties: {},
  } as Record<string, unknown>
  Object.defineProperty(accessor, 'required', {
    enumerable: true,
    get: () => ['must-not-run'],
  })
  invalidSchemas.push(accessor)

  for (const schema of invalidSchemas) {
    assert.throws(
      () => normalizeMcpElicitationFormSchema(schema),
      hasCode('invalid_request'),
    )
  }
})

test('URL mode and user-visible messages enforce safe bounded input', () => {
  assert.equal(
    normalizeMcpElicitationUrl('https://example.com/confirm?state=opaque'),
    'https://example.com/confirm?state=opaque',
  )
  assert.equal(
    normalizeMcpElicitationUrl('http://localhost:3333'),
    'http://localhost:3333/',
  )
  assert.equal(
    normalizeMcpElicitationMessage('Confirm this operation\nOnly once.'),
    'Confirm this operation\nOnly once.',
  )

  for (const invalid of [
    'javascript:alert(1)',
    'file:///tmp/secret',
    'https://user:password@example.com/confirm',
    'https://@example.com/confirm',
    'https://example.com/confirm#token',
    'https://example.com/confirm#',
    'https://example.com/with space',
    'https://example.com\\redirect',
    'https://example.com/confirm\u0000',
  ]) {
    assert.throws(
      () => normalizeMcpElicitationUrl(invalid),
      hasCode('invalid_request'),
    )
  }
  for (const invalid of ['', '   ', 'unsafe\u0000message', 'x'.repeat(4_097)]) {
    assert.throws(
      () => normalizeMcpElicitationMessage(invalid),
      hasCode('invalid_request'),
    )
  }
})
