/**
 * The model that writes an Agent is not the model the Agent runs with.
 *
 * A generated persona that copied the authoring pair would pin every new Agent
 * to whichever model happened to author it, and would keep pinning it long
 * after Settings moved on. A new Agent inherits the one application default
 * unless someone deliberately gives it a pair of its own.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import { readAgentModelChoice } from '../../contracts/agent-model-selection.js'
import {
  ARCHITECT_SYSTEM_PROMPT_BASE,
  normalizeGeneratedPersona,
} from '../../domains/agent-generator/agent-prompt.js'

test('the architect is never told to write a provider or model into a persona', () => {
  // The prompt is the contract with the authoring model. Asking for the fields
  // and then stripping them would produce a fight on every generation.
  assert.doesNotMatch(ARCHITECT_SYSTEM_PROMPT_BASE, /provider: <selected-provider>/)
  assert.doesNotMatch(ARCHITECT_SYSTEM_PROMPT_BASE, /model: <selected-model>/)
  assert.match(
    ARCHITECT_SYSTEM_PROMPT_BASE,
    /application default|app default/i,
  )
})

test('a generated persona that names the authoring pair anyway has it removed', () => {
  // Enforced, not merely requested: the authoring model can write whatever it
  // likes, and the file is what a run reads.
  const persona = [
    '---',
    'name: scope-reviewer',
    'tier: specialist',
    'provider: openai',
    'model: local-test-model',
    'thinking: medium',
    'tools: none',
    '---',
    '',
    '# Scope Reviewer',
    '',
  ].join('\n')

  const normalized = normalizeGeneratedPersona(persona)

  assert.doesNotMatch(normalized, /^provider:/m)
  assert.doesNotMatch(normalized, /^model:/m)
  assert.match(normalized, /^name: scope-reviewer$/m)
  assert.match(normalized, /^thinking: medium$/m)
  assert.match(normalized, /# Scope Reviewer/)
  assert.deepEqual(readAgentModelChoice(personaFields(normalized)).choice, {
    mode: 'app-default',
  })
})

test('a persona that named nothing retired is left exactly as it is', () => {
  const persona = '---\nname: scope-reviewer\nthinking: medium\n---\n\n# Scope Reviewer\n'

  assert.equal(normalizeGeneratedPersona(persona), persona)
})

test('a generated persona that volunteers a grade has it removed', () => {
  // A grade is no longer part of authoring: nothing asks the model for one and
  // no new file carries one. The model can still write one unprompted, and the
  // file is what a run reads, so the removal is enforced here rather than
  // hoped for. Only newly generated personas pass through this — an existing
  // persona a person wrote is never rewritten.
  const persona = [
    '---',
    'name: scope-reviewer',
    'description: Reviews scope.',
    'tier: strategic',
    'thinking: medium',
    'tools: none',
    '---',
    '',
    '# Scope Reviewer',
    '',
    'Body mentioning tier: strategic should survive untouched.',
    '',
  ].join('\n')

  const normalized = normalizeGeneratedPersona(persona)

  assert.doesNotMatch(frontmatterOf(normalized), /^tier:/m)
  // Everything else the model wrote is still there, in order.
  assert.match(normalized, /^name: scope-reviewer$/m)
  assert.match(normalized, /^description: Reviews scope\.$/m)
  assert.match(normalized, /^thinking: medium$/m)
  assert.match(normalized, /^tools: none$/m)
  assert.match(normalized, /Body mentioning tier: strategic should survive untouched\./)
})

/**
 * Spellings the persona loader reads as a top-level key, and spellings it does
 * not.
 *
 * `parseAgentFrontmatter` (`parsers/load-agent.ts:49-52`) finds the first
 * colon, requires at least one character before it, rejects a line starting
 * with a space or `-`, and trims the key. So `tier : strategic`, `tier:` and
 * `tier:strategic` are all a `tier` field to the thing that actually reads the
 * file. Removal has to use the same rule, or a persona would be written that
 * looks clean and still loads with a grade.
 */
const LOADER_KEY_SPELLINGS = [
  { line: 'tier: strategic', readAsKey: true },
  { line: 'tier : strategic', readAsKey: true },
  { line: 'tier:strategic', readAsKey: true },
  { line: 'tier:', readAsKey: true },
  { line: 'tier:   strategic   ', readAsKey: true },
  { line: 'provider :openai', readAsKey: true },
  { line: 'model:local-test-model', readAsKey: true },
  // Indented, so it is nested content rather than a field. Removing it would
  // silently edit a structure this has no business touching.
  { line: '  tier: strategic', readAsKey: false },
  // A list item, which the loader skips for the same reason.
  { line: '- tier: strategic', readAsKey: false },
] as const

for (const spelling of LOADER_KEY_SPELLINGS) {
  test(
    `normalizeGeneratedPersona ${
      spelling.readAsKey ? 'removes' : 'keeps'
    } \`${spelling.line}\``,
    () => {
      const persona = [
        '---',
        'name: scope-reviewer',
        spelling.line,
        'thinking: medium',
        '---',
        '',
        '# Scope Reviewer',
        '',
      ].join('\n')

      const normalized = normalizeGeneratedPersona(persona)

      assert.equal(
        frontmatterOf(normalized).split('\n').includes(spelling.line),
        !spelling.readAsKey,
        normalized,
      )
      // Whatever it decided, the rest of the file is untouched.
      assert.match(normalized, /^name: scope-reviewer$/m)
      assert.match(normalized, /^thinking: medium$/m)
      assert.match(normalized, /# Scope Reviewer/)
    },
  )
}

test('the architect is not asked for a grade at all', () => {
  // Asking for the field and then removing it would produce a fight on every
  // generation, and would put the retired vocabulary back in front of the
  // model.
  assert.doesNotMatch(ARCHITECT_SYSTEM_PROMPT_BASE, /tier:/)
  assert.doesNotMatch(ARCHITECT_SYSTEM_PROMPT_BASE, /strategic\|tactical\|specialist/)
})

test('an exemplar persona is shown without the fields the prompt forbids', async () => {
  // The exemplars are real files from `agents/`, and a real file may predate
  // both rules. Embedding one verbatim would contradict the instruction in the
  // same message and invite the model to copy what it was just told to omit.
  const { buildAgentArchitectSystemPrompt } = await import(
    '../../domains/agent-generator/agent-prompt.js'
  )
  const repoRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'exemplar-prompt-')),
  )
  const agentDir = path.join(repoRoot, 'agents', 'contrarian')
  fs.mkdirSync(agentDir, { recursive: true })
  const onDisk = [
    '---',
    'name: contrarian',
    'description: Argues the other side.',
    'tier: strategic',
    'provider: openai',
    'model: some-model',
    'thinking: medium',
    '---',
    '',
    '# Contrarian',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(agentDir, 'contrarian.md'), onDisk)
  try {
    const prompt = buildAgentArchitectSystemPrompt(repoRoot)

    assert.match(prompt, /### Exemplar: contrarian/)
    assert.doesNotMatch(prompt, /^tier: strategic$/m)
    assert.doesNotMatch(prompt, /^provider: openai$/m)
    assert.doesNotMatch(prompt, /^model: some-model$/m)
    // The exemplar is still an exemplar: what it teaches is still there.
    assert.match(prompt, /^name: contrarian$/m)
    assert.match(prompt, /^description: Argues the other side\.$/m)
    assert.match(prompt, /# Contrarian/)
    // And the file itself is untouched. This reads a persona; it never edits one.
    assert.equal(fs.readFileSync(path.join(agentDir, 'contrarian.md'), 'utf8'), onDisk)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

/** The frontmatter block alone, so a body mention cannot satisfy an assertion. */
function frontmatterOf(markdown: string): string {
  return /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? ''
}

test('a persona with no frontmatter is left alone', () => {
  assert.equal(normalizeGeneratedPersona('# Just a body\n'), '# Just a body\n')
})

/** The provider/model a persona file declares, read the way the loader does. */
function personaFields(markdown: string): {
  provider?: string
  model?: string
} {
  const body = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? ''
  const read = (key: string): string | undefined =>
    new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(body)?.[1]?.trim()
  return {
    ...(read('provider') ? { provider: read('provider') as string } : {}),
    ...(read('model') ? { model: read('model') as string } : {}),
  }
}

test('the offline fallback persona inherits the default too', async () => {
  // The fallback runs when the architect is unavailable. It used to write the
  // authoring pair into the persona, which pinned every Agent created during
  // an outage to whatever the caller happened to be using.
  const { runCreateAgent } = await import(
    '../../domains/agent-generator/create-agent.js'
  )
  const previousKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  try {
    const draft = await runCreateAgent({
      repoRoot: process.cwd(),
      skillPaths: [],
      chatHistory: [
        { role: 'user', text: 'I need an agent that reviews contract scope.' },
      ],
      provider: 'openai',
      model: 'authoring-model',
    })
    assert.ok('personaMarkdown' in draft, JSON.stringify(draft))
    assert.doesNotMatch(draft.personaMarkdown, /^provider:/m)
    assert.doesNotMatch(draft.personaMarkdown, /^model:/m)
    assert.doesNotMatch(frontmatterOf(draft.personaMarkdown), /^tier:/m)
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  }
})

test('the offline fallback for a selected skill writes no grade either', async () => {
  // The other fallback branch. `fallback` splits on whether any skill was
  // selected, and the two branches render different persona files, so covering
  // one proves nothing about the other.
  const { runCreateAgent } = await import(
    '../../domains/agent-generator/create-agent.js'
  )
  const previousKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  const repoRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-persona-')),
  )
  const skillPath = path.join(repoRoot, 'skills', 'scope-review')
  fs.mkdirSync(skillPath, { recursive: true })
  fs.writeFileSync(
    path.join(skillPath, 'SKILL.md'),
    '---\nname: scope-review\ndescription: Review scope. Use when a brief needs one.\n---\n\n# Review\n',
  )
  try {
    const draft = await runCreateAgent({
      repoRoot,
      skillPaths: [skillPath],
      chatHistory: [
        { role: 'user', text: 'I need an agent that reviews contract scope.' },
      ],
      provider: 'openai',
      model: 'authoring-model',
    })
    assert.ok('personaMarkdown' in draft, JSON.stringify(draft))
    assert.doesNotMatch(frontmatterOf(draft.personaMarkdown), /^tier:/m)
    assert.doesNotMatch(draft.personaMarkdown, /^provider:/m)
    assert.doesNotMatch(draft.personaMarkdown, /^model:/m)
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})
