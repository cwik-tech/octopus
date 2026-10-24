/**
 * What a Team run writes down about the model each agent was admitted on.
 *
 * Recorded on the `start` event, which is emitted before the provider is
 * called, so the disclosure is on screen while the agent is still working
 * rather than after its first token. Read back through the same run store the
 * UI reads, because that is what decides whether a reopened run can still say
 * what it ran on.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { logAgentRun } from '../../domains/runtime/logger.js'
import type { AgentRunEvent } from '../../core/types.js'
import type { ModelSelectionRecord } from '../../contracts/agent-model-selection.js'

const AGENT_DEFAULT: ModelSelectionRecord = {
  provider: 'connection:abc',
  model: 'gpt-5.4-mini',
  source: 'app-default',
  reason: 'agent-default',
  caller: 'agent',
}

async function withRunWorkspace(
  fn: (paths: {
    workspacePath: string
    assignmentPath: string
  }) => void | Promise<void>,
): Promise<void> {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-model-selection-')),
  )
  try {
    const workspacePath = path.join(directory, 'workspace')
    // The legacy assignment layout the run store still lists.
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-1')
    fs.mkdirSync(assignmentPath, { recursive: true })
    await fn({ workspacePath, assignmentPath })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function startEvent(
  assignmentPath: string,
  overrides: Partial<AgentRunEvent> = {},
): AgentRunEvent {
  return {
    timestamp: '2026-09-05T10:00:00.000Z',
    event: 'start',
    session_id: 'run-1',
    assignment_path: assignmentPath,
    team: 'review-team',
    agent_name: 'reviewer',
    agent_type: 'agent',
    status: 'active',
    provider: AGENT_DEFAULT.provider,
    model: AGENT_DEFAULT.model,
    ...overrides,
  }
}

test('an agent start event carries the selection that admitted it', async () => {
  await withRunWorkspace(({ assignmentPath }) => {
    logAgentRun(assignmentPath, startEvent(assignmentPath, {
      model_selection: AGENT_DEFAULT,
    }))

    const recorded = fs
      .readFileSync(
        path.join(assignmentPath, 'logs', 'agent-runs.jsonl'),
        'utf8',
      )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AgentRunEvent)

    assert.equal(recorded.length, 1)
    assert.deepEqual(recorded[0]?.model_selection, AGENT_DEFAULT)
  })
})

test('a run reopened from disk still reports the selection it ran on', async () => {
  await withRunWorkspace(async ({ workspacePath, assignmentPath }) => {
    logAgentRun(assignmentPath, startEvent(assignmentPath, {
      model_selection: AGENT_DEFAULT,
    }))

    const store = new FileSystemRunStore(workspacePath)
    const events = await store.listRunEvents('run-1')
    const start = events.find((event) => event.type === 'agent.start')

    assert.ok(start, 'the run store must project the agent start event')
    assert.deepEqual(
      (start.payload as { model_selection?: ModelSelectionRecord })
        .model_selection,
      AGENT_DEFAULT,
    )
  })
})

test('a run recorded before provenance existed reports none rather than inventing one', async () => {
  await withRunWorkspace(async ({ workspacePath, assignmentPath }) => {
    logAgentRun(assignmentPath, startEvent(assignmentPath))

    const store = new FileSystemRunStore(workspacePath)
    const start = (await store.listRunEvents('run-1')).find(
      (event) => event.type === 'agent.start',
    )

    assert.ok(start)
    assert.equal(
      (start.payload as { model_selection?: ModelSelectionRecord })
        .model_selection,
      undefined,
    )
  })
})
