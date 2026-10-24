/**
 * An authorized update edits `team.yaml` surgically.
 *
 * Everything the Team already declares — comments, field order, roster keys the
 * roster model does not model, custom stage configuration, gates — must survive
 * byte for byte. The only bytes an update may add are the new roster entries
 * and, where the Team declares them, the entry stage's participant or default
 * setup-chain sequence names.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { addTeamBuilderAgents } from '../../domains/agent-generator/team-manager.js'
import { computeTeamRevision } from '../../domains/resource-architect/resource-revision.js'

const TEAM_ID = 'contract-review-team'
const SEEDED = 'michigan-contract-lawyer'
const ADDED = 'scoping-lawyer'

function persona(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} description.\ntier: strategic\n---\n\n# ${name}\n`
}

function makeRepo(teamYaml: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-preserve-'))
  for (const name of [SEEDED, ADDED, 'second-added-lawyer']) {
    const agentDir = path.join(repoRoot, 'agents', name)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, `${name}.md`), persona(name))
  }
  const teamDir = path.join(repoRoot, 'teams', TEAM_ID)
  fs.mkdirSync(teamDir, { recursive: true })
  fs.writeFileSync(path.join(teamDir, 'team.yaml'), teamYaml)
  fs.writeFileSync(
    path.join(repoRoot, 'teams.yaml'),
    [
      `${TEAM_ID}:`,
      '  type: team',
      '  description: Reviews contracts.',
      `  team_path: ./teams/${TEAM_ID}`,
      '  tags: []',
      '',
    ].join('\n'),
  )
  return repoRoot
}

async function addAgents(
  teamYaml: string,
  names: readonly string[] = [ADDED],
): Promise<{ before: string; after: string; roster: string[] }> {
  const repoRoot = makeRepo(teamYaml)
  const teamYamlPath = path.join(repoRoot, 'teams', TEAM_ID, 'team.yaml')
  try {
    const before = fs.readFileSync(teamYamlPath, 'utf8')
    // The returned detail is parsed from the bytes that were written, so a
    // result that no longer parses cannot look like a successful edit.
    const detail = await addTeamBuilderAgents({
      repoRoot,
      teamId: TEAM_ID,
      expectedRevision: computeTeamRevision(repoRoot, TEAM_ID),
      agents: names.map((name) => ({ name, role: 'Scope reviewer' })),
    })
    return {
      before,
      after: fs.readFileSync(teamYamlPath, 'utf8'),
      roster: detail.agents.map((agent) => agent.name),
    }
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
}

/** Lines the update removed. An update may only add. */
function removedLines(before: string, after: string): string[] {
  const remaining = after.split('\n')
  const missing: string[] = []
  let cursor = 0
  for (const line of before.split('\n')) {
    const found = remaining.indexOf(line, cursor)
    if (found < 0) missing.push(line)
    else cursor = found + 1
  }
  return missing.filter((line) => line.trim() !== '')
}

const DISCUSSION_TEAM_YAML = [
  '# Contract review board. Do not renumber the levels.',
  'team:',
  `  name: "${TEAM_ID}"`,
  '  description: >',
  '    Reviews contracts.',
  'workflow:',
  '  entry_level: review',
  'agents:',
  `  - name: "${SEEDED}"`,
  '    type: agent',
  '    # The reviewer that owns the Michigan limitation analysis.',
  '    role: >',
  '      Michigan contract reviewer',
  '    tier: strategic',
  '    tools: []',
  '    escalation_contact: "legal-ops@example.com"',
  '    produces:',
  '      - path: "review-notes.md"',
  '        description: Reviewer findings.',
  `    agent_file: "../../agents/${SEEDED}/${SEEDED}.md"`,
  '    experience_enabled: true',
  'levels:',
  '  - id: review',
  '    name: Review',
  '    order: 0',
  '    stage:',
  '      type: discussion',
  `      coordinator: "${SEEDED}"`,
  '      participants:',
  `        - "${SEEDED}"`,
  '      config:',
  '        mode: brainstorm',
  '        max_rounds: 7',
  'gates:',
  '  - from: review',
  '    to: done',
  '    condition:',
  '      type: artifact_exists',
  '      artifact: "CUSTOM-ESCALATION-CONTRACT.md"',
  '',
].join('\n')

test('an update adds roster entries without rewriting any existing Team bytes', async () => {
  const { before, after } = await addAgents(DISCUSSION_TEAM_YAML)

  assert.deepEqual(
    removedLines(before, after),
    [],
    'every existing line must survive an update',
  )
  assert.ok(after.includes('# Contract review board. Do not renumber the levels.'))
  assert.ok(after.includes('    # The reviewer that owns the Michigan limitation analysis.'))
  assert.ok(
    after.includes('    escalation_contact: "legal-ops@example.com"'),
    'a roster key the roster model does not know must survive',
  )
  assert.ok(after.includes('      - path: "review-notes.md"'))
  assert.ok(after.includes('        max_rounds: 7'))
  assert.ok(after.includes('      artifact: "CUSTOM-ESCALATION-CONTRACT.md"'))
  assert.ok(after.includes(`- name: "${ADDED}"`), 'the addition is present')
})

test('an update extends only the entry discussion participants it already declares', async () => {
  const { after } = await addAgents(DISCUSSION_TEAM_YAML)

  assert.deepEqual(participantNames(after), [SEEDED, ADDED])
})

test('an update extends an inline entry discussion participant list', async () => {
  const inlineYaml = DISCUSSION_TEAM_YAML.replace(
    ['      participants:', `        - "${SEEDED}"`].join('\n'),
    `      participants: ["${SEEDED}"]`,
  )

  const { after } = await addAgents(inlineYaml)

  assert.deepEqual(inlineParticipantNames(after), [SEEDED, ADDED])
})

test('an update leaves a non-discussion entry stage participant list alone', async () => {
  const pipelineYaml = DISCUSSION_TEAM_YAML.replace(
    '      type: discussion',
    '      type: pipeline',
  )

  const { after } = await addAgents(pipelineYaml)

  assert.deepEqual(
    participantNames(after),
    [SEEDED],
    'only a discussion entry stage takes new participants',
  )
  assert.ok(after.includes(`- name: "${ADDED}"`), 'the roster still gains the Agent')
})

test('an update ignores a participants key that belongs to a later level', async () => {
  const nestedYaml = [
    'team:',
    `  name: "${TEAM_ID}"`,
    'workflow:',
    '  entry_level: review',
    'agents:',
    `  - name: "${SEEDED}"`,
    '    type: agent',
    '    role: >',
    '      Michigan contract reviewer',
    '    tier: strategic',
    '    tools: []',
    `    agent_file: "../../agents/${SEEDED}/${SEEDED}.md"`,
    'levels:',
    '  - id: review',
    '    name: Review',
    '    order: 0',
    '    stage:',
    '      type: chain',
    '      sequence:',
    `        - "${SEEDED}"`,
    '      config:',
    '        handoff_format: markdown',
    '  - id: debate',
    '    name: Debate',
    '    order: 1',
    '    stage:',
    '      type: discussion',
    `      coordinator: "${SEEDED}"`,
    '      participants:',
    `        - "${SEEDED}"`,
    '      config:',
    '        mode: brainstorm',
    '',
  ].join('\n')

  const { after } = await addAgents(nestedYaml)

  assert.deepEqual(
    participantNames(after),
    [SEEDED],
    'a discussion that is not the entry level must not be edited',
  )
})

test('an update extends the default setup chain without rewriting its custom config', async () => {
  const defaultChainYaml = [
    'team:',
    `  name: "${TEAM_ID}"`,
    'agents:',
    `  - name: "${SEEDED}"`,
    '    type: agent',
    '    role: >',
    '      Michigan contract reviewer',
    '    tier: strategic',
    '    tools: []',
    `    agent_file: "../../agents/${SEEDED}/${SEEDED}.md"`,
    'levels:',
    '  - id: setup',
    '    name: Setup',
    '    order: 0',
    '    stage:',
    '      type: chain',
    '      sequence:',
    `        - "${SEEDED}"`,
    '      config:',
    '        handoff_format: markdown',
    '        # Reviewers sign off before the chain completes.',
    '        user_review_note: "keep me"',
    '        output:',
    '          format: "final-result.md"',
    '          user_review: false',
    '',
  ].join('\n')

  const { before, after } = await addAgents(defaultChainYaml)

  assert.deepEqual(removedLines(before, after), [])
  assert.ok(after.includes('        # Reviewers sign off before the chain completes.'))
  assert.ok(after.includes('        user_review_note: "keep me"'))
  assert.deepEqual(sequenceNames(after), [SEEDED, ADDED])
})

test('two additions join the roster and the entry discussion in one write', async () => {
  const { before, after } = await addAgents(DISCUSSION_TEAM_YAML, [
    ADDED,
    'second-added-lawyer',
  ])

  assert.deepEqual(removedLines(before, after), [])
  assert.deepEqual(participantNames(after), [SEEDED, ADDED, 'second-added-lawyer'])
})

function participantNames(yaml: string): string[] {
  return blockListEntries(yaml, 'participants')
}

function sequenceNames(yaml: string): string[] {
  return blockListEntries(yaml, 'sequence')
}

function blockListEntries(yaml: string, key: string): string[] {
  const lines = yaml.split('\n')
  const keyIndex = lines.findIndex((line) =>
    new RegExp(`^\\s*${key}:\\s*$`).test(line),
  )
  if (keyIndex < 0) return []
  const keyLine = lines[keyIndex] ?? ''
  const keyIndent = (keyLine.match(/^\s*/) ?? [''])[0].length
  const names: string[] = []
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const entry = (lines[index] ?? '').match(/^(\s*)- (.*)$/)
    if (!entry || (entry[1] ?? '').length <= keyIndent) break
    names.push((entry[2] ?? '').trim().replace(/"/g, ''))
  }
  return names
}

function inlineParticipantNames(yaml: string): string[] {
  const inline = yaml.match(/^\s*participants:\s*\[(.*)\]\s*$/mu)
  if (!inline) return []
  return (inline[1] ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/"/g, ''))
    .filter(Boolean)
}

test('an update finds the entry level own stage, not a nested stage lookalike', async () => {
  const nestedStageYaml = [
    'team:',
    `  name: "${TEAM_ID}"`,
    'workflow:',
    '  entry_level: review',
    'agents:',
    `  - name: "${SEEDED}"`,
    '    type: agent',
    '    role: >',
    '      Michigan contract reviewer',
    '    tier: strategic',
    '    tools: []',
    `    agent_file: "../../agents/${SEEDED}/${SEEDED}.md"`,
    'levels:',
    '  - id: review',
    '    name: Review',
    '    order: 0',
    '    metadata:',
    '      stage:',
    '        type: discussion',
    '        participants:',
    '          - "documentation-only-name"',
    '    stage:',
    '      type: discussion',
    `      coordinator: "${SEEDED}"`,
    '      participants:',
    `        - "${SEEDED}"`,
    '      config:',
    '        mode: brainstorm',
    '',
  ].join('\n')

  const { after } = await addAgents(nestedStageYaml)

  assert.deepEqual(
    blockListEntries(after, 'participants'),
    ['documentation-only-name'],
    'the documentation block above the real stage must be untouched',
  )
  const lines = after.split('\n')
  const realStageIndex = lines.findIndex((line) => line === '    stage:')
  assert.notEqual(realStageIndex, -1, 'the entry level own stage is still there')
  assert.deepEqual(
    blockListEntries(lines.slice(realStageIndex).join('\n'), 'participants'),
    [SEEDED, ADDED],
    'the entry level own stage takes the addition',
  )
})

test('an inline participant list keeps its trailing comment when a member is added', async () => {
  const commentedInlineYaml = DISCUSSION_TEAM_YAML.replace(
    ['      participants:', `        - "${SEEDED}"`].join('\n'),
    `      participants: ["${SEEDED}"] # ownership note`,
  )

  const { after } = await addAgents(commentedInlineYaml)

  const line = after
    .split('\n')
    .find((candidate) => candidate.includes('participants:')) ?? ''
  assert.match(line, /# ownership note\s*$/, 'the trailing comment survives')
  assert.deepEqual(inlineListNames(line), [SEEDED, ADDED])
})

test('a block participant list gains members after the existing names, not before them', async () => {
  const commentedBlockYaml = DISCUSSION_TEAM_YAML.replace(
    ['      participants:', `        - "${SEEDED}"`].join('\n'),
    [
      '      participants:',
      '        # The coordinator always speaks first.',
      `        - "${SEEDED}"`,
      '',
      '        # Escalation contacts follow.',
    ].join('\n'),
  )

  const { before, after } = await addAgents(commentedBlockYaml)

  assert.deepEqual(removedLines(before, after), [])
  assert.deepEqual(
    blockListEntriesWithComments(after),
    [
      '# The coordinator always speaks first.',
      SEEDED,
      ADDED,
      '# Escalation contacts follow.',
    ],
    'the addition follows the existing names and no comment moves ahead of one',
  )
})

test('an empty inline roster with a trailing comment becomes a block and keeps the comment', async () => {
  const emptyRosterYaml = [
    'team:',
    `  name: "${TEAM_ID}"`,
    'agents: [] # no reviewers yet',
    'levels: []',
    '',
  ].join('\n')

  const { after, roster } = await addAgents(emptyRosterYaml)

  assert.deepEqual(
    roster,
    [ADDED],
    'the written Team still parses and carries the addition',
  )
  assert.ok(
    after.includes('# no reviewers yet'),
    'the comment on the empty roster line survives',
  )
})

test('an inline setup-chain sequence keeps its trailing comment when a member is added', async () => {
  const inlineSequenceYaml = [
    'team:',
    `  name: "${TEAM_ID}"`,
    'agents:',
    `  - name: "${SEEDED}"`,
    '    type: agent',
    '    role: >',
    '      Michigan contract reviewer',
    '    tier: strategic',
    '    tools: []',
    `    agent_file: "../../agents/${SEEDED}/${SEEDED}.md"`,
    'levels:',
    '  - id: setup',
    '    name: Setup',
    '    order: 0',
    '    stage:',
    '      type: chain',
    `      sequence: ["${SEEDED}"] # ordering is deliberate`,
    '      config:',
    '        handoff_format: markdown',
    '',
  ].join('\n')

  const { after } = await addAgents(inlineSequenceYaml)

  const line = after.split('\n').find((candidate) => candidate.includes('sequence:')) ?? ''
  assert.match(line, /# ordering is deliberate\s*$/, 'the trailing comment survives')
  assert.deepEqual(inlineListNames(line), [SEEDED, ADDED])
})

/** Entries of an inline flow sequence on one line, ignoring any comment. */
function inlineListNames(line: string): string[] {
  const inline = line.match(/\[(.*?)\]/u)
  if (!inline) return []
  return (inline[1] ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/"/g, ''))
    .filter(Boolean)
}

/** Participant-block lines, as names and comments in file order. */
function blockListEntriesWithComments(yaml: string): string[] {
  const lines = yaml.split('\n')
  const keyIndex = lines.findIndex((line) => /^\s*participants:\s*$/.test(line))
  if (keyIndex < 0) return []
  const keyLine = lines[keyIndex] ?? ''
  const keyIndent = (keyLine.match(/^\s*/) ?? [''])[0].length
  const entries: string[] = []
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '') continue
    const indent = (line.match(/^\s*/) ?? [''])[0].length
    if (indent <= keyIndent) break
    const comment = line.trim()
    if (comment.startsWith('#')) {
      entries.push(comment)
      continue
    }
    const entry = line.match(/^\s*- (.*)$/)
    if (!entry) break
    entries.push((entry[1] ?? '').trim().replace(/"/g, ''))
  }
  return entries
}
