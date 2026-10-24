/**
 * Who inherits the application default effort, and who overrides it.
 *
 * The rule has two halves and both need holding. An Agent that names no level
 * follows the setting, on every load, so changing it in Settings changes what
 * those Agents do. An Agent that names one keeps it, including when it names
 * the provider's own default, because those are deliberate choices about that
 * Agent rather than an absence of one.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { loadAgent } from '../../parsers/load-agent.js'
import { loadArchitectConfig } from '../../domains/provider/architect-model-config.js'
import { loadResourceArchitectConfig } from '../../domains/resource-architect/resource-architect-prompt.js'
import { loadResourceArchitectReviewerConfig } from '../../domains/resource-architect/resource-architect-reviewer.js'
import {
  DEFAULT_EFFORT_ENV,
  setRuntimeDefaultEffort,
} from '../../domains/provider/default-effort-selection.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import type { AgentRosterEntry, TeamConfig } from '../../core/types.js'

const APP_DEFAULT = {
  status: 'available',
  provider: 'connection:abc',
  model: 'default-model',
} as const

function withDefaultEffort(level: string | undefined, run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'default-effort-'))
  const inherited = process.env[DEFAULT_EFFORT_ENV]
  // "Has chosen nothing" means nothing in the process and nothing in the
  // environment. Forgetting the in-process value alone re-reads the
  // environment, which is the behaviour a spawned runtime depends on.
  delete process.env[DEFAULT_EFFORT_ENV]
  setRuntimeDefaultEffort(undefined)
  if (level !== undefined) setRuntimeDefaultEffort(level as never)
  setRuntimeDefaultModelState(APP_DEFAULT)
  try {
    run(root)
  } finally {
    if (inherited === undefined) delete process.env[DEFAULT_EFFORT_ENV]
    else process.env[DEFAULT_EFFORT_ENV] = inherited
    setRuntimeDefaultEffort(undefined)
    setRuntimeDefaultModelState({ status: 'unset' })
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function writeAgent(root: string, name: string, frontmatter: string): string {
  const directory = path.join(root, 'agents', name)
  fs.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, `${name}.md`)
  fs.writeFileSync(file, `---\nname: ${name}\n${frontmatter}---\n\n# ${name}\n\nBody.\n`)
  return file
}

function teamConfig(): TeamConfig {
  return {
    team: { name: 'test-team', description: '', version: '0.1.0' },
    workspace: { path: '/tmp/workspace', watch: false },
    levels: [],
    gates: [],
    agents: [],
  }
}

function entry(agentFile: string): AgentRosterEntry {
  return {
    name: path.basename(agentFile, '.md'),
    type: 'agent',
    role: 'tester',
    agent_file: agentFile,
  }
}

function writeArchitect(root: string, teamName: string, frontmatter: string): void {
  const teamDirectory = path.join(root, 'teams', teamName)
  const agentDirectory = path.join(teamDirectory, 'agents', 'architect')
  fs.mkdirSync(agentDirectory, { recursive: true })
  fs.writeFileSync(
    path.join(teamDirectory, 'team.yaml'),
    ['team:', `  name: ${teamName}`, 'agents:', '  - name: architect', '    agent_file: agents/architect/architect.md', ''].join('\n'),
  )
  fs.writeFileSync(
    path.join(agentDirectory, 'architect.md'),
    `---\nname: architect\nprovider: openrouter\nmodel: vendor/model\n${frontmatter}---\n\n# Architect\n\nBody.\n`,
  )
}

test('an Agent that names no level follows the application default', () => {
  withDefaultEffort('xhigh', (root) => {
    const file = writeAgent(root, 'inheritor', '')
    const loaded = loadAgent(entry(file), teamConfig(), 0)
    assert.ok(loaded)
    assert.equal(loaded.thinking, 'xhigh')
  })
})

test('an Agent that names a level keeps it', () => {
  withDefaultEffort('xhigh', (root) => {
    const file = writeAgent(root, 'pinned', 'thinking: low\n')
    const loaded = loadAgent(entry(file), teamConfig(), 0)
    assert.ok(loaded)
    assert.equal(loaded.thinking, 'low')
  })
})

test('an Agent that asks for the provider default keeps that too', () => {
  // A deliberate choice, and not the same as the application default.
  withDefaultEffort('xhigh', (root) => {
    const file = writeAgent(root, 'vendor-led', 'thinking: provider-default\n')
    const loaded = loadAgent(entry(file), teamConfig(), 0)
    assert.ok(loaded)
    assert.equal(loaded.thinking, 'provider-default')
  })
})

test('an installation that has chosen nothing still loads at medium', () => {
  withDefaultEffort(undefined, (root) => {
    const file = writeAgent(root, 'inheritor', '')
    const loaded = loadAgent(entry(file), teamConfig(), 0)
    assert.ok(loaded)
    assert.equal(loaded.thinking, 'medium')
  })
})

test('a later change to the setting reaches an Agent already on disk', () => {
  // Read at load, never captured at import: an Agent written before the change
  // inherits the new answer on its next turn rather than after a restart.
  withDefaultEffort('low', (root) => {
    const file = writeAgent(root, 'inheritor', '')
    assert.equal(loadAgent(entry(file), teamConfig(), 0)?.thinking, 'low')
    setRuntimeDefaultEffort('max')
    assert.equal(loadAgent(entry(file), teamConfig(), 0)?.thinking, 'max')
  })
})

test('both Architects and the reviewer inherit it as well', () => {
  withDefaultEffort('high', (root) => {
    writeArchitect(root, 'workflow-architect', '')
    writeArchitect(root, 'resource-architect', '')
    assert.equal(loadArchitectConfig(root).thinking, 'high')
    assert.equal(loadResourceArchitectConfig(root).thinking, 'high')

    const reviewerId = 'reviewer-of-agent-architect'
    const reviewerDirectory = path.join(root, 'agents', reviewerId)
    fs.mkdirSync(reviewerDirectory, { recursive: true })
    fs.writeFileSync(
      path.join(reviewerDirectory, `${reviewerId}.md`),
      `---\nname: ${reviewerId}\nsystem: true\n---\n# Reviewer\n\nCheck it.\n`,
    )
    const reviewer = loadResourceArchitectReviewerConfig(root, APP_DEFAULT)
    assert.ok(reviewer.ok)
    assert.equal(reviewer.config.thinking, 'high')
  })
})
