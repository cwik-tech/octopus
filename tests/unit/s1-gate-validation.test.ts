import { requiredValue } from '../../core/required-value.js'
/**
 * S1 Sprint Gate Validation — T3
 *
 * Verifies all S1 acceptance criteria:
 *   - Types importable (AgentFailurePolicy, AgentErrorEvent, ResolvedFailurePolicy, HaltError)
 *   - resolveFailurePolicy defaults, stage override, agent config
 *   - Config parsing: on_failure in team-config.ts, on_agent_failure in stage parsers
 *   - Validation: validateFailurePolicies
 *   - Logger: logAgentError writes JSONL
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import {
  resolveFailurePolicy,
  HaltError,
} from '../../domains/agent-execution/failure-policy.js'
import type { ResolvedFailurePolicy } from '../../domains/agent-execution/failure-policy.js'
import type { AgentFailurePolicy, AgentErrorEvent } from '../../core/types.js'
import {
  FAILURE_POLICY,
  DEFAULT_MAX_RETRIES,
  MAX_ALLOWED_RETRIES,
  RETRY_DELAY_MS,
  CRITICAL_STAGE_TYPES,
  ADDITIVE_STAGE_TYPES,
} from '../../core/constants.js'
import { logAgentError } from '../../domains/runtime/logger.js'
import { validateFailurePolicies } from '../../parsers/config-validator.js'
import {
  parseDiscussionStage,
  parsePipelineStage,
  parseChainStage,
  parseBroadcastStage,
  parseReviewStage,
} from '../../parsers/stage-parsers.js'

// ─── Check 2: Types importable from their modules ──────────────────────────

test('HaltError is importable and is a proper Error subclass', () => {
  const err = new HaltError('test-agent', 'boom')
  assert.ok(err instanceof Error)
  assert.ok(err instanceof HaltError)
  assert.equal(err.name, 'HaltError')
  assert.equal(err.agentName, 'test-agent')
  assert.equal(err.originalError, 'boom')
  assert.ok(err.message.includes('test-agent'))
})

test('ResolvedFailurePolicy shape from resolveFailurePolicy', () => {
  const result: ResolvedFailurePolicy = resolveFailurePolicy('agent', 'pipeline')
  assert.equal(typeof result.policy, 'string')
  assert.equal(typeof result.maxRetries, 'number')
})

test('Constants exported from constants.ts', () => {
  assert.deepEqual(FAILURE_POLICY, { RETRY: 'retry', FALLBACK: 'fallback', SKIP: 'skip', HALT: 'halt' })
  assert.equal(DEFAULT_MAX_RETRIES, 2)
  assert.equal(MAX_ALLOWED_RETRIES, 5)
  assert.equal(RETRY_DELAY_MS, 2000)
  assert.ok(CRITICAL_STAGE_TYPES.has('pipeline'))
  assert.ok(CRITICAL_STAGE_TYPES.has('chain'))
  assert.ok(CRITICAL_STAGE_TYPES.has('review'))
  assert.ok(ADDITIVE_STAGE_TYPES.has('discussion'))
  assert.ok(ADDITIVE_STAGE_TYPES.has('broadcast'))
})

// ─── Check 3: resolveFailurePolicy defaults ────────────────────────────────

test('resolveFailurePolicy: pipeline → retry(2)', () => {
  const r = resolveFailurePolicy('agent', 'pipeline')
  assert.equal(r.policy, 'retry')
  assert.equal(r.maxRetries, 2)
})

test('resolveFailurePolicy: chain → retry(2)', () => {
  const r = resolveFailurePolicy('agent', 'chain')
  assert.equal(r.policy, 'retry')
  assert.equal(r.maxRetries, 2)
})

test('resolveFailurePolicy: review → retry(2)', () => {
  const r = resolveFailurePolicy('agent', 'review')
  assert.equal(r.policy, 'retry')
  assert.equal(r.maxRetries, 2)
})

test('resolveFailurePolicy: discussion → skip(0)', () => {
  const r = resolveFailurePolicy('agent', 'discussion')
  assert.equal(r.policy, 'skip')
  assert.equal(r.maxRetries, 0)
})

test('resolveFailurePolicy: broadcast → skip(0)', () => {
  const r = resolveFailurePolicy('agent', 'broadcast')
  assert.equal(r.policy, 'skip')
  assert.equal(r.maxRetries, 0)
})

// ─── Check 4: Stage override wins over agent config ────────────────────────

test('resolveFailurePolicy: stageOverride halt overrides agent retry', () => {
  const r = resolveFailurePolicy('agent', 'pipeline', 'halt', { policy: 'retry', max_retries: 3 })
  assert.equal(r.policy, 'halt')
  assert.equal(r.maxRetries, 0)
})

test('resolveFailurePolicy: stageOverride skip overrides pipeline default', () => {
  const r = resolveFailurePolicy('agent', 'pipeline', 'skip')
  assert.equal(r.policy, 'skip')
  assert.equal(r.maxRetries, 0)
})

test('resolveFailurePolicy: stageOverride retry gets default maxRetries', () => {
  const r = resolveFailurePolicy('agent', 'discussion', 'retry')
  assert.equal(r.policy, 'retry')
  assert.equal(r.maxRetries, 2)
})

// ─── Check 5: Agent config over stage defaults ─────────────────────────────

test('resolveFailurePolicy: agent halt overrides discussion default skip', () => {
  const r = resolveFailurePolicy('agent', 'discussion', undefined, { policy: 'halt' })
  assert.equal(r.policy, 'halt')
})

test('resolveFailurePolicy: agent retry(3) overrides default 2', () => {
  const r = resolveFailurePolicy('agent', 'pipeline', undefined, { policy: 'retry', max_retries: 3 })
  assert.equal(r.maxRetries, 3)
})

test('resolveFailurePolicy: agent fallback_agent propagated', () => {
  const r = resolveFailurePolicy('agent', 'pipeline', undefined, { policy: 'retry', fallback_agent: 'backup' })
  assert.equal(r.fallbackAgent, 'backup')
})

test('resolveFailurePolicy: agent retry without max_retries uses DEFAULT_MAX_RETRIES', () => {
  const r = resolveFailurePolicy('agent', 'discussion', undefined, { policy: 'retry' })
  assert.equal(r.maxRetries, DEFAULT_MAX_RETRIES)
})

// ─── Check 6: Stage parsers read on_agent_failure ──────────────────────────

const AGENT_NAMES = new Set(['coord', 'alice', 'bob', 'prod', 'rev'])

test('parseDiscussionStage reads on_agent_failure', () => {
  const errors: string[] = []
  const result = parseDiscussionStage(
    { type: 'discussion', coordinator: 'coord', participants: ['alice', 'bob'], on_agent_failure: 'skip' } as any,
    AGENT_NAMES, errors,
  )
  assert.equal(errors.length, 0)
  assert.equal(result.config.on_agent_failure, 'skip')
})

test('parseDiscussionStage reads min_successful_participants', () => {
  const errors: string[] = []
  const warnings: string[] = []
  const result = parseDiscussionStage(
    {
      type: 'discussion',
      coordinator: 'coord',
      participants: ['alice', 'bob'],
      config: { min_successful_participants: 2 },
    } as any,
    AGENT_NAMES,
    errors,
    warnings,
  )
  assert.equal(errors.length, 0)
  assert.equal(warnings.length, 0)
  assert.equal(result.config.min_successful_participants, 2)
})

test('parsePipelineStage reads on_agent_failure', () => {
  const errors: string[] = []
  const result = parsePipelineStage(
    { type: 'pipeline', coordinator: 'coord', on_agent_failure: 'halt' } as any,
    AGENT_NAMES, errors,
  )
  assert.equal(errors.length, 0)
  assert.equal(result.config.on_agent_failure, 'halt')
})

test('parseChainStage reads on_agent_failure', () => {
  const errors: string[] = []
  const result = parseChainStage(
    { type: 'chain', coordinator: 'coord', sequence: ['alice', 'bob'], on_agent_failure: 'retry' } as any,
    AGENT_NAMES, errors,
  )
  assert.equal(errors.length, 0)
  assert.equal(result.config.on_agent_failure, 'retry')
})

test('parseBroadcastStage reads on_agent_failure', () => {
  const errors: string[] = []
  const result = parseBroadcastStage(
    { type: 'broadcast', coordinator: 'coord', fan_out: ['alice', 'bob'], on_agent_failure: 'skip' } as any,
    AGENT_NAMES, errors,
  )
  assert.equal(errors.length, 0)
  assert.equal(result.config.on_agent_failure, 'skip')
})

test('parseReviewStage reads on_agent_failure', () => {
  const errors: string[] = []
  const result = parseReviewStage(
    { type: 'review', coordinator: 'coord', producer: 'prod', reviewer: 'rev', on_agent_failure: 'fallback' } as any,
    AGENT_NAMES, errors,
  )
  assert.equal(errors.length, 0)
  assert.equal(result.config.on_agent_failure, 'fallback')
})

test('parseReviewStage reads on_max_iterations', () => {
  const errors: string[] = []
  const result = parseReviewStage(
    {
      type: 'review',
      coordinator: 'coord',
      producer: 'prod',
      reviewer: 'rev',
      config: { on_max_iterations: 'escalate_to_user' },
    } as any,
    AGENT_NAMES,
    errors,
  )
  assert.equal(errors.length, 0)
  assert.equal(result.config.on_max_iterations, 'escalate_to_user')
})

test('on_agent_failure undefined when not provided', () => {
  const errors: string[] = []
  const result = parseDiscussionStage(
    { type: 'discussion', coordinator: 'coord', participants: ['alice'] } as any,
    AGENT_NAMES, errors,
  )
  assert.equal(result.config.on_agent_failure, undefined)
})

test('invalid on_agent_failure produces parse error', () => {
  const errors: string[] = []
  parseDiscussionStage(
    { type: 'discussion', coordinator: 'coord', participants: ['alice'], on_agent_failure: 'bad_value' } as any,
    AGENT_NAMES, errors,
  )
  assert.ok(errors.some(e => e.includes('Invalid on_agent_failure')))
})

// ─── Check 7: validateFailurePolicies ──────────────────────────────────────

test('validateFailurePolicies: unknown fallback_agent → error', () => {
  const errors: string[] = []
  const warnings: string[] = []
  validateFailurePolicies(
    [{ name: 'alice', on_failure: { policy: 'retry', fallback_agent: 'nonexistent' } }] as any,
    errors, warnings,
  )
  assert.ok(errors.some(e => e.includes('nonexistent') && e.includes('not found')))
})

test('validateFailurePolicies: max_retries > 5 → error', () => {
  const errors: string[] = []
  const warnings: string[] = []
  validateFailurePolicies(
    [{ name: 'alice', on_failure: { policy: 'retry', max_retries: 10 } }] as any,
    errors, warnings,
  )
  assert.ok(errors.some(e => e.includes('max_retries') && e.includes('10')))
})

test('validateFailurePolicies: self-referencing fallback → error', () => {
  const errors: string[] = []
  const warnings: string[] = []
  validateFailurePolicies(
    [{ name: 'alice', on_failure: { policy: 'retry', fallback_agent: 'alice' } }] as any,
    errors, warnings,
  )
  assert.ok(errors.some(e => e.includes('references itself')))
})

test('validateFailurePolicies: policy fallback without fallback_agent → error', () => {
  const errors: string[] = []
  const warnings: string[] = []
  validateFailurePolicies(
    [{ name: 'alice', on_failure: { policy: 'fallback' } }] as any,
    errors, warnings,
  )
  assert.ok(errors.some(e => e.includes('fallback') && e.includes('no fallback_agent')))
})

test('validateFailurePolicies: valid config → no errors', () => {
  const errors: string[] = []
  const warnings: string[] = []
  validateFailurePolicies(
    [
      { name: 'alice', on_failure: { policy: 'retry', max_retries: 2, fallback_agent: 'bob' } },
      { name: 'bob', on_failure: { policy: 'skip' } },
    ] as any,
    errors, warnings,
  )
  assert.equal(errors.length, 0)
})

// ─── Check 8: logAgentError writes JSONL ───────────────────────────────────

test('logAgentError writes valid JSONL to workspace/agent-errors.jsonl', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-gate-'))
  const event: AgentErrorEvent = {
    timestamp: new Date().toISOString(),
    session_id: 'sess-1',
    level_id: 'level-1',
    agent_name: 'test-agent',
    attempt: 1,
    max_attempts: 3,
    policy: 'retry',
    error_message: 'test error',
    error_type: 'agent_failure',
    duration_ms: 100,
  }

  logAgentError(tmpDir, event)

  const logPath = path.join(tmpDir, 'agent-errors.jsonl')
  assert.ok(fs.existsSync(logPath))

  const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n')
  assert.equal(lines.length, 1)

  const parsed = JSON.parse(requiredValue(lines[0], 'tests/unit/s1-gate-validation.test.ts:334'))
  assert.equal(parsed.agent_name, 'test-agent')
  assert.equal(parsed.attempt, 1)
  assert.equal(parsed.error_type, 'agent_failure')
  assert.equal(parsed.session_id, 'sess-1')
  assert.equal(parsed.root_session_id, undefined)

  fs.rmSync(tmpDir, { recursive: true })
})

test('logAgentError includes root_session_id when provided', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-gate-'))
  const event: AgentErrorEvent = {
    timestamp: new Date().toISOString(),
    root_session_id: 'root-123',
    session_id: 'sess-1',
    level_id: 'level-1',
    agent_name: 'test-agent',
    attempt: 1,
    max_attempts: 3,
    policy: 'retry',
    error_message: 'test error',
    error_type: 'agent_failure',
    duration_ms: 100,
  }

  logAgentError(tmpDir, event)

  const logPath = path.join(tmpDir, 'agent-errors.jsonl')
  const parsed = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim())
  assert.equal(parsed.root_session_id, 'root-123')

  fs.rmSync(tmpDir, { recursive: true })
})
