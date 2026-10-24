import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { DeferredRunCompletion } from '../../domains/run/run-completion.js'
import { logRuntimeEvent } from '../../domains/runtime/logger.js'

function readEventTypes(assignmentPath: string): string[] {
  const eventsPath = path.join(assignmentPath, 'logs', 'engine-events.jsonl')
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string })
    .map((event) => event.type)
}

function completionRequest(assignmentPath: string) {
  return {
    assignmentPath,
    sessionId: 'child-run',
    rootSessionId: 'root-run',
    parentSessionId: 'root-run',
    team: 'writing-team',
    levelId: 'editorial-review',
    stageType: 'review',
  }
}

describe('DeferredRunCompletion', () => {
  it('emits completion only after later host activity has settled', () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'run-completion-'))
    const assignmentPath = path.join(workspacePath, 'assignments', 'child-run')

    try {
      const completion = new DeferredRunCompletion()
      completion.request(completionRequest(assignmentPath))

      assert.equal(completion.emitWhenIdle(false), false)
      logRuntimeEvent(assignmentPath, {
        timestamp: new Date().toISOString(),
        event: 'host.agent_end',
        session_id: 'child-run',
        root_session_id: 'root-run',
      })

      assert.equal(completion.emitWhenIdle(true), true)
      assert.deepEqual(readEventTypes(assignmentPath), [
        'host.agent_end',
        'run.completed',
      ])
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('uses shutdown as a single-emission fallback', () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'run-completion-'))
    const assignmentPath = path.join(workspacePath, 'assignments', 'child-run')

    try {
      const completion = new DeferredRunCompletion()
      completion.request(completionRequest(assignmentPath))

      assert.equal(completion.emitOnShutdown(), true)
      assert.equal(completion.emitOnShutdown(), false)
      assert.deepEqual(readEventTypes(assignmentPath), ['run.completed'])
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('emits failure immediately and suppresses a pending successful completion', () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'run-completion-'))
    const assignmentPath = path.join(workspacePath, 'assignments', 'child-run')

    try {
      const completion = new DeferredRunCompletion()
      completion.request(completionRequest(assignmentPath))

      assert.equal(completion.fail({
        ...completionRequest(assignmentPath),
        error: 'Provider credentials are unavailable.',
      }), true)
      assert.equal(completion.emitOnShutdown(), false)
      assert.deepEqual(readEventTypes(assignmentPath), ['run.failed'])
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true })
    }
  })
})
