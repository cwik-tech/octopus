/**
 * From a real failed dispatch to an offer, with nothing hand-written.
 *
 * The evaluator's other tests write run-log records themselves, which proves
 * the policy but not that anything produces records it can read. This one runs
 * an actual dispatch against a provider that refuses before sending, then asks
 * the production evaluator whether that failure earned an offer.
 *
 * It is the join between the two halves: a producer that records a typed,
 * attributable, pre-dispatch failure, and a policy that will only act on one.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { initProviders } from '../../providers/index.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import { dispatchToAgentOrTeam } from '../../domains/agent-execution/agent-runner.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { createWorkflowModelChoiceEvaluator } from '../../services/workflow-model-choice-evaluator.js'
import type { LoadedAgent, RuntimeState } from '../../core/types.js'

initProviders()

function dispatchState(sessionId: string): RuntimeState {
  return {
    sessionId,
    currentLevelIndex: 0,
    levelStates: new Map(),
    totalCost: 0,
    startTime: 0,
    timerStarted: false,
    endTime: null,
    spawnDepth: 0,
  }
}

function agentPinnedTo(provider: string, model: string): LoadedAgent {
  return {
    name: 'writer',
    model,
    thinking: 'low',
    tools: [],
    systemPrompt: 'Answer.',
    experienceContent: '',
    experienceEnabled: false,
    skillsContent: '',
    knowledgeContent: '',
    agentDir: '',
    color: 1,
    provider,
    providerConfig: {},
    selection: {
      provider,
      model,
      source: 'agent',
      reason: 'explicit-agent-choice',
    },
  }
}

test('a connection that is gone produces a failure the evaluator can act on', async () => {
  // The agent is pinned to a configured connection that no longer exists. The
  // adapter refuses before building a request, which is the one thing that
  // proves nothing ran — and the only shape a retry may be offered for.
  const outputPath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'model-choice-producer-')),
  )
  // Nothing is registered, so the pinned connection cannot resolve.
  setConfiguredProviderConnections([])
  setRuntimeDefaultModelState({
    status: 'available',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
  })
  try {
    await dispatchToAgentOrTeam({
      agent: agentPinnedTo('connection:missing-connection', 'pinned-model'),
      rosterEntry: { type: 'agent' },
      finalPrompt: 'Answer.',
      userMessage: 'A question.',
      state: dispatchState('model-choice-producer-session'),
      workspacePath: outputPath,
      outputPath,
      metrics: undefined,
      logicalInvocationId: 'invocation-1',
    }).catch(() => undefined)

    const offer = await createWorkflowModelChoiceEvaluator().evaluate({
      stepId: 'write',
      childRunId: 'child-run',
      childAssignmentPath: outputPath,
      taskId: 'task-producer',
      sessionId: 'session-producer',
      expectedRevision: '3',
    })

    assert.ok(offer, 'a real pre-dispatch refusal earns an offer')
    assert.equal(offer.agentName, 'writer')
    assert.equal(offer.logicalInvocationId, 'invocation-1')
    assert.deepEqual(offer.failedChoice, {
      provider: 'connection:missing-connection',
      model: 'pinned-model',
    })
    assert.deepEqual(offer.proposedDefault, {
      provider: 'anthropic',
      model: 'claude-opus-4-6',
    })
  } finally {
    setRuntimeDefaultModelState(undefined)
    fs.rmSync(outputPath, { recursive: true, force: true })
  }
})
