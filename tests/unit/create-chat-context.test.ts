import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  readAgentPackageSnapshot,
  renderAgentLibraryContextBlock,
  renderAgentPackageDetailBody,
} from '../../domains/agent-generator/agent-context.js'
import { buildAgentArchitectSystemPrompt } from '../../domains/agent-generator/agent-prompt.js'
import { listAgents } from '../../domains/agent-generator/list-agents.js'
import {
  readSelectedAgentPackageContext,
  renderAgentLibraryBlock,
  renderTeamLibraryBlock,
} from '../../domains/resource-architect/resource-architect-prompt.js'
import {
  SELECTED_AGENT,
  SELECTED_PACKAGE_MARKERS,
  selectedPackageBlock,
  writeSelectedAgentPackage,
} from '../support/selected-agent-package-fixture.js'

test('renderTeamLibraryBlock includes compact team roster context without raw yaml', () => {
  const block = renderTeamLibraryBlock([
    {
      id: 'strategy-board',
      name: 'strategy-board',
      description: 'Strategic review team',
      tags: ['strategy', 'review'],
      agentCount: 2,
      health: { status: 'ok', errors: [], warnings: [] },
      revision: "sha256:fixture",
      teamPath: 'teams/strategy-board',
      agents: [
        {
          name: 'contrarian',
          type: 'agent',
          role: 'Challenges assumptions',
          tier: 'strategic',
          tools: ['handoff'],
          agent_file: '../../agents/contrarian/contrarian.md',
          referenced: true,
        },
      ],
      yaml: [
        'team:',
        '  name: strategy-board',
        'agents:',
        '  - name: contrarian',
        '',
      ].join('\n'),
      warnings: [],
    },
  ])

  assert.match(block, /Existing runtime teams/)
  assert.match(block, /strategy-board/)
  assert.match(block, /roster:/)
  // No grade, even though this member's entry still declares one. The block is
  // what the architect reads before writing a proposal, and a grade there is
  // vocabulary it would copy into a plan that has nowhere to put it.
  assert.match(block, /contrarian \[agent\] - Challenges assumptions/)
  assert.doesNotMatch(block, /strategic/)
  assert.doesNotMatch(block, /team_yaml:/)
  assert.doesNotMatch(block, /team:\n\s+name: strategy-board/)
})

test('renderAgentLibraryContextBlock includes selected agent package file contents', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-'))
  try {
    const agentRoot = path.join(repoRoot, 'agents', 'researcher')
    fs.mkdirSync(path.join(agentRoot, 'skills', 'desk-research', 'templates'), { recursive: true })
    fs.mkdirSync(path.join(agentRoot, 'skills', 'desk-research', 'references'), { recursive: true })
    fs.mkdirSync(path.join(agentRoot, 'scripts'), { recursive: true })
    fs.mkdirSync(path.join(agentRoot, 'knowledge'), { recursive: true })
    fs.writeFileSync(
      path.join(agentRoot, 'researcher.md'),
      [
        '---',
        'name: researcher',
        'description: Finds evidence.',
        'tier: strategic',
        'provider: openai',
        'model: gpt-5.4',
        '---',
        '',
        '# Researcher',
        '',
      ].join('\n'),
    )
    fs.writeFileSync(
      path.join(agentRoot, 'skills', 'desk-research', 'SKILL.md'),
      [
        '---',
        'name: desk-research',
        'description: Finds credible references.',
        '---',
        '',
        '# Desk Research',
        '',
      ].join('\n'),
    )
    fs.writeFileSync(
      path.join(agentRoot, 'skills', 'desk-research', 'templates', 'brief.md'),
      '# Research Brief Template\n',
    )
    fs.writeFileSync(
      path.join(agentRoot, 'skills', 'desk-research', 'references', 'standards.md'),
      '# Evidence Standards\n',
    )
    fs.writeFileSync(path.join(agentRoot, 'scripts', 'collect.js'), 'export const ok = true\n')
    fs.writeFileSync(path.join(agentRoot, 'knowledge', 'notes.md'), '# Prior Notes\n')

    const block = renderAgentLibraryContextBlock({
      repoRoot,
      focusAgentName: 'researcher',
    })

    assert.match(block, /researcher.*selected agent/)
    assert.match(block, /persona:/)
    assert.match(block, /skills\/desk-research\/SKILL\.md/)
    assert.match(block, /# Desk Research/)
    assert.match(block, /templates\/brief\.md/)
    assert.match(block, /# Research Brief Template/)
    assert.match(block, /references\/standards\.md/)
    assert.match(block, /scripts\/collect\.js/)
    assert.match(block, /knowledge\/notes\.md/)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('the Agent generator and the Agent Architect read the same package facts under their own wrappers', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-shared-'))
  try {
    writeSelectedAgentPackage(repoRoot)
    const body = renderAgentPackageDetailBody(readAgentPackageSnapshot(repoRoot, SELECTED_AGENT))

    const generator = renderAgentLibraryContextBlock({ repoRoot, focusAgentName: SELECTED_AGENT })
    const architect = renderAgentLibraryBlock(
      listAgents(repoRoot),
      new Set(),
      readSelectedAgentPackageContext({
        repoRoot,
        agentName: SELECTED_AGENT,
        mcp: { status: 'available', servers: [] },
      }),
    )

    assert.ok(body.includes(SELECTED_PACKAGE_MARKERS.skill), 'the shared body carries package contents')
    assert.ok(generator.includes(body), 'the generator renders the shared body')
    const block = selectedPackageBlock(architect)
    assert.ok(block?.includes(body), 'the architect renders the same shared body')
    // The generator's own wrapper stays with the generator.
    assert.match(generator, /\*\*researcher\*\* \(selected agent\)/)
    assert.doesNotMatch(architect, /\(selected agent\)/)
    assert.doesNotMatch(block ?? '', /^ {4}model: openai\/gpt-5\.4$/m)
    assert.doesNotMatch(block ?? '', /^ {4}used_in: /m)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('an unreadable selected package gives the architect a context warning instead of the generator error line', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-missing-'))
  try {
    writeSelectedAgentPackage(repoRoot)
    const architect = renderAgentLibraryBlock(
      listAgents(repoRoot),
      new Set(),
      readSelectedAgentPackageContext({ repoRoot, agentName: 'departed-agent' }),
    )

    assert.match(architect, /departed-agent/)
    assert.match(architect, /agents\/departed-agent\/departed-agent\.md/)
    assert.doesNotMatch(architect, /^ {4}error: /m)
    assert.doesNotMatch(architect, /Persona file does not exist/)
    assert.equal(selectedPackageBlock(architect, 'departed-agent'), null)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('agent architect prompt tells the LLM to answer library questions from injected context', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-prompt-'))
  try {
    const prompt = buildAgentArchitectSystemPrompt(repoRoot)

    assert.match(prompt, /answer questions about the existing agent library/i)
    assert.match(prompt, /Do not\s+ask the user what agents already exist/i)
    assert.match(prompt, /whether more agents are needed/i)
    assert.match(prompt, /do not draft a new persona/i)
    assert.doesNotMatch(prompt, /What domain or job should the agent specialize/i)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})
