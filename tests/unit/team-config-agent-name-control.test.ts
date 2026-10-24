/**
 * A roster name holding a control character is refused by `parseTeamConfig`.
 *
 * An agent's name becomes a folder name and appears in logs, prompts and the
 * UI. `isSafePathSegment` rejects `/`, `\` and NUL but not the other control
 * characters, and a double-quoted YAML escape such as a backslash-t now
 * decodes to a real TAB, so a name like that reached validation and passed.
 * The same name written with a raw control character in a single-quoted
 * scalar passed too.
 *
 * Escapes are built from character codes, so the YAML text holds a real
 * backslash where the fixture means one.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parseTeamConfig } from '../../parsers/team-config.js'

const BACKSLASH = String.fromCharCode(92)
const TAB = String.fromCharCode(9)
const BEL = String.fromCharCode(7)
const DEL = String.fromCharCode(127)

function parseWithRosterName(nameScalar: string): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-name-control-'))
  try {
    fs.mkdirSync(path.join(dir, 'agents', 'alpha'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'agents', 'alpha', 'alpha.md'), '# Alpha')
    const yaml = [
      'team:',
      '  name: control-name-team',
      'agents:',
      '  - name: alpha',
      '    type: agent',
      '    role: Leads.',
      '    tier: strategic',
      '    agent_file: agents/alpha/alpha.md',
      `  - name: ${nameScalar}`,
      '    type: agent',
      '    role: Joins.',
      '    tier: strategic',
      '    agent_file: agents/alpha/alpha.md',
      'levels:',
      '  - id: l1',
      '    name: Level 1',
      '    order: 0',
      '    stage:',
      '      type: discussion',
      '      coordinator: alpha',
      '      participants:',
      '        - alpha',
      '      config:',
      '        min_rounds: 1',
      '        max_rounds: 2',
      'gates:',
      '  - from: l1',
      '    to: done',
      '    condition:',
      '      type: all_tasks_terminal',
      '',
    ].join('\n')
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)
    return parseTeamConfig(path.join(dir, 'team.yaml')).errors
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function controlCharacterError(name: string): string {
  return `Agent name ${JSON.stringify(name)} must not contain control characters`
}

for (const [label, scalar, decoded] of [
  ['a double-quoted TAB escape', `"a${BACKSLASH}tb"`, `a${TAB}b`],
  ['a double-quoted BEL escape', `"a${BACKSLASH}u0007b"`, `a${BEL}b`],
  ['a raw TAB in a single-quoted name', `'a${TAB}b'`, `a${TAB}b`],
  ['a raw DEL in a single-quoted name', `'a${DEL}b'`, `a${DEL}b`],
] as const) {
  test(`a roster name with ${label} is refused`, () => {
    const errors = parseWithRosterName(scalar)
    assert.ok(
      errors.includes(controlCharacterError(decoded)),
      `expected the control-character error, got ${JSON.stringify(errors)}`,
    )
  })
}

test('an ordinary roster name raises no control-character error', () => {
  const errors = parseWithRosterName('beta-2')
  assert.deepEqual(
    errors.filter((error) => error.includes('control characters')),
    [],
  )
})
