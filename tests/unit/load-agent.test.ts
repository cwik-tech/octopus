import { whenDefined } from '../../core/optional-properties.js'
/**
 * Tests for parsers/load-agent.ts — template variable injection and agent loading.
 *
 * Covers GAP-2: {{PRODUCES_ARTIFACTS}} and {{CONSUMES_ARTIFACTS}} injection.
 */

import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import { loadAgent, parseAgentFrontmatter } from '../../parsers/load-agent.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { validateLoadedAgentProviders } from '../../domains/provider/provider-preflight.js'
import {
  APPROVED_MODEL_CHOICE_ENV,
  setRuntimeApprovedModelChoice,
} from '../../domains/provider/approved-model-choice.js'
import type { ApprovedModelChoiceAuthorization } from '../../contracts/model-choice.js'
import type { AppDefaultModelState } from '../../contracts/agent-model-selection.js'
import type { AgentRosterEntry, TeamConfig } from '../../core/types.js'

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-agent-test-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function makeMinimalTeamConfig(): TeamConfig {
  return {
    team: { name: 'test-team', description: '', version: '0.1.0' },
    workspace: { path: '/tmp/workspace', watch: false,   },
    
    levels: [],
    gates: [],
    agents: [],
  }
}

function makeAgentFile(dir: string, name: string, content: string): string {
  const agentDir = path.join(dir, 'agents', name)
  fs.mkdirSync(agentDir, { recursive: true })
  const filePath = path.join(agentDir, `${name}.md`)
  fs.writeFileSync(filePath, content)
  return filePath
}

for (const provider of ['claude', 'codex', 'lm-studio']) {
  test(`a ${provider} agent receives list and website formatting guidance outside chat too`, () => {
    withTempDir((dir) => {
      const agentFile = makeAgentFile(dir, 'writer', `---\nname: writer\nprovider: ${provider}\nmodel: fixture\n---\nWrite the requested answer.`)
      const agent = loadAgent({ name: 'writer', type: 'agent', role: 'worker', agent_file: agentFile }, makeMinimalTeamConfig(), 0)
      assert.ok(agent)
      assert.match(agent.systemPrompt, /Use bullet points for lists/)
      assert.match(agent.systemPrompt, /clickable Markdown link for each website/)
      assert.match(agent.systemPrompt, /explicitly requested format/)
    })
  })
}

// ─── parseAgentFrontmatter tests ────────────────────────────────────────────

function withApprovedRetry(
  authorization: ApprovedModelChoiceAuthorization | undefined,
  fn: () => void,
): void {
  setRuntimeApprovedModelChoice(authorization)
  try {
    fn()
  } finally {
    setRuntimeApprovedModelChoice(undefined)
    delete process.env[APPROVED_MODEL_CHOICE_ENV]
  }
}

const RETRY_AUTHORIZATION: ApprovedModelChoiceAuthorization = {
  offerId: 'offer-1',
  agentName: 'alpha',
  failedChoice: { provider: 'anthropic', model: 'claude-opus-4-6' },
  proposedDefault: { provider: 'connection:abc', model: 'gpt-5.4-mini' },
}

test('parseAgentFrontmatter parses frontmatter and body', () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, 'test.md')
    fs.writeFileSync(filePath, `---
name: alpha
tier: strategic
model: claude-sonnet-4-6
---
# Agent Prompt

You are an agent.`)

    const { frontmatter, body } = parseAgentFrontmatter(filePath)
    assert.equal(frontmatter.name, 'alpha')
    assert.equal(frontmatter.tier, 'strategic')
    assert.equal(frontmatter.model, 'claude-sonnet-4-6')
    assert.ok(body.includes('# Agent Prompt'))
    assert.ok(body.includes('You are an agent.'))
  })
})

test('parseAgentFrontmatter preserves tools as raw frontmatter text', () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, 'test.md')
    fs.writeFileSync(filePath, `---
name: alpha
tools: handoff, submit_for_review
---
Body`)

    const { frontmatter } = parseAgentFrontmatter(filePath)
    assert.equal(frontmatter.tools, 'handoff, submit_for_review')
  })
})

test('parseAgentFrontmatter accepts CRLF input without a trailing newline', () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, 'test.md')
    fs.writeFileSync(filePath, '---\r\nname: alpha\r\ntier: strategic\r\n---\r\nBody without trailing newline')

    const { frontmatter, body } = parseAgentFrontmatter(filePath)
    assert.equal(frontmatter.name, 'alpha')
    assert.equal(frontmatter.tier, 'strategic')
    assert.equal(body, 'Body without trailing newline')
  })
})

test('parseAgentFrontmatter returns body as-is when no frontmatter', () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, 'test.md')
    fs.writeFileSync(filePath, '# Just a body\n\nNo frontmatter here.')

    const { frontmatter, body } = parseAgentFrontmatter(filePath)
    assert.deepEqual(frontmatter, {})
    assert.ok(body.includes('# Just a body'))
  })
})

// ─── Template injection: {{PRODUCES_ARTIFACTS}} / {{CONSUMES_ARTIFACTS}} ────

test('loadAgent injects comma-separated produces paths into {{PRODUCES_ARTIFACTS}}', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\ntier: strategic\n---\nYou produce: {{PRODUCES_ARTIFACTS}}')

    const entry: AgentRosterEntry = {
      name: 'alpha',
      type: 'agent',
      role: 'worker',
      tier: 'strategic',
      agent_file: agentFile,
      produces: [{ path: 'a.md' }, { path: 'b.md' }],
    }

    const loaded = loadAgent(entry, makeMinimalTeamConfig(), 0)
    assert.ok(loaded, 'Expected agent to load')
    assert.ok(loaded.systemPrompt.includes('a.md, b.md'),
      `Expected 'a.md, b.md' in prompt, got: ${loaded.systemPrompt}`)
    assert.ok(!loaded.systemPrompt.includes('{{PRODUCES_ARTIFACTS}}'),
      'Template variable should be fully replaced')
  })
})

test('loadAgent injects comma-separated consumes paths into {{CONSUMES_ARTIFACTS}}', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\ntier: strategic\n---\nYou read: {{CONSUMES_ARTIFACTS}}')

    const entry: AgentRosterEntry = {
      name: 'alpha',
      type: 'agent',
      role: 'worker',
      tier: 'strategic',
      agent_file: agentFile,
      consumes: [{ path: 'research/brief.md' }, { path: 'data/report.md' }],
    }

    const loaded = loadAgent(entry, makeMinimalTeamConfig(), 0)
    assert.ok(loaded, 'Expected agent to load')
    assert.ok(loaded.systemPrompt.includes('research/brief.md, data/report.md'),
      `Expected consumes paths in prompt, got: ${loaded.systemPrompt}`)
    assert.ok(!loaded.systemPrompt.includes('{{CONSUMES_ARTIFACTS}}'),
      'Template variable should be fully replaced')
  })
})

test('loadAgent injects empty string (not "undefined") when produces is undefined', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\ntier: strategic\n---\nYou produce: [{{PRODUCES_ARTIFACTS}}]')

    const entry: AgentRosterEntry = {
      name: 'alpha',
      type: 'agent',
      role: 'worker',
      tier: 'strategic',
      agent_file: agentFile,
      // No produces field
    }

    const loaded = loadAgent(entry, makeMinimalTeamConfig(), 0)
    assert.ok(loaded, 'Expected agent to load')
    assert.ok(loaded.systemPrompt.includes('You produce: []'),
      `Expected empty replacement, got: ${loaded.systemPrompt}`)
    assert.ok(!loaded.systemPrompt.includes('undefined'),
      'Should not contain the literal string "undefined"')
  })
})

test('loadAgent injects empty string (not "undefined") when consumes is undefined', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\ntier: strategic\n---\nYou read: [{{CONSUMES_ARTIFACTS}}]')

    const entry: AgentRosterEntry = {
      name: 'alpha',
      type: 'agent',
      role: 'worker',
      tier: 'strategic',
      agent_file: agentFile,
      // No consumes field
    }

    const loaded = loadAgent(entry, makeMinimalTeamConfig(), 0)
    assert.ok(loaded, 'Expected agent to load')
    assert.ok(loaded.systemPrompt.includes('You read: []'),
      `Expected empty replacement, got: ${loaded.systemPrompt}`)
    assert.ok(!loaded.systemPrompt.includes('undefined'),
      'Should not contain the literal string "undefined"')
  })
})

test('loadAgent handles single produces path without trailing comma', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\ntier: strategic\n---\nOutput: {{PRODUCES_ARTIFACTS}}')

    const entry: AgentRosterEntry = {
      name: 'alpha',
      type: 'agent',
      role: 'worker',
      tier: 'strategic',
      agent_file: agentFile,
      produces: [{ path: 'output.md' }],
    }

    const loaded = loadAgent(entry, makeMinimalTeamConfig(), 0)
    assert.ok(loaded, 'Expected agent to load')
    assert.match(loaded.systemPrompt, /^Output: output\.md$/m,
      'The produced path must have no trailing comma')
  })
})

test('loadAgent preserves the persona body when template variables are absent', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\ntier: strategic\n---\nNo template vars here.')

    const entry: AgentRosterEntry = {
      name: 'alpha',
      type: 'agent',
      role: 'worker',
      tier: 'strategic',
      agent_file: agentFile,
      produces: [{ path: 'a.md' }],
    }

    const loaded = loadAgent(entry, makeMinimalTeamConfig(), 0)
    assert.ok(loaded, 'Expected agent to load')
    assert.ok(loaded.systemPrompt.includes('No template vars here.'),
      'Prompt body should be preserved')
    assert.ok(!loaded.systemPrompt.includes('a.md'),
      'Produces paths should not appear when template var is absent')
  })
})

test('loadAgent parses tools from frontmatter when roster entry omits tools', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\ntier: strategic\ntools: handoff, submit_for_review\n---\nPrompt')

    const entry: AgentRosterEntry = {
      name: 'alpha',
      type: 'agent',
      role: 'worker',
      tier: 'strategic',
      agent_file: agentFile,
    }

    const loaded = loadAgent(entry, makeMinimalTeamConfig(), 0)
    assert.ok(loaded, 'Expected agent to load')
    assert.deepEqual(loaded.tools, ['handoff', 'submit_for_review'])
  })
})

test('loadAgent gives roster tools precedence over frontmatter tools', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\ntier: strategic\ntools: read, write\n---\nPrompt')

    const entry: AgentRosterEntry = {
      name: 'alpha',
      type: 'agent',
      role: 'worker',
      tier: 'strategic',
      agent_file: agentFile,
      tools: ['spawn_team'],
    }

    const loaded = loadAgent(entry, makeMinimalTeamConfig(), 0)
    assert.ok(loaded, 'Expected agent to load')
    assert.deepEqual(loaded.tools, ['spawn_team'])
  })
})

test('loadAgent returns undefined for missing agent file', () => {
  const entry: AgentRosterEntry = {
    name: 'alpha',
    type: 'agent',
    role: 'worker',
    tier: 'strategic',
    agent_file: '/nonexistent/path/alpha.md',
  }

  const loaded = loadAgent(entry, makeMinimalTeamConfig(), 0)
  assert.equal(loaded, undefined, 'Expected undefined for missing agent file')
})

test('loadAgent returns placeholder for team-type agent', () => {
  const entry: AgentRosterEntry = {
    name: 'sub-team',
    type: 'team',
    role: 'subteam',
    tier: 'strategic',
    agent_file: '',
    team_path: '/some/team',
  }

  const loaded = loadAgent(entry, makeMinimalTeamConfig(), 42)
  assert.ok(loaded, 'Expected team placeholder')
  assert.equal(loaded.name, 'sub-team')
  assert.equal(loaded.systemPrompt, '')
  assert.equal(loaded.agentDir, '/some/team')
  assert.equal(loaded.color, 42)
  assert.equal(loaded.experienceEnabled, true)
})

test('loadAgent defaults experienceEnabled to true when omitted', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\ntier: strategic\n---\nYou are alpha.')

    const experienceDir = path.join(dir, 'agents', 'alpha', 'experience')
    fs.mkdirSync(experienceDir, { recursive: true })
    fs.writeFileSync(path.join(experienceDir, 'scratch-pad.md'), 'Past lessons')

    const entry: AgentRosterEntry = {
      name: 'alpha',
      type: 'agent',
      role: 'worker',
      tier: 'strategic',
      agent_file: agentFile,
    }

    const loaded = loadAgent(entry, makeMinimalTeamConfig(), 0)
    assert.ok(loaded)
    assert.equal(loaded.experienceEnabled, true)
    assert.match(loaded.experienceContent, /Past lessons/)
  })
})

test('loadAgent skips experience content when experience_enabled is false', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\ntier: strategic\n---\nExperience: [{{EXPERIENCE_BLOCK}}]')

    const experienceDir = path.join(dir, 'agents', 'alpha', 'experience')
    fs.mkdirSync(experienceDir, { recursive: true })
    fs.writeFileSync(path.join(experienceDir, 'scratch-pad.md'), 'Past lessons')

    const entry: AgentRosterEntry = {
      name: 'alpha',
      type: 'agent',
      role: 'worker',
      tier: 'strategic',
      agent_file: agentFile,
      experience_enabled: false,
    }

    const loaded = loadAgent(entry, makeMinimalTeamConfig(), 0)
    assert.ok(loaded)
    assert.equal(loaded.experienceEnabled, false)
    assert.equal(loaded.experienceContent, '')
    assert.match(loaded.systemPrompt, /No experience accumulated yet/)
  })
})

test('loadAgent discovers skill metadata without injecting full skill instructions', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(
      dir,
      'alpha',
      '---\nname: alpha\ntier: strategic\n---\nSkills:\n{{SKILLS_BLOCK}}',
    )
    const agentDir = path.dirname(agentFile)
    const conciseSkillDir = path.join(agentDir, 'skills', 'concise-writing')
    const researchSkillDir = path.join(agentDir, 'skills', 'source-research')
    fs.mkdirSync(conciseSkillDir, { recursive: true })
    fs.mkdirSync(researchSkillDir, { recursive: true })
    fs.writeFileSync(
      path.join(conciseSkillDir, 'SKILL.md'),
      `---
name: concise-writing
description: >
  Produce short, decision-ready prose without losing material evidence.
version: 1.2.0
---

# Concise Writing

FULL-CONCISE-INSTRUCTIONS-MUST-NOT-BE-EAGERLY-INJECTED
`,
    )
    fs.writeFileSync(
      path.join(researchSkillDir, 'SKILL.md'),
      `---
name: source-research
description: Verify external claims against primary sources.
---

# Source Research

FULL-RESEARCH-INSTRUCTIONS-MUST-NOT-BE-EAGERLY-INJECTED
`,
    )
    const entry: AgentRosterEntry = {
      name: 'alpha',
      type: 'agent',
      role: 'worker',
      tier: 'strategic',
      agent_file: agentFile,
    }

    const loaded = loadAgent(entry, makeMinimalTeamConfig(), 0)

    assert.ok(loaded, 'Expected agent to load')
    assert.match(loaded.skillsContent, /concise-writing/)
    assert.match(
      loaded.skillsContent,
      /Produce short, decision-ready prose without losing material evidence\./,
    )
    assert.match(loaded.skillsContent, /version: 1\.2\.0/)
    assert.match(loaded.skillsContent, /source-research/)
    assert.match(loaded.skillsContent, /sha256: [a-f0-9]{64}/)
    assert.match(
      loaded.skillsContent,
      /mcp__pipeline_skills__load_skill/,
    )
    assert.doesNotMatch(
      loaded.systemPrompt,
      /FULL-CONCISE-INSTRUCTIONS-MUST-NOT-BE-EAGERLY-INJECTED/,
    )
    assert.doesNotMatch(
      loaded.systemPrompt,
      /FULL-RESEARCH-INSTRUCTIONS-MUST-NOT-BE-EAGERLY-INJECTED/,
    )
  })
})

// ─── Model selection: the agent's own choice, or the one app default ────────

function makeUnresolvedTeamConfig(): TeamConfig {
  return {
    team: { name: 'test-team', description: '', version: '0.1.0' },
    workspace: { path: '/tmp/workspace', watch: false },
    levels: [],
    gates: [],
    agents: [],
  }
}

function withAppDefault(state: AppDefaultModelState, fn: () => void): void {
  setRuntimeDefaultModelState(state)
  try {
    fn()
  } finally {
    setRuntimeDefaultModelState({ status: 'unset' })
  }
}

const APP_DEFAULT: AppDefaultModelState = {
  status: 'available',
  provider: 'connection:abc',
  model: 'gpt-5.4-mini',
}

function makeEntry(agentFile: string, extra: Partial<AgentRosterEntry> = {}): AgentRosterEntry {
  return {
    name: 'alpha',
    type: 'agent',
    role: 'worker',
    tier: 'strategic',
    agent_file: agentFile,
    ...extra,
  }
}

test('loadAgent runs the agent with its own explicit pair', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\nprovider: openrouter\nmodel: openai/gpt-4o-mini\nthinking: high\n---\nPrompt')

    withAppDefault(APP_DEFAULT, () => {
      const loaded = loadAgent(makeEntry(agentFile), makeUnresolvedTeamConfig(), 0)
      assert.ok(loaded)
      assert.equal(loaded.provider, 'openrouter')
      assert.equal(loaded.model, 'openai/gpt-4o-mini')
      assert.equal(loaded.thinking, 'high')
      assert.deepEqual(loaded.selection, {
        provider: 'openrouter',
        model: 'openai/gpt-4o-mini',
        source: 'agent',
        reason: 'explicit-agent-choice',
      })
    })
  })
})

test('loadAgent ignores a team tier table that names a different model', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\nprovider: openrouter\nmodel: openai/gpt-4o-mini\n---\nPrompt')

    const teamConfig = makeUnresolvedTeamConfig()
    teamConfig.legacyModels = {
      strategic: { model: 'claude-sonnet-4-6', thinking: 'low', provider: 'anthropic' },
    }
    teamConfig.defaults = { provider: 'anthropic' }

    withAppDefault(APP_DEFAULT, () => {
      const loaded = loadAgent(makeEntry(agentFile), teamConfig, 0)
      assert.ok(loaded)
      assert.equal(loaded.provider, 'openrouter')
      assert.equal(loaded.model, 'openai/gpt-4o-mini')
    })
  })
})

test('loadAgent ignores a legacy roster override that names a different model', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\nprovider: openrouter\nmodel: openai/gpt-4o-mini\n---\nPrompt')

    const entry = makeEntry(agentFile, { legacyProvider: 'gemini', legacyModel: 'gemini-2.5-pro' })

    withAppDefault(APP_DEFAULT, () => {
      const loaded = loadAgent(entry, makeUnresolvedTeamConfig(), 0)
      assert.ok(loaded)
      assert.equal(loaded.provider, 'openrouter')
      assert.equal(loaded.model, 'openai/gpt-4o-mini')
    })
  })
})

test('loadAgent uses the app default when the agent chose nothing, and says so', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha', '---\nname: alpha\n---\nPrompt')

    withAppDefault(APP_DEFAULT, () => {
      const loaded = loadAgent(makeEntry(agentFile), makeUnresolvedTeamConfig(), 0)
      assert.ok(loaded)
      assert.equal(loaded.provider, 'connection:abc')
      assert.equal(loaded.model, 'gpt-5.4-mini')
      assert.deepEqual(loaded.selection, {
        provider: 'connection:abc',
        model: 'gpt-5.4-mini',
        source: 'app-default',
        reason: 'agent-default',
      })
    })
  })
})

test('loadAgent keeps an explicit pair explicit even when it equals the app default', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\nprovider: connection:abc\nmodel: gpt-5.4-mini\n---\nPrompt')

    withAppDefault(APP_DEFAULT, () => {
      const loaded = loadAgent(makeEntry(agentFile), makeUnresolvedTeamConfig(), 0)
      assert.ok(loaded)
      assert.equal(loaded.selection?.source, 'agent')
      assert.equal(loaded.selection?.reason, 'explicit-agent-choice')
    })
  })
})

test('loadAgent reads a legacy codex/default persona as app-default mode with a diagnostic', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\nprovider: codex\nmodel: default\n---\nPrompt')

    withAppDefault(APP_DEFAULT, () => {
      const loaded = loadAgent(makeEntry(agentFile), makeUnresolvedTeamConfig(), 0)
      assert.ok(loaded)
      assert.equal(loaded.selection?.source, 'app-default')
      assert.deepEqual(
        loaded.selectionDiagnostics?.map((entry) => entry.code),
        ['legacy-builtin-default-pair'],
      )
    })
  })
})

test('loadAgent reports an unset app default instead of choosing some other model', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha', '---\nname: alpha\n---\nPrompt')

    withAppDefault({ status: 'unset' }, () => {
      const loaded = loadAgent(makeEntry(agentFile), makeUnresolvedTeamConfig(), 0)
      assert.ok(loaded)
      assert.equal(loaded.selection, null)
      assert.equal(loaded.selectionError?.code, 'app-default-unset')
      assert.equal(loaded.model, '')
      assert.equal(loaded.provider, '')
    })
  })
})

test('a loaded agent reports its configured selection, not an approved retry', () => {
  // The permission covers one *invocation*, and loading happens before any
  // dispatch exists. Applying it here would either make an invocation-scoped
  // approval never match, or make it cover every attempt that agent makes;
  // `tests/integration/agent-runner.test.ts` covers where it does apply.
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\nprovider: anthropic\nmodel: claude-opus-4-6\n---\nPrompt')

    withAppDefault(APP_DEFAULT, () => {
      withApprovedRetry(RETRY_AUTHORIZATION, () => {
        const loaded = loadAgent(makeEntry(agentFile), makeUnresolvedTeamConfig(), 0)
        assert.ok(loaded)
        assert.equal(loaded.selection?.source, 'agent')
        assert.equal(loaded.model, 'claude-opus-4-6')
      })
    })
  })
})

test('an agent carries its own provider options', () => {
  // Team-level provider options are gone. The plan keeps Agent-owned ones, so
  // the authoring boundary has to be able to express them — otherwise "remove
  // the Team merge" quietly means "lose the setting".
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha', [
      '---',
      'name: alpha',
      'provider: anthropic',
      'model: claude-opus-4-6',
      'provider_options: {"temperature": 0.2, "max_tokens": 512, "reasoning": false}',
      '---',
      'Prompt',
    ].join('\n'))

    withAppDefault(APP_DEFAULT, () => {
      const loaded = loadAgent(makeEntry(agentFile), makeUnresolvedTeamConfig(), 0)
      assert.ok(loaded)
      assert.deepEqual(loaded.providerConfig, {
        temperature: 0.2,
        max_tokens: 512,
        reasoning: false,
      })
    })
  })
})

test('provider options that are not plain settings are refused with a diagnostic', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha', [
      '---',
      'name: alpha',
      'provider: anthropic',
      'model: claude-opus-4-6',
      'provider_options: {"nested": {"not": "allowed"}}',
      '---',
      'Prompt',
    ].join('\n'))

    withAppDefault(APP_DEFAULT, () => {
      const loaded = loadAgent(makeEntry(agentFile), makeUnresolvedTeamConfig(), 0)
      assert.ok(loaded)
      assert.deepEqual(loaded.providerConfig, {})
      assert.deepEqual(
        loaded.selectionDiagnostics?.map((entry) => entry.code),
        ['invalid-provider-options'],
      )
    })
  })
})

test('an agent file may not carry a credential', () => {
  // Connection credentials stay in their own settings boundary. An agent file
  // is repository content that gets copied, shared and generated.
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha', [
      '---',
      'name: alpha',
      'provider: anthropic',
      'model: claude-opus-4-6',
      'provider_options: {"api_key": "sk-should-never-be-here"}',
      '---',
      'Prompt',
    ].join('\n'))

    withAppDefault(APP_DEFAULT, () => {
      const loaded = loadAgent(makeEntry(agentFile), makeUnresolvedTeamConfig(), 0)
      assert.ok(loaded)
      assert.deepEqual(loaded.providerConfig, {})
      assert.deepEqual(
        loaded.selectionDiagnostics?.map((entry) => entry.code),
        ['provider-options-credential'],
      )
    })
  })
})

test('a real agent file with no pair reaches preflight as an actionable startup error', () => {
  // The seam between the two: the loader decides and records why, preflight is
  // what stops the Team and has to repeat that reason. Tested together because
  // each half passing on its own is what let "unknown provider ''" reach an
  // operator.
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha', '---\nname: alpha\n---\nPrompt')

    withAppDefault({ status: 'unset' }, () => {
      const loaded = loadAgent(makeEntry(agentFile), makeUnresolvedTeamConfig(), 0)
      assert.ok(loaded)

      const errors = validateLoadedAgentProviders([loaded])
      assert.equal(errors.length, 1)
      assert.match(String(errors[0]), /agent 'alpha' has no model selected/)
      assert.match(String(errors[0]), /Settings → AI Providers/)
      assert.doesNotMatch(String(errors[0]), /unknown provider/)
    })
  })
})

test('loadAgent names the broken default rather than replacing it', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha', '---\nname: alpha\n---\nPrompt')

    withAppDefault(
      { status: 'unavailable', provider: 'connection:abc', model: 'gpt-5.4-mini' },
      () => {
        const loaded = loadAgent(makeEntry(agentFile), makeUnresolvedTeamConfig(), 0)
        assert.ok(loaded)
        assert.equal(loaded.selectionError?.code, 'app-default-unavailable')
        assert.equal(loaded.selectionError?.provider, 'connection:abc')
        assert.equal(loaded.selectionError?.model, 'gpt-5.4-mini')
      },
    )
  })
})

test('loadAgent refuses a persona model that names no provider', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\nmodel: claude-sonnet-4-6\n---\nPrompt')

    withAppDefault(APP_DEFAULT, () => {
      const loaded = loadAgent(makeEntry(agentFile), makeUnresolvedTeamConfig(), 0)
      assert.ok(loaded)
      assert.equal(loaded.selection, null)
      assert.equal(loaded.selectionError?.code, 'agent-model-without-provider')
    })
  })
})

test('loadAgent takes thinking from the agent, never from the team tier table', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\nprovider: openrouter\nmodel: openai/gpt-4o-mini\nthinking: low\n---\nPrompt')

    const teamConfig = makeUnresolvedTeamConfig()
    teamConfig.legacyModels = {
      strategic: { model: 'claude-sonnet-4-6', thinking: 'high' },
    }

    withAppDefault(APP_DEFAULT, () => {
      const loaded = loadAgent(makeEntry(agentFile), teamConfig, 0)
      assert.ok(loaded)
      assert.equal(loaded.thinking, 'low')
    })
  })
})

test('loadAgent does not merge team tier provider options into the agent', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\nprovider: openrouter\nmodel: openai/gpt-4o-mini\n---\nPrompt')

    const teamConfig = makeUnresolvedTeamConfig()
    teamConfig.legacyModels = {
      strategic: {
        model: 'claude-sonnet-4-6',
        thinking: 'high',
        provider_config: { temperature: 0.9 },
      },
    }

    withAppDefault(APP_DEFAULT, () => {
      const loaded = loadAgent(makeEntry(agentFile), teamConfig, 0)
      assert.ok(loaded)
      assert.equal(loaded.providerConfig?.temperature, undefined)
    })
  })
})

// ─── Effort levels beyond the original three ────────────────────────────────

test('loadAgent keeps an effort level the vendor supports and the old vocabulary did not', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\nprovider: openrouter\nmodel: openai/gpt-4o-mini\nthinking: xhigh\n---\nPrompt')

    withAppDefault(APP_DEFAULT, () => {
      const loaded = loadAgent(makeEntry(agentFile), makeUnresolvedTeamConfig(), 0)
      assert.ok(loaded)
      assert.equal(loaded.thinking, 'xhigh')
    })
  })
})

test('loadAgent reads an explicit request for the provider default as its own value', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\nprovider: openrouter\nmodel: openai/gpt-4o-mini\nthinking: provider-default\n---\nPrompt')

    withAppDefault(APP_DEFAULT, () => {
      const loaded = loadAgent(makeEntry(agentFile), makeUnresolvedTeamConfig(), 0)
      assert.ok(loaded)
      assert.equal(loaded.thinking, 'provider-default')
    })
  })
})

test('loadAgent still runs an agent that names no thinking level at medium', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'alpha',
      '---\nname: alpha\nprovider: openrouter\nmodel: openai/gpt-4o-mini\n---\nPrompt')

    withAppDefault(APP_DEFAULT, () => {
      const loaded = loadAgent(makeEntry(agentFile), makeUnresolvedTeamConfig(), 0)
      assert.ok(loaded)
      assert.equal(loaded.thinking, 'medium')
    })
  })
})

test('loadAgent keeps each of the three levels agent files already use', () => {
  for (const level of ['low', 'medium', 'high'] as const) {
    withTempDir((dir) => {
      const agentFile = makeAgentFile(dir, 'alpha',
        `---\nname: alpha\nprovider: openrouter\nmodel: openai/gpt-4o-mini\nthinking: ${level}\n---\nPrompt`)

      withAppDefault(APP_DEFAULT, () => {
        const loaded = loadAgent(makeEntry(agentFile), makeUnresolvedTeamConfig(), 0)
        assert.ok(loaded)
        assert.equal(loaded.thinking, level)
      })
    })
  }
})

for (const kind of ['agent', 'team'] as const) {
  test(`a chat-selected workflow model overrides a saved ${kind} pair`, () => {
    const previous = process.env.PIPELINE_WORKFLOW_MODEL_SELECTION
    process.env.PIPELINE_WORKFLOW_MODEL_SELECTION = Buffer.from(JSON.stringify({ provider: 'codex', model: 'selected-codex' })).toString('base64')
    try {
      withTempDir((dir) => {
        const agentFile = makeAgentFile(dir, 'youtube-extractor', '---\nname: youtube-extractor\nprovider: claude\nmodel: opus\nprovider_options: {"old_vendor_flag":true}\n---\nExtract the video.')
        const loaded = loadAgent({ name: 'youtube-extractor', type: kind, role: 'worker', agent_file: agentFile, host_provider: 'claude', host_model: 'opus' }, makeMinimalTeamConfig(), 0)
        assert.equal(loaded?.provider, 'codex')
        assert.equal(loaded?.model, 'selected-codex')
        assert.equal(loaded?.selection?.source, 'user')
        assert.deepEqual(loaded?.providerConfig ?? {}, {})
      })
    } finally {
      if (previous === undefined) delete process.env.PIPELINE_WORKFLOW_MODEL_SELECTION
      else process.env.PIPELINE_WORKFLOW_MODEL_SELECTION = previous
    }
  })
}

test('an invalid workflow model payload stops instead of falling back to Claude', () => {
  const previous = process.env.PIPELINE_WORKFLOW_MODEL_SELECTION
  process.env.PIPELINE_WORKFLOW_MODEL_SELECTION = Buffer.from(JSON.stringify({ provider: 'codex' })).toString('base64')
  try {
    withTempDir((dir) => {
      const agentFile = makeAgentFile(dir, 'worker', '---\nprovider: claude\nmodel: opus\n---\nWork.')
      assert.throws(() => loadAgent({ name: 'worker', type: 'agent', role: 'worker', agent_file: agentFile }, makeMinimalTeamConfig(), 0), /Invalid workflow model selection/)
    })
  } finally {
    if (previous === undefined) delete process.env.PIPELINE_WORKFLOW_MODEL_SELECTION
    else process.env.PIPELINE_WORKFLOW_MODEL_SELECTION = previous
  }
})
