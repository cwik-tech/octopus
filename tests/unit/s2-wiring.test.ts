/**
 * S2 Wiring Tests
 *
 * Tests for the runtime wiring introduced in S2 (T4):
 *   1. parsers/team-config.ts    — budget section parsing (cap_usd, enforce, on_exceed)
 *   2. parsers/stage-parsers.ts  — constraints: agent_timeout_minutes, and the
 *                                  rejection of the removed enforce/on_exceed keys
 *   3. domains/agent-execution/failure-policy.ts  — budget pre-dispatch check (budgetLedger + totalCost)
 *
 * NOTE: Section 3 uses mock.module (--experimental-test-module-mocks required).
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parseTeamConfig } from '../../parsers/team-config.js'
import {
  parseDiscussionStage,
  parsePipelineStage,
  parseChainStage,
  parseBroadcastStage,
  parseReviewStage,
} from '../../parsers/stage-parsers.js'
import { BudgetLedger } from '../../core/budget-ledger.js'

// ─── Mock dispatchToAgentOrTeam before importing failure-policy ───────────────

let mockDispatchResult = { text: 'mock-result', cost: 0.01, model: 'claude-3-5' }
let mockDispatchError: Error | null = null

mock.module('../../domains/agent-execution/agent-runner.js', {
  namedExports: {
    dispatchToAgentOrTeam: mock.fn(async (_opts: unknown) => {
      if (mockDispatchError) throw mockDispatchError
      return mockDispatchResult
    }),
  },
})

// Dynamic import AFTER mock is registered
const { HaltError, dispatchWithFailurePolicy } = await import('../../domains/agent-execution/failure-policy.js')
const { FAILURE_POLICY, STAGE_TYPE } = await import('../../core/constants.js')

// ─── Helpers ─────────────────────────────────────────────────────────────────

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's2-wiring-test-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Write a minimal team.yaml with optional budget section and parse it. */
function parseWithBudget(budgetYaml: string): ReturnType<typeof parseTeamConfig> {
  let result!: ReturnType<typeof parseTeamConfig>
  withTempDir((dir) => {
    const agentDir = path.join(dir, 'agents', 'alpha')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'alpha.md'), '# Alpha')

    fs.writeFileSync(path.join(dir, 'team.yaml'), `
team:
  name: test-team
agents:
  - name: alpha
    type: agent
    role: tester
    tier: execution
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md
${budgetYaml}
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
          max_budget_usd: 10
        output:
          format: output.md
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`)
    result = parseTeamConfig(path.join(dir, 'team.yaml'))
  })
  return result
}

/** Minimal stub for a LoadedAgent. */
function makeAgent(name = 'alpha') {
  return {
    name,
    role: 'tester',
    agentDir: '/tmp/agents/' + name,
    systemPrompt: 'You are a tester.',
    knowledgeContent: '',
    experienceContent: '',
    experienceEnabled: true,
    skillsContent: '',
  } as any
}

/** Build dispatch options for budget tests. Needs an errorLogPath in a real dir. */
function makeOpts(extras: Record<string, unknown> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's2-budget-'))
  return {
    agent: makeAgent(),
    rosterEntry: undefined,
    finalPrompt: 'do something',
    userMessage: 'task',
    state: { totalCost: 0, spawnDepth: 0, sessionId: 'sess' } as any,
    workspacePath: tmpDir,
    outputPath: tmpDir,
    metrics: undefined,
    policy: { policy: FAILURE_POLICY.SKIP, maxRetries: 0 },
    levelId: 'l1',
    stageType: STAGE_TYPE.PIPELINE,
    sessionId: 'sess-test',
    errorLogPath: path.join(tmpDir, 'errors.jsonl'),
    _tmpDir: tmpDir,
    ...extras,
  }
}

const AGENT_NAMES = new Set(['alpha'])
const BASE_CONSTRAINTS = { max_budget_usd: 5, max_time_minutes: 10 }

// ═══════════════════════════════════════════════════════════════════════════════
// 1. parsers/team-config.ts — budget section parsing
// ═══════════════════════════════════════════════════════════════════════════════

test('parseTeamConfig: budget section omitted → config.budget is undefined', () => {
  const result = parseWithBudget('')
  assert.equal(result.errors.length, 0)
  assert.ok(result.config)
  assert.equal(result.config!.budget, undefined)
})

test('parseTeamConfig: budget.cap_usd parsed correctly', () => {
  const result = parseWithBudget(`
budget:
  cap_usd: 25.50
  enforce: true
  on_exceed: halt
`)
  assert.equal(result.errors.length, 0)
  assert.ok(result.config!.budget)
  assert.equal(result.config!.budget!.cap_usd, 25.50)
})

test('parseTeamConfig: budget.enforce parsed correctly (true)', () => {
  const result = parseWithBudget(`
budget:
  cap_usd: 10
  enforce: true
`)
  assert.equal(result.config!.budget!.enforce, true)
})

test('parseTeamConfig: budget.enforce defaults to false when omitted', () => {
  const result = parseWithBudget(`
budget:
  cap_usd: 10
`)
  assert.equal(result.config!.budget!.enforce, false)
})

test('parseTeamConfig: budget.on_exceed = halt', () => {
  const result = parseWithBudget(`
budget:
  cap_usd: 10
  enforce: true
  on_exceed: halt
`)
  assert.equal(result.config!.budget!.on_exceed, 'halt')
})

test('parseTeamConfig: budget.on_exceed = warn', () => {
  const result = parseWithBudget(`
budget:
  cap_usd: 10
  enforce: true
  on_exceed: warn
`)
  assert.equal(result.config!.budget!.on_exceed, 'warn')
})

test('parseTeamConfig: budget.cap_usd = 0 produces a warning (not an error)', () => {
  const result = parseWithBudget(`
budget:
  cap_usd: 0
  enforce: true
`)
  assert.equal(result.errors.length, 0)
  assert.ok(result.warnings.some(w => /cap_usd/.test(w) || /budget/.test(w)),
    `Expected a budget warning, got: ${JSON.stringify(result.warnings)}`)
})

// ═══════════════════════════════════════════════════════════════════════════════
// 2. parsers/stage-parsers.ts — extended constraint fields
// ═══════════════════════════════════════════════════════════════════════════════

// `constraints.enforce` and `constraints.on_exceed` were removed from the public
// schema (docs/adr/2026-08-21-Stage-Constraint-Schema-Removal.md). The two tests
// that previously asserted they parsed now assert the parsed shape no longer
// carries them at all — a clean config must not grow the key back by default.
test('parseDiscussionStage: a clean config carries no enforce or on_exceed key', () => {
  const errors: string[] = []
  const stage = parseDiscussionStage({
    coordinator: 'alpha',
    participants: ['alpha'],
    config: {
      mode: 'deliberate',
      min_rounds: 1,
      max_rounds: 3,
      constraints: BASE_CONSTRAINTS,
      output: { format: 'out.md' },
    },
  }, AGENT_NAMES, errors)
  assert.equal(errors.length, 0)
  assert.ok(stage.config.constraints)
  assert.equal('enforce' in stage.config.constraints, false)
  assert.equal('on_exceed' in stage.config.constraints, false)
})

test('parseDiscussionStage: constraints.agent_timeout_minutes is parsed', () => {
  const errors: string[] = []
  const stage = parseDiscussionStage({
    coordinator: 'alpha',
    participants: ['alpha'],
    config: {
      mode: 'deliberate',
      min_rounds: 1,
      max_rounds: 3,
      constraints: { ...BASE_CONSTRAINTS, agent_timeout_minutes: 8 },
      output: { format: 'out.md' },
    },
  }, AGENT_NAMES, errors)
  assert.equal(stage.config.constraints?.agent_timeout_minutes, 8)
})

test('parseDiscussionStage: constraints.agent_timeout_minutes is undefined when not set', () => {
  const errors: string[] = []
  const stage = parseDiscussionStage({
    coordinator: 'alpha',
    participants: ['alpha'],
    config: {
      mode: 'deliberate',
      min_rounds: 1,
      max_rounds: 3,
      constraints: BASE_CONSTRAINTS,
      output: { format: 'out.md' },
    },
  }, AGENT_NAMES, errors)
  assert.equal(stage.config.constraints?.agent_timeout_minutes, undefined)
})

test('parsePipelineStage: agent_timeout_minutes parses; enforce/on_exceed are rejected', () => {
  const clean: string[] = []
  const stage = parsePipelineStage({
    config: { constraints: { ...BASE_CONSTRAINTS, agent_timeout_minutes: 5 } },
  }, AGENT_NAMES, clean)
  assert.deepEqual(clean, [])
  assert.equal(stage.config.constraints?.agent_timeout_minutes, 5)

  const errors: string[] = []
  parsePipelineStage({
    config: { constraints: { ...BASE_CONSTRAINTS, enforce: true, on_exceed: 'warn' } },
  }, AGENT_NAMES, errors)
  assert.ok(errors.some((e) => /enforce/.test(e)))
  assert.ok(errors.some((e) => /on_exceed/.test(e)))
})

test('parseBroadcastStage: no config.constraints → constraints is undefined', () => {
  const errors: string[] = []
  const stage = parseBroadcastStage({
    fan_out: ['alpha'],
  }, AGENT_NAMES, errors)
  // When config.constraints is absent, the field is undefined (not a default object)
  assert.equal(stage.config.constraints, undefined)
})

test('parseBroadcastStage: agent_timeout_minutes parses; enforce is rejected', () => {
  const clean: string[] = []
  const stage = parseBroadcastStage({
    fan_out: ['alpha'],
    config: { constraints: { ...BASE_CONSTRAINTS, agent_timeout_minutes: 3 } },
  }, AGENT_NAMES, clean)
  assert.deepEqual(clean, [])
  assert.equal(stage.config.constraints?.agent_timeout_minutes, 3)

  const errors: string[] = []
  parseBroadcastStage({
    fan_out: ['alpha'],
    config: { constraints: { ...BASE_CONSTRAINTS, enforce: true } },
  }, AGENT_NAMES, errors)
  assert.ok(errors.some((e) => /enforce/.test(e)))
})

test('parseChainStage: agent_timeout_minutes parses; enforce is rejected', () => {
  const clean: string[] = []
  const stage = parseChainStage({
    sequence: ['alpha'],
    config: { constraints: { ...BASE_CONSTRAINTS, agent_timeout_minutes: 10 } },
  }, AGENT_NAMES, clean)
  assert.deepEqual(clean, [])
  assert.equal(stage.config.constraints?.agent_timeout_minutes, 10)

  const errors: string[] = []
  parseChainStage({
    sequence: ['alpha'],
    config: { constraints: { ...BASE_CONSTRAINTS, enforce: true } },
  }, AGENT_NAMES, errors)
  assert.ok(errors.some((e) => /enforce/.test(e)))
})

test('parseReviewStage: agent_timeout_minutes parses; enforce/on_exceed are rejected', () => {
  const clean: string[] = []
  const stage = parseReviewStage({
    producer: 'alpha',
    reviewer: 'alpha',
    config: {
      constraints: { ...BASE_CONSTRAINTS, agent_timeout_minutes: 6 },
      output: { format: 'out.md' },
    },
  }, AGENT_NAMES, clean)
  assert.deepEqual(clean, [])
  assert.equal(stage.config.constraints?.agent_timeout_minutes, 6)

  const errors: string[] = []
  parseReviewStage({
    producer: 'alpha',
    reviewer: 'alpha',
    config: {
      constraints: { ...BASE_CONSTRAINTS, enforce: true, on_exceed: 'halt' },
      output: { format: 'out.md' },
    },
  }, AGENT_NAMES, errors)
  assert.ok(errors.some((e) => /enforce/.test(e)))
  assert.ok(errors.some((e) => /on_exceed/.test(e)))
})

// ═══════════════════════════════════════════════════════════════════════════════
// 3. domains/agent-execution/failure-policy.ts — budget pre-dispatch checks
// ═══════════════════════════════════════════════════════════════════════════════

test('dispatchWithFailurePolicy: no budgetLedger → dispatches normally', async () => {
  mockDispatchError = null
  mockDispatchResult = { text: 'hello', cost: 0.01, model: 'claude' }
  const opts = makeOpts()
  const result = await dispatchWithFailurePolicy(opts)
  assert.equal(result.text, 'hello')
  fs.rmSync(opts._tmpDir, { recursive: true, force: true })
})

test('dispatchWithFailurePolicy: budgetLedger under cap → dispatches normally', async () => {
  mockDispatchError = null
  mockDispatchResult = { text: 'done', cost: 0.01, model: 'claude' }
  const ledger = new BudgetLedger({ capUsd: 100, policy: 'halt' })
  const opts = makeOpts({ budgetLedger: ledger, totalCost: 50 })
  const result = await dispatchWithFailurePolicy(opts)
  assert.equal(result.text, 'done')
  fs.rmSync(opts._tmpDir, { recursive: true, force: true })
})

test('dispatchWithFailurePolicy: budget exceeded + halt policy → throws HaltError', async () => {
  mockDispatchError = null
  mockDispatchResult = { text: 'should not run', cost: 0, model: '' }
  const ledger = new BudgetLedger({ capUsd: 30, policy: 'halt' })
  const opts = makeOpts({ budgetLedger: ledger, totalCost: 30.12 })
  try {
    await assert.rejects(
      () => dispatchWithFailurePolicy(opts),
      (err: unknown) => {
        assert.ok(err instanceof HaltError, `Expected HaltError, got ${err}`)
        assert.ok(
          (err as typeof HaltError.prototype).message.includes('Budget exceeded'),
          `Message: ${(err as Error).message}`,
        )
        return true
      },
    )
  } finally {
    fs.rmSync(opts._tmpDir, { recursive: true, force: true })
  }
})

test('dispatchWithFailurePolicy: budget exceeded + warn policy → appends warning to result', async () => {
  mockDispatchError = null
  mockDispatchResult = { text: 'result text', cost: 0.01, model: 'claude' }
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'warn' })
  const opts = makeOpts({ budgetLedger: ledger, totalCost: 12.00 })
  try {
    const result = await dispatchWithFailurePolicy(opts)
    assert.ok(result.text.includes('result text'), 'Original text preserved')
    assert.ok(
      result.text.includes('⚠️ Budget warning'),
      `Expected budget warning in result text: "${result.text}"`,
    )
  } finally {
    fs.rmSync(opts._tmpDir, { recursive: true, force: true })
  }
})

test('dispatchWithFailurePolicy: budget warn shows dollar amounts in warning', async () => {
  mockDispatchError = null
  mockDispatchResult = { text: 'ok', cost: 0.01, model: 'claude' }
  // totalCost (110) > capUsd (100) → budget exceeded → warn appended
  const ledger = new BudgetLedger({ capUsd: 100, policy: 'warn' })
  const opts = makeOpts({ budgetLedger: ledger, totalCost: 110 })
  try {
    const result = await dispatchWithFailurePolicy(opts)
    assert.ok(result.text.includes('$110.00'), `Expected dollar amount in: "${result.text}"`)
    assert.ok(result.text.includes('$100.00'), `Expected cap in: "${result.text}"`)
  } finally {
    fs.rmSync(opts._tmpDir, { recursive: true, force: true })
  }
})

test('dispatchWithFailurePolicy: budgetLedger present but totalCost undefined → no warning, dispatches normally', async () => {
  mockDispatchError = null
  mockDispatchResult = { text: 'plain', cost: 0.01, model: 'claude' }
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'warn' })
  const opts = makeOpts({ budgetLedger: ledger })
  // totalCost intentionally omitted
  try {
    const result = await dispatchWithFailurePolicy(opts)
    assert.equal(result.text, 'plain')
  } finally {
    fs.rmSync(opts._tmpDir, { recursive: true, force: true })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// D2 — stage constraints reject enforce/on_exceed; top-level cap_usd warns
// ═══════════════════════════════════════════════════════════════════════════════

// All six stage types share one `parseConstraints`, so rejecting the keys there
// covers every stage. These assert at that shared layer and then again at the
// real external boundary, `parseTeamConfig` reading a team.yaml from disk.

test('D2: stage constraints reject enforce', () => {
  const errors: string[] = []
  parseDiscussionStage({
    coordinator: 'alpha',
    participants: ['alpha'],
    config: {
      mode: 'deliberate',
      min_rounds: 1,
      max_rounds: 3,
      constraints: { ...BASE_CONSTRAINTS, enforce: true },
      output: { format: 'output.md' },
    },
  }, AGENT_NAMES, errors)

  assert.ok(
    errors.some((e) => /enforce/.test(e)),
    `expected an error naming 'enforce', got: ${JSON.stringify(errors)}`,
  )
})

test('D2: stage constraints reject on_exceed', () => {
  const errors: string[] = []
  parseDiscussionStage({
    coordinator: 'alpha',
    participants: ['alpha'],
    config: {
      mode: 'deliberate',
      min_rounds: 1,
      max_rounds: 3,
      constraints: { ...BASE_CONSTRAINTS, on_exceed: 'halt' },
      output: { format: 'output.md' },
    },
  }, AGENT_NAMES, errors)

  assert.ok(
    errors.some((e) => /on_exceed/.test(e)),
    `expected an error naming 'on_exceed', got: ${JSON.stringify(errors)}`,
  )
})

test('D2: stage constraints keep max_time_minutes, max_budget_usd and agent_timeout_minutes', () => {
  // The removal must be surgical. `agent_timeout_minutes` in particular is read
  // by every engine (engines/pipeline.ts:806, engines/chain.ts:280,
  // engines/broadcast.ts:249, engines/discussion.ts:761, engines/review.ts:955),
  // so removing it would break real dispatch behaviour.
  const errors: string[] = []
  const stage = parseDiscussionStage({
    coordinator: 'alpha',
    participants: ['alpha'],
    config: {
      mode: 'deliberate',
      min_rounds: 1,
      max_rounds: 3,
      constraints: { ...BASE_CONSTRAINTS, agent_timeout_minutes: 7 },
      output: { format: 'output.md' },
    },
  }, AGENT_NAMES, errors)

  assert.deepEqual(errors, [])
  assert.equal(stage.config.constraints?.max_time_minutes, 10)
  assert.equal(stage.config.constraints?.max_budget_usd, 5)
  assert.equal(stage.config.constraints?.agent_timeout_minutes, 7)
})

test('D2: parseTeamConfig rejects stage constraints enforce/on_exceed from real YAML', () => {
  let result!: ReturnType<typeof parseTeamConfig>
  withTempDir((dir) => {
    const agentDir = path.join(dir, 'agents', 'alpha')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'alpha.md'), '# Alpha')
    fs.writeFileSync(path.join(dir, 'team.yaml'), `
team:
  name: test-team
agents:
  - name: alpha
    type: agent
    role: tester
    tier: execution
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
          max_budget_usd: 10
          enforce: true
          on_exceed: halt
        output:
          format: output.md
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`)
    result = parseTeamConfig(path.join(dir, 'team.yaml'))
  })

  assert.ok(
    result.errors.some((e) => /enforce/.test(e)),
    `expected an 'enforce' error, got: ${JSON.stringify(result.errors)}`,
  )
  assert.ok(
    result.errors.some((e) => /on_exceed/.test(e)),
    `expected an 'on_exceed' error, got: ${JSON.stringify(result.errors)}`,
  )
})

test('D2: top-level budget with cap_usd but no enforce warns that the cap is inactive', () => {
  // `budget: { cap_usd: N }` reads as tightening spend, but parses enforce=false
  // (parsers/team-config.ts:599), which makes team-runtime/index.ts:778 evaluate
  // shouldEnforce=false and delete the ledger entirely — looser than declaring
  // no budget at all. Warn; do not reject.
  const result = parseWithBudget(`
budget:
  cap_usd: 5
`)

  assert.equal(result.errors.length, 0, 'a missing enforce must not be an error')
  assert.ok(
    result.warnings.some((w) => /enforce/.test(w)),
    `expected a warning naming 'enforce', got: ${JSON.stringify(result.warnings)}`,
  )
})

test('D2: top-level budget with explicit enforce true emits no enforce warning', () => {
  const result = parseWithBudget(`
budget:
  cap_usd: 5
  enforce: true
`)

  assert.equal(result.errors.length, 0)
  assert.equal(
    result.warnings.filter((w) => /enforce/.test(w)).length,
    0,
    `an active budget must not warn, got: ${JSON.stringify(result.warnings)}`,
  )
})

test('D2: top-level budget with explicit enforce false emits no enforce warning', () => {
  // An explicit opt-out is a deliberate choice, not the omission trap. The
  // warning discriminates on the key being absent, not on the parsed value.
  const result = parseWithBudget(`
budget:
  cap_usd: 5
  enforce: false
`)

  assert.equal(result.errors.length, 0)
  assert.equal(
    result.warnings.filter((w) => /enforce/.test(w)).length,
    0,
    `an explicit opt-out must not warn, got: ${JSON.stringify(result.warnings)}`,
  )
})

test('D2: stage constraints reject an explicitly null enforce or on_exceed key', () => {
  // Post-review boundary regression. `enforce:` with no value is valid YAML and
  // parses to null, so a `!= null` value check would silently accept a key the
  // public schema rejects. Presence of the key is what the schema forbids.
  let result!: ReturnType<typeof parseTeamConfig>
  withTempDir((dir) => {
    const agentDir = path.join(dir, 'agents', 'alpha')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'alpha.md'), '# Alpha')
    fs.writeFileSync(path.join(dir, 'team.yaml'), `
team:
  name: test-team
agents:
  - name: alpha
    type: agent
    role: tester
    tier: execution
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
          max_budget_usd: 10
          enforce:
          on_exceed: null
        output:
          format: output.md
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`)
    result = parseTeamConfig(path.join(dir, 'team.yaml'))
  })

  assert.ok(
    result.errors.some((e) => /enforce/.test(e)),
    `a null-valued 'enforce' key must still be rejected, got: ${JSON.stringify(result.errors)}`,
  )
  assert.ok(
    result.errors.some((e) => /on_exceed/.test(e)),
    `a null-valued 'on_exceed' key must still be rejected, got: ${JSON.stringify(result.errors)}`,
  )
})

test('D2: the budget warning does not claim a ledger is never created', () => {
  // Post-review accuracy regression. The parser cannot see the environment:
  // team-runtime/index.ts:773-792 lets TEAM_BUDGET_CAP supply a cap, in which
  // case shouldEnforce is true and a ledger IS created. The warning must scope
  // its claim to this configured cap.
  const result = parseWithBudget(`
budget:
  cap_usd: 5
`)
  const warning = result.warnings.find((w) => /enforce/.test(w))

  assert.ok(warning, `expected an enforce warning, got: ${JSON.stringify(result.warnings)}`)
  assert.doesNotMatch(warning, /no budget ledger is created/i)
  assert.match(warning, /unless/i)
})

test('D2: the removed-key parse error states an accurate contract', () => {
  // Post-review regression. The first wording said "stage constraints are
  // advisory" — the same blanket claim corrected in {{CONSTRAINTS}}. It is false:
  // `max_time_minutes` is the delegated routing coordinator's real timeout
  // (team-runtime/index.ts:1590-1593) and `agent_timeout_minutes` is enforced by
  // every engine. Only the removed key itself had no runtime effect.
  const errors: string[] = []
  parseDiscussionStage({
    coordinator: 'alpha',
    participants: ['alpha'],
    config: {
      mode: 'deliberate',
      min_rounds: 1,
      max_rounds: 3,
      constraints: { ...BASE_CONSTRAINTS, enforce: true },
      output: { format: 'output.md' },
    },
  }, AGENT_NAMES, errors)

  const message = errors.find((e) => /enforce/.test(e))
  assert.ok(message, `expected an 'enforce' error, got: ${JSON.stringify(errors)}`)

  // Names the removed key, and scopes the "no effect" claim to that key.
  assert.match(message, /constraints 'enforce'/)
  assert.match(message, /never had any runtime effect/i)
  // Points at both real mechanisms by name.
  assert.match(message, /budget/)
  assert.match(message, /enforce: true/)
  assert.match(message, /agent_timeout_minutes/)
  // Must NOT generalise to the whole constraints block.
  assert.doesNotMatch(message, /stage constraints are advisory/i)
})
