import assert from 'node:assert/strict'
import test from 'node:test'
import { isSessionTask } from '../../contracts/sessions.js'
import { requireSessionTaskRecord } from '../../domains/sessions/session-normalizers.js'

import {
  readWorkflowModelSelection,
  workflowModelEnvironment,
  WORKFLOW_MODEL_SELECTION_ENV,
} from '../../domains/provider/workflow-model-selection.js'

test('a workflow model survives process transport as a concrete pair', () => {
  const pair = { provider: 'codex', model: 'selected-codex' }
  assert.deepEqual(readWorkflowModelSelection(workflowModelEnvironment(pair)), pair)
})

test('a task without a chat selection explicitly clears an inherited workflow model', () => {
  const inherited = workflowModelEnvironment({ provider: 'codex', model: 'selected-codex' })
  const environment = { ...inherited, ...workflowModelEnvironment(undefined) }
  assert.equal(environment[WORKFLOW_MODEL_SELECTION_ENV], '')
  assert.equal(readWorkflowModelSelection(environment), undefined)
})

for (const invalid of ['not json', JSON.stringify({ provider: 'claude' }), JSON.stringify({ provider: 'codex', model: 'x', extra: true }), 'x'.repeat(9000)]) {
  test(`invalid workflow transport is refused: ${invalid.slice(0, 45)}`, () => {
    assert.throws(() => readWorkflowModelSelection({
      [WORKFLOW_MODEL_SELECTION_ENV]: Buffer.from(invalid).toString('base64'),
    }), /Invalid workflow model selection/)
  })
}

function makeTask() {
  return {
    id: 'task', sessionId: 'session', runId: 'run', workflowId: 'workflow',
    brief: 'Build the manual', status: 'queued', createdAt: '2026-10-19T12:00:00.000Z',
    cwd: '/tmp/workflow-task', workerModel: { provider: 'codex', model: 'selected-codex' },
  }
}

test('a saved task retains its valid workflow model at both read boundaries', () => {
  const task = makeTask()
  assert.equal(isSessionTask(task), true)
  assert.deepEqual(requireSessionTaskRecord(task, { sessionId: 'session', taskId: 'task' }).workerModel, { provider: 'codex', model: 'selected-codex' })
})

for (const workerModel of [{ provider: 'codex' }, { provider: '', model: 'x' }, { provider: 'codex', model: 'x', extra: true }, null]) {
  test(`a corrupt saved task model is refused at both read boundaries: ${JSON.stringify(workerModel)}`, () => {
    const task = { ...makeTask(), workerModel }
    assert.equal(isSessionTask(task), false)
    assert.throws(() => requireSessionTaskRecord(task, { sessionId: 'session', taskId: 'task' }), /Task worker model has an invalid schema/)
  })
}
