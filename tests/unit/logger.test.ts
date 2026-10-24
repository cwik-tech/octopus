import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { getAssignmentLogPath, logConversationMessage, logSessionStart } from '../../domains/runtime/logger.js'

test('logSessionStart initializes provider-events.jsonl, host-events.jsonl, review-events.jsonl, runtime-events.jsonl, and engine-events.jsonl alongside the other runtime logs', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-init-'))

  try {
    logSessionStart(outputDir, 'session-1', 'writing-team', ['editor'], 'root-1')

    assert.ok(fs.existsSync(getAssignmentLogPath(outputDir, 'conversation.jsonl')))
    assert.ok(fs.existsSync(getAssignmentLogPath(outputDir, 'tool-use.jsonl')))
    assert.ok(fs.existsSync(getAssignmentLogPath(outputDir, 'agent-runs.jsonl')))
    assert.ok(fs.existsSync(getAssignmentLogPath(outputDir, 'delegations.jsonl')))
    assert.ok(fs.existsSync(getAssignmentLogPath(outputDir, 'provider-events.jsonl')))
    assert.ok(fs.existsSync(getAssignmentLogPath(outputDir, 'host-events.jsonl')))
    assert.ok(fs.existsSync(getAssignmentLogPath(outputDir, 'review-events.jsonl')))
    assert.ok(fs.existsSync(getAssignmentLogPath(outputDir, 'runtime-events.jsonl')))
    assert.ok(fs.existsSync(getAssignmentLogPath(outputDir, 'engine-events.jsonl')))
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

test('logSessionStart writes a normalized run.session_started engine event', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-run-start-'))

  try {
    logSessionStart(outputDir, 'session-2', 'writing-team', ['editor'], 'root-2')

    const persisted = fs.readFileSync(getAssignmentLogPath(outputDir, 'engine-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const runStartEvent = persisted.find((event) => event.type === 'run.session_started')

    assert.ok(runStartEvent)
    assert.equal(runStartEvent?.schema_version, 1)
    assert.equal(runStartEvent?.tenant_id, 'local')
    assert.equal(runStartEvent?.run_id, 'session-2')
    assert.equal(runStartEvent?.root_run_id, 'root-2')
    assert.equal(runStartEvent?.team, 'writing-team')
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

test('logConversationMessage publishes a discussion.message engine event', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-discussion-message-'))

  try {
    logSessionStart(outputDir, 'session-3', 'problem-thinking-board', ['agent'], 'root-3')
    logConversationMessage(
      outputDir,
      {
        from: 'agent',
        to: 'all',
        round: 1,
        timestamp: '2026-05-01T12:00:00.000Z',
        type: 'position',
        message: 'Live debate content',
      },
      'root-3',
      {
        sessionId: 'session-3',
        team: 'problem-thinking-board',
        levelId: 'deliberation',
        stageType: 'discussion',
      },
    )

    const persisted = fs.readFileSync(getAssignmentLogPath(outputDir, 'engine-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const messageEvent = persisted.find((event) => event.type === 'discussion.message')

    assert.ok(messageEvent)
    assert.equal(messageEvent?.run_id, 'session-3')
    assert.equal(messageEvent?.root_run_id, 'root-3')
    assert.equal(messageEvent?.stage_type, 'discussion')
    assert.equal((messageEvent?.payload as Record<string, unknown>).text, 'Live debate content')
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})
