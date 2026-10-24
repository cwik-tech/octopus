import { requiredValue } from '../../core/required-value.js'
/**
 * Integration tests for S1: Conditional Routing — parseTeamConfig with real YAML
 *
 * These tests exercise the full parseTeamConfig() pipeline with YAML fixture
 * strings that include artifact_content and agent_verdict gates. They validate:
 *   - Full parse round-trip for new condition types
 *   - Warning/error emission via the integrated validator pipeline
 *   - Backward compatibility for single-gate configs
 *   - UJ-3 (fallback warning), UJ-4 (invalid validator), UJ-5 (backward compat)
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseTeamConfig } from '../../parsers/team-config.js'
import type { GateCondition } from '../../core/types.js'

// ── helpers ───────────────────────────────────────────────────────────────────

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-integ-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function makeAgentDir(dir: string, name: string): void {
  const agentDir = path.join(dir, 'agents', name)
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, `${name}.md`), `# ${name}`)
}

// Base YAML template — agents + levels, gates injected per test
function makeYaml(gates: string, extraAgents = ''): string {
  return `
team:
  name: test-team
agents:
  - name: worker
    type: agent
    role: does work
    tier: strategic
    agent_file: agents/worker/worker.md
    produces:
      - path: output.md
  - name: validator
    type: agent
    role: validates things
    tier: strategic
    agent_file: agents/validator/validator.md
${extraAgents}
levels:
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: discussion
      coordinator: worker
  - id: l2
    name: Level 2
    order: 1
    stage:
      type: discussion
      coordinator: worker
  - id: done
    name: Done
    order: 2
    stage:
      type: discussion
      coordinator: worker
gates:
${gates}
`
}

// ── S1 Integration Tests ──────────────────────────────────────────────────────

describe('S1 Integration: parseTeamConfig with new condition types', () => {
  it('INT-1: artifact_content gate parses correctly from YAML — contains match_type', () => {
    withTempDir((dir) => {
      makeAgentDir(dir, 'worker')
      makeAgentDir(dir, 'validator')

      const yaml = makeYaml(`
  - from: l1
    to: l2
    condition:
      type: artifact_content
      artifact: output.md
      match: "classification: technical"
      match_type: contains
`)
      fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

      const result = parseTeamConfig(path.join(dir, 'team.yaml'))
      assert.equal(result.errors.length, 0, `Unexpected errors: ${result.errors.join(', ')}`)

      const gate = result.config?.gates[0]
      assert.ok(gate, 'gate should exist')
      const cond = gate.condition as Extract<GateCondition, { type: 'artifact_content' }>
      assert.equal(cond.type, 'artifact_content')
      assert.equal(cond.artifact, 'output.md')
      assert.equal(cond.match, 'classification: technical')
      assert.equal(cond.match_type, 'contains')
    })
  })

  it('INT-2: artifact_content gate with regex match_type parses correctly', () => {
    withTempDir((dir) => {
      makeAgentDir(dir, 'worker')
      makeAgentDir(dir, 'validator')

      const yaml = makeYaml(`
  - from: l1
    to: l2
    condition:
      type: artifact_content
      artifact: output.md
      match: "^classification:\\s+technical"
      match_type: regex
`)
      fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

      const result = parseTeamConfig(path.join(dir, 'team.yaml'))
      assert.equal(result.errors.length, 0, `Unexpected errors: ${result.errors.join(', ')}`)

      const gate = result.config?.gates[0]
      assert.ok(gate)
      const cond = gate.condition as Extract<GateCondition, { type: 'artifact_content' }>
      assert.equal(cond.type, 'artifact_content')
      assert.equal(cond.match_type, 'regex')
    })
  })

  it('INT-3: artifact_content gate with no match_type defaults to "contains"', () => {
    withTempDir((dir) => {
      makeAgentDir(dir, 'worker')
      makeAgentDir(dir, 'validator')

      const yaml = makeYaml(`
  - from: l1
    to: l2
    condition:
      type: artifact_content
      artifact: output.md
      match: "technical"
`)
      fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

      const result = parseTeamConfig(path.join(dir, 'team.yaml'))
      assert.equal(result.errors.length, 0, `Unexpected errors: ${result.errors.join(', ')}`)

      const gate = result.config?.gates[0]
      assert.ok(gate)
      const cond = gate.condition as Extract<GateCondition, { type: 'artifact_content' }>
      assert.equal(cond.match_type, 'contains')
      assert.notEqual(cond.match_type, undefined, 'match_type must be explicit "contains", not undefined')
    })
  })

  it('INT-4: agent_verdict gate parses correctly from YAML', () => {
    withTempDir((dir) => {
      makeAgentDir(dir, 'worker')
      makeAgentDir(dir, 'validator')

      const yaml = makeYaml(`
  - from: l1
    to: l2
    condition:
      type: agent_verdict
      validator: validator
      verdict: APPROVE
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`)
      fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

      const result = parseTeamConfig(path.join(dir, 'team.yaml'))
      assert.equal(result.errors.length, 0, `Unexpected errors: ${result.errors.join(', ')}`)

      const verdictGate = result.config?.gates.find((g) => {
        const c = g.condition as GateCondition
        return c.type === 'agent_verdict'
      })
      assert.ok(verdictGate, 'agent_verdict gate should be present')
      const cond = verdictGate.condition as Extract<GateCondition, { type: 'agent_verdict' }>
      assert.equal(cond.validator, 'validator')
      assert.equal(cond.verdict, 'APPROVE')
    })
  })

  it('INT-5 (UJ-4): error emitted for agent_verdict referencing nonexistent validator', () => {
    withTempDir((dir) => {
      makeAgentDir(dir, 'worker')
      makeAgentDir(dir, 'validator')

      const yaml = makeYaml(`
  - from: l1
    to: l2
    condition:
      type: agent_verdict
      validator: quality-checker
      verdict: APPROVE
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`)
      fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

      const result = parseTeamConfig(path.join(dir, 'team.yaml'))
      const hasValidatorError = result.errors.some(
        (e) => e.includes('quality-checker') && e.toLowerCase().includes('not found'),
      )
      assert.ok(hasValidatorError, `Expected error about missing validator 'quality-checker'. Got: ${result.errors.join('; ')}`)
    })
  })

  it('INT-6 (UJ-3): warning emitted for multi-gate level without fallback', () => {
    withTempDir((dir) => {
      makeAgentDir(dir, 'worker')
      makeAgentDir(dir, 'validator')

      const yaml = makeYaml(`
  - from: l1
    to: l2
    condition:
      type: artifact_content
      artifact: output.md
      match: technical
  - from: l1
    to: done
    condition:
      type: artifact_content
      artifact: output.md
      match: commercial
`)
      fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

      const result = parseTeamConfig(path.join(dir, 'team.yaml'))
      const hasWarning = result.warnings.some(
        (w) => w.toLowerCase().includes('fallback') || w.toLowerCase().includes('l1'),
      )
      assert.ok(hasWarning, `Expected fallback warning for level 'l1'. Got warnings: ${result.warnings.join('; ')}`)
    })
  })

  it('INT-7 (UJ-3): no fallback warning when last gate is artifact_exists fallback', () => {
    withTempDir((dir) => {
      makeAgentDir(dir, 'worker')
      makeAgentDir(dir, 'validator')

      const yaml = makeYaml(`
  - from: l1
    to: l2
    condition:
      type: artifact_content
      artifact: output.md
      match: technical
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`)
      fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

      const result = parseTeamConfig(path.join(dir, 'team.yaml'))
      const hasFallbackWarning = result.warnings.some(
        (w) => w.toLowerCase().includes('fallback'),
      )
      assert.equal(hasFallbackWarning, false, `Unexpected fallback warning. Warnings: ${result.warnings.join('; ')}`)
    })
  })

  it('INT-8 (UJ-5): single-gate config produces no new warnings (backward compat)', () => {
    withTempDir((dir) => {
      makeAgentDir(dir, 'worker')
      makeAgentDir(dir, 'validator')

      const yaml = makeYaml(`
  - from: l1
    to: l2
    condition:
      type: artifact_exists
      artifact: output.md
`)
      fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

      const result = parseTeamConfig(path.join(dir, 'team.yaml'))
      assert.equal(result.errors.length, 0, `Unexpected errors: ${result.errors.join(', ')}`)
      // No conditional routing warnings for a single-gate config
      const hasRoutingWarning = result.warnings.some(
        (w) => w.toLowerCase().includes('fallback') || w.toLowerCase().includes('conditional'),
      )
      assert.equal(hasRoutingWarning, false, `Unexpected routing warning: ${result.warnings.join('; ')}`)
    })
  })

  it('INT-9: multiple gates from same level — all gates in parsed config in order', () => {
    withTempDir((dir) => {
      makeAgentDir(dir, 'worker')
      makeAgentDir(dir, 'validator')

      const yaml = makeYaml(`
  - from: l1
    to: l2
    condition:
      type: artifact_content
      artifact: output.md
      match: technical
  - from: l1
    to: done
    condition:
      type: artifact_content
      artifact: output.md
      match: commercial
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`)
      fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

      const result = parseTeamConfig(path.join(dir, 'team.yaml'))
      // No errors (validator references etc)
      assert.equal(result.errors.length, 0, `Errors: ${result.errors.join(', ')}`)

      const l1Gates = result.config?.gates.filter((g) => g.from === 'l1') ?? []
      assert.equal(l1Gates.length, 3, 'Should have 3 gates from l1')

      // Check order is preserved
      const cond0 = requiredValue(l1Gates[0], 'tests/unit/s1-integration-conditional-routing.test.ts:342').condition as Extract<GateCondition, { type: 'artifact_content' }>
      const cond1 = requiredValue(l1Gates[1], 'tests/unit/s1-integration-conditional-routing.test.ts:343').condition as Extract<GateCondition, { type: 'artifact_content' }>
      const cond2 = requiredValue(l1Gates[2], 'tests/unit/s1-integration-conditional-routing.test.ts:344').condition as GateCondition
      assert.equal(cond0.match, 'technical')
      assert.equal(cond1.match, 'commercial')
      assert.equal(cond2.type, 'artifact_exists')
    })
  })

  it('INT-10: warning for empty match string on artifact_content', () => {
    withTempDir((dir) => {
      makeAgentDir(dir, 'worker')
      makeAgentDir(dir, 'validator')

      const yaml = makeYaml(`
  - from: l1
    to: l2
    condition:
      type: artifact_content
      artifact: output.md
      match: ""
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`)
      fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)

      const result = parseTeamConfig(path.join(dir, 'team.yaml'))
      const hasEmptyMatchWarning = result.warnings.some(
        (w) => w.toLowerCase().includes('match') || w.toLowerCase().includes('empty'),
      )
      assert.ok(hasEmptyMatchWarning, `Expected warning for empty match string. Warnings: ${result.warnings.join('; ')}`)
    })
  })
})
