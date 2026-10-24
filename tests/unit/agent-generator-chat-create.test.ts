import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  commitAgent,
  deleteAgent,
  nextAvailableAgentName,
  previewAgentDelete,
  runCreateAgent,
  runRefineAgent,
} from '../../domains/agent-generator/index.js'

function makeAgentArchitectRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-generator-'))
  fs.mkdirSync(path.join(repoRoot, 'teams', 'workflow-architect'), { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'agents', 'workflow-architect'), { recursive: true })
  fs.writeFileSync(
    path.join(repoRoot, 'teams', 'workflow-architect', 'team.yaml'),
    [
      'agents:',
      '  - name: workflow-architect',
      '    role: Architect',
      '    agent_file: ../../agents/workflow-architect/workflow-architect.md',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(repoRoot, 'agents', 'workflow-architect', 'workflow-architect.md'),
    // The architect runs with its own agent file's pair.
    "---\nmodel: test-model\nprovider: openai\n---\n\n" + ('Return an agent draft as JSON.'),
  )
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
  return repoRoot
}

test('runCreateAgent creates a concrete generated-skill draft from a short value proposition brief when offline', async () => {
  const repoRoot = makeAgentArchitectRepo()
  const previousOpenAiKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY

  try {
    const result = await runCreateAgent({
      repoRoot,
      skillPaths: [],
      chatHistory: [
        {
          role: 'user',
          text: 'Create an expert in value proposition validation.',
        },
      ],
    })

    assert.equal('duplicate' in result, false)
    if ('duplicate' in result) return
    assert.equal('needsInput' in result, false)
    if ('needsInput' in result) return
    assert.equal(result.meta.fallback, true)
    assert.equal(result.suggestedName, 'value-proposition-strategist')
    assert.equal(result.generatedSkills?.length, 1)
    assert.equal(result.generatedSkills?.[0]?.name, 'value-proposition-design')
    assert.match(result.generatedSkills?.[0]?.body ?? '', /Current pain or alternative/)
    assert.match(result.personaMarkdown, /Value Proposition Strategist/)
    assert.match(result.personaMarkdown, /Customer segment/)
    assert.doesNotMatch(result.personaMarkdown, /Replace this paragraph/i)
    assert.doesNotMatch(result.personaMarkdown, /no skills selected/i)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
    if (previousOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiKey
    }
  }
})

test('runCreateAgent does not intercept underspecified chat briefs with canned questions', async () => {
  const repoRoot = makeAgentArchitectRepo()
  const previousOpenAiKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY

  try {
    const result = await runCreateAgent({
      repoRoot,
      skillPaths: [],
      chatHistory: [{ role: 'user', text: 'Create an agent.' }],
    })

    assert.equal('needsInput' in result, false)
    if ('needsInput' in result || 'duplicate' in result) return
    assert.equal(result.meta.fallback, true)
    assert.equal(result.suggestedName, 'general-purpose-specialist')
    assert.match(result.personaMarkdown, /General Purpose Specialist/)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
    if (previousOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiKey
    }
  }
})

test('runCreateAgent creates a customer discovery draft with a generated skill when offline', async () => {
  const repoRoot = makeAgentArchitectRepo()
  const previousOpenAiKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY

  try {
    const result = await runCreateAgent({
      repoRoot,
      skillPaths: [],
      chatHistory: [
        {
          role: 'user',
          text: 'Create an agent that specializes in customer discovery.',
        },
      ],
    })

    assert.equal('duplicate' in result, false)
    if ('duplicate' in result) return
    assert.equal('needsInput' in result, false)
    if ('needsInput' in result) return
    assert.equal(result.suggestedName, 'customer-discovery-specialist')
    assert.equal(result.generatedSkills?.[0]?.name, 'customer-discovery-research')
    assert.match(result.personaMarkdown, /Customer Discovery Specialist/)
    assert.match(result.personaMarkdown, /Interview plan/)
    assert.match(result.generatedSkills?.[0]?.body ?? '', /non-leading/)
    assert.doesNotMatch(result.personaMarkdown, /Placeholder persona/i)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
    if (previousOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiKey
    }
  }
})

test('runRefineAgent preserves the persona when the architect is offline', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-refine-'))
  const currentPersona = '# Existing Agent\n\nKeep this persona unchanged.\n'

  try {
    const result = await runRefineAgent({
      repoRoot,
      agentName: 'existing-agent',
      currentPersona,
      chatHistory: [{ role: 'user', text: 'Make the persona more concise.' }],
    })

    assert.equal(result.personaMarkdown, currentPersona)
    assert.equal(result.meta.fallback, true)
    assert.equal(result.meta.model, 'fallback')
    assert.match(result.meta.reason ?? '', /workflow-architect team.yaml not found/)
    assert.match(result.message, /Refinement not applied/)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('commitAgent writes generated skills when no source skills are selected', async () => {
  const repoRoot = makeAgentArchitectRepo()

  try {
    const result = await commitAgent({
      repoRoot,
      approvedName: 'value-proposition-validator',
      personaMarkdown: [
        '---',
        'name: value-proposition-validator',
        'description: Validates business value propositions and assumptions.',
        'tier: specialist',
        'provider: openai',
        'model: gpt-5.4',
        'thinking: medium',
        'tools: none',
        '---',
        '',
        '# Value Proposition Validator',
      ].join('\n'),
      skillPaths: [],
      generatedSkills: [
        {
          name: 'value-proposition-validation',
          body: [
            '---',
            'name: value-proposition-validation',
            'description: Tests value proposition and assumption quality. Use when a business case needs its assumptions challenged.',
            '---',
            '',
            '# Value Proposition Validation',
          ].join('\n'),
        },
      ],
    })

    assert.deepEqual(result.importedSkills, [])
    assert.deepEqual(result.generatedSkills, ['value-proposition-validation'])
    assert.ok(
      fs.existsSync(
        path.join(
          repoRoot,
          'agents',
          'value-proposition-validator',
          'skills',
          'value-proposition-validation',
          'SKILL.md',
        ),
      ),
    )
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('nextAvailableAgentName advances colliding agent names', () => {
  const repoRoot = makeAgentArchitectRepo()

  try {
    fs.mkdirSync(path.join(repoRoot, 'agents', 'value-proposition-expert'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(repoRoot, 'agents', 'value-proposition-expert-2'), {
      recursive: true,
    })

    assert.equal(
      nextAvailableAgentName(repoRoot, 'value-proposition-expert'),
      'value-proposition-expert-3',
    )
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('previewAgentDelete lists skills used by other agents', () => {
  const repoRoot = makeAgentArchitectRepo()

  try {
    writeAgentWithSkills(repoRoot, 'alpha', ['shared-skill', 'alpha-only'])
    writeAgentWithSkills(repoRoot, 'beta', ['shared-skill'])
    writeAgentWithSkills(repoRoot, 'gamma', ['shared-skill'])

    const preview = previewAgentDelete(repoRoot, 'alpha')
    const shared = preview.skills.find((skill) => skill.name === 'shared-skill')
    const alphaOnly = preview.skills.find((skill) => skill.name === 'alpha-only')

    assert.equal(preview.agentName, 'alpha')
    assert.equal(shared?.usedByCount, 2)
    assert.deepEqual(shared?.usedByAgents, ['beta', 'gamma'])
    assert.equal(alphaOnly?.usedByCount, 0)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('deleteAgent preserves skills in the shared library when requested', async () => {
  const repoRoot = makeAgentArchitectRepo()

  try {
    writeAgentWithSkills(repoRoot, 'alpha', ['alpha-only'])

    const result = await deleteAgent({
      repoRoot,
      agentName: 'alpha',
      deleteSkills: false,
    })

    assert.equal(result.deleted, true)
    assert.deepEqual(result.preservedSkills, ['alpha-only'])
    assert.deepEqual(result.preservedSkillPaths, ['skills/alpha-only'])
    assert.equal(fs.existsSync(path.join(repoRoot, 'agents', 'alpha')), false)
    assert.equal(
      fs.existsSync(path.join(repoRoot, 'skills', 'alpha-only', 'SKILL.md')),
      true,
    )
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('deleteAgent removes agent skills when requested', async () => {
  const repoRoot = makeAgentArchitectRepo()

  try {
    writeAgentWithSkills(repoRoot, 'alpha', ['alpha-only'])

    const result = await deleteAgent({
      repoRoot,
      agentName: 'alpha',
      deleteSkills: true,
    })

    assert.equal(result.deleted, true)
    assert.deepEqual(result.deletedSkills, ['alpha-only'])
    assert.equal(fs.existsSync(path.join(repoRoot, 'agents', 'alpha')), false)
    assert.equal(
      fs.existsSync(path.join(repoRoot, 'skills', 'alpha-only', 'SKILL.md')),
      false,
    )
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('deleteAgent preserves colliding skill variants byte for byte', async () => {
  const repoRoot = makeAgentArchitectRepo()

  try {
    writeAgentWithSkills(repoRoot, 'alpha', ['alpha-only'])
    const agentSkillDir = path.join(repoRoot, 'agents', 'alpha', 'skills', 'alpha-only')
    fs.writeFileSync(path.join(agentSkillDir, 'SKILL.md'), '# Agent instructions\n')
    fs.mkdirSync(path.join(agentSkillDir, 'references'))
    fs.writeFileSync(path.join(agentSkillDir, 'references', 'source.md'), '# Agent source\n')
    const sharedSkillDir = path.join(repoRoot, 'skills', 'alpha-only')
    fs.mkdirSync(path.join(sharedSkillDir, 'references'), { recursive: true })
    fs.writeFileSync(path.join(sharedSkillDir, 'SKILL.md'), '# Shared instructions\n')
    fs.writeFileSync(path.join(sharedSkillDir, 'references', 'source.md'), '# Shared source\n')

    const result = await deleteAgent({
      repoRoot,
      agentName: 'alpha',
      deleteSkills: false,
    })

    assert.equal(fs.readFileSync(path.join(sharedSkillDir, 'SKILL.md'), 'utf8'), '# Shared instructions\n')
    assert.equal(result.preservedSkillPaths.length, 1)
    const preservedPath = result.preservedSkillPaths[0]
    assert.ok(preservedPath)
    assert.match(preservedPath, /^skills\/alpha-only-[a-f0-9]+\/alpha-only$/)
    const preservedDir = path.join(repoRoot, preservedPath)
    assert.equal(fs.readFileSync(path.join(preservedDir, 'SKILL.md'), 'utf8'), '# Agent instructions\n')
    assert.equal(
      fs.readFileSync(path.join(preservedDir, 'references', 'source.md'), 'utf8'),
      '# Agent source\n',
    )
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

function writeAgentWithSkills(
  repoRoot: string,
  agentName: string,
  skillNames: string[],
): void {
  const agentDir = path.join(repoRoot, 'agents', agentName)
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, `${agentName}.md`), `# ${agentName}\n`)
  for (const skillName of skillNames) {
    const skillDir = path.join(agentDir, 'skills', skillName)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${skillName}\n`)
  }
}
