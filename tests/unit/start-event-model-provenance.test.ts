/**
 * Every `start` event a run writes has to say how its model was decided.
 *
 * The disclosure requirement is about the run as a whole, but the events are
 * emitted from three places in three files: the dispatcher
 * (`domains/agent-execution/agent-runner.ts`), the direct-discussion
 * coordinator (`team-runtime/discussion-autostart.ts`), and the host
 * coordinator (`team-runtime/host-turn-lifecycle.ts`, moved out of
 * `team-runtime/index.ts`). Two of them shipped
 * without provenance, and neither was covered by a test that would have
 * noticed, because reaching them means starting a real Team runtime.
 *
 * This reads the emitters instead. It cannot prove the recorded value is
 * right — `tests/integration/agent-runner.test.ts` does that — but it does
 * prove no emitter was added or left without one, which is the failure that
 * actually happened.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const EMITTERS = [
  'team-runtime/host-turn-lifecycle.ts',
  'team-runtime/discussion-autostart.ts',
  'domains/agent-execution/agent-runner.ts',
]

/**
 * Modules that emit no start event today: `index.ts`, whose host coordinator
 * start event moved to `host-turn-lifecycle.ts`, and the modules split out of
 * it. Any start event one of them gains must record how its model was
 * selected too.
 */
const MOVED_FROM_EMITTERS = [
  'team-runtime/index.ts',
  'team-runtime/team-boot.ts',
  'team-runtime/level-tools.ts',
  'team-runtime/runtime-teardown.ts',
]

/**
 * The object literal each `event: "start"` sits in.
 *
 * Found by scanning forward to the matching close brace from the line that
 * declares the event, which is enough structure for a literal with no nested
 * function bodies.
 */
function startEventLiterals(source: string): string[] {
  const literals: string[] = []
  const pattern = /event:\s*(['"])start\1/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    const openIndex = source.lastIndexOf('{', match.index)
    if (openIndex === -1) continue
    let depth = 0
    let end = openIndex
    for (let index = openIndex; index < source.length; index += 1) {
      const character = source[index]
      if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) {
          end = index
          break
        }
      }
    }
    literals.push(source.slice(openIndex, end + 1))
  }
  return literals
}

test('every run start event records how its model was selected', () => {
  let checked = 0
  for (const relativePath of EMITTERS) {
    const source = fs.readFileSync(
      path.join(process.cwd(), relativePath),
      'utf8',
    )
    const literals = startEventLiterals(source)
    assert.notEqual(
      literals.length,
      0,
      `${relativePath} must still emit a start event`,
    )
    for (const literal of literals) {
      checked += 1
      assert.match(
        literal,
        /model_selection/,
        `a start event in ${relativePath} records no model_selection:\n${literal}`,
      )
    }
  }
  for (const relativePath of MOVED_FROM_EMITTERS) {
    const source = fs.readFileSync(
      path.join(process.cwd(), relativePath),
      'utf8',
    )
    for (const literal of startEventLiterals(source)) {
      checked += 1
      assert.match(
        literal,
        /model_selection/,
        `a start event in ${relativePath} records no model_selection:\n${literal}`,
      )
    }
  }
  // Three emitters today: the dispatcher, the direct-discussion coordinator,
  // and the host coordinator. A fourth arriving without provenance is exactly
  // what this is here to catch, so the count is pinned rather than assumed.
  assert.equal(checked, 3)
})
