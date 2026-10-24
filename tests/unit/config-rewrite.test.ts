import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'

import {
  replaceRequiredText,
  replaceYamlField,
  replaceYamlFields,
  setFrontMatterField,
  setFrontMatterFields,
} from '../support/config-rewrite.js'

/**
 * The rewrite that stopped rewriting.
 *
 * Electron specs reroute a bundled persona, team or workflow onto a
 * deterministic fixture by string-replacing one line of the shipped file. When
 * the shipped file stops carrying that line, a bare `String.replace` returns
 * the input untouched: nothing fails to compile, no assertion fires, and the
 * spec runs against the real application default while its name still claims it
 * exercises the fixture. These tests pin the loud failure that replaces that
 * silence, and the one call shape that is allowed to survive the change.
 */

const repoRoot = process.cwd()

/** A bundled persona that still declares `provider:`. */
const PERSONA_PATH = path.join(
  repoRoot,
  'agents',
  'web-researcher',
  'web-researcher.md',
)

/** A bundled Markdown file that carries no YAML front matter at all. */
const PERSONA_WITHOUT_FRONT_MATTER = path.join(
  repoRoot,
  'agents',
  'resource-architect',
  'resource-architect.md',
)

/** The exact expression the specs used before this helper existed. */
const BARE_SPEC_REPLACE = /^provider:\s*.+$/mu

/** Node's `assert.throws` returns nothing, and the message is the evidence. */
function messageThrownBy(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return assert.fail('expected the rewrite to throw, but it returned quietly')
}

function bundledPersona(): string {
  return fs.readFileSync(PERSONA_PATH, 'utf8')
}

/** The same persona as the pending sweep will leave it: no `provider:` line. */
function personaAfterProviderSweep(): string {
  const swept = bundledPersona().replace(/^provider:.*\n/m, '')
  assert.doesNotMatch(swept, /^provider:/m, 'the simulated sweep must remove it')
  assert.match(swept, /^---\n/, 'and must leave the front matter intact')
  return swept
}

test('the bare replace the specs used is a silent no-op once the field is gone', () => {
  const swept = personaAfterProviderSweep()
  assert.equal(
    swept.replace(BARE_SPEC_REPLACE, 'provider: openai'),
    swept,
    'the trap: the persona comes back untouched and the spec routes nowhere',
  )
})

test('replaceYamlField rewrites every occurrence and preserves indentation', () => {
  const registry = [
    'writing-team:',
    '  host_provider: codex',
    '',
    'research-team:',
    '  host_provider: "codex"',
    '',
  ].join('\n')

  assert.equal(
    replaceYamlField({
      field: 'host_provider',
      file: 'teams.yaml',
      source: registry,
      value: 'openai',
    }),
    [
      'writing-team:',
      '  host_provider: openai',
      '',
      'research-team:',
      '  host_provider: openai',
      '',
    ].join('\n'),
  )
})

test('replaceYamlField throws, naming file and pattern, when the field is absent', () => {
  const message = messageThrownBy(() =>
    replaceYamlField({
      field: 'provider',
      file: PERSONA_PATH,
      source: personaAfterProviderSweep(),
      value: 'openai',
    }),
  )
  assert.match(message, /web-researcher\.md/)
  assert.match(message, /provider/)
  assert.match(message, /pattern/)
})

test('setFrontMatterField replaces the field a persona still declares', () => {
  const persona = [
    '---',
    'name: fixture-researcher',
    'provider: codex',
    'model: gpt-5.5',
    '---',
    '',
    '# Fixture Researcher',
    '',
  ].join('\n')
  const routed = setFrontMatterField({
    field: 'provider',
    file: PERSONA_PATH,
    source: persona,
    value: 'openai',
  })
  assert.match(routed, /^provider: openai$/m)
  assert.doesNotMatch(routed, /^provider: codex$/m)
  assert.equal(
    routed.slice(routed.indexOf('\n---', 4)),
    persona.slice(persona.indexOf('\n---', 4)),
    'the body below the front matter is untouched',
  )
})

test('setFrontMatterField inserts the field the sweep removed', () => {
  const swept = personaAfterProviderSweep()
  const routed = setFrontMatterField({
    field: 'provider',
    file: PERSONA_PATH,
    source: swept,
    value: 'openai',
  })
  assert.match(
    routed.slice(0, routed.indexOf('\n---', 4)),
    /^provider: openai$/m,
  )
  assert.equal(
    routed.slice(routed.indexOf('\n---', 4)),
    swept.slice(swept.indexOf('\n---', 4)),
    'the body below the front matter is untouched',
  )
})

test('setFrontMatterField leaves every other front matter field alone', () => {
  const routed = setFrontMatterField({
    field: 'provider',
    file: PERSONA_PATH,
    source: [
      '---',
      'name: fixture-researcher',
      'model: gpt-5.5',
      'thinking: medium',
      '---',
      '',
      '# Fixture Researcher',
      '',
    ].join('\n'),
    value: 'openai',
  })
  assert.match(routed, /^name: fixture-researcher$/m)
  assert.match(routed, /^model: gpt-5\.5$/m)
  assert.match(routed, /^thinking: medium$/m)
})

test('setFrontMatterField throws when it can neither find nor insert', () => {
  const message = messageThrownBy(() =>
    setFrontMatterField({
      field: 'provider',
      file: PERSONA_WITHOUT_FRONT_MATTER,
      source: fs.readFileSync(PERSONA_WITHOUT_FRONT_MATTER, 'utf8'),
      value: 'openai',
    }),
  )
  assert.match(message, /resource-architect\.md/)
  assert.match(message, /front matter/i)
})

test('replaceRequiredText throws when the anchor it needs is gone', () => {
  const message = messageThrownBy(() =>
    replaceRequiredText({
      file: 'workflows/templates/packaged-smoke.yaml',
      pattern: 'id: packaged-smoke',
      replacement: 'id: pitch-deck-evaluation',
      source: 'workflow:\n  id: renamed-upstream\n',
    }),
  )
  assert.match(message, /packaged-smoke\.yaml/)
  assert.match(message, /id: packaged-smoke/)
})

test('replaceRequiredText rewrites when the anchor is present', () => {
  assert.equal(
    replaceRequiredText({
      file: 'workflows/templates/packaged-smoke.yaml',
      pattern: 'id: packaged-smoke',
      replacement: 'id: pitch-deck-evaluation',
      source: 'workflow:\n  id: packaged-smoke\n',
    }),
    'workflow:\n  id: pitch-deck-evaluation\n',
  )
})

test('replaceRequiredText throws when a regular expression matches nothing', () => {
  const message = messageThrownBy(() =>
    replaceRequiredText({
      file: 'workflows/templates/packaged-smoke.yaml',
      pattern: /\n {4}- id: finalize[\s\S]*?\n {2}output:/,
      replacement: '\n  output:',
      source: 'workflow:\n  id: packaged-smoke\n  output:\n',
    }),
  )
  assert.match(message, /packaged-smoke\.yaml/)
  assert.match(message, /finalize/)
})

test('setFrontMatterFields pins a whole routing pair in one call', () => {
  const routed = setFrontMatterFields({
    fields: { model: 'fixture/research-web', provider: 'openai' },
    file: PERSONA_PATH,
    source: personaAfterProviderSweep(),
  })
  const frontMatter = routed.slice(0, routed.indexOf('\n---', 4))
  assert.match(frontMatter, /^provider: openai$/m)
  assert.match(frontMatter, /^model: fixture\/research-web$/m)
})

test('setFrontMatterFields throws for the first field it cannot pin', () => {
  const message = messageThrownBy(() =>
    setFrontMatterFields({
      fields: { model: 'fixture/research-web', provider: 'openai' },
      file: PERSONA_WITHOUT_FRONT_MATTER,
      source: fs.readFileSync(PERSONA_WITHOUT_FRONT_MATTER, 'utf8'),
    }),
  )
  assert.match(message, /resource-architect\.md/)
})

test('replaceYamlFields pins a whole registry pair in one call', () => {
  const registry = [
    'writing-team:',
    '  host_model: gpt-5.4-mini',
    '  host_provider: codex',
    '',
  ].join('\n')

  assert.equal(
    replaceYamlFields({
      fields: { host_model: 'fixture/tool-loop', host_provider: 'openai' },
      file: 'teams.yaml',
      source: registry,
    }),
    [
      'writing-team:',
      '  host_model: fixture/tool-loop',
      '  host_provider: openai',
      '',
    ].join('\n'),
  )
})

test('replaceYamlFields throws for the first field the registry has lost', () => {
  const message = messageThrownBy(() =>
    replaceYamlFields({
      fields: { host_model: 'fixture/tool-loop', host_provider: 'openai' },
      file: 'teams.yaml',
      source: 'writing-team:\n  host_provider: codex\n',
    }),
  )
  assert.match(message, /teams\.yaml/)
  assert.match(message, /host_model/)
})
