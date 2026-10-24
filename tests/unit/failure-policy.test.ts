import { requiredValue } from '../../core/required-value.js'
/**
 * T8: Comprehensive Tests — Failure Recovery System
 *
 * Covers:
 *   1–10:  resolveFailurePolicy — defaults, agent overrides, stage overrides, fallback propagation
 *   11–14: Config parsing via parseTeamConfig — on_failure on agents, on_agent_failure on stages
 *   15–19: validateFailurePolicies — self-ref, max_retries, missing fallback_agent, unknown agent
 *   20–22: logAgentError — JSONL output, root_session_id inclusion/omission
 *   23–24: Stage parsers accept on_agent_failure (see also s3-parser-split.test.ts)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { resolveFailurePolicy, HaltError } from '../../domains/agent-execution/failure-policy.js'
import type { AgentFailurePolicy, AgentErrorEvent } from '../../core/types.js'
import { logAgentError } from '../../domains/runtime/logger.js'
import { validateFailurePolicies } from '../../parsers/config-validator.js'
import { parseTeamConfig } from '../../parsers/team-config.js'
import {
  parseDiscussionStage,
  parsePipelineStage,
  parseChainStage,
  parseBroadcastStage,
  parseReviewStage,
} from '../../parsers/stage-parsers.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-policy-test-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Write a minimal team.yaml with the given agents block (as YAML string) into
 * a temp directory, then run parseTeamConfig and return the result.
 * The agent named 'alpha' has a required agent_file created automatically.
 */
function parseYamlFixture(agentsYaml: string, stagesYaml?: string): ReturnType<typeof parseTeamConfig> {
  let result!: ReturnType<typeof parseTeamConfig>
  withTempDir((dir) => {
    const agentDir = path.join(dir, 'agents', 'alpha')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'alpha.md'), '# Alpha')

    const backupDir = path.join(dir, 'agents', 'backup')
    fs.mkdirSync(backupDir, { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'backup.md'), '# Backup')

    const stagesBlock = stagesYaml ?? `
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: discussion
      coordinator: alpha
      participants:
        - alpha
      config:
        min_rounds: 1
        max_rounds: 2
`

    const yaml = `
team:
  name: fixture-team
agents:
${agentsYaml}
levels:
${stagesBlock}
gates:
  - from: l1
    to: done
    condition:
      type: all_tasks_terminal
`
    fs.writeFileSync(path.join(dir, 'team.yaml'), yaml)
    result = parseTeamConfig(path.join(dir, 'team.yaml'))
  })
  return result
}

const AGENT_NAMES = new Set(['coord', 'alice', 'bob', 'prod', 'rev', 'backup'])

// ─── Tests 1–5: Stage-type defaults ─────────────────────────────────────────

test('T8-1: resolveFailurePolicy pipeline default → retry(2)', () => {
  const r = resolveFailurePolicy('agent', 'pipeline')
  assert.equal(r.policy, 'retry')
  assert.equal(r.maxRetries, 2)
})

test('T8-2: resolveFailurePolicy discussion default → skip(0)', () => {
  const r = resolveFailurePolicy('agent', 'discussion')
  assert.equal(r.policy, 'skip')
  assert.equal(r.maxRetries, 0)
})

test('T8-3: resolveFailurePolicy chain default → retry(2)', () => {
  const r = resolveFailurePolicy('agent', 'chain')
  assert.equal(r.policy, 'retry')
  assert.equal(r.maxRetries, 2)
})

test('T8-4: resolveFailurePolicy broadcast default → skip(0)', () => {
  const r = resolveFailurePolicy('agent', 'broadcast')
  assert.equal(r.policy, 'skip')
  assert.equal(r.maxRetries, 0)
})

test('T8-5: resolveFailurePolicy review default → retry(2)', () => {
  const r = resolveFailurePolicy('agent', 'review')
  assert.equal(r.policy, 'retry')
  assert.equal(r.maxRetries, 2)
})

// ─── Tests 6–10: Agent overrides and stage overrides ─────────────────────────

test('T8-6: agent override halt in discussion → halt', () => {
  const agentPolicy: AgentFailurePolicy = { policy: 'halt' }
  const r = resolveFailurePolicy('agent', 'discussion', undefined, agentPolicy)
  assert.equal(r.policy, 'halt')
  assert.equal(r.maxRetries, 0)
})

test('T8-7: agent override retry with max_retries:3 → maxRetries:3', () => {
  const agentPolicy: AgentFailurePolicy = { policy: 'retry', max_retries: 3 }
  const r = resolveFailurePolicy('agent', 'discussion', undefined, agentPolicy)
  assert.equal(r.policy, 'retry')
  assert.equal(r.maxRetries, 3)
})

test('T8-8: stage override halt wins over agent retry → halt', () => {
  const agentPolicy: AgentFailurePolicy = { policy: 'retry', max_retries: 2 }
  const r = resolveFailurePolicy('agent', 'pipeline', 'halt', agentPolicy)
  assert.equal(r.policy, 'halt')
  assert.equal(r.maxRetries, 0)
})

test('T8-9: stage override with no agent config → stage override used', () => {
  const r = resolveFailurePolicy('agent', 'pipeline', 'skip')
  assert.equal(r.policy, 'skip')
  assert.equal(r.maxRetries, 0)
})

test('T8-10: fallback_agent propagated in resolved policy', () => {
  const agentPolicy: AgentFailurePolicy = { policy: 'retry', fallback_agent: 'backup' }
  const r = resolveFailurePolicy('agent', 'pipeline', undefined, agentPolicy)
  assert.equal(r.fallbackAgent, 'backup')
})

// ─── Tests 11–14: Config parsing (parseTeamConfig) ───────────────────────────

test('T8-11: parseTeamConfig populates AgentRosterEntry.on_failure from team.yaml', () => {
  const result = parseYamlFixture(`
  - name: alpha
    type: agent
    role: test agent
    tier: strategic
    agent_file: agents/alpha/alpha.md
    on_failure:
      policy: retry
      max_retries: 2
`)
  // Parsing the fixture may emit warnings but no errors for a valid on_failure
  const agent = result.config?.agents.find((a) => a.name === 'alpha')
  assert.ok(agent, 'agent alpha found')
  assert.ok(agent?.on_failure, 'on_failure populated')
  assert.equal(agent?.on_failure?.policy, 'retry')
  assert.equal(agent?.on_failure?.max_retries, 2)
})

test('T8-12: parseTeamConfig populates on_agent_failure on stage config', () => {
  const result = parseYamlFixture(
    `
  - name: alpha
    type: agent
    role: test agent
    tier: strategic
    agent_file: agents/alpha/alpha.md
`,
    `
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: discussion
      coordinator: alpha
      participants:
        - alpha
      on_agent_failure: skip
      config:
        min_rounds: 1
        max_rounds: 2
`,
  )
  assert.equal(result.errors.length, 0, `parse errors: ${result.errors.join(', ')}`)
  const stage = requiredValue(result.config?.levels[0], 'tests/unit/failure-policy.test.ts:206').stage
  assert.ok(stage, 'stage exists')
  assert.equal((stage as any).config?.on_agent_failure, 'skip')
})

test('T8-13: on_failure with all fields → all parsed correctly', () => {
  const result = parseYamlFixture(`
  - name: alpha
    type: agent
    role: test agent
    tier: strategic
    agent_file: agents/alpha/alpha.md
    on_failure:
      policy: retry
      max_retries: 1
      fallback_agent: backup
  - name: backup
    type: agent
    role: backup agent
    tier: strategic
    agent_file: agents/backup/backup.md
`)
  const agent = result.config?.agents.find((a) => a.name === 'alpha')
  assert.ok(agent?.on_failure, 'on_failure populated')
  assert.equal(agent?.on_failure?.policy, 'retry')
  assert.equal(agent?.on_failure?.max_retries, 1)
  assert.equal(agent?.on_failure?.fallback_agent, 'backup')
})

test('T8-14: on_failure with only policy → defaults applied', () => {
  const result = parseYamlFixture(`
  - name: alpha
    type: agent
    role: test agent
    tier: strategic
    agent_file: agents/alpha/alpha.md
    on_failure:
      policy: skip
`)
  const agent = result.config?.agents.find((a) => a.name === 'alpha')
  assert.ok(agent?.on_failure, 'on_failure populated')
  assert.equal(agent?.on_failure?.policy, 'skip')
  // max_retries and fallback_agent are undefined when not specified
  assert.equal(agent?.on_failure?.max_retries, undefined)
  assert.equal(agent?.on_failure?.fallback_agent, undefined)
})

// ─── Tests 15–19: Validation ─────────────────────────────────────────────────

test('T8-15: validateFailurePolicies self-referencing fallback_agent → error', () => {
  const errors: string[] = []
  const warnings: string[] = []
  validateFailurePolicies(
    [{ name: 'alice', on_failure: { policy: 'retry', fallback_agent: 'alice' } }] as any,
    errors,
    warnings,
  )
  assert.ok(errors.some((e) => e.includes('references itself')), `expected self-ref error, got: ${errors}`)
})

test('T8-16: validateFailurePolicies max_retries:10 → error (exceeds MAX_ALLOWED_RETRIES=5)', () => {
  const errors: string[] = []
  const warnings: string[] = []
  validateFailurePolicies(
    [{ name: 'alice', on_failure: { policy: 'retry', max_retries: 10 } }] as any,
    errors,
    warnings,
  )
  assert.ok(
    errors.some((e) => e.includes('max_retries') && e.includes('10')),
    `expected max_retries error, got: ${errors}`,
  )
})

test('T8-17: validateFailurePolicies policy:fallback without fallback_agent → error', () => {
  const errors: string[] = []
  const warnings: string[] = []
  validateFailurePolicies(
    [{ name: 'alice', on_failure: { policy: 'fallback' } }] as any,
    errors,
    warnings,
  )
  assert.ok(
    errors.some((e) => e.includes('fallback') && (e.includes('no fallback_agent') || e.includes('fallback_agent'))),
    `expected fallback-without-agent error, got: ${errors}`,
  )
})

test('T8-18: validateFailurePolicies unknown fallback_agent → error', () => {
  const errors: string[] = []
  const warnings: string[] = []
  validateFailurePolicies(
    [{ name: 'alice', on_failure: { policy: 'retry', fallback_agent: 'ghost-agent' } }] as any,
    errors,
    warnings,
  )
  assert.ok(
    errors.some((e) => e.includes('ghost-agent') && (e.includes('not found') || e.includes('not in'))),
    `expected unknown-fallback error, got: ${errors}`,
  )
})

test('T8-19: validateFailurePolicies valid config → no errors', () => {
  const errors: string[] = []
  const warnings: string[] = []
  validateFailurePolicies(
    [
      { name: 'alice', on_failure: { policy: 'retry', max_retries: 2, fallback_agent: 'bob' } },
      { name: 'bob', on_failure: { policy: 'skip' } },
    ] as any,
    errors,
    warnings,
  )
  assert.equal(errors.length, 0, `unexpected errors: ${errors.join(', ')}`)
})

// ─── Tests 20–22: Error logging ───────────────────────────────────────────────

test('T8-20: logAgentError writes valid JSONL with all required fields', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-log-'))
  try {
    const event: AgentErrorEvent = {
      timestamp: '2026-03-28T12:00:00.000Z',
      session_id: 'sess-abc',
      level_id: 'level-1',
      agent_name: 'researcher',
      attempt: 1,
      max_attempts: 3,
      policy: 'retry',
      error_message: 'API timeout',
      error_type: 'agent_failure',
      duration_ms: 5000,
    }

    logAgentError(tmpDir, event)

    const logPath = path.join(tmpDir, 'agent-errors.jsonl')
    assert.ok(fs.existsSync(logPath), 'agent-errors.jsonl created')

    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n')
    assert.equal(lines.length, 1, 'exactly one JSONL line written')

    const parsed = JSON.parse(requiredValue(lines[0], 'tests/unit/failure-policy.test.ts:349'))
    assert.equal(parsed.timestamp, '2026-03-28T12:00:00.000Z', 'timestamp preserved')
    assert.equal(parsed.session_id, 'sess-abc', 'session_id preserved')
    assert.equal(parsed.level_id, 'level-1', 'level_id preserved')
    assert.equal(parsed.agent_name, 'researcher', 'agent_name preserved')
    assert.equal(parsed.attempt, 1, 'attempt preserved')
    assert.equal(parsed.max_attempts, 3, 'max_attempts preserved')
    assert.equal(parsed.policy, 'retry', 'policy preserved')
    assert.equal(parsed.error_message, 'API timeout', 'error_message preserved')
    assert.equal(parsed.error_type, 'agent_failure', 'error_type preserved')
    assert.equal(parsed.duration_ms, 5000, 'duration_ms preserved')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('T8-21: logAgentError includes root_session_id when provided', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-log-'))
  try {
    const event: AgentErrorEvent = {
      timestamp: new Date().toISOString(),
      root_session_id: 'root-session-xyz',
      session_id: 'child-sess-1',
      level_id: 'level-2',
      agent_name: 'analyst',
      attempt: 2,
      max_attempts: 3,
      policy: 'retry',
      error_message: 'model error',
      error_type: 'agent_failure',
      duration_ms: 300,
    }

    logAgentError(tmpDir, event)

    const logPath = path.join(tmpDir, 'agent-errors.jsonl')
    const parsed = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim())
    assert.equal(parsed.root_session_id, 'root-session-xyz', 'root_session_id present')
    assert.equal(parsed.session_id, 'child-sess-1', 'session_id preserved')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('T8-22: logAgentError omits root_session_id when not provided', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-log-'))
  try {
    const event: AgentErrorEvent = {
      timestamp: new Date().toISOString(),
      session_id: 'standalone-sess',
      level_id: 'level-1',
      agent_name: 'creative',
      attempt: 1,
      max_attempts: 2,
      policy: 'skip',
      error_message: 'subprocess crash',
      error_type: 'skipped',
      duration_ms: 100,
      // root_session_id intentionally omitted
    }

    logAgentError(tmpDir, event)

    const logPath = path.join(tmpDir, 'agent-errors.jsonl')
    const parsed = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim())
    // root_session_id should not be present in the JSONL
    assert.equal(
      Object.prototype.hasOwnProperty.call(parsed, 'root_session_id'),
      false,
      'root_session_id must be absent when not provided',
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ─── Tests 23–24: Stage parsers accept on_agent_failure ──────────────────────
// (Canonical coverage is in s3-parser-split.test.ts; these verify the contract
// from the failure-policy perspective — that parsers thread the field correctly.)

test('T8-23: stage parsers accept on_agent_failure field without errors', () => {
  const errors: string[] = []
  // Verify all 5 stage parsers accept on_agent_failure without emitting errors
  parseDiscussionStage(
    { type: 'discussion', coordinator: 'coord', participants: ['alice'], on_agent_failure: 'skip' } as any,
    AGENT_NAMES, errors,
  )
  parsePipelineStage(
    { type: 'pipeline', coordinator: 'coord', participants: ['alice'], on_agent_failure: 'halt' } as any,
    AGENT_NAMES, errors,
  )
  parseChainStage(
    { type: 'chain', sequence: ['alice', 'bob'], on_agent_failure: 'retry' } as any,
    AGENT_NAMES, errors,
  )
  parseBroadcastStage(
    { type: 'broadcast', coordinator: 'coord', fan_out: ['alice', 'bob'], on_agent_failure: 'skip' } as any,
    AGENT_NAMES, errors,
  )
  parseReviewStage(
    { type: 'review', producer: 'prod', reviewer: 'rev', on_agent_failure: 'fallback' } as any,
    AGENT_NAMES, errors,
  )
  assert.equal(errors.length, 0, `unexpected errors: ${errors.join(', ')}`)
})

test('T8-24: parsed stage config includes on_agent_failure value', () => {
  const errors: string[] = []
  const discussion = parseDiscussionStage(
    { type: 'discussion', coordinator: 'coord', participants: ['alice'], on_agent_failure: 'skip' } as any,
    AGENT_NAMES, errors,
  )
  const pipeline = parsePipelineStage(
    { type: 'pipeline', on_agent_failure: 'halt' } as any,
    AGENT_NAMES, errors,
  )
  const chain = parseChainStage(
    { type: 'chain', sequence: ['alice'], on_agent_failure: 'retry' } as any,
    AGENT_NAMES, errors,
  )
  const broadcast = parseBroadcastStage(
    { type: 'broadcast', fan_out: ['alice'], on_agent_failure: 'skip' } as any,
    AGENT_NAMES, errors,
  )
  const review = parseReviewStage(
    { type: 'review', producer: 'prod', reviewer: 'rev', on_agent_failure: 'fallback' } as any,
    AGENT_NAMES, errors,
  )

  assert.equal(discussion.config.on_agent_failure, 'skip', 'discussion on_agent_failure = skip')
  assert.equal(pipeline.config.on_agent_failure, 'halt', 'pipeline on_agent_failure = halt')
  assert.equal(chain.config.on_agent_failure, 'retry', 'chain on_agent_failure = retry')
  assert.equal(broadcast.config.on_agent_failure, 'skip', 'broadcast on_agent_failure = skip')
  assert.equal(review.config.on_agent_failure, 'fallback', 'review on_agent_failure = fallback')
})

test('T8-24b: parseReviewStage accepts on_max_iterations without errors', () => {
  const errors: string[] = []
  const review = parseReviewStage(
    {
      type: 'review',
      producer: 'prod',
      reviewer: 'rev',
      config: { on_max_iterations: 'approve_latest' },
    } as any,
    AGENT_NAMES,
    errors,
  )

  assert.equal(errors.length, 0, `unexpected errors: ${errors.join(', ')}`)
  assert.equal(review.config.on_max_iterations, 'approve_latest')
})

// ─── Additional edge cases ────────────────────────────────────────────────────

test('T8-bonus: HaltError is a proper Error subclass with correct fields', () => {
  const err = new HaltError('my-agent', 'connection refused')
  assert.ok(err instanceof Error, 'instanceof Error')
  assert.ok(err instanceof HaltError, 'instanceof HaltError')
  assert.equal(err.name, 'HaltError', 'name property')
  assert.equal(err.agentName, 'my-agent', 'agentName field')
  assert.equal(err.originalError, 'connection refused', 'originalError field')
  assert.ok(err.message.includes('my-agent'), 'message mentions agent name')
})

test('T8-bonus: resolveFailurePolicy stage override retry gets DEFAULT_MAX_RETRIES', () => {
  const r = resolveFailurePolicy('agent', 'discussion', 'retry')
  assert.equal(r.policy, 'retry')
  assert.equal(r.maxRetries, 2)
})

test('T8-bonus: logAgentError appends multiple entries to the same file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-multi-'))
  try {
    const base: AgentErrorEvent = {
      timestamp: new Date().toISOString(),
      session_id: 'sess-multi',
      level_id: 'level-1',
      agent_name: 'bot',
      attempt: 1,
      max_attempts: 2,
      policy: 'retry',
      error_message: 'err',
      error_type: 'agent_failure',
      duration_ms: 10,
    }
    logAgentError(tmpDir, base)
    logAgentError(tmpDir, { ...base, attempt: 2 })

    const logPath = path.join(tmpDir, 'agent-errors.jsonl')
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n')
    assert.equal(lines.length, 2, 'two JSONL entries written')
    assert.equal(JSON.parse(requiredValue(lines[0], 'tests/unit/failure-policy.test.ts:541')).attempt, 1)
    assert.equal(JSON.parse(requiredValue(lines[1], 'tests/unit/failure-policy.test.ts:542')).attempt, 2)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
