import assert from 'node:assert/strict'
import test from 'node:test'
import { toMcpJsonObject } from '../../contracts/mcp.js'

test('toMcpJsonObject preserves a recursively JSON-safe input object', () => {
  const value = toMcpJsonObject({
    action: 'open',
    metadata: { retries: 2, enabled: true },
    paths: ['one', 'two'],
  })

  assert.deepEqual(value, {
    action: 'open',
    metadata: { retries: 2, enabled: true },
    paths: ['one', 'two'],
  })
})

test('toMcpJsonObject rejects values that cannot cross an MCP JSON boundary', () => {
  assert.throws(
    () => toMcpJsonObject({ missing: undefined }),
    /JSON-compatible object/,
  )
})
