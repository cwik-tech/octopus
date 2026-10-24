import { requiredValue } from '../../core/required-value.js'
/**
 * Unit tests for conditional routing: new gate condition types and validation logic.
 *
 * Covers:
 *  - parseGateCondition() via parseTeamConfig() — tests 1–5
 *  - validateConditionalRouting() — tests 6–10
 *  - checkGate() for artifact_content — tests 11–16
 *  - checkGate() for agent_verdict (with runAgent mock) — tests 17–20
 *  - tryAdvanceLevel() routing table loop behavior — tests 21–28
 *
 * NOTE: The project uses node:test (not Vitest). Top-level await is valid here
 * because the package has "type": "module" and target is ES2022.
 */

import { describe, it, mock, before, after, afterEach } from 'node:test'
import assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTeamConfig } from '../../parsers/team-config.js'
import { validateConditionalRouting } from '../../parsers/config-validator.js'
import type { GateConfig, LevelConfig, LevelState, RuntimeState } from '../../core/types.js'
import { DEFAULT_MAX_LOOPBACKS, STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── runAgent mock ─────────────────────────────────────────────────────────────
// mock.module must be called before gate-checker.js is first loaded so that the
// module picks up the mocked agent-runner at import time.  Using top-level await
// to ensure the dynamic import of gate-checker.js happens AFTER the mock is set.

let lastRunAgentOptions: Record<string, unknown> | null = null
let agentRunnerImpl: () => Promise<{ text: string; cost: number }> = async () => ({
  text: 'APPROVE\n',
  cost: 0,
})

mock.module('../../domains/agent-execution/agent-runner.js', {
  namedExports: {
    runAgent: mock.fn(async (options: Record<string, unknown>) => {
      lastRunAgentOptions = options
      return agentRunnerImpl()
    }),
  },
})

// Dynamic import of gate-checker AFTER mock is registered — ensures gate-checker
// imports the mocked agent-runner rather than the real one.
const { checkGate } = await import('../../engines/gate-checker.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

function createState(): RuntimeState {
  return {
    sessionId: 'test-session',
    currentLevelIndex: 0,
    levelStates: new Map(),
    totalCost: 0,
    startTime: 0,
    timerStarted: false,
    endTime: null,
    spawnDepth: 0,
  }
}

/**
 * Minimal team.yaml content with one strategic agent called 'worker' that
 * declares producing 'output.md'.  Used as a base for parser tests.
 */
const MINIMAL_YAML_BASE = `
team:
  name: test-team
  description: Test team for conditional routing unit tests

agents:
  - name: worker
    agent_file: /dev/null
    role: Worker agent
    tier: strategic
    produces:
      - path: output.md

levels:
  - id: execute
    name: Execute
    stage:
      type: broadcast
      coordinator: worker
      fan_out:
        - worker
`

// ─────────────────────────────────────────────────────────────────────────────
// Parser tests 1–5: parseGateCondition behaviour via parseTeamConfig()
// ─────────────────────────────────────────────────────────────────────────────

describe('parseGateCondition — artifact_content and agent_verdict', () => {
  let tmpDir: string

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-gate-test-'))
  })

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** Write a YAML file containing the base template plus the given gates block. */
  function writeYaml(gatesBlock: string): string {
    const yamlPath = path.join(tmpDir, 'team.yaml')
    fs.writeFileSync(yamlPath, MINIMAL_YAML_BASE + '\n' + gatesBlock)
    return yamlPath
  }

  it('1: parses artifact_content condition with contains match_type', () => {
    const yamlPath = writeYaml(`
gates:
  - from: execute
    to: done
    condition:
      type: artifact_content
      artifact: output.md
      match: technical
      match_type: contains
`)
    const { config, errors } = parseTeamConfig(yamlPath)
    assert.equal(errors.length, 0, `Expected no errors, got: ${JSON.stringify(errors)}`)
    assert.ok(config, 'Expected non-null config')

    const cond = requiredValue(config!.gates[0], 'tests/unit/conditional-routing.test.ts:132').condition
    assert.equal(cond.type, 'artifact_content')
    if (cond.type === 'artifact_content') {
      assert.equal(cond.artifact, 'output.md')
      assert.equal(cond.match, 'technical')
      assert.equal(cond.match_type, 'contains')
    }
  })

  it('2: parses artifact_content condition with regex match_type', () => {
    const yamlPath = writeYaml(`
gates:
  - from: execute
    to: done
    condition:
      type: artifact_content
      artifact: output.md
      match: technic.*
      match_type: regex
`)
    const { config, errors } = parseTeamConfig(yamlPath)
    assert.equal(errors.length, 0, `Expected no errors, got: ${JSON.stringify(errors)}`)
    assert.ok(config, 'Expected non-null config')

    const cond = requiredValue(config!.gates[0], 'tests/unit/conditional-routing.test.ts:156').condition
    assert.equal(cond.type, 'artifact_content')
    if (cond.type === 'artifact_content') {
      assert.equal(cond.match_type, 'regex')
    }
  })

  it('3: parses artifact_content with no match_type — defaults to "contains" (not undefined)', () => {
    const yamlPath = writeYaml(`
gates:
  - from: execute
    to: done
    condition:
      type: artifact_content
      artifact: output.md
      match: technical
`)
    const { config, errors } = parseTeamConfig(yamlPath)
    assert.equal(errors.length, 0, `Expected no errors, got: ${JSON.stringify(errors)}`)
    assert.ok(config, 'Expected non-null config')

    const cond = requiredValue(config!.gates[0], 'tests/unit/conditional-routing.test.ts:177').condition
    assert.equal(cond.type, 'artifact_content')
    if (cond.type === 'artifact_content') {
      // Must be the string 'contains', NOT undefined
      assert.equal(cond.match_type, 'contains', 'Expected match_type to default to "contains"')
      assert.notEqual(cond.match_type, undefined, 'Expected match_type to be explicit, not undefined')
    }
  })

  it('4: parses agent_verdict condition with validator and verdict', () => {
    const yamlPath = writeYaml(`
gates:
  - from: execute
    to: done
    condition:
      type: agent_verdict
      validator: worker
      verdict: APPROVE
`)
    const { config, errors } = parseTeamConfig(yamlPath)
    assert.equal(errors.length, 0, `Expected no errors, got: ${JSON.stringify(errors)}`)
    assert.ok(config, 'Expected non-null config')

    const cond = requiredValue(config!.gates[0], 'tests/unit/conditional-routing.test.ts:200').condition
    assert.equal(cond.type, 'agent_verdict')
    if (cond.type === 'agent_verdict') {
      assert.equal(cond.validator, 'worker')
      assert.equal(cond.verdict, 'APPROVE')
    }
  })

  it('5: unknown condition type is rejected rather than silently defaulted', () => {
    const yamlPath = writeYaml(`
gates:
  - from: execute
    to: done
    condition:
      type: totally_unknown_condition_type
      artifact: output.md
`)
    const { config, errors } = parseTeamConfig(yamlPath)
    assert.equal(config, null)
    assert.match(errors.join('\n'), /Invalid gate condition 'type' 'totally_unknown_condition_type'/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Parser tests 6–10: validateConditionalRouting() direct calls
// ─────────────────────────────────────────────────────────────────────────────

describe('validateConditionalRouting — routing table validation', () => {
  it('6: emits fallback warning for multi-gate level without fallback', () => {
    const gates: GateConfig[] = [
      {
        from: 'triage',
        to: 'technical',
        condition: { type: 'artifact_content', artifact: 'a.md', match: 'technical', match_type: 'contains' },
      },
      {
        from: 'triage',
        to: 'commercial',
        condition: { type: 'artifact_content', artifact: 'a.md', match: 'commercial', match_type: 'contains' },
      },
    ]
    const errors: string[] = []
    const warnings: string[] = []
    validateConditionalRouting(gates, new Set(['worker']), errors, warnings)
    assert.ok(
      warnings.some((w) => w.includes('no fallback')),
      `Expected fallback warning, got: ${JSON.stringify(warnings)}`,
    )
  })

  it('7: no fallback warning when last gate is artifact_exists', () => {
    // Include an artifact_exists gate as fallback — it also populates knownArtifacts,
    // which prevents Validation D from warning about the artifact_content gate.
    const gates: GateConfig[] = [
      {
        from: 'triage',
        to: 'technical',
        condition: { type: 'artifact_content', artifact: 'output.md', match: 'technical', match_type: 'contains' },
      },
      {
        from: 'triage',
        to: 'done',
        condition: { type: 'artifact_exists', artifact: 'output.md' },
      },
    ]
    const errors: string[] = []
    const warnings: string[] = []
    validateConditionalRouting(gates, new Set(['worker']), errors, warnings)
    assert.ok(
      !warnings.some((w) => w.includes('no fallback')),
      `Expected no fallback warning, got: ${JSON.stringify(warnings)}`,
    )
    // With matching artifact paths, both Validation A and Validation D are satisfied.
    assert.equal(errors.length, 0, `Expected no errors, got: ${JSON.stringify(errors)}`)
    assert.equal(warnings.length, 0, `Expected no warnings at all, got: ${JSON.stringify(warnings)}`)
  })

  it('8: emits error for agent_verdict referencing nonexistent validator', () => {
    const gates: GateConfig[] = [
      {
        from: 'review',
        to: 'done',
        condition: { type: 'agent_verdict', validator: 'quality-checker', verdict: 'APPROVE' },
      },
    ]
    const errors: string[] = []
    const warnings: string[] = []
    validateConditionalRouting(gates, new Set(['worker']), errors, warnings)
    assert.ok(
      errors.some((e) => e.includes('quality-checker')),
      `Expected error mentioning 'quality-checker', got: ${JSON.stringify(errors)}`,
    )
    assert.ok(
      errors.some((e) => e.includes('not found in agent roster')),
      `Expected "not found in agent roster" error, got: ${JSON.stringify(errors)}`,
    )
  })

  it('9: emits warning for empty match string on artifact_content', () => {
    const gates: GateConfig[] = [
      {
        from: 'triage',
        to: 'done',
        condition: { type: 'artifact_content', artifact: 'output.md', match: '', match_type: 'contains' },
      },
    ]
    const errors: string[] = []
    const warnings: string[] = []
    validateConditionalRouting(gates, new Set(['worker']), errors, warnings)
    assert.ok(
      warnings.some((w) => w.includes('empty match string')),
      `Expected empty match string warning, got: ${JSON.stringify(warnings)}`,
    )
  })

  it('10: single-gate configs produce no new warnings (backward compat)', () => {
    const gates: GateConfig[] = [
      {
        from: 'execute',
        to: 'done',
        condition: { type: 'artifact_exists', artifact: 'output.md' },
      },
    ]
    const errors: string[] = []
    const warnings: string[] = []
    validateConditionalRouting(gates, new Set(['worker']), errors, warnings)
    assert.equal(errors.length, 0, `Expected no errors, got: ${JSON.stringify(errors)}`)
    assert.equal(warnings.length, 0, `Expected no warnings, got: ${JSON.stringify(warnings)}`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Gate checker tests 11–16: checkGate with artifact_content conditions
// ─────────────────────────────────────────────────────────────────────────────

describe('checkGate — artifact_content conditions', () => {
  let workspaceDir: string

  before(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-content-test-'))
  })

  after(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true })
  })

  function makeContentGate(matchType: 'contains' | 'regex', match: string, artifact = 'output.md'): GateConfig {
    return {
      from: 'l1',
      to: 'done',
      condition: { type: 'artifact_content', artifact, match, match_type: matchType },
    }
  }

  it('11: artifact_content contains — match found (case-insensitive)', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'output.md'), 'classification: TECHNICAL\nSome details.')
    const gate = makeContentGate('contains', 'technical') // lowercase, file has uppercase
    const result = await checkGate(gate, workspaceDir, createState())
    assert.equal(result.passed, true, `Expected pass, got reason: ${result.reason}`)
  })

  it('12: artifact_content contains — no match', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'output.md'), 'classification: commercial\nDetails here.')
    const gate = makeContentGate('contains', 'technical')
    const result = await checkGate(gate, workspaceDir, createState())
    assert.equal(result.passed, false, `Expected fail`)
    assert.ok(
      result.reason.includes('does not contain'),
      `Expected "does not contain" in reason, got: ${result.reason}`,
    )
  })

  it('13: artifact_content contains — file not found', async () => {
    const gate = makeContentGate('contains', 'technical', 'nonexistent-file.md')
    const result = await checkGate(gate, workspaceDir, createState())
    assert.equal(result.passed, false, 'Expected fail when file does not exist')
    assert.ok(
      result.reason.toLowerCase().includes('not found') || result.reason.includes('Artifact not found'),
      `Expected "not found" in reason, got: ${result.reason}`,
    )
  })

  it('14: artifact_content regex — match found', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'output.md'), 'classification: TECHNICAL_DEEP_DIVE')
    const gate = makeContentGate('regex', 'technic.*deep')
    const result = await checkGate(gate, workspaceDir, createState())
    assert.equal(result.passed, true, `Expected pass, got reason: ${result.reason}`)
  })

  it('15: artifact_content regex — no match', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'output.md'), 'classification: commercial')
    const gate = makeContentGate('regex', 'technic.*')
    const result = await checkGate(gate, workspaceDir, createState())
    assert.equal(result.passed, false, 'Expected fail when regex does not match')
    assert.ok(
      result.reason.includes('does not match'),
      `Expected "does not match" in reason, got: ${result.reason}`,
    )
  })

  it('16: artifact_content regex — invalid regex pattern returns graceful error (no throw)', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'output.md'), 'some content here')
    const gate = makeContentGate('regex', '[invalid(regex') // deliberately broken regex
    const result = await checkGate(gate, workspaceDir, createState())
    assert.equal(result.passed, false, 'Expected fail for invalid regex')
    assert.ok(
      result.reason.toLowerCase().includes('regex') || result.reason.includes('Invalid'),
      `Expected regex-related error in reason, got: ${result.reason}`,
    )
    // Key assertion: checkGate must return gracefully — if it had thrown, the test itself would fail.
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Gate checker tests 17–20: checkGate with agent_verdict conditions
// Uses the runAgent mock established at module level.
// ─────────────────────────────────────────────────────────────────────────────

describe('checkGate — agent_verdict conditions (runAgent mocked)', () => {
  let workspaceDir: string

  before(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-verdict-test-'))
  })

  after(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true })
  })

  afterEach(() => {
    // Restore default implementation so tests don't bleed into each other
    agentRunnerImpl = async () => ({ text: 'APPROVE\n', cost: 0 })
    lastRunAgentOptions = null
  })

  /** Build a minimal agents map with a single named validator entry. */
  function makeAgentMap(name: string): Map<string, import('../../core/types.js').LoadedAgent> {
    const agents = new Map<string, import('../../core/types.js').LoadedAgent>()
    agents.set(name, {
      name,
      systemPrompt: 'You are a validator. Respond with a single verdict token on the first line.',
      model: 'claude-3-5-sonnet-20241022',
      thinking: 'low',
      agentDir: '/dev/null',
      knowledgeContent: '',
      // The pair this validator resolved, matching the `provider`/`model`
      // below. The loader always sets these together — `selection: null` means
      // no pair could be chosen at all, and then `provider` and `model` are
      // empty — so a fixture naming a concrete pair with a null selection
      // described an Agent that cannot exist.
      selection: {
        provider: 'pi',
        model: 'claude-3-5-sonnet-20241022',
        source: 'agent',
        reason: 'explicit-agent-choice',
      },
      experienceContent: '',
      experienceEnabled: true,
      skillsContent: '',
      color: 36,
      provider: 'pi',
      providerConfig: { sandbox: 'workspace-write' },
    })
    return agents
  }

  function makeVerdictGate(validator: string, verdict: string): GateConfig {
    return {
      from: 'review',
      to: 'done',
      condition: { type: 'agent_verdict', validator, verdict },
    }
  }

  it('17: agent_verdict — mock agent returns expected verdict (APPROVE) → passes', async () => {
    agentRunnerImpl = async () => ({ text: 'APPROVE\n', cost: 0 })
    const gate = makeVerdictGate('reviewer', 'APPROVE')
    const result = await checkGate(gate, workspaceDir, createState(), makeAgentMap('reviewer'))
    assert.equal(result.passed, true, `Expected pass, got reason: ${result.reason}`)
    assert.ok(
      result.reason.includes('APPROVE'),
      `Expected 'APPROVE' in reason, got: ${result.reason}`,
    )
  })

  it('18: agent_verdict — mock agent returns different verdict (REJECT) → fails', async () => {
    agentRunnerImpl = async () => ({ text: 'REJECT\nSome explanation.', cost: 0 })
    const gate = makeVerdictGate('reviewer', 'APPROVE')
    const result = await checkGate(gate, workspaceDir, createState(), makeAgentMap('reviewer'))
    assert.equal(result.passed, false, 'Expected fail when agent returns REJECT but APPROVE expected')
    assert.ok(
      result.reason.includes('REJECT'),
      `Expected 'REJECT' in failure reason, got: ${result.reason}`,
    )
  })

  it('19: agent_verdict — validator not found in agents map → passes: false', async () => {
    const gate = makeVerdictGate('nonexistent-validator', 'APPROVE')
    // Provide a map that does NOT include 'nonexistent-validator'
    const result = await checkGate(gate, workspaceDir, createState(), makeAgentMap('other-agent'))
    assert.equal(result.passed, false, 'Expected fail when validator not in agents map')
    assert.ok(
      result.reason.toLowerCase().includes('not found'),
      `Expected "not found" in reason, got: ${result.reason}`,
    )
  })

  it('20: agent_verdict — agent execution error → passes: false with error reason', async () => {
    agentRunnerImpl = async () => {
      throw new Error('Simulated network failure')
    }
    const gate = makeVerdictGate('reviewer', 'APPROVE')
    const result = await checkGate(gate, workspaceDir, createState(), makeAgentMap('reviewer'))
    assert.equal(result.passed, false, 'Expected fail when agent throws')
    // The fault this test owns, by name. Accepting any reason containing
    // "error" let it pass while the gate was actually refusing for an entirely
    // different reason before it ever dispatched — so it stopped proving that
    // the provider-error path is what produced the failure.
    assert.ok(
      result.reason.includes('Simulated network failure'),
      `Expected the simulated provider failure, got: ${result.reason}`,
    )
  })

  it('21: agent_verdict forwards validator providerConfig to runAgent', async () => {
    agentRunnerImpl = async () => ({ text: 'APPROVE\n', cost: 0 })
    const gate = makeVerdictGate('reviewer', 'APPROVE')
    const result = await checkGate(gate, workspaceDir, createState(), makeAgentMap('reviewer'))
    assert.equal(result.passed, true, `Expected pass, got reason: ${result.reason}`)
    assert.deepEqual(lastRunAgentOptions?.providerConfig, { sandbox: 'workspace-write' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Routing table tests 21–28: tryAdvanceLevel() first-match-wins semantics
//
// Strategy: mock engines/gate-checker.js (checkGate, runGateTransform,
// writeGateReport), experience-reflections.js, and domains/agent-execution/minutes.js at module
// level AFTER the existing checkGate import.  This preserves the real checkGate
// reference used by tests 11-20 (destructuring captures a fixed value), while
// ensuring level-lifecycle.ts — imported after these mocks — picks up the mocked
// gate-checker via its static import statement.
//
// The `checkGateImpl` closure variable is updated per-test to control pass/fail
// for each gate in the routing table.
// ─────────────────────────────────────────────────────────────────────────────

// ── Routing-table mock state ──────────────────────────────────────────────────

type GateMockResult = { passed: boolean; reason: string }
let checkGateImpl: (gate: GateConfig, ...args: unknown[]) => Promise<GateMockResult> =
  async () => ({ passed: true, reason: 'default mock pass' })

const checkGateMockFn = mock.fn(
  async (gate: GateConfig, ...args: unknown[]) => checkGateImpl(gate, ...args),
)
let runGateTransformImpl = async () => ({
  outputPath: 'gate-checks/transform-output.md',
  cost: 0,
} as {
  outputPath: string
  cost: number
  error?: string
  routeUnavailable?: boolean
})
const runGateTransformMockFn = mock.fn(async () => runGateTransformImpl())
const writeGateReportMockFn = mock.fn(async () => {})

// These mock.module calls must be placed BEFORE importing level-lifecycle so
// that level-lifecycle's static imports resolve to the mocked versions.
// They are placed AFTER the existing `const { checkGate } = await import(...)`
// above, so tests 11-20 continue to hold the original real checkGate reference.

// Mock failure-policy.js to break the import chain that would otherwise
// require the engine files (broadcast, pipeline, chain, discussion, review)
// to load agent-runner.js's `dispatchToAgentOrTeam` export — which is absent
// from the existing agent-runner mock (and Node.js disallows re-mocking a
// module that is already mocked).  failure-policy.js is NOT yet loaded at this
// point (no earlier import needs it), so this mock is clean.
mock.module('../../domains/agent-execution/failure-policy.js', {
  namedExports: {
    // Minimal stubs — the routing-table tests never trigger real agent dispatch.
    DispatchResultValidationError: class DispatchResultValidationError extends Error {},
    HaltError: class HaltError extends Error {},
    resolveFailurePolicy: mock.fn(() => ({ policy: 'skip', maxRetries: 0, fallbackAgent: undefined })),
    dispatchWithFailurePolicy: mock.fn(async () => ({ text: '', cost: 0 })),
  },
})

mock.module('../../engines/gate-checker.js', {
  namedExports: {
    checkGate: checkGateMockFn,
    runGateTransform: runGateTransformMockFn,
    writeGateReport: writeGateReportMockFn,
  },
})

const runExperienceReflectionsMockFn = mock.fn(async (_level?: unknown, ..._rest: unknown[]) => {})
mock.module('../../team-runtime/experience-reflections.js', {
  namedExports: {
    runExperienceReflections: runExperienceReflectionsMockFn,
  },
})

mock.module('../../domains/agent-execution/minutes.js', {
  namedExports: {
    generateMinutes: mock.fn(async () => {}),
  },
})

// Import level-lifecycle AFTER mocks are registered — ensures its static
// `import { checkGate } from './engines/gate-checker.js'` picks up the mock.
const { tryAdvanceLevel, isLevelReadyForGate } = await import('../../team-runtime/level-lifecycle.js')
const { writeCheckpoint, readCheckpoint, restoreLevelStatesFromCheckpoint } = await import('../../domains/runtime/checkpoint.js')
const { transitionStageStatus } = await import('../../domains/stage/stage-lifecycle.js')

// ── Fixture helpers ───────────────────────────────────────────────────────────

/**
 * Minimal broadcast stage config — isBroadcastComplete() is controlled via
 * engineState.aggregatedResult rather than file existence, so no files need
 * to be created for isLevelReadyForGate() to return true.
 */
function broadcastStage() {
  return {
    type: 'broadcast' as const,
    fan_out: ['agent1'],
    config: {
      aggregation: 'merge' as const,
      output: { format: 'broadcast-result.md', user_review: false },
    },
  }
}

/**
 * Minimal completed broadcast engine state — makes isLevelReadyForGate()
 * return true for the active level (l1 at index 1).
 */
function completedBroadcastEngine() {
  return {
    type: 'broadcast' as const,
    responses: [] as Array<{ agent: string; text: string; cost: number }>,
    aggregatedResult: 'done',
  }
}

/**
 * Build a four-level array:  l0 (index 0, loopback target) → l1 (index 1,
 * always the active/current level) → l2 (index 2, first forward target) →
 * l3 (index 3, second forward target).
 */
function makeLevels() {
  return [
    { id: 'l0', name: 'Level 0', order: 0, stage: broadcastStage() },
    { id: 'l1', name: 'Level 1', order: 1, stage: broadcastStage() },
    { id: 'l2', name: 'Level 2', order: 2, stage: broadcastStage() },
    { id: 'l3', name: 'Level 3', order: 3, stage: broadcastStage() },
  ]
}

/**
 * Build a RuntimeContext stub with l1 active at index 1.
 * The `teamRoot` must point to a real directory so that logLevelTransition
 * can write level-transitions.jsonl inside the pre-created assignmentPath.
 */
function makeCtx(levels: LevelConfig[], gates: GateConfig[], teamRoot: string) {
  const workspacePath = path.join(teamRoot, 'workspace')
  const levelStates = new Map<string, LevelState>(
    levels.map((l, i) => [
      l.id,
      {
        status: i === 1 ? 'active' : 'pending',
        stageStatus: i === 1 ? STAGE_LIFECYCLE_STATUS.RUNNING : STAGE_LIFECYCLE_STATUS.NOT_STARTED,
        loopbackCount: 0,
        engineState: i === 1 ? completedBroadcastEngine() : null,
      },
    ]),
  )

  return {
    teamConfig: {
      team: { name: 'test', description: 'test', version: '1.0.0' },
      workspace: { path: workspacePath, watch: false },
      models: {},
      levels,
      gates,
      agents: [],
    },
    teamRoot,
    inputFilesContent: '',
    agents: new Map(),
    rosterEntries: new Map(),
    state: {
      sessionId: 'default',
      currentLevelIndex: 1, // l1 is the active level
      levelStates,
      totalCost: 0,
      startTime: 0,
      timerStarted: false,
      endTime: null,
      spawnDepth: 0,
    },
    agentMetrics: new Map(),
    coordinatorRunId: 0,
    levelAdvancedCoordinatorRunId: null,
    activeSpawnCount: 0,
    setupMode: false,
    configErrors: [],
    lastCtx: null,
    refreshTimer: null,
    activeDelegations: new Map(),
    blockedToolCallIds: new Set(),
    currentRegisteredTools: [],
    pendingFollowUps: [],
    pendingFollowUpTimer: null,
    pi: { sendUserMessage: mock.fn() },
    rateLimiter: undefined,
    ENGINE_TOOLS: new Set(),
    shutdownController: new AbortController(),
    budgetLedger: undefined,
  }
}

/** Stub ExtensionContext — only ui.notify is required by tryAdvanceLevel. */
function makeExtCtx() {
  return { ui: { notify: mock.fn() } }
}

/** Stub LifecycleCallbacks. */
function makeCallbacks() {
  return {
    registerLevelTools: mock.fn(),
    // These fixtures assert that the destination is armed at advance time, so
    // they exercise the runtime-owned branch. The host-managed branch, where
    // arming waits for the turn that enters the stage, is covered by I-13 in
    // tests/integration/routing-table-integration.test.ts.
    runtimeOwnsLevel: mock.fn(() => true),
    prepareHostForActiveLevel: mock.fn(async () => true),
    startActiveLevel: mock.fn(async () => false),
    requestRunCompletion: mock.fn(),
    persistState: mock.fn(),
    updateDashboard: mock.fn(),
  }
}

// Gate factory helpers
function forwardGate1(): GateConfig {
  return { from: 'l1', to: 'l2', condition: { type: 'artifact_exists', artifact: 'gate1.md' } }
}
function forwardGate2(): GateConfig {
  return { from: 'l1', to: 'l3', condition: { type: 'artifact_exists', artifact: 'gate2.md' } }
}
function completionGate(): GateConfig {
  return { from: 'l1', to: 'done', condition: { type: 'artifact_exists', artifact: 'output.md' } }
}
function loopbackGate(): GateConfig {
  return { from: 'l1', to: 'l0', condition: { type: 'artifact_exists', artifact: 'loopback.md' } }
}
function gateWithTransform(from: string, to: string): GateConfig {
  return {
    from,
    to,
    condition: { type: 'artifact_exists', artifact: `${to}.md` },
    transform: { type: 'script', script: 'echo done', output: 'gate-checks/out.md' },
  }
}

it('routing gate readiness respects output.path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-output-path-test-'))
  try {
    const level = {
      id: 'route',
      name: 'Route',
      order: 0,
      stage: {
        type: 'routing',
        coordinator: 'worker',
        config: { output: { path: 'decisions', format: 'chosen.md', user_review: false } },
      },
    } as any
    const ctx = {
      state: { levelStates: new Map([['route', { engineState: null }]]) },
    }

    fs.mkdirSync(path.join(dir, 'decisions'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'decisions', 'chosen.md'), '# Decision')

    assert.equal(isLevelReadyForGate(level, dir, ctx as any), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Tests 21–28
// ─────────────────────────────────────────────────────────────────────────────

describe('tryAdvanceLevel — routing table behavior', () => {
  let tmpDir: string
  let assignmentPath: string

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-table-test-'))
    // Pre-create assignmentPath so logLevelTransition can write JSONL files there.
    assignmentPath = path.join(tmpDir, 'workspace', 'assignments', 'default')
    fs.mkdirSync(assignmentPath, { recursive: true })
  })

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  afterEach(() => {
    // Reset mock state between tests to prevent cross-test contamination.
    checkGateImpl = async () => ({ passed: true, reason: 'default mock pass' })
    runGateTransformImpl = async () => ({
      outputPath: 'gate-checks/transform-output.md',
      cost: 0,
    })
    checkGateMockFn.mock.resetCalls()
    runGateTransformMockFn.mock.resetCalls()
    writeGateReportMockFn.mock.resetCalls()
  })

  it('21: single gate from level — backward compat: gate passes → advances to gate target', async () => {
    // Single gate identical to pre-routing-table behavior.
    checkGateImpl = async () => ({ passed: true, reason: 'pass' })

    const levels = makeLevels()
    const gates = [forwardGate1()]
    const ctx = makeCtx(levels, gates, tmpDir)
    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    assert.equal(
      ctx.state.currentLevelIndex,
      2, // l2 is at index 2
      `Expected currentLevelIndex to be 2 (l2), got ${ctx.state.currentLevelIndex}`,
    )
    assert.equal(checkGateMockFn.mock.calls.length, 1, 'Expected checkGate to be called exactly once')
  })

  it('22: two gates from same level — first passes → advances to FIRST gate target (not second)', async () => {
    // First-match-wins: if gate1 passes, gate2 must never be evaluated.
    checkGateImpl = async () => ({ passed: true, reason: 'pass' })

    const levels = makeLevels()
    const gates = [forwardGate1(), forwardGate2()]
    const ctx = makeCtx(levels, gates, tmpDir)
    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    // Must advance to l2 (gate1's target), NOT l3 (gate2's target).
    assert.equal(
      ctx.state.currentLevelIndex,
      2,
      `Expected currentLevelIndex 2 (gate1 target l2), got ${ctx.state.currentLevelIndex}`,
    )
    // Only gate1 should have been evaluated — gate2 is skipped because gate1 won.
    assert.equal(
      checkGateMockFn.mock.calls.length,
      1,
      `Expected checkGate called once (gate1 only), got ${checkGateMockFn.mock.calls.length}`,
    )
  })

  it('23: two gates from same level — first fails, second passes → advances to SECOND gate target', async () => {
    // Routing table must continue to the next gate when the first fails.
    let callIndex = 0
    checkGateImpl = async (gate) => {
      callIndex++
      // gate1 (to l2) fails; gate2 (to l3) passes
      return gate.to === 'l2'
        ? { passed: false, reason: 'gate1 failed' }
        : { passed: true, reason: 'gate2 passed' }
    }

    const levels = makeLevels()
    const gates = [forwardGate1(), forwardGate2()]
    const ctx = makeCtx(levels, gates, tmpDir)
    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    // Must advance to l3 (gate2's target), skipping l2 (gate1's target).
    assert.equal(
      ctx.state.currentLevelIndex,
      3,
      `Expected currentLevelIndex 3 (gate2 target l3), got ${ctx.state.currentLevelIndex}`,
    )
    // Both gates evaluated: gate1 failed → gate2 checked.
    assert.equal(
      checkGateMockFn.mock.calls.length,
      2,
      `Expected checkGate called twice (both gates), got ${checkGateMockFn.mock.calls.length}`,
    )
  })

  it('24: two gates from same level — both fail → no advancement (pipeline waits)', async () => {
    // When no gate passes, the pipeline must not advance.
    checkGateImpl = async () => ({ passed: false, reason: 'gate failed' })

    const levels = makeLevels()
    const gates = [forwardGate1(), forwardGate2()]
    const ctx = makeCtx(levels, gates, tmpDir)
    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    // Level index must remain at 1 (l1 — no advancement).
    assert.equal(
      ctx.state.currentLevelIndex,
      1,
      `Expected currentLevelIndex to remain 1 (no advance), got ${ctx.state.currentLevelIndex}`,
    )
    // persistState (called on successful advance) must NOT have been called.
    assert.equal(
      (callbacks.persistState as ReturnType<typeof mock.fn>).mock.calls.length,
      0,
      'Expected persistState NOT to be called when no gate passes',
    )
  })

  it('25: completion gate in routing table — passes → calls completion handler', async () => {
    // When the winning gate targets "done", handleCompletionGatePassed runs.
    checkGateImpl = async () => ({ passed: true, reason: 'completion check passed' })

    const levels = makeLevels()
    const gates = [completionGate()]
    const ctx = makeCtx(levels, gates, tmpDir)
    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    // endTime is set by handleCompletionGatePassed.
    assert.ok(
      ctx.state.endTime !== null,
      'Expected ctx.state.endTime to be set (completion triggered)',
    )
    // persistState is called inside handleCompletionGatePassed.
    assert.equal(
      (callbacks.persistState as ReturnType<typeof mock.fn>).mock.calls.length,
      1,
      'Expected persistState to be called exactly once (completion)',
    )
    const completionCalls = (callbacks.requestRunCompletion as ReturnType<typeof mock.fn>).mock.calls
    assert.equal(completionCalls.length, 1, 'Expected completion emission to be deferred to the runtime')
    assert.deepEqual(completionCalls[0]?.arguments[0], {
      assignmentPath,
      levelId: 'l1',
      stageType: 'broadcast',
    })
    // ui.notify should announce completion.
    const notifyCalls = (extCtx.ui.notify as ReturnType<typeof mock.fn>).mock.calls
    assert.ok(
      notifyCalls.some((c) => String(c.arguments[0]).includes('complete')),
      `Expected a completion notification, got: ${JSON.stringify(notifyCalls.map((c) => c.arguments[0]))}`,
    )
  })

  it('26: completion gate in routing table — fails → notifies (sole gate)', async () => {
    // When the sole gate is a completion gate and it fails, the failure handler runs.
    checkGateImpl = async () => ({ passed: false, reason: 'output file missing' })

    const levels = makeLevels()
    const gates = [completionGate()]
    const ctx = makeCtx(levels, gates, tmpDir)
    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    // endTime must NOT be set — pipeline is still running.
    assert.equal(
      ctx.state.endTime,
      null,
      'Expected ctx.state.endTime to remain null (completion not triggered)',
    )
    // handleCompletionGateFailed calls ctx.pi.sendUserMessage.
    const sendCalls = (ctx.pi.sendUserMessage as ReturnType<typeof mock.fn>).mock.calls
    assert.ok(
      sendCalls.length >= 1,
      `Expected sendUserMessage to be called (failure notification), got ${sendCalls.length} calls`,
    )
    assert.ok(
      sendCalls.some((c) => String(c.arguments[0]).includes('COMPLETION GATE FAILED')),
      `Expected "COMPLETION GATE FAILED" message, got: ${JSON.stringify(sendCalls.map((c) => c.arguments[0]))}`,
    )
  })

  it('Team chat completes a ready terminal stage without requiring an artifact gate', async () => {
    checkGateImpl = async () => ({ passed: false, reason: 'output artifact is missing' })

    const ctx = makeCtx(makeLevels(), [completionGate()], tmpDir)
    ctx.teamConfig.levels[1] = {
      id: 'l1',
      name: 'Discussion',
      order: 1,
      stage: {
        type: 'discussion',
        coordinator: 'lead',
        participants: ['agent1'],
        config: {
          mode: 'deliberate',
          max_rounds: 3,
          min_rounds: 1,
          constraints: { max_time_minutes: 2, max_budget_usd: 1 },
          output: { format: 'output.md', user_review: false },
        },
      },
    }
    const currentState = ctx.state.levelStates.get('l1')
    assert.ok(currentState)
    currentState.stageStatus = STAGE_LIFECYCLE_STATUS.COMPLETED
    currentState.engineState = {
      type: 'discussion',
      round: 1,
      messages: [],
      outputPath: assignmentPath,
      approvedRoster: ['agent1'],
    }
    const callbacks = {
      ...makeCallbacks(),
      teamChatMode: true,
    }

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, callbacks as never)

    assert.notEqual(ctx.state.endTime, null)
    assert.equal(checkGateMockFn.mock.calls.length, 0)
    assert.equal(callbacks.requestRunCompletion.mock.calls.length, 1)
  })

  it('27: loopback gate wins in routing table — level loops back to earlier level', async () => {
    // When the winning gate targets an earlier level, currentLevelIndex decreases.
    checkGateImpl = async () => ({ passed: true, reason: 'loopback condition met' })

    const levels = makeLevels()
    const gates = [loopbackGate()] // from l1 → to l0 (index 0 < currentLevelIndex 1)
    const ctx = makeCtx(levels, gates, tmpDir)
    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    // Must loop back to l0 at index 0.
    assert.equal(
      ctx.state.currentLevelIndex,
      0,
      `Expected currentLevelIndex 0 (looped back to l0), got ${ctx.state.currentLevelIndex}`,
    )
    // l0's loopbackCount must have been incremented.
    const l0State = ctx.state.levelStates.get('l0')
    assert.ok(l0State, 'Expected l0 state to exist')
    assert.equal(l0State!.loopbackCount, 1, 'Expected l0.loopbackCount to be 1 after loopback')
    // l0 must now be active.
    assert.equal(l0State!.status, 'active', 'Expected l0 to be active after loopback')
  })

  it('27b: a capped loopback is skipped and a later forward gate still advances', async () => {
    checkGateImpl = async () => ({ passed: true, reason: 'gate passed' })

    const levels = makeLevels()
    const ctx = makeCtx(levels, [loopbackGate(), forwardGate1()], tmpDir)
    ctx.state.levelStates.get('l0')!.loopbackCount = DEFAULT_MAX_LOOPBACKS
    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    assert.equal(ctx.state.currentLevelIndex, 2)
    assert.equal(ctx.state.levelStates.get('l1')!.status, 'completed')
    assert.equal(ctx.state.levelStates.get('l2')!.status, 'active')
    assert.equal(checkGateMockFn.mock.calls.length, 2, 'The passed capped loopback and forward gate must both be evaluated')
  })

  it('27c: a route-specific cap overrides the global loopback limit', async () => {
    checkGateImpl = async () => ({ passed: true, reason: 'gate passed' })

    const cappedGate = { ...loopbackGate(), max_loopbacks: 1 }
    const ctx = makeCtx(makeLevels(), [cappedGate, forwardGate1()], tmpDir)
    ctx.state.levelStates.get('l0')!.loopbackCount = 1

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, makeCallbacks() as never)

    assert.equal(ctx.state.currentLevelIndex, 2)
    assert.equal(checkGateMockFn.mock.calls.length, 2)
  })

  it('27d: target_through_source resets every stage in the correction span', async () => {
    checkGateImpl = async () => ({ passed: true, reason: 'revision required' })

    const gate = { ...loopbackGate(), reset_scope: 'target_through_source' as const }
    const ctx = makeCtx(makeLevels(), [gate], tmpDir)
    ctx.state.levelStates.get('l0')!.engineState = completedBroadcastEngine()

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, makeCallbacks() as never)

    assert.equal(ctx.state.levelStates.get('l0')!.status, 'active')
    assert.equal(ctx.state.levelStates.get('l0')!.engineState, null)
    assert.equal(ctx.state.levelStates.get('l1')!.status, 'pending')
    assert.equal(ctx.state.levelStates.get('l1')!.stageStatus, STAGE_LIFECYCLE_STATUS.NOT_STARTED)
    assert.equal(ctx.state.levelStates.get('l1')!.engineState, null)
  })

  it('27e: loopback removes a pipeline runtime snapshot so correction work can be claimed again', async () => {
    checkGateImpl = async () => ({ passed: true, reason: 'revision required' })
    const levels = makeLevels()
    requiredValue(levels[0], 'tests/unit/conditional-routing.test.ts:1048').stage = {
      type: 'pipeline',
      participants: ['worker'],
      config: {
        plan_file: 'research/correction-plan.md',
        parallel: true,
        gate: { type: 'all_tasks_terminal', strictness: 'hard' },
      },
    } as never
    const runtimePlan = path.join(
      assignmentPath,
      '.runtime',
      'pipeline',
      'l0',
      'plan.md',
    )
    fs.mkdirSync(path.dirname(runtimePlan), { recursive: true })
    fs.writeFileSync(runtimePlan, '# completed prior correction plan')
    const ctx = makeCtx(levels, [loopbackGate()], tmpDir)

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, makeCallbacks() as never)

    assert.equal(fs.existsSync(runtimePlan), false)
    assert.equal(ctx.state.currentLevelIndex, 0)
  })

  it('27a: delegated autostart sessions can autostart the next deterministic stage without a follow-up turn', async () => {
    checkGateImpl = async () => ({ passed: true, reason: 'advance to next level' })

    const previousAutostart = process.env.TEAM_DELEGATED_AUTOSTART
    process.env.TEAM_DELEGATED_AUTOSTART = '1'

    try {
      const levels = makeLevels()
      const gates = [forwardGate1()]
      const ctx = makeCtx(levels, gates, tmpDir)
      const extCtx = makeExtCtx()
      const callbacks = makeCallbacks()
      ;(callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => true)

      await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)
      await new Promise((resolve) => setTimeout(resolve, 40))

      const sendCalls = (ctx.pi.sendUserMessage as ReturnType<typeof mock.fn>).mock.calls
      assert.equal(sendCalls.length, 0, `Expected no follow-up message when runtime autostart succeeds, got ${sendCalls.length}`)
      assert.equal((callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.calls.length, 1)
    } finally {
      if (previousAutostart === undefined) delete process.env.TEAM_DELEGATED_AUTOSTART
      else process.env.TEAM_DELEGATED_AUTOSTART = previousAutostart
    }
  })

  it('28: gate transform runs only for the winning gate (not for skipped gates)', async () => {
    // Gate transforms must execute for the winning gate only.
    // Setup: gate1 fails (no transform run), gate2 passes (transform must run).
    checkGateImpl = async (gate) => {
      return gate.to === 'l2'
        ? { passed: false, reason: 'gate1 failed' }
        : { passed: true, reason: 'gate2 passed' }
    }

    const levels = makeLevels()
    const gates = [gateWithTransform('l1', 'l2'), gateWithTransform('l1', 'l3')]
    const ctx = makeCtx(levels, gates, tmpDir)
    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()

    // Pre-create gate-checks dir (executeGateTransformIfNeeded creates it if absent,
    // but mock avoids the real runGateTransform; writeGateReport is also mocked).
    const gateChecksDir = path.join(assignmentPath, 'gate-checks')
    if (!fs.existsSync(gateChecksDir)) fs.mkdirSync(gateChecksDir, { recursive: true })

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    // gate2 won (target l3), so currentLevelIndex must be 3.
    assert.equal(
      ctx.state.currentLevelIndex,
      3,
      `Expected currentLevelIndex 3 (gate2 target l3), got ${ctx.state.currentLevelIndex}`,
    )
    // runGateTransform must have been called exactly once (for gate2 only).
    assert.equal(
      runGateTransformMockFn.mock.calls.length,
      1,
      `Expected runGateTransform called once (winning gate only), got ${runGateTransformMockFn.mock.calls.length}`,
    )
  })

  it('29: write-free loopback refusal falls through to a later forward gate', async () => {
    checkGateImpl = async () => ({ passed: true, reason: 'gate passed' })
    runGateTransformImpl = async () => ({
      outputPath: 'gate-checks/transform-output.md',
      error: 'Script exited with code 69: deadline preflight refused route',
      cost: 0,
      routeUnavailable: true,
    })
    const ctx = makeCtx(
      makeLevels(),
      [gateWithTransform('l1', 'l0'), forwardGate1()],
      tmpDir,
    )
    const extCtx = makeExtCtx()

    await tryAdvanceLevel(extCtx as never, ctx as never, makeCallbacks() as never)

    assert.equal(ctx.state.currentLevelIndex, 2)
    assert.equal(checkGateMockFn.mock.calls.length, 2)
    assert.equal(writeGateReportMockFn.mock.calls.length, 2)
    const notifications = (extCtx.ui.notify as ReturnType<typeof mock.fn>).mock.calls
      .map((call) => String(call.arguments[0]))
    assert.ok(notifications.some((message) => message.includes('write-free preflight')))
  })

  it('30: ordinary hard loopback transform failure still blocks later gates', async () => {
    checkGateImpl = async () => ({ passed: true, reason: 'gate passed' })
    runGateTransformImpl = async () => ({
      outputPath: 'gate-checks/transform-output.md',
      error: 'Script exited with code 1 after materialization started',
      cost: 0,
    })
    const ctx = makeCtx(
      makeLevels(),
      [gateWithTransform('l1', 'l0'), forwardGate1()],
      tmpDir,
    )

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, makeCallbacks() as never)

    assert.equal(ctx.state.currentLevelIndex, 1)
    assert.equal(checkGateMockFn.mock.calls.length, 1)
  })

  it('31: a forward route-unavailable transform still blocks later gates', async () => {
    checkGateImpl = async () => ({ passed: true, reason: 'gate passed' })
    runGateTransformImpl = async () => ({
      outputPath: 'gate-checks/transform-output.md',
      error: 'Script exited with code 69: deadline preflight refused route',
      cost: 0,
      routeUnavailable: true,
    })
    const ctx = makeCtx(
      makeLevels(),
      [gateWithTransform('l1', 'l2'), forwardGate2()],
      tmpDir,
    )

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, makeCallbacks() as never)

    assert.equal(ctx.state.currentLevelIndex, 1)
    assert.equal(checkGateMockFn.mock.calls.length, 1)
  })
})

describe('B2 — loopback revisit semantics', () => {
  /**
   * The full cycle for `reset_scope: target`.
   *
   * Only the target re-runs. The source keeps its completed work, and the
   * forward walk traverses it by re-evaluating its gate against the evidence it
   * already holds — not by re-running it, and not by attempting a transition
   * `completed` cannot accept. The traversed state must be restart-safe at the
   * point that matters: while the retained source is the current level.
   */
  it('B2a: a target-only loopback re-runs the target and traverses the retained source, restart-safely', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-loopback-cycle-'))
    try {
      const levels = makeLevels()
      const gates: GateConfig[] = [
        { from: 'l1', to: 'l0', condition: { type: 'artifact_exists', artifact: 'loopback.md' } },
        { from: 'l1', to: 'l2', condition: { type: 'artifact_exists', artifact: 'onward.md' } },
        { from: 'l0', to: 'l1', condition: { type: 'artifact_exists', artifact: 'forward.md' } },
      ]

      // Gate outcomes are driven per visit, so the second visit to l1 provably
      // takes a different branch than the first, and the walk can be stopped on
      // the retained level to checkpoint it there.
      const checkedGates: string[] = []
      let l1Visits = 0
      let onwardOpen = false
      checkGateImpl = async (gate: GateConfig) => {
        const id = `${gate.from}->${gate.to}`
        checkedGates.push(id)
        if (id === 'l1->l0') return { passed: l1Visits === 0, reason: 'first visit loops back' }
        if (id === 'l1->l2') return { passed: onwardOpen, reason: 'second visit moves onward' }
        return { passed: true, reason: 'gate passed' }
      }

      const ctx = makeCtx(levels, gates, dir)
      const extCtx = makeExtCtx()
      const callbacks = makeCallbacks()
      const startedLevelIds: string[] = []
      callbacks.startActiveLevel = mock.fn(async () => {
        const level = levels[ctx.state.currentLevelIndex]
        if (level) startedLevelIds.push(level.id)
        return false
      })

      // ── 1. Backward, target-only ──────────────────────────────────────────
      await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)
      l1Visits += 1

      assert.equal(ctx.state.currentLevelIndex, 0, 'the run must be back at l0')
      const target = requiredValue(ctx.state.levelStates.get('l0'), 'l0 state')
      assert.equal(target.stageStatus, STAGE_LIFECYCLE_STATUS.READY,
        'the target is reset and made ready so it can genuinely re-run')
      assert.equal(target.loopbackCount, 1, 'the loopback is counted on the target')
      assert.equal(
        requiredValue(ctx.state.levelStates.get('l1'), 'l1 state').stageStatus,
        STAGE_LIFECYCLE_STATUS.COMPLETED,
        'the source retains its completed work under reset_scope: target',
      )

      // ── 2. The target really re-runs, through the ordinary lifecycle ──────
      transitionStageStatus(target, STAGE_LIFECYCLE_STATUS.RUNNING)
      transitionStageStatus(target, STAGE_LIFECYCLE_STATUS.COMPLETED)
      target.engineState = completedBroadcastEngine()

      startedLevelIds.length = 0
      runExperienceReflectionsMockFn.mock.resetCalls()

      // ── 3. Forward into the retained source, and stop there ───────────────
      // `onwardOpen` is still false, so the traversal re-evaluates l1's gate,
      // finds no passing route, and leaves l1 as the current level.
      await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

      assert.ok(checkedGates.includes('l0->l1'), 'the forward gate must be evaluated')
      assert.ok(
        checkedGates.filter((id) => id === 'l1->l2').length > 0,
        'the retained level\'s own gate must be re-evaluated on its existing evidence',
      )
      assert.equal(ctx.state.currentLevelIndex, 1, 'the walk rests on the retained level')
      const retained = requiredValue(ctx.state.levelStates.get('l1'), 'l1 state')
      assert.equal(retained.status, 'active', 'the retained level is activated')
      assert.equal(retained.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED,
        'its work is complete, so it is not transitioned back to ready')
      assert.equal(startedLevelIds.includes('l1'), false,
        `a retained completed level must not have its engine re-executed; started ${startedLevelIds.join(', ')}`)
      const reflectedAfterTraversal = runExperienceReflectionsMockFn.mock.calls.map(
        (call) => (call.arguments[0] as { id?: string } | undefined)?.id,
      )
      assert.equal(reflectedAfterTraversal.includes('l1'), false,
        `a traversed level's reflections must not run again; saw ${reflectedAfterTraversal.join(', ')}`)

      // ── 4. Restart at the critical point ──────────────────────────────────
      // Persist and reload while the retained source *is* the current level,
      // then resume gate evaluation from the reloaded state.
      const assignmentPath = path.join(dir, 'assignment')
      fs.mkdirSync(assignmentPath, { recursive: true })
      writeCheckpoint(assignmentPath, ctx.state as never)
      const reloaded = readCheckpoint(assignmentPath)
      assert.ok(reloaded, 'the checkpoint must be readable back')
      assert.equal(reloaded.currentLevelIndex, 1,
        'the retained level is still current after a restart')
      const restoredStates = restoreLevelStatesFromCheckpoint(reloaded)
      const restoredRetained = requiredValue(restoredStates.get('l1'), 'restored l1')
      assert.equal(restoredRetained.status, 'active', 'active survives the restart')
      assert.equal(restoredRetained.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED,
        'retained completed work survives the restart')

      // ── 5. Resume from the reloaded state ─────────────────────────────────
      const resumed = makeCtx(levels, gates, dir)
      resumed.state.currentLevelIndex = reloaded.currentLevelIndex
      resumed.state.levelStates = restoredStates
      const resumedCallbacks = makeCallbacks()
      const resumedStarts: string[] = []
      resumedCallbacks.startActiveLevel = mock.fn(async () => {
        const level = levels[resumed.state.currentLevelIndex]
        if (level) resumedStarts.push(level.id)
        return false
      })
      runExperienceReflectionsMockFn.mock.resetCalls()
      onwardOpen = true

      await tryAdvanceLevel(extCtx as never, resumed as never, resumedCallbacks as never)

      assert.equal(resumed.state.currentLevelIndex, 2,
        'a reloaded traversed level resumes gate evaluation and advances')
      assert.equal(resumedStarts.includes('l1'), false,
        'the reloaded retained level must not be re-executed either')
      const reflectedAfterResume = runExperienceReflectionsMockFn.mock.calls.map(
        (call) => (call.arguments[0] as { id?: string } | undefined)?.id,
      )
      assert.equal(reflectedAfterResume.includes('l1'), false,
        `a reloaded traversed level's reflections must not run; saw ${reflectedAfterResume.join(', ')}`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
