import { requiredValue } from '../../core/required-value.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseTeamConfig } from '../../parsers/team-config.js'

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-config-test-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('parseTeamConfig resolves paths and fills default model tiers', () => {
  withTempDir((dir) => {
    const agentDir = path.join(dir, 'agents', 'alpha')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'alpha.md'), '# Alpha')

    fs.writeFileSync(path.join(dir, 'team.yaml'), `
team:
  name: sample-team
agents:
  - name: alpha
    type: agent
    role: test agent
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md
levels:
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: discussion
      coordinator: alpha
      participants:
        - alpha
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        constraints:
          max_time_minutes: 5
          max_budget_usd: 1
        output:
          format: output.md
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.errors.length, 0)
    assert.ok(result.config)
    assert.equal(result.config?.team.name, 'sample-team')
    assert.equal(requiredValue(result.config?.agents[0], 'tests/unit/team-config.test.ts:64').agent_file, path.join(dir, 'agents', 'alpha', 'alpha.md'))
    assert.equal(result.config?.workspace.path, path.join(dir, 'workspace'))
  })
})

test('parseTeamConfig no longer synthesizes a models-by-tier table', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'team.yaml'), `
team:
  name: sample-team
workspace:
  path: ./workspace
agents:
  - name: alpha
    type: agent
    role: Worker
    tier: strategic
    agent_file: ./agents/alpha/alpha.md
    produces:
      - path: output.md
levels:
  - id: work
    name: Work
    order: 0
    stage:
      type: chain
      sequence:
        - alpha
gates:
  - from: work
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`)
    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.deepEqual(result.errors, [])
    assert.ok(result.config)
    // A team that declares no models must not acquire invented ones. The
    // grades stopped deciding anything, so manufacturing them would only
    // re-create the hierarchy this removed.
    assert.deepEqual(result.config?.legacyModels, undefined)
  })
})

test('parseTeamConfig reports a legacy models table and member overrides as ignored', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'team.yaml'), `
team:
  name: legacy-team
workspace:
  path: ./workspace
defaults:
  provider: anthropic
models:
  strategic:
    model: claude-sonnet-4-6
    thinking: high
    provider: anthropic
agents:
  - name: alpha
    type: agent
    role: Worker
    tier: strategic
    agent_file: ./agents/alpha/alpha.md
    provider: gemini
    model: gemini-2.5-pro
    produces:
      - path: output.md
levels:
  - id: work
    name: Work
    order: 0
    stage:
      type: chain
      sequence:
        - alpha
gates:
  - from: work
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`)
    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config)
    assert.equal(result.errors.length, 0)
    const warnings = result.warnings.join(' ')
    assert.match(warnings, /models/)
    assert.match(warnings, /defaults\.provider/)
    assert.match(warnings, /alpha/)
    // The values are still readable for diagnostics, but never as runtime.
    assert.equal(result.config?.legacyModels?.strategic?.model, 'claude-sonnet-4-6')
    assert.equal(result.config?.agents[0]?.legacyProvider, 'gemini')
  })
})

test('parseTeamConfig reports unknown coordinator references', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'team.yaml'), `
team:
  name: invalid-team
agents:
  - name: alpha
    type: agent
    role: test agent
    tier: strategic
    agent_file: agents/alpha/alpha.md
levels:
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: discussion
      coordinator: missing-agent
      participants:
        - alpha
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        constraints:
          max_time_minutes: 5
          max_budget_usd: 1
        output:
          format: output.md
`)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null)
    assert.match(result.errors.join('\n'), /Discussion coordinator 'missing-agent' not found/)
  })
})

test('parseTeamConfig defaults experience_enabled to true when omitted', () => {
  withTempDir((dir) => {
    const agentDir = path.join(dir, 'agents', 'alpha')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'alpha.md'), '# Alpha')

    fs.writeFileSync(path.join(dir, 'team.yaml'), `
team:
  name: sample-team
agents:
  - name: alpha
    type: agent
    role: test agent
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md
levels:
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: discussion
      coordinator: alpha
      participants:
        - alpha
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        constraints:
          max_time_minutes: 5
          max_budget_usd: 1
        output:
          format: output.md
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.errors.length, 0)
    assert.equal(requiredValue(result.config?.agents[0], 'tests/unit/team-config.test.ts:154').experience_enabled, true)
  })
})

test('parseTeamConfig preserves explicit experience_enabled false', () => {
  withTempDir((dir) => {
    const agentDir = path.join(dir, 'agents', 'alpha')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'alpha.md'), '# Alpha')

    fs.writeFileSync(path.join(dir, 'team.yaml'), `
team:
  name: sample-team
agents:
  - name: alpha
    type: agent
    role: test agent
    tier: strategic
    agent_file: agents/alpha/alpha.md
    experience_enabled: false
    produces:
      - path: output.md
levels:
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: discussion
      coordinator: alpha
      participants:
        - alpha
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        constraints:
          max_time_minutes: 5
          max_budget_usd: 1
        output:
          format: output.md
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.errors.length, 0)
    assert.equal(requiredValue(result.config?.agents[0], 'tests/unit/team-config.test.ts:204').experience_enabled, false)
  })
})

test('parseTeamConfig preserves per-agent tools allowlists', () => {
  withTempDir((dir) => {
    const agentDir = path.join(dir, 'agents', 'alpha')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'alpha.md'), '# Alpha')

    fs.writeFileSync(path.join(dir, 'team.yaml'), `
team:
  name: sample-team
agents:
  - name: alpha
    type: agent
    role: test agent
    tier: strategic
    tools:
      - handoff
      - submit_for_review
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md
levels:
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: discussion
      coordinator: alpha
      participants:
        - alpha
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        constraints:
          max_time_minutes: 5
          max_budget_usd: 1
        output:
          format: output.md
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.errors.length, 0)
    assert.deepEqual(requiredValue(result.config?.agents[0], 'tests/unit/team-config.test.ts:256').tools, ['handoff', 'submit_for_review'])
  })
})

test('parseTeamConfig loads the live writing-team config', () => {
  const teamFile = path.resolve(process.cwd(), 'teams', 'writing-team', 'team.yaml')
  const result = parseTeamConfig(teamFile)

  assert.equal(result.errors.length, 0, `Expected no errors, got: ${result.errors.join('; ')}`)
  assert.ok(result.config)
  assert.equal(result.config?.team.name, 'writing-team')
  assert.equal(result.config?.agents.length, 3)
  assert.equal(result.config?.levels[0]?.stage.type, 'chain')
  const entryStage = result.config?.levels[0]?.stage
  assert.equal(
    entryStage?.type === 'chain'
      ? entryStage.config.preserve_initial_input
      : undefined,
    true,
  )
  assert.equal(result.config?.gates[0]?.condition.type, 'artifact_exists')
})

// ── Tier validation tests ────────────────────────────────────────────────────

function makeMinimalYaml(overrides: {
  tier?: string
  coordinatorTier?: string
  fanOutTier?: string
  stageType?: string
}): string {
  const { tier = 'strategic', coordinatorTier, fanOutTier, stageType = 'discussion' } = overrides

  const agents: string[] = []
  const stages: string[] = []

  if (stageType === 'discussion') {
    agents.push(`  - name: alpha
    type: agent
    role: test agent
    tier: ${tier}
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md`)

    stages.push(`  - id: l1
    name: Level 1
    order: 0
    stage:
      type: discussion
      coordinator: alpha
      participants:
        - alpha
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        constraints:
          max_time_minutes: 5
          max_budget_usd: 1
        output:
          format: output.md`)
  } else if (stageType === 'broadcast') {
    agents.push(`  - name: coord
    type: agent
    role: coordinator
    tier: ${coordinatorTier ?? 'orchestration'}
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md`)
    agents.push(`  - name: worker
    type: agent
    role: worker
    tier: ${fanOutTier ?? 'execution'}
    agent_file: agents/alpha/alpha.md`)

    stages.push(`  - id: l1
    name: Level 1
    order: 0
    stage:
      type: broadcast
      coordinator: coord
      fan_out:
        - worker
      config:
        aggregation: merge
        output:
          format: output.md`)
  }

  return `
team:
  name: test-team
agents:
${agents.join('\n')}
levels:
${stages.join('\n')}
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`
}

test('parseTeamConfig accepts valid tiers (orchestration, strategic, execution)', () => {
  for (const validTier of ['orchestration', 'strategic', 'execution']) {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'team.yaml'), makeMinimalYaml({ tier: validTier }))
      const result = parseTeamConfig(path.join(dir, 'team.yaml'))
      assert.equal(
        result.errors.filter(e => e.includes('unknown tier')).length,
        0,
        `Expected no tier error for valid tier '${validTier}', got: ${result.errors.join('; ')}`
      )
    })
  }
})

test('parseTeamConfig no longer refuses a Team over a misspelled grade', () => {
  // This used to fail the whole file and return `config: null`. It was the
  // right rule while a grade selected a model; now that it selects nothing, a
  // typo in a label is not a reason to stop a Team from running. The grade is
  // still carried back exactly as written, typo included, so a caller that
  // wants to report it can.
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'team.yaml'), makeMinimalYaml({ tier: 'orchestartion' }))
    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected a parsed Team, got errors: ${result.errors.join('; ')}`)
    assert.deepEqual(result.errors, [])
    assert.equal(result.config!.agents[0]?.tier, 'orchestartion')
  })
})



test('parseTeamConfig warnings do not appear in errors array', () => {
  withTempDir((dir) => {
    // A retired runtime setting is a warning, not an error: the file still
    // parses and still runs, it just no longer decides a model.
    fs.writeFileSync(
      path.join(dir, 'team.yaml'),
      makeMinimalYaml({ tier: 'execution' }).replace(
        'agents:',
        'defaults:\n  provider: codex\n\nagents:',
      ),
    )
    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse`)
    assert.equal(result.errors.length, 0, `Expected no errors, got: ${result.errors.join('; ')}`)
    assert.ok(result.warnings.length > 0, 'Expected at least one warning')
  })
})

test('parseTeamConfig result includes warnings array even on success with no issues', () => {
  withTempDir((dir) => {
    // A roster written now declares no grade, so there is nothing to disclose
    // and the warnings list is genuinely empty.
    fs.writeFileSync(
      path.join(dir, 'team.yaml'),
      makeMinimalYaml({ tier: 'strategic' }).replace('    tier: strategic\n', ''),
    )
    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config)
    assert.ok(Array.isArray(result.warnings), 'warnings should be an array')
    assert.deepEqual(result.warnings, [])
  })
})

test('parseTeamConfig reports a scalar where an agent artifact list is required', () => {
  withTempDir((dir) => {
    const yaml = makeMinimalYaml({ tier: 'strategic' })
      .replace('    produces:\n      - path: output.md', '    produces: output.md')
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null)
    assert.match(result.errors.join('\n'), /Invalid agent produces: must be an array/)
  })
})

test('parseTeamConfig rejects enum-like configuration typos instead of defaulting them', () => {
  withTempDir((dir) => {
    const yaml = makeMinimalYaml({ tier: 'strategic' })
      .replace('type: artifact_exists', 'type: artifact_exits')
      .replace('mode: deliberate', 'mode: deliberatee')
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null)
    assert.match(result.errors.join('\n'), /Invalid gate condition 'type' 'artifact_exits'/)
    assert.match(result.errors.join('\n'), /Invalid discussion 'mode' 'deliberatee'/)
  })
})

test('parseTeamConfig rejects min_rounds greater than max_rounds', () => {
  withTempDir((dir) => {
    const yaml = makeMinimalYaml({ tier: 'strategic' })
      .replace('min_rounds: 1', 'min_rounds: 4')
      .replace('max_rounds: 2', 'max_rounds: 2')
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null)
    assert.match(result.errors.join('\n'), /min_rounds \(4\) cannot be greater than max_rounds \(2\)/)
  })
})

test('parseTeamConfig treats unquoted yes/no as strings, not booleans', () => {
  withTempDir((dir) => {
    const yaml = makeMinimalYaml({ tier: 'strategic' })
      .replace('    agent_file:', '    experience_enabled: no\n    agent_file:')
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, result.errors.join('\n'))
    assert.equal(result.config?.agents[0]?.experience_enabled, true)
  })
})

test('parseTeamConfig allows review-stage terminal artifacts to be runtime-owned', () => {
  withTempDir((dir) => {
    const writerDir = path.join(dir, 'agents', 'writer')
    const editorDir = path.join(dir, 'agents', 'editor')
    fs.mkdirSync(writerDir, { recursive: true })
    fs.mkdirSync(editorDir, { recursive: true })
    fs.writeFileSync(path.join(writerDir, 'writer.md'), '# Writer')
    fs.writeFileSync(path.join(editorDir, 'editor.md'), '# Editor')

    fs.writeFileSync(path.join(dir, 'team.yaml'), `
team:
  name: writing-team
agents:
  - name: writer
    type: agent
    role: writer
    tier: execution
    agent_file: agents/writer/writer.md
    produces:
      - path: draft-package.md
  - name: editor
    type: agent
    role: editor
    tier: strategic
    agent_file: agents/editor/editor.md
levels:
  - id: draft
    name: Draft
    order: 0
    stage:
      type: chain
      sequence:
        - writer
      config:
        output:
          format: draft-package.md
          user_review: false
  - id: review
    name: Review
    order: 1
    stage:
      type: review
      producer: writer
      reviewer: editor
      config:
        max_iterations: 2
        output:
          format: final-draft.md
          user_review: false
gates:
  - from: draft
    to: review
    condition:
      type: artifact_exists
      artifact: draft-package.md
  - from: review
    to: done
    condition:
      type: artifact_exists
      artifact: final-draft.md
`)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.errors.length, 0, `Expected no errors, got: ${result.errors.join('; ')}`)
    assert.ok(result.config)
  })
})

// ── Gate transform parsing tests ─────────────────────────────────────────────

function makeTransformYaml(transform: string): string {
  return `
team:
  name: test-team
agents:
  - name: alpha
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md
  - name: synthesizer
    type: agent
    role: synthesizer
    tier: strategic
    agent_file: agents/alpha/alpha.md
levels:
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: discussion
      coordinator: alpha
      participants:
        - alpha
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        constraints:
          max_time_minutes: 5
          max_budget_usd: 1
        output:
          format: output.md
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
${transform}
`
}

test('parseTeamConfig accepts machine-readable JSON gates with correction controls', () => {
  withTempDir((dir) => {
    const yaml = makeTransformYaml('')
      .replace('      - path: output.md', '      - path: verdict.json')
      .replace(
        `      type: artifact_exists\n      artifact: output.md`,
        `      type: artifact_json\n      artifact: verdict.json\n      pointer: /decision\n      operator: equals\n      value: REVISE`,
      )
      .replace('    condition:\n', '    reset_scope: target_through_source\n    max_loopbacks: 2\n    condition:\n')
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.errors.length, 0, result.errors.join('; '))
    assert.deepEqual(result.config?.gates[0], {
      from: 'l1',
      to: 'done',
      condition: {
        type: 'artifact_json',
        artifact: 'verdict.json',
        pointer: '/decision',
        operator: 'equals',
        value: 'REVISE',
      },
      reset_scope: 'target_through_source',
      max_loopbacks: 2,
    })
  })
})

test('parseTeamConfig rejects malformed JSON gates and loopback controls', () => {
  withTempDir((dir) => {
    const yaml = makeTransformYaml('')
      .replace(
        `      type: artifact_exists\n      artifact: output.md`,
        `      type: artifact_json\n      artifact: ''\n      pointer: decision\n      operator: contains\n      value:\n        nested: invalid`,
      )
      .replace('    condition:\n', '    reset_scope: everything\n    max_loopbacks: -1\n    condition:\n')
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null)
    assert.match(result.errors.join('\n'), /artifact_json 'artifact' is required/)
    assert.match(result.errors.join('\n'), /artifact_json 'pointer'/)
    assert.match(result.errors.join('\n'), /artifact_json 'operator'/)
    assert.match(result.errors.join('\n'), /gate 'reset_scope'/)
    assert.match(result.errors.join('\n'), /gate 'max_loopbacks'/)
  })
})

test('parseTeamConfig parses gate transform with script type', () => {
  withTempDir((dir) => {
    const scriptPath = path.join(dir, 'scripts', 'merge.mjs')
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    fs.writeFileSync(scriptPath, '// merge script')

    const yaml = makeTransformYaml(`    transform:
      type: script
      script: scripts/merge.mjs
      input: output.md
      output: processed-output.md`)
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    const gate = result.config!.gates[0]
    assert.ok(requiredValue(gate, 'tests/unit/team-config.test.ts:665').transform, 'Expected transform to be parsed')
    assert.equal(requiredValue(gate, 'tests/unit/team-config.test.ts:666').transform!.type, 'script')
    assert.equal(requiredValue(gate, 'tests/unit/team-config.test.ts:667').transform!.input, 'output.md')
    assert.equal(requiredValue(gate, 'tests/unit/team-config.test.ts:668').transform!.output, 'processed-output.md')
    assert.ok(requiredValue(gate, 'tests/unit/team-config.test.ts:669').transform!.script?.endsWith('merge.mjs'))
  })
})

test('parseTeamConfig parses gate transform with agent type', () => {
  withTempDir((dir) => {
    const yaml = makeTransformYaml(`    transform:
      type: agent
      agent: synthesizer
      input: output.md
      output: summary.md
      prompt: Summarize the input`)
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    const gate = result.config!.gates[0]
    assert.ok(requiredValue(gate, 'tests/unit/team-config.test.ts:686').transform, 'Expected transform to be parsed')
    assert.equal(requiredValue(gate, 'tests/unit/team-config.test.ts:687').transform!.type, 'agent')
    assert.equal(requiredValue(gate, 'tests/unit/team-config.test.ts:688').transform!.agent, 'synthesizer')
    assert.equal(requiredValue(gate, 'tests/unit/team-config.test.ts:689').transform!.prompt, 'Summarize the input')
  })
})

test('parseTeamConfig parses gate transform strictness field', () => {
  withTempDir((dir) => {
    const scriptPath = path.join(dir, 'scripts', 'merge.mjs')
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    fs.writeFileSync(scriptPath, '// merge script')

    const yaml = makeTransformYaml(`    transform:
      type: script
      script: scripts/merge.mjs
      strictness: soft`)
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    const gate = result.config!.gates[0]
    assert.equal(requiredValue(gate, 'tests/unit/team-config.test.ts:708').transform!.strictness, 'soft')
  })
})

test('parseTeamConfig emits error for transform agent not in roster', () => {
  withTempDir((dir) => {
    const yaml = makeTransformYaml(`    transform:
      type: agent
      agent: missing-agent
      input: raw-output.md
      output: summary.md`)
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null)
    const err = result.errors.find(e => e.includes("transform agent 'missing-agent'"))
    assert.ok(err, `Expected transform agent error, got: ${result.errors.join('; ')}`)
  })
})

test('parseTeamConfig emits warning for missing script file at parse time', () => {
  withTempDir((dir) => {
    // script file does NOT exist at dir
    const yaml = makeTransformYaml(`    transform:
      type: script
      script: scripts/nonexistent.mjs`)
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse despite missing script, errors: ${result.errors.join('; ')}`)
    const warning = result.warnings.find(w => w.includes('nonexistent.mjs'))
    assert.ok(warning, `Expected warning for missing script, got warnings: ${result.warnings.join('; ')}`)
  })
})

test('parseTeamConfig gate with no transform has undefined transform field', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'team.yaml'), makeMinimalYaml({ tier: 'strategic' }))
    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config)
    const gate = result.config!.gates[0]
    assert.equal(requiredValue(gate, 'tests/unit/team-config.test.ts:749').transform, undefined)
  })
})

// ── Artifact contract parsing and validation tests ───────────────────────────

/**
 * Helper: build a minimal team.yaml string with flexible agent produces/consumes,
 * gate artifact, stage output format, and optional gate transform.
 */
function makeContractYaml(opts: {
  agentsBlock: string
  coordinatorName?: string
  participantName?: string
  stageOutputFormat?: string
  gateArtifact?: string
  gateTransformBlock?: string
}): string {
  const {
    coordinatorName = 'alpha',
    participantName = 'alpha',
    stageOutputFormat = 'output.md',
    gateArtifact = 'output.md',
    gateTransformBlock = '',
  } = opts

  return `
team:
  name: test-team
agents:
${opts.agentsBlock}
levels:
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: discussion
      coordinator: ${coordinatorName}
      participants:
        - ${participantName}
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        constraints:
          max_time_minutes: 5
          max_budget_usd: 1
        output:
          format: ${stageOutputFormat}
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: ${gateArtifact}${gateTransformBlock}
`
}

// ── Test 1: Parses produces and consumes correctly ────────────────────────────

test('parseTeamConfig parses produces and consumes correctly', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: alpha
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: research/brief.md
        description: Domain research output
      - path: output.md
  - name: beta
    type: agent
    role: consumer
    tier: strategic
    agent_file: agents/alpha/alpha.md
    consumes:
      - path: research/brief.md
        description: Read the brief`,
      coordinatorName: 'alpha',
      participantName: 'alpha',
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    const alpha = result.config!.agents.find(a => a.name === 'alpha')!
    assert.ok(alpha.produces, 'Expected produces to be set')
    assert.equal(requiredValue(alpha.produces![0], 'tests/unit/team-config.test.ts:838').path, 'research/brief.md')
    assert.equal(requiredValue(alpha.produces![0], 'tests/unit/team-config.test.ts:839').description, 'Domain research output')
    assert.equal(requiredValue(alpha.produces![1], 'tests/unit/team-config.test.ts:840').path, 'output.md')
    assert.equal(requiredValue(alpha.produces![1], 'tests/unit/team-config.test.ts:841').description, undefined)
    const beta = result.config!.agents.find(a => a.name === 'beta')!
    assert.ok(beta.consumes, 'Expected consumes to be set')
    assert.equal(requiredValue(beta.consumes![0], 'tests/unit/team-config.test.ts:844').path, 'research/brief.md')
    assert.equal(requiredValue(beta.consumes![0], 'tests/unit/team-config.test.ts:845').description, 'Read the brief')
  })
})

// ── Test 2: Parses produces with path only (no description) ──────────────────

test('parseTeamConfig parses produces with path only (no description)', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: alpha
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md`,
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    const alpha = result.config!.agents[0]
    assert.ok(requiredValue(alpha, 'tests/unit/team-config.test.ts:867').produces, 'Expected produces to be set')
    assert.equal(requiredValue(requiredValue(alpha, 'tests/unit/team-config.test.ts:868').produces![0], 'tests/unit/team-config.test.ts:869').path, 'output.md')
    assert.equal(requiredValue(requiredValue(alpha, 'tests/unit/team-config.test.ts:869').produces![0], 'tests/unit/team-config.test.ts:870').description, undefined)
  })
})

// ── Test 3: Agents without produces/consumes have undefined for those fields ─

test('parseTeamConfig agents without produces/consumes have undefined fields', () => {
  withTempDir((dir) => {
    // makeMinimalYaml now adds produces to alpha, but consumes is still absent
    fs.writeFileSync(path.join(dir, 'team.yaml'), makeMinimalYaml({ tier: 'strategic' }))
    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    // alpha has produces (added by helper) but no consumes
    assert.ok(requiredValue(result.config!.agents[0], 'tests/unit/team-config.test.ts:882').produces, 'Expected produces to be defined')
    assert.equal(requiredValue(result.config!.agents[0], 'tests/unit/team-config.test.ts:883').consumes, undefined, 'Expected consumes to be undefined')
  })
})

// ── Test 4: Error when gate artifact has no declared producer

test('parseTeamConfig emits error for gate artifact without declared producer', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: alpha
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: something-else.md`,
      gateArtifact: 'report.md',
      stageOutputFormat: 'stage-output.md',
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null, 'Expected parse to fail')
    const error = result.errors.find(w => w.includes("requires artifact 'report.md'") && w.includes('no agent declares producing it'))
    assert.ok(error, `Expected gate artifact error, got errors: ${result.errors.join('; ')}`)
  })
})

// ── Test 5: Stage output.format alone does NOT satisfy gate (requires explicit produces)

test('parseTeamConfig errors when gate artifact only matches stage output.format but no produces declaration', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: alpha
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: something-else.md`,
      gateArtifact: 'ideas-summary.md',
      stageOutputFormat: 'ideas-summary.md',
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null, 'Expected parse to fail — stage output.format alone should not satisfy gate')
    const error = result.errors.find(w => w.includes("requires artifact 'ideas-summary.md'"))
    assert.ok(error, `Expected gate artifact error, got errors: ${result.errors.join('; ')}`)
  })
})

// ── Test 6: No error when gate artifact has declared producer ─────────────────

test('parseTeamConfig no error when gate artifact has declared producer', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: alpha
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md`,
      gateArtifact: 'output.md',
      stageOutputFormat: 'stage-result.md',
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    const artifactError = result.errors.find(w => w.includes("requires artifact 'output.md'"))
    assert.equal(artifactError, undefined, `Expected no gate artifact error, got: ${result.errors.join('; ')}`)
  })
})

// ── Test 7: Error when consumed artifact has no producer ──────────────────────

test('parseTeamConfig emits error for consumed artifact without producer', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: alpha
    type: agent
    role: producer
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md
  - name: beta
    type: agent
    role: consumer
    tier: strategic
    agent_file: agents/alpha/alpha.md
    consumes:
      - path: brief.md`,
      coordinatorName: 'alpha',
      participantName: 'alpha',
      gateArtifact: 'output.md',
      stageOutputFormat: 'stage-output.md',
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null, 'Expected parse to fail')
    const error = result.errors.find(w => w.includes("beta") && w.includes("consumes 'brief.md'") && w.includes('no agent declares producing'))
    assert.ok(error, `Expected consumes error for brief.md, got errors: ${result.errors.join('; ')}`)
  })
})

// ── Test 8: No error when consumed artifact has a declared producer ───────────

test('parseTeamConfig no error when consumed artifact has a declared producer', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: alpha
    type: agent
    role: producer
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: brief.md
      - path: output.md
  - name: beta
    type: agent
    role: consumer
    tier: strategic
    agent_file: agents/alpha/alpha.md
    consumes:
      - path: brief.md`,
      coordinatorName: 'alpha',
      participantName: 'alpha',
      gateArtifact: 'output.md',
      stageOutputFormat: 'stage-output.md',
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    const artifactErrors = result.errors.filter(w => w.includes('brief.md'))
    assert.equal(artifactErrors.length, 0, `Expected no errors about brief.md, got: ${result.errors.join('; ')}`)
  })
})

// ── Test 9: Error for consumed artifact name near-match ───────────────────────

test('parseTeamConfig emits near-match error for consumed artifact with underscore vs hyphen', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: alpha
    type: agent
    role: producer
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: research-brief.md
      - path: output.md
  - name: beta
    type: agent
    role: consumer
    tier: strategic
    agent_file: agents/alpha/alpha.md
    consumes:
      - path: research_brief.md`,
      coordinatorName: 'alpha',
      participantName: 'alpha',
      gateArtifact: 'output.md',
      stageOutputFormat: 'stage-output.md',
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null, 'Expected parse to fail')
    const error = result.errors.find(w =>
      w.includes("beta") &&
      w.includes("research_brief.md") &&
      w.includes("research-brief.md") &&
      w.includes('did you mean')
    )
    assert.ok(error, `Expected near-match error, got errors: ${result.errors.join('; ')}`)
  })
})

// ── Test 10: Error for gate artifact name near-match ──────────────────────────

test('parseTeamConfig emits near-match error for gate artifact with underscore vs hyphen', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: alpha
    type: agent
    role: producer
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: research-brief.md`,
      gateArtifact: 'research_brief.md',
      stageOutputFormat: 'stage-output.md',
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null, 'Expected parse to fail')
    const error = result.errors.find(w =>
      w.includes("research_brief.md") &&
      w.includes("research-brief.md") &&
      w.includes('did you mean')
    )
    assert.ok(error, `Expected near-match error for gate artifact, got errors: ${result.errors.join('; ')}`)
    // Should NOT be a generic missing-producer error
    const genericError = result.errors.find(w =>
      w.includes("research_brief.md") &&
      w.includes('no agent declares producing it')
    )
    assert.equal(genericError, undefined, `Expected near-match error (not generic), got: ${result.errors.join('; ')}`)
  })
})

// ── Test 11: Warning for duplicate producers ──────────────────────────────────

test('parseTeamConfig emits warning for duplicate producers', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: alpha
    type: agent
    role: producer
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md
  - name: beta
    type: agent
    role: producer
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md`,
      coordinatorName: 'alpha',
      participantName: 'alpha',
      gateArtifact: 'output.md',
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    const warning = result.warnings.find(w =>
      w.includes("output.md") &&
      w.includes('alpha') &&
      w.includes('beta') &&
      (w.includes('declared as produced by both') || w.includes('Only one agent'))
    )
    assert.ok(warning, `Expected duplicate producer warning, got warnings: ${result.warnings.join('; ')}`)
  })
})

// ── Test 12: Config without produces declarations errors when gate artifact has no declared producer

test('parseTeamConfig errors when no agent declares producing the gate artifact', () => {
  withTempDir((dir) => {
    // Raw YAML without any produces/consumes — gate checks for output.md but nobody claims it
    const yaml = `
team:
  name: test-team
agents:
  - name: alpha
    type: agent
    role: test agent
    tier: strategic
    agent_file: agents/alpha/alpha.md
levels:
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: discussion
      coordinator: alpha
      participants:
        - alpha
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        constraints:
          max_time_minutes: 5
          max_budget_usd: 1
        output:
          format: output.md
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)
    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null, 'Expected parse to fail — no agent declares producing the gate artifact')
    const error = result.errors.find(w => w.includes("requires artifact 'output.md'"))
    assert.ok(error, `Expected gate artifact error, got errors: ${result.errors.join('; ')}`)
  })
})

// ── Test 13: Subdirectory paths parse correctly ───────────────────────────────

test('parseTeamConfig preserves subdirectory paths in produces declarations', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: alpha
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: research/deep/brief.md
        description: Nested output
      - path: output.md`,
      gateArtifact: 'output.md',
      stageOutputFormat: 'stage-out.md',
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    assert.equal(requiredValue(requiredValue(result.config!.agents[0], 'tests/unit/team-config.test.ts:1204').produces![0], 'tests/unit/team-config.test.ts:1205').path, 'research/deep/brief.md')
    assert.equal(requiredValue(requiredValue(result.config!.agents[0], 'tests/unit/team-config.test.ts:1205').produces![0], 'tests/unit/team-config.test.ts:1206').description, 'Nested output')
  })
})

// ── Test 14: Error for gate transform input without source ────────────────────

test('parseTeamConfig emits error for gate transform input without source', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: alpha
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md`,
      gateArtifact: 'output.md',
      stageOutputFormat: 'stage-output.md',
      gateTransformBlock: `
    transform:
      type: agent
      agent: alpha
      input: missing-transform-input.md`,
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null, 'Expected parse to fail')
    const error = result.errors.find(w =>
      w.includes("transform input 'missing-transform-input.md'") &&
      w.includes('no agent declares producing')
    )
    assert.ok(error, `Expected transform input error, got errors: ${result.errors.join('; ')}`)
  })
})

// ── Test 15: No error when gate transform input matches gate condition artifact

test('parseTeamConfig no error when gate transform input matches gate condition artifact', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: alpha
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md`,
      gateArtifact: 'output.md',
      stageOutputFormat: 'stage-output.md',
      gateTransformBlock: `
    transform:
      type: agent
      agent: alpha
      input: output.md`,
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    const transformError = result.errors.find(w =>
      w.includes("transform input 'output.md'") &&
      w.includes('no agent declares producing')
    )
    assert.equal(transformError, undefined, `Expected no transform input error, got: ${result.errors.join('; ')}`)
  })
})

// ── Test 16: Error for empty path in produces ─────────────────────────────────

test('parseTeamConfig emits error for empty path in produces', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: alpha
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: ""`,
      gateArtifact: 'output.md',
      stageOutputFormat: 'output.md',
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null, 'Expected parse to fail')
    const error = result.errors.find(w =>
      w.includes("'alpha'") &&
      w.includes('empty path')
    )
    assert.ok(error, `Expected empty path error, got errors: ${result.errors.join('; ')}`)
  })
})

// ── Test 17: No warning when team-type agent output_artifact satisfies consumes

test('parseTeamConfig no warning when team-type agent output_artifact satisfies consumes', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: subteam
    type: team
    role: subteam
    tier: strategic
    agent_file: agents/alpha/alpha.md
    output_artifact: brief.md
  - name: alpha
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md
    consumes:
      - path: brief.md`,
      coordinatorName: 'alpha',
      participantName: 'alpha',
      gateArtifact: 'output.md',
      stageOutputFormat: 'stage-output.md',
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    const noProducerError = result.errors.find(w =>
      w.includes("brief.md") &&
      w.includes('no agent declares producing it')
    )
    assert.equal(noProducerError, undefined, `Expected no 'no producer' error for brief.md, got: ${result.errors.join('; ')}`)
  })
})

// ── Test 18: GAP-1 — Error for empty path in consumes ─────────────────────────

test('parseTeamConfig emits error for empty path in consumes', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: alpha
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md
    consumes:
      - path: ""`,
      gateArtifact: 'output.md',
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)
    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null, 'Expected parse to fail')
    const error = result.errors.find(e =>
      e.includes("'alpha'") && e.includes('consumes') && e.includes('empty path')
    )
    assert.ok(error, `Expected empty consumes-path error, got: ${result.errors.join('; ')}`)
  })
})

// ── Test 19: GAP-3 — Non-artifact_exists gates skip Check 1 ──────────────────

test('parseTeamConfig does not require produces for non-artifact_exists gates', () => {
  withTempDir((dir) => {
    const yaml = `
team:
  name: test-team
agents:
  - name: alpha
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/alpha/alpha.md
levels:
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: discussion
      coordinator: alpha
      participants:
        - alpha
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 3
        constraints:
          max_time_minutes: 5
          max_budget_usd: 1
        output:
          format: output.md
gates:
  - from: l1
    to: done
    condition:
      type: all_tasks_terminal
`
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)
    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    assert.equal(result.errors.length, 0, `Expected zero errors, got: ${result.errors.join('; ')}`)
  })
})

// ── Test 20: GAP-4 — Check 4 passes when transform input is a declared producer

test('parseTeamConfig no error when gate transform input is a declared producer different from condition artifact', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: alpha
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md
      - path: brief.md`,
      gateArtifact: 'output.md',
      gateTransformBlock: `
    transform:
      type: agent
      agent: alpha
      input: brief.md`,
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)
    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    assert.equal(result.errors.filter(e => e.includes('transform input')).length, 0,
      `Expected no transform input errors, got: ${result.errors.join('; ')}`)
  })
})

// ── Test 21: GAP-5 — Multiple simultaneous errors are all collected ───────────

test('parseTeamConfig collects all artifact contract errors simultaneously', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: alpha
    type: agent
    role: producer
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: ""
      - path: valid.md
  - name: beta
    type: agent
    role: consumer
    tier: strategic
    agent_file: agents/alpha/alpha.md
    consumes:
      - path: missing-consumed.md`,
      coordinatorName: 'alpha',
      participantName: 'alpha',
      gateArtifact: 'missing-gate.md',
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)
    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null, 'Expected parse to fail')
    assert.ok(result.errors.length >= 3,
      `Expected at least 3 errors, got ${result.errors.length}: ${result.errors.join('; ')}`)
    assert.ok(result.errors.some(e => e.includes('empty path')), 'Expected Check 0 error')
    assert.ok(result.errors.some(e => e.includes('missing-gate.md')), 'Expected Check 1 error')
    assert.ok(result.errors.some(e => e.includes('missing-consumed.md')), 'Expected Check 2 error')
  })
})

// ── Test 22: GAP-6 — Self-referencing produces+consumes is accepted ───────────

test('parseTeamConfig accepts agent that produces and consumes the same artifact', () => {
  withTempDir((dir) => {
    const yaml = makeContractYaml({
      agentsBlock: `  - name: alpha
    type: agent
    role: transformer
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: report.md
      - path: output.md
    consumes:
      - path: report.md`,
      gateArtifact: 'output.md',
    })
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)
    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    assert.equal(result.errors.length, 0, 'Expected zero errors for self-referencing')
    assert.equal(result.warnings.filter(w => w.includes('report.md')).length, 0,
      'Expected no warnings for self-referencing')
  })
})

// ── Context Strategy + Rate Limiting Config Tests (T8 additions) ──────────────

/**
 * Minimal discussion YAML with optional context strategy fields injected into
 * the stage `config:` block. Agent alpha declares `produces: output.md` so
 * gate artifact validation passes.
 */
function makeContextYaml(extraConfigLines: string = ''): string {
  return `
team:
  name: test-team
agents:
  - name: alpha
    type: agent
    role: test agent
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md
levels:
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: discussion
      coordinator: alpha
      participants:
        - alpha
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
${extraConfigLines}
        constraints:
          max_time_minutes: 5
          max_budget_usd: 1
        output:
          format: output.md
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`
}

/**
 * Minimal team YAML with a top-level rate_limiting section.
 */
function makeRateLimitYaml(maxConcurrent: number, delayBetweenMs: number): string {
  return `
team:
  name: test-team
rate_limiting:
  max_concurrent: ${maxConcurrent}
  delay_between_ms: ${delayBetweenMs}
agents:
  - name: alpha
    type: agent
    role: test agent
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md
levels:
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: discussion
      coordinator: alpha
      participants:
        - alpha
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        constraints:
          max_time_minutes: 5
          max_budget_usd: 1
        output:
          format: output.md
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`
}

// ── Test 16: Parse rolling_summary with summarize_after_rounds ────────────────

test('parseTeamConfig parses context_strategy: rolling_summary with summarize_after_rounds: 5', () => {
  withTempDir((dir) => {
    const yaml = makeContextYaml('        context_strategy: rolling_summary\n        summarize_after_rounds: 5')
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    assert.equal(result.errors.length, 0, `Expected no errors, got: ${result.errors.join('; ')}`)

    const stage = requiredValue(result.config!.levels[0], 'tests/unit/team-config.test.ts:1599').stage as any
    assert.equal(stage.config.context_strategy, 'rolling_summary', 'context_strategy should be rolling_summary')
    assert.equal(stage.config.summarize_after_rounds, 5, 'summarize_after_rounds should be 5')
  })
})

// ── Test 17: Parse recent_N with context_window_rounds ────────────────────────

test('parseTeamConfig parses context_strategy: recent_N with context_window_rounds: 3', () => {
  withTempDir((dir) => {
    const yaml = makeContextYaml('        context_strategy: recent_N\n        context_window_rounds: 3')
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    assert.equal(result.errors.length, 0, `Expected no errors, got: ${result.errors.join('; ')}`)

    const stage = requiredValue(result.config!.levels[0], 'tests/unit/team-config.test.ts:1616').stage as any
    assert.equal(stage.config.context_strategy, 'recent_N', 'context_strategy should be recent_N')
    assert.equal(stage.config.context_window_rounds, 3, 'context_window_rounds should be 3')
  })
})

// ── Test 18: Parse rate_limiting section ──────────────────────────────────────

test('parseTeamConfig parses rate_limiting: { max_concurrent: 5, delay_between_ms: 200 }', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'team.yaml'), makeRateLimitYaml(5, 200))

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    assert.equal(result.errors.length, 0, `Expected no errors, got: ${result.errors.join('; ')}`)

    assert.ok(result.config!.rateLimiting, 'rateLimiting should be present')
    assert.equal(result.config!.rateLimiting!.maxConcurrent, 5, 'maxConcurrent should be 5')
    assert.equal(result.config!.rateLimiting!.delayBetweenMs, 200, 'delayBetweenMs should be 200')
  })
})

// ── Test 19: Default context strategy is absent (undefined) when omitted ──────

test('parseTeamConfig: default context strategy is absent (undefined) when omitted', () => {
  withTempDir((dir) => {
    // No context_strategy field in config
    fs.writeFileSync(path.join(dir, 'team.yaml'), makeContextYaml())

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)

    const stage = requiredValue(result.config!.levels[0], 'tests/unit/team-config.test.ts:1648').stage as any
    assert.equal(
      stage.config.context_strategy,
      undefined,
      'context_strategy should be undefined when omitted (default applied at runtime by engine)',
    )
  })
})

// ── Test 20: No rateLimiting key on TeamConfig when section is omitted ─────────

test('parseTeamConfig: no rateLimiting key on TeamConfig when rate_limiting section is omitted', () => {
  withTempDir((dir) => {
    // Use a basic YAML with no rate_limiting section
    fs.writeFileSync(path.join(dir, 'team.yaml'), makeContextYaml())

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)

    assert.equal(
      result.config!.rateLimiting,
      undefined,
      'rateLimiting should be undefined when rate_limiting section is absent',
    )
  })
})

// ── Test 21: rolling_summary without summarize_after_rounds → field absent ────

test('parseTeamConfig: context_strategy rolling_summary without summarize_after_rounds — field absent (default applied at runtime)', () => {
  withTempDir((dir) => {
    // Only context_strategy set, no summarize_after_rounds
    const yaml = makeContextYaml('        context_strategy: rolling_summary')
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse, errors: ${result.errors.join('; ')}`)
    assert.equal(result.errors.length, 0, `Expected no errors, got: ${result.errors.join('; ')}`)

    const stage = requiredValue(result.config!.levels[0], 'tests/unit/team-config.test.ts:1687').stage as any
    assert.equal(stage.config.context_strategy, 'rolling_summary', 'context_strategy should be rolling_summary')
    // summarize_after_rounds is absent from parsed config; engine applies DEFAULT_SUMMARIZE_AFTER_ROUNDS at runtime
    assert.equal(
      stage.config.summarize_after_rounds,
      undefined,
      'summarize_after_rounds should be absent when not specified (default applied by engine)',
    )
  })
})

// ── Test 22: context_window_rounds: 0 with recent_N → warning + clamped to 1 ──

test('parseTeamConfig: context_window_rounds: 0 with recent_N — warning emitted and value clamped to 1', () => {
  withTempDir((dir) => {
    // context_window_rounds: 0 is provided (not null/undefined), so no "required" error fires.
    // But 0 < 1 triggers a warning and the value is clamped to 1.
    const yaml = makeContextYaml('        context_strategy: recent_N\n        context_window_rounds: 0')
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse (warning, not error), errors: ${result.errors.join('; ')}`)
    assert.equal(result.errors.length, 0, `Expected no errors, got: ${result.errors.join('; ')}`)

    const warning = result.warnings.find(w => w.includes('context_window_rounds') && w.includes('clamping'))
    assert.ok(warning, `Expected warning about context_window_rounds clamping, got warnings: ${result.warnings.join('; ')}`)

    const stage = requiredValue(result.config!.levels[0], 'tests/unit/team-config.test.ts:1714').stage as any
    assert.equal(
      stage.config.context_window_rounds,
      1,
      'context_window_rounds should be clamped to 1 when specified as 0',
    )
  })
})

// ── Test 23: summarize_after_rounds: 0 with rolling_summary → warning + clamped ─

test('parseTeamConfig: summarize_after_rounds: 0 with rolling_summary — warning emitted and value clamped to 1', () => {
  withTempDir((dir) => {
    const yaml = makeContextYaml('        context_strategy: rolling_summary\n        summarize_after_rounds: 0')
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected successful parse (warning, not error), errors: ${result.errors.join('; ')}`)
    assert.equal(result.errors.length, 0, `Expected no errors, got: ${result.errors.join('; ')}`)

    const warning = result.warnings.find(w => w.includes('summarize_after_rounds') && w.includes('clamping'))
    assert.ok(warning, `Expected warning about summarize_after_rounds clamping, got warnings: ${result.warnings.join('; ')}`)

    const stage = requiredValue(result.config!.levels[0], 'tests/unit/team-config.test.ts:1737').stage as any
    assert.equal(
      stage.config.summarize_after_rounds,
      1,
      'summarize_after_rounds should be clamped to 1 when specified as 0',
    )
  })
})

test('parseTeamConfig errors when a gate has no condition', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'team.yaml'), `
team:
  name: missing-condition-team
agents:
  - name: alpha
    type: agent
    role: test agent
    tier: strategic
    agent_file: agents/alpha/alpha.md
levels:
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: discussion
      coordinator: alpha
      participants:
        - alpha
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        constraints:
          max_time_minutes: 5
          max_budget_usd: 1
        output:
          format: output.md
gates:
  - from: l1
    to: done
`)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null)
    assert.match(result.errors.join('\n'), /Gate from 'l1' to 'done' is missing a 'condition' mapping/)
  })
})

/**
 * A grade a Team file already carries is data, not a configuration failure.
 *
 * The runtime's own vocabulary was `orchestration | strategic | execution`, and
 * an Agent authored under a different one — `specialist`, say, which the
 * Resource Architect used to produce — is on somebody's disk right now. It no
 * longer selects anything, so refusing the whole Team over it would break a
 * Team that is otherwise entirely valid, for a label nothing reads.
 *
 * The checks this parser actually makes are unaffected — `type` is still an
 * enum, and the reference and artifact validators still run. It has never
 * refused a member for having no role, and that is not changed here either.
 */
test('a Team carrying a retired grade still parses, and the grade is not obeyed', () => {
  for (const retired of ['specialist', 'tactical', 'orchestartion', '']) {
    withTempDir((dir) => {
      const yaml = makeMinimalYaml({ tier: retired })
      fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

      const result = parseTeamConfig(path.join(dir, 'team.yaml'))

      assert.deepEqual(
        result.errors,
        [],
        `a retired grade '${retired}' must not fail the Team: ${result.errors.join('; ')}`,
      )
      assert.ok(result.config, `no config for retired grade '${retired}'`)
      assert.deepEqual(result.config!.agents.map((agent) => agent.name), ['alpha'])
      assert.equal(result.config!.agents[0]?.role, 'test agent')
      // Carried as written, so a caller can still see what the file says.
      assert.equal(result.config!.agents[0]?.tier, retired === '' ? undefined : retired)
      // The file is read, never rewritten.
      assert.equal(fs.readFileSync(path.join(dir, 'team.yaml'), 'utf8'), yaml)
      // And the setting is disclosed rather than silently obeyed or dropped
      // (§5): a Team that predates the change says so in its warnings.
      if (retired !== '') {
        assert.ok(
          result.warnings.some(
            (warning) => warning.includes('tier') && warning.includes('ignored'),
          ),
          `expected an ignored-tier warning, got: ${result.warnings.join('; ')}`,
        )
      }
    })
  }
})

test('a member whose type is not a member type still fails, retired grade or not', () => {
  // The control for the change above: this parser's real enum check is on
  // `type`, and it is untouched. Only the grade stopped being judged.
  withTempDir((dir) => {
    const yaml = makeMinimalYaml({ tier: 'specialist' }).replace(
      '    type: agent\n',
      '    type: workflow\n',
    )
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))

    assert.ok(
      result.errors.some((error) => error.includes("agent 'type'")),
      `an unknown member type must still be refused: ${result.errors.join('; ')}`,
    )
  })
})
