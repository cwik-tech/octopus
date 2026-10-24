import test from 'node:test'
import assert from 'node:assert/strict'
import { parseYaml } from '../../core/yaml-parser.js'

test('parseYaml handles nested objects arrays and comments', () => {
  const result = parseYaml(`
team:
  name: sample
  enabled: true
agents:
  - name: alpha
    color: 208
  - name: beta # inline comment
    color: 34
`)

  assert.equal((result.team as any).name, 'sample')
  assert.equal((result.team as any).enabled, true)
  assert.equal((result.agents as any[]).length, 2)
  assert.deepEqual(result.agents, [
    { name: 'alpha', color: 208 },
    { name: 'beta', color: 34 },
  ])
})

test('parseYaml handles folded and literal blocks', () => {
  const result = parseYaml(`
team:
  description: >
    first line
    second line
  notes: |
    keep
    line breaks
`)

  assert.equal((result.team as any).description, 'first line second line')
  assert.equal((result.team as any).notes, 'keep\nline breaks')
})

test('parseYaml handles folded and literal blocks inside array objects', () => {
  const result = parseYaml(`
steps:
  - id: write
    brief_prefix: |
      keep
      line breaks
    brief_suffix: >
      fold
      these lines
`)

  assert.equal((result.steps as any[])[0]?.brief_prefix, 'keep\nline breaks')
  assert.equal((result.steps as any[])[0]?.brief_suffix, 'fold these lines')
})

test('parseYaml retains blank lines in literal blocks at every nesting level', () => {
  const result = parseYaml(`
notes: |
  first paragraph

  second paragraph
steps:
  - brief: |
      first step paragraph

      second step paragraph
`)

  assert.equal(result.notes, 'first paragraph\n\nsecond paragraph')
  assert.equal((result.steps as any[])[0]?.brief, 'first step paragraph\n\nsecond step paragraph')
})

test('parseYaml does not coerce YAML 1.1 yes/no strings to booleans', () => {
  const result = parseYaml(`
first: yes
second: no
explicit: true
`)

  assert.equal(result.first, 'yes')
  assert.equal(result.second, 'no')
  assert.equal(result.explicit, true)
})

test('parseYaml preserves YAML empty collections as collections', () => {
  const result = parseYaml(`
agents: []
defaults: {}
level:
  sequence: []
`)

  assert.deepEqual(result.agents, [])
  assert.deepEqual(result.defaults, {})
  assert.deepEqual((result.level as Record<string, unknown>).sequence, [])
})

test('parseYaml keeps # characters inside block scalars verbatim', () => {
  const result = parseYaml(`
brief: |
  real # not-comment
  # looks like a comment but is content
  last line
folded: >
  also # kept
  content
`)

  assert.equal(result.brief, 'real # not-comment\n# looks like a comment but is content\nlast line')
  assert.equal(result.folded, 'also # kept content')
})

test('parseYaml supports indentless sequences under a key', () => {
  const result = parseYaml(`
steps:
- id: a
- id: b
nested:
  items:
  - one
  - two
  after: ok
`)

  assert.deepEqual(result.steps, [{ id: 'a' }, { id: 'b' }])
  assert.deepEqual((result.nested as any).items, ['one', 'two'])
  assert.equal((result.nested as any).after, 'ok')
})

test('parseYaml parses flow sequences of scalars', () => {
  const result = parseYaml(`
tools: [read, bash]
quoted: ['a, b', "c"]
empty: [ ]
unbalanced: [read, bash
`)

  assert.deepEqual(result.tools, ['read', 'bash'])
  assert.deepEqual(result.quoted, ['a, b', 'c'])
  assert.deepEqual(result.empty, [])
  assert.equal(result.unbalanced, '[read, bash')
})

test('parseYaml decodes quoted mapping keys', () => {
  const result = parseYaml(`
levels:
  "deliberation: #1":
    discussion:
      max_rounds: 1
`)

  assert.deepEqual(result, {
    levels: {
      'deliberation: #1': {
        discussion: { max_rounds: 1 },
      },
    },
  })
})
