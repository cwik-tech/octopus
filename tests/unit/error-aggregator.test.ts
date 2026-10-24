import { requiredValue } from '../../core/required-value.js'
/**
 * Error Aggregator Tests
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  readAgentErrors,
  getAgentFailureSummary,
  readProviderFailures,
  getProviderFailureStats,
  formatRecentErrors,
  errorTypeColor,
} from '../../core/error-aggregator.js'
import { logAgentError } from '../../domains/runtime/logger.js'
import type { AgentErrorEvent, ProviderEvent } from '../../core/types.js'

function withTempWorkspace(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'error-aggregator-test-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function writeAgentErrors(workspacePath: string, events: AgentErrorEvent[]): void {
  for (const event of events) {
    logAgentError(workspacePath, event)
  }
}

function writeProviderEvents(outputPath: string, events: ProviderEvent[]): void {
  const logDir = path.join(outputPath, 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  for (const event of events) {
    fs.appendFileSync(path.join(logDir, 'provider-events.jsonl'), JSON.stringify(event) + '\n')
  }
}

test('readAgentErrors returns empty array when file missing', () => {
  withTempWorkspace((dir) => {
    const errors = readAgentErrors(dir)
    assert.deepEqual(errors, [])
  })
})

test('readAgentErrors reads events in chronological order', () => {
  withTempWorkspace((dir) => {
    const base: AgentErrorEvent = {
      timestamp: '2026-05-01T10:00:00.000Z',
      session_id: 's1',
      level_id: 'l1',
      agent_name: 'alice',
      attempt: 1,
      max_attempts: 3,
      policy: 'retry',
      error_message: 'fail',
      error_type: 'agent_failure',
      duration_ms: 100,
    }
    writeAgentErrors(dir, [
      { ...base, timestamp: '2026-05-01T10:00:00.000Z' },
      { ...base, timestamp: '2026-05-01T10:01:00.000Z', attempt: 2 },
      { ...base, timestamp: '2026-05-01T10:02:00.000Z', attempt: 3 },
    ])
    const errors = readAgentErrors(dir)
    assert.equal(errors.length, 3)
    assert.equal(requiredValue(errors[0], 'tests/unit/error-aggregator.test.ts:72').attempt, 1)
    assert.equal(requiredValue(errors[2], 'tests/unit/error-aggregator.test.ts:73').attempt, 3)
  })
})

test('readAgentErrors respects since filter', () => {
  withTempWorkspace((dir) => {
    const base: AgentErrorEvent = {
      timestamp: '2026-05-01T10:00:00.000Z',
      session_id: 's1',
      level_id: 'l1',
      agent_name: 'alice',
      attempt: 1,
      max_attempts: 3,
      policy: 'retry',
      error_message: 'fail',
      error_type: 'agent_failure',
      duration_ms: 100,
    }
    writeAgentErrors(dir, [
      { ...base, timestamp: '2026-05-01T08:00:00.000Z' },
      { ...base, timestamp: '2026-05-01T12:00:00.000Z' },
    ])
    const errors = readAgentErrors(dir, { since: new Date('2026-05-01T10:00:00.000Z') })
    assert.equal(errors.length, 1)
    assert.equal(requiredValue(errors[0], 'tests/unit/error-aggregator.test.ts:97').timestamp, '2026-05-01T12:00:00.000Z')
  })
})

test('readAgentErrors respects agentFilter', () => {
  withTempWorkspace((dir) => {
    const base: AgentErrorEvent = {
      timestamp: '2026-05-01T10:00:00.000Z',
      session_id: 's1',
      level_id: 'l1',
      agent_name: 'alice',
      attempt: 1,
      max_attempts: 3,
      policy: 'retry',
      error_message: 'fail',
      error_type: 'agent_failure',
      duration_ms: 100,
    }
    writeAgentErrors(dir, [
      { ...base, agent_name: 'alice' },
      { ...base, agent_name: 'bob' },
    ])
    const errors = readAgentErrors(dir, { agentFilter: 'bob' })
    assert.equal(errors.length, 1)
    assert.equal(requiredValue(errors[0], 'tests/unit/error-aggregator.test.ts:121').agent_name, 'bob')
  })
})

test('getAgentFailureSummary aggregates per agent', () => {
  withTempWorkspace((dir) => {
    const base: AgentErrorEvent = {
      timestamp: '2026-05-01T10:00:00.000Z',
      session_id: 's1',
      level_id: 'l1',
      agent_name: 'alice',
      attempt: 1,
      max_attempts: 3,
      policy: 'retry',
      error_message: 'fail',
      error_type: 'agent_failure',
      duration_ms: 100,
    }
    writeAgentErrors(dir, [
      { ...base, agent_name: 'alice' },
      { ...base, agent_name: 'alice', timestamp: '2026-05-01T10:01:00.000Z', error_type: 'halt' },
      { ...base, agent_name: 'bob' },
    ])
    const summary = getAgentFailureSummary(dir)
    assert.equal(summary.length, 2)
    const alice = summary.find((s) => s.agentName === 'alice')!
    assert.equal(alice.failureCount, 2)
    assert.equal(alice.lastErrorType, 'halt')
    assert.ok(alice.errorTypes.includes('agent_failure'))
    assert.ok(alice.errorTypes.includes('halt'))
    const bob = summary.find((s) => s.agentName === 'bob')!
    assert.equal(bob.failureCount, 1)
  })
})

test('formatRecentErrors returns the most recent limited window in chronological order', () => {
  withTempWorkspace((dir) => {
    const base: AgentErrorEvent = {
      timestamp: '2026-05-01T10:00:00.000Z',
      session_id: 's1',
      level_id: 'l1',
      agent_name: 'alice',
      attempt: 1,
      max_attempts: 3,
      policy: 'retry',
      error_message: 'fail',
      error_type: 'agent_failure',
      duration_ms: 100,
    }
    writeAgentErrors(dir, [
      { ...base, timestamp: '2026-05-01T10:00:00.000Z', attempt: 1 },
      { ...base, timestamp: '2026-05-01T10:01:00.000Z', attempt: 2 },
      { ...base, timestamp: '2026-05-01T10:02:00.000Z', attempt: 3 },
    ])
    const errors = formatRecentErrors(dir, 2)
    assert.equal(errors.length, 2)
    assert.equal(requiredValue(errors[0], 'tests/unit/error-aggregator.test.ts:177').attempt, 2)
    assert.equal(requiredValue(errors[1], 'tests/unit/error-aggregator.test.ts:178').attempt, 3)
  })
})

test('readProviderFailures filters request.fail events', () => {
  withTempWorkspace((dir) => {
    const events: ProviderEvent[] = [
      { timestamp: '2026-05-01T10:00:00.000Z', provider: 'anthropic', event: 'request.start' },
      { timestamp: '2026-05-01T10:00:01.000Z', provider: 'anthropic', event: 'request.fail', status: 'failed', detail: 'rate limit' },
      { timestamp: '2026-05-01T10:00:02.000Z', provider: 'anthropic', event: 'request.end' },
    ]
    writeProviderEvents(dir, events)
    const failures = readProviderFailures(dir)
    assert.equal(failures.length, 1)
    assert.equal(requiredValue(failures[0], 'tests/unit/error-aggregator.test.ts:192').event, 'request.fail')
  })
})

test('getProviderFailureStats aggregates per provider', () => {
  withTempWorkspace((dir) => {
    const events: ProviderEvent[] = [
      { timestamp: '2026-05-01T10:00:00.000Z', provider: 'anthropic', event: 'request.fail', status: 'failed', detail: 'error 1', raw: { http_status: 429 } },
      { timestamp: '2026-05-01T10:00:01.000Z', provider: 'anthropic', event: 'request.fail', status: 'failed', detail: 'error 2' },
      { timestamp: '2026-05-01T10:00:02.000Z', provider: 'openai', event: 'request.fail', status: 'failed', detail: 'error 3' },
    ]
    writeProviderEvents(dir, events)
    const stats = getProviderFailureStats(dir)
    assert.equal(stats.length, 2)
    const anthropic = stats.find((s) => s.provider === 'anthropic')!
    assert.equal(anthropic.failureCount, 2)
    assert.equal(anthropic.lastStatusCode, 429)
    const openai = stats.find((s) => s.provider === 'openai')!
    assert.equal(openai.failureCount, 1)
  })
})

test('formatRecentErrors returns ErrorPaneEntry shape', () => {
  withTempWorkspace((dir) => {
    const event: AgentErrorEvent = {
      timestamp: '2026-05-01T10:00:00.000Z',
      session_id: 's1',
      level_id: 'l1',
      agent_name: 'alice',
      attempt: 2,
      max_attempts: 3,
      policy: 'retry',
      error_message: 'timeout',
      error_type: 'agent_failure',
      duration_ms: 500,
    }
    writeAgentErrors(dir, [event])
    const formatted = formatRecentErrors(dir)
    assert.equal(formatted.length, 1)
    assert.equal(requiredValue(formatted[0], 'tests/unit/error-aggregator.test.ts:231').agent, 'alice')
    assert.equal(requiredValue(formatted[0], 'tests/unit/error-aggregator.test.ts:232').errorType, 'agent_failure')
    assert.equal(requiredValue(formatted[0], 'tests/unit/error-aggregator.test.ts:233').attempt, 2)
    assert.equal(requiredValue(formatted[0], 'tests/unit/error-aggregator.test.ts:234').maxAttempts, 3)
  })
})

test('errorTypeColor returns expected ANSI colors', () => {
  assert.equal(errorTypeColor('halt'), 196)
  assert.equal(errorTypeColor('fallback_failure'), 208)
  assert.equal(errorTypeColor('skipped'), 226)
  assert.equal(errorTypeColor('agent_failure'), 220)
  assert.equal(errorTypeColor('unknown'), 250)
})
