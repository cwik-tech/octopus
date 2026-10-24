/**
 * Covers how `readAgentDetail` reports a skill's description.
 *
 * The description in a `SKILL.md` is YAML, so it may be written as a folded
 * block scalar (`description: >`) — the form the Agent Skills specification
 * requires whenever the text contains a `: `. A line-based reader sees only
 * the `>` marker and falls back to the skill body's first paragraph, so the
 * authored description never reaches the Agent Library. These tests pin the
 * folded form to the authored text while preserving the body-paragraph
 * fallback for every shape that yields no usable description: a missing key,
 * a non-string value, an empty folded scalar, and no frontmatter at all.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { readAgentDetail } from '../../domains/agent-generator/index.js'

const AGENT_NAME = 'demo-agent'

function makeAgentRepo(skillName: string, skillSource: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skill-description-'))
  const agentDir = path.join(repoRoot, 'agents', AGENT_NAME)
  fs.mkdirSync(path.join(agentDir, 'skills', skillName), { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, `${AGENT_NAME}.md`),
    ['---', `name: ${AGENT_NAME}`, 'description: A demo agent.', '---', '', '# Demo Agent', ''].join('\n'),
  )
  fs.writeFileSync(path.join(agentDir, 'skills', skillName, 'SKILL.md'), skillSource)
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
  return repoRoot
}

function readSkillDescription(repoRoot: string, skillName: string): string | undefined {
  const detail = readAgentDetail(repoRoot, AGENT_NAME)
  const skill = detail.skillDetails.find((candidate) => candidate.name === skillName)
  assert.ok(skill, `expected skillDetails to include ${skillName}`)
  return skill.description
}

test('a folded SKILL.md description reaches the agent detail instead of the body paragraph', () => {
  const skillName = 'folded-description-skill'
  const repoRoot = makeAgentRepo(
    skillName,
    [
      '---',
      `name: ${skillName}`,
      'description: >',
      '  Price an asset against the cost to rebuild it. The ratio sets a ceiling on long-run',
      '  downside: below replacement cost, new supply cannot undercut you. Use when setting a',
      '  purchase price or judging downside protection.',
      '---',
      '',
      '# Folded Description Skill',
      '',
      'This opening body paragraph must not be used as the description.',
      '',
    ].join('\n'),
  )

  try {
    assert.equal(
      readSkillDescription(repoRoot, skillName),
      'Price an asset against the cost to rebuild it. The ratio sets a ceiling on long-run downside: below replacement cost, new supply cannot undercut you. Use when setting a purchase price or judging downside protection.',
    )
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('a single-line SKILL.md description still reaches the agent detail', () => {
  const skillName = 'plain-description-skill'
  const repoRoot = makeAgentRepo(
    skillName,
    [
      '---',
      `name: ${skillName}`,
      'description: Map the supply pipeline. Use when validating a market thesis.',
      '---',
      '',
      '# Plain Description Skill',
      '',
      'This opening body paragraph must not be used as the description.',
      '',
    ].join('\n'),
  )

  try {
    assert.equal(
      readSkillDescription(repoRoot, skillName),
      'Map the supply pipeline. Use when validating a market thesis.',
    )
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('a SKILL.md without a description falls back to the first body paragraph', () => {
  const skillName = 'no-description-skill'
  const repoRoot = makeAgentRepo(
    skillName,
    [
      '---',
      `name: ${skillName}`,
      '---',
      '',
      '# No Description Skill',
      '',
      'The first body paragraph stands in for the missing description.',
      '',
    ].join('\n'),
  )

  try {
    assert.equal(
      readSkillDescription(repoRoot, skillName),
      'The first body paragraph stands in for the missing description.',
    )
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('a non-string SKILL.md description falls back to the first body paragraph', () => {
  const skillName = 'mapping-description-skill'
  const repoRoot = makeAgentRepo(
    skillName,
    [
      '---',
      `name: ${skillName}`,
      'description:',
      '  what: maps a supply pipeline',
      '  when: validating a market thesis',
      '---',
      '',
      '# Mapping Description Skill',
      '',
      'The first body paragraph stands in when the description is not a string.',
      '',
    ].join('\n'),
  )

  try {
    assert.equal(
      readSkillDescription(repoRoot, skillName),
      'The first body paragraph stands in when the description is not a string.',
    )
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('an empty folded SKILL.md description falls back to the first body paragraph', () => {
  const skillName = 'empty-folded-skill'
  const repoRoot = makeAgentRepo(
    skillName,
    [
      '---',
      `name: ${skillName}`,
      'description: >',
      '---',
      '',
      '# Empty Folded Skill',
      '',
      'The first body paragraph stands in when the folded description is empty.',
      '',
    ].join('\n'),
  )

  try {
    assert.equal(
      readSkillDescription(repoRoot, skillName),
      'The first body paragraph stands in when the folded description is empty.',
    )
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('a SKILL.md with no frontmatter falls back to the first body paragraph', () => {
  const skillName = 'no-frontmatter-skill'
  const repoRoot = makeAgentRepo(
    skillName,
    ['# No Frontmatter Skill', '', 'The first body paragraph stands in when there is no frontmatter.', ''].join('\n'),
  )

  try {
    assert.equal(
      readSkillDescription(repoRoot, skillName),
      'The first body paragraph stands in when there is no frontmatter.',
    )
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})
