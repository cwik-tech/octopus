/**
 * Double-quoted scalars that hold escapes, read by `parseYaml`.
 *
 * The app writes double-quoted scalars with `JSON.stringify` (`yamlQuoted`),
 * so a value holding a backslash or a double quote reaches the file as `\\`
 * or `\"`. These tests pin that the parser decodes those escapes, and that an
 * escaped quote does not end the scalar for the scanners that run before
 * decoding: comment stripping, the key colon search and the flow-list split.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { parseYaml } from '../../core/yaml-parser.js'
import { yamlQuoted } from '../../domains/agent-generator/team-yaml-scalars.js'

test('parseYaml decodes the escapes JSON.stringify writes in a double-quoted scalar, and keeps any other backslash as written', () => {
  const result = parseYaml(String.raw`
backslash: "../repo\\x/a.md"
quote: "../repo\"x/a.md"
controls: "one\ntwo\tthree\r\b\f"
unicode: "caf\u00e9 \ud83d\ude00 \u0001"
slash: "a\/b"
unknown: "C:\Users\x41\q"
`)

  assert.deepEqual(result, {
    backslash: '../repo\\x/a.md',
    quote: '../repo"x/a.md',
    controls: 'one\ntwo\tthree\r\b\f',
    unicode: 'caf\u00e9 \ud83d\ude00 \u0001',
    slash: 'a/b',
    unknown: 'C:\\Users\\x41\\q',
  })
})

test('parseYaml does not end a double-quoted scalar at an escaped quote, so a following " #" is not a comment', () => {
  const result = parseYaml(String.raw`
agent_file: "a\" #b.md"
sequence:
  - "a\" #b"
`)

  assert.deepEqual(result, { agent_file: 'a" #b.md', sequence: ['a" #b'] })
})

test('parseYaml does not end a double-quoted sequence item or key at an escaped quote, so the item stays a string and the key keeps its line', () => {
  const result = parseYaml(String.raw`
sequence:
  - "a\": b"
  - c
"a\"b": 1
`)

  assert.deepEqual(result, { sequence: ['a": b', 'c'], 'a"b': 1 })
})

test('parseYaml does not end a double-quoted flow item at an escaped quote, so a following ", " or "]" neither splits nor closes the list', () => {
  const result = parseYaml(String.raw`
comma: ["a\", b", "c"]
bracket: ["a\"]", "c"]
`)

  assert.deepEqual(result, { comma: ['a", b', 'c'], bracket: ['a"]', 'c'] })
})

test('a value yamlQuoted writes reads back through parseYaml unchanged, as a mapping value, a sequence item and a flow item', () => {
  const value = '../repo"x\\y/agents/a.md'
  const result = parseYaml(
    [
      `agent_file: ${yamlQuoted(value)}`,
      'sequence:',
      `  - ${yamlQuoted(value)}`,
      `participants: [${yamlQuoted(value)}, "lead"]`,
      '',
    ].join('\n'),
  )

  assert.deepEqual(result, {
    agent_file: value,
    sequence: [value],
    participants: [value, 'lead'],
  })
})
