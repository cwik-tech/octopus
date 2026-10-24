/**
 * Whether a failed workflow step earned a model-choice offer, decided from the
 * evidence a Team dispatch actually leaves behind.
 *
 * That evidence is the assignment's run log — the same records a real Team step
 * writes, not the selected-agent chat journal an earlier version of this read
 * by mistake. One dispatch's `start` says which agent ran and on what; its
 * `fail` says why, how far it got, and how many tools were on the table. The
 * two are joined by dispatch id, so a step where one agent spoke twice cannot
 * have one attempt's pair attributed to the other's failure.
 *
 * Three things must all hold before a user is asked anything: the agent was on
 * its *own* explicit pair, the failure was one a different model could fix, and
 * the attempt is proven to have started no tool. Anything less refuses.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { logAgentRun } from '../../domains/runtime/logger.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { createWorkflowModelChoiceEvaluator } from '../../services/workflow-model-choice-evaluator.js'
import type { AgentRunFailure } from '../../core/types.js'
import type { ModelSelectionRecord } from '../../contracts/agent-model-selection.js'

const EXPLICIT: ModelSelectionRecord = {
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  source: 'agent',
  reason: 'explicit-agent-choice',
  caller: 'agent',
}

const INHERITED: ModelSelectionRecord = {
  provider: 'connection:abc',
  model: 'gpt-5.4-mini',
  source: 'app-default',
  reason: 'agent-default',
  caller: 'agent',
}

const FAILED_DISPATCH = 'dispatch-2'

interface Harness {
  readonly childAssignmentPath: string
  cleanup(): void
}

function makeHarness(): Harness {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-choice-evidence-')),
  )
  const childAssignmentPath = path.join(directory, 'assignments', 'child-run')
  fs.mkdirSync(childAssignmentPath, { recursive: true })
  return {
    childAssignmentPath,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  }
}

function writeStart(
  harness: Harness,
  selection: ModelSelectionRecord,
  options: {
    dispatchId?: string
    agentName?: string
    logicalInvocationId?: string
  } = {},
): void {
  logAgentRun(harness.childAssignmentPath, {
    timestamp: new Date().toISOString(),
    event: 'start',
    session_id: 'child-run',
    assignment_path: harness.childAssignmentPath,
    team: 'writing-team',
    agent_name: options.agentName ?? 'writer',
    agent_type: 'agent',
    status: 'active',
    model: selection.model,
    provider: selection.provider,
    model_selection: selection,
    dispatch_id: options.dispatchId ?? FAILED_DISPATCH,
    ...(options.logicalInvocationId
      ? { logical_invocation_id: options.logicalInvocationId }
      : {}),
  })
}

function writeFailure(
  harness: Harness,
  failure: Partial<AgentRunFailure> & { phase: AgentRunFailure['phase'] },
  options: {
    dispatchId?: string
    agentName?: string
    logicalInvocationId?: string
  } = {},
): void {
  logAgentRun(harness.childAssignmentPath, {
    timestamp: new Date().toISOString(),
    event: 'fail',
    session_id: 'child-run',
    assignment_path: harness.childAssignmentPath,
    team: 'writing-team',
    agent_name: options.agentName ?? 'writer',
    agent_type: 'agent',
    status: 'the attempt failed',
    dispatch_id: options.dispatchId ?? FAILED_DISPATCH,
    ...(options.logicalInvocationId
      ? { logical_invocation_id: options.logicalInvocationId }
      : {}),
    failure: {
      serviceCode: 'provider_failed',
      retryable: false,
      dispatched: false,
      ...failure,
    },
  })
}

/** A dispatch that finished successfully. */
function writeEnd(
  harness: Harness,
  options: { dispatchId?: string; agentName?: string } = {},
): void {
  logAgentRun(harness.childAssignmentPath, {
    timestamp: new Date().toISOString(),
    event: 'end',
    session_id: 'child-run',
    assignment_path: harness.childAssignmentPath,
    team: 'writing-team',
    agent_name: options.agentName ?? 'writer',
    agent_type: 'agent',
    status: 'done',
    dispatch_id: options.dispatchId ?? FAILED_DISPATCH,
  })
}

function evaluatorInput(harness: Harness) {
  return {
    stepId: 'write',
    childRunId: 'child-run',
    childAssignmentPath: harness.childAssignmentPath,
    taskId: 'task-choice',
    sessionId: 'session-choice',
    expectedRevision: '3',
  }
}

function evaluate(harness: Harness) {
  return createWorkflowModelChoiceEvaluator().evaluate(evaluatorInput(harness))
}

function withDefault<T>(
  state: Parameters<typeof setRuntimeDefaultModelState>[0],
  run: () => T,
): T {
  setRuntimeDefaultModelState(state)
  try {
    return run()
  } finally {
    setRuntimeDefaultModelState(undefined)
  }
}

const AVAILABLE_DEFAULT = {
  status: 'available' as const,
  provider: 'connection:abc',
  model: 'gpt-5.4-mini',
}

test('a credential failure on an agent\u2019s own model earns an offer of the app default', async () => {
  const harness = makeHarness()
  try {
    writeStart(harness, EXPLICIT)
    writeFailure(harness, {
      phase: 'provider-resolution',
      providerKind: 'authentication',
    })

    const offer = await withDefault(AVAILABLE_DEFAULT, () => evaluate(harness))

    assert.ok(offer, 'an eligible failure earns an offer')
    assert.equal(offer.agentName, 'writer')
    assert.equal(offer.scope.kind, 'task')
    assert.deepEqual(offer.failedChoice, {
      provider: 'anthropic',
      model: 'claude-opus-4-6',
    })
    assert.deepEqual(offer.proposedDefault, {
      provider: 'connection:abc',
      model: 'gpt-5.4-mini',
    })
    assert.equal(offer.expectedRevision, '3')
  } finally {
    harness.cleanup()
  }
})

test('the pair comes from the attempt that failed, not from another one', async () => {
  const harness = makeHarness()
  try {
    // Two attempts by one agent. Taking the last start, or any start, would
    // attribute the wrong pair to this failure.
    writeStart(harness, INHERITED, { dispatchId: 'dispatch-1' })
    writeEnd(harness, { dispatchId: 'dispatch-1' })
    writeStart(harness, { ...EXPLICIT, model: 'claude-sonnet-4-6' }, {
      dispatchId: 'dispatch-3',
    })
    writeEnd(harness, { dispatchId: 'dispatch-3' })
    writeStart(harness, EXPLICIT, { dispatchId: FAILED_DISPATCH })
    writeFailure(harness, {
      phase: 'provider-resolution',
      providerKind: 'authentication',
    })

    const offer = await withDefault(AVAILABLE_DEFAULT, () => evaluate(harness))

    assert.ok(offer)
    assert.deepEqual(offer.failedChoice, {
      provider: 'anthropic',
      model: 'claude-opus-4-6',
    })
  } finally {
    harness.cleanup()
  }
})

test('a step already on the application default is offered nothing', async () => {
  const harness = makeHarness()
  try {
    // The default has moved since, so the proposed pair would differ from the
    // failed one and a naive eligibility check would allow it. What refuses is
    // the *source*: an inherited step has nothing to be displaced.
    writeStart(harness, INHERITED)
    writeFailure(harness, {
      phase: 'provider-resolution',
      providerKind: 'authentication',
    })

    assert.equal(
      await withDefault(
        { status: 'available', provider: 'connection:abc', model: 'gpt-5.6-sol' },
        () => evaluate(harness),
      ),
      undefined,
    )
  } finally {
    harness.cleanup()
  }
})

test('an attempt that had already sent something is offered nothing', async () => {
  const harness = makeHarness()
  try {
    // The provider runs tools out of process. A failure late in the attempt
    // does not prove none started, and neither does one early in it: an
    // earlier round of the same invocation may already have acted.
    writeStart(harness, EXPLICIT)
    writeFailure(harness, {
      phase: 'provider-resolution',
      providerKind: 'authentication',
      dispatched: true,
    })

    assert.equal(
      await withDefault(AVAILABLE_DEFAULT, () => evaluate(harness)),
      undefined,
    )
  } finally {
    harness.cleanup()
  }
})

test('safety comes from proven tool access, not from the failure phase', async () => {
  // The phase says how the attempt was categorized, which is not observed
  // progress: a provider can authenticate late, or run for a while and report
  // the failure at exit. So a request-phase failure with proven no-tool access
  // is offerable, and a resolution-phase one without that proof is not.
  const offered = makeHarness()
  try {
    writeStart(offered, EXPLICIT)
    writeFailure(offered, { phase: 'provider-request', providerKind: 'not_found' })
    assert.ok(await withDefault(AVAILABLE_DEFAULT, () => evaluate(offered)))
  } finally {
    offered.cleanup()
  }

  const refused = makeHarness()
  try {
    writeStart(refused, EXPLICIT)
    writeFailure(refused, {
      phase: 'provider-resolution',
      providerKind: 'authentication',
      dispatched: true,
    })
    assert.equal(
      await withDefault(AVAILABLE_DEFAULT, () => evaluate(refused)),
      undefined,
    )
  } finally {
    refused.cleanup()
  }
})

test('an earlier attempt of the same invocation is not erased by a later one', async () => {
  // A step can run a primary agent and then a fallback within one logical
  // invocation. The fallback refusing before it sent anything says nothing
  // about what the primary already did, and retrying the invocation would
  // repeat whatever that was.
  const harness = makeHarness()
  try {
    const invocation = 'invocation-1'
    writeStart(harness, EXPLICIT, {
      dispatchId: 'dispatch-primary',
      logicalInvocationId: invocation,
    })
    writeFailure(harness, {
      phase: 'provider-request',
      providerKind: 'authentication',
      dispatched: true,
    }, { dispatchId: 'dispatch-primary', logicalInvocationId: invocation })

    writeStart(harness, EXPLICIT, {
      dispatchId: FAILED_DISPATCH,
      logicalInvocationId: invocation,
    })
    writeFailure(harness, {
      phase: 'provider-resolution',
      providerKind: 'authentication',
      dispatched: false,
    }, { dispatchId: FAILED_DISPATCH, logicalInvocationId: invocation })

    assert.equal(
      await withDefault(AVAILABLE_DEFAULT, () => evaluate(harness)),
      undefined,
    )
  } finally {
    harness.cleanup()
  }
})

test('a malformed later record does not expose an earlier failure as terminal', async () => {
  const harness = makeHarness()
  try {
    writeStart(harness, EXPLICIT, { dispatchId: 'dispatch-earlier' })
    writeFailure(harness, {
      phase: 'provider-resolution',
      providerKind: 'authentication',
      dispatched: false,
    }, { dispatchId: 'dispatch-earlier' })

    // A later attempt whose record this build cannot read. Answering from the
    // earlier one would present a stale failure as the step's outcome.
    logAgentRun(harness.childAssignmentPath, {
      timestamp: new Date().toISOString(),
      event: 'fail',
      session_id: 'child-run',
      assignment_path: harness.childAssignmentPath,
      team: 'writing-team',
      agent_name: 'writer',
      agent_type: 'agent',
      status: 'the attempt failed',
      dispatch_id: FAILED_DISPATCH,
      failure: { phase: 'not-a-phase' } as unknown as AgentRunFailure,
    })

    assert.equal(
      await withDefault(AVAILABLE_DEFAULT, () => evaluate(harness)),
      undefined,
    )
  } finally {
    harness.cleanup()
  }
})

test('a later attempt that never finished is offered nothing', async () => {
  // The step's outcome is not the earlier failure: something started after it
  // and this build cannot say how it ended.
  const harness = makeHarness()
  try {
    writeStart(harness, EXPLICIT, {
      dispatchId: 'dispatch-earlier',
      logicalInvocationId: 'invocation-unfinished',
    })
    writeFailure(harness, {
      phase: 'provider-resolution',
      providerKind: 'authentication',
      dispatched: false,
    }, { dispatchId: 'dispatch-earlier', logicalInvocationId: 'invocation-unfinished' })
    writeStart(harness, EXPLICIT, {
      dispatchId: FAILED_DISPATCH,
      logicalInvocationId: 'invocation-unfinished',
    })

    assert.equal(
      await withDefault(AVAILABLE_DEFAULT, () => evaluate(harness)),
      undefined,
    )
  } finally {
    harness.cleanup()
  }
})

test('an attempt that failed and then finished is not a failure to retry', async () => {
  // A dispatch that recorded both. Whatever produced that log, the attempt
  // ended by finishing, and offering to replace its model would propose
  // undoing a result the run already has.
  const harness = makeHarness()
  try {
    writeStart(harness, EXPLICIT)
    writeFailure(harness, {
      phase: 'provider-resolution',
      providerKind: 'authentication',
      dispatched: false,
    })
    writeEnd(harness)

    assert.equal(
      await withDefault(AVAILABLE_DEFAULT, () => evaluate(harness)),
      undefined,
    )
  } finally {
    harness.cleanup()
  }
})

test('a retry that succeeded supersedes the failure it retried', async () => {
  // One invocation, two attempts: the first failed and the policy retried it,
  // and the retry answered. Offering here would propose replacing a model that
  // went on to produce the step's result.
  const harness = makeHarness()
  const invocation = 'invocation-retried'
  try {
    writeStart(harness, EXPLICIT, {
      dispatchId: 'dispatch-earlier',
      logicalInvocationId: invocation,
    })
    writeFailure(harness, {
      phase: 'provider-resolution',
      providerKind: 'authentication',
      dispatched: false,
    }, { dispatchId: 'dispatch-earlier', logicalInvocationId: invocation })
    writeStart(harness, EXPLICIT, {
      dispatchId: FAILED_DISPATCH,
      logicalInvocationId: invocation,
    })
    writeEnd(harness, { dispatchId: FAILED_DISPATCH })

    assert.equal(
      await withDefault(AVAILABLE_DEFAULT, () => evaluate(harness)),
      undefined,
    )
  } finally {
    harness.cleanup()
  }
})

test('a truncated log line voids the history rather than hiding a later attempt', async () => {
  // A half-written line is not "nothing happened". Skipping it would leave the
  // earlier eligible failure looking like the step's outcome while an
  // unreadable attempt sits after it.
  const harness = makeHarness()
  try {
    writeStart(harness, EXPLICIT, { dispatchId: 'dispatch-earlier' })
    writeFailure(harness, {
      phase: 'provider-resolution',
      providerKind: 'authentication',
      dispatched: false,
    }, { dispatchId: 'dispatch-earlier' })
    fs.appendFileSync(
      path.join(harness.childAssignmentPath, 'logs', 'agent-runs.jsonl'),
      '{"event":"start","dispatch_id":"dispatch-tru\n',
      'utf8',
    )

    assert.equal(
      await withDefault(AVAILABLE_DEFAULT, () => evaluate(harness)),
      undefined,
    )
  } finally {
    harness.cleanup()
  }
})

test('a parallel wave attributes the offer to the invocation that failed', async () => {
  // A pipeline wave runs its members concurrently into one log, so the records
  // interleave: A starts, B starts, B finishes, A fails. Taking whichever
  // dispatch appeared last picks B — which succeeded — and loses A's otherwise
  // eligible failure entirely.
  const harness = makeHarness()
  try {
    writeStart(harness, EXPLICIT, {
      dispatchId: 'dispatch-a',
      agentName: 'writer',
      logicalInvocationId: 'invocation-a',
    })
    writeStart(harness, INHERITED, {
      dispatchId: 'dispatch-b',
      agentName: 'reviewer',
      logicalInvocationId: 'invocation-b',
    })
    writeEnd(harness, { dispatchId: 'dispatch-b', agentName: 'reviewer' })
    writeFailure(harness, {
      phase: 'provider-resolution',
      providerKind: 'authentication',
      dispatched: false,
    }, { dispatchId: 'dispatch-a', agentName: 'writer', logicalInvocationId: 'invocation-a' })

    const offer = await withDefault(AVAILABLE_DEFAULT, () => evaluate(harness))

    assert.ok(offer, 'the successful peer must not hide the failed member')
    assert.equal(offer.agentName, 'writer')
    assert.deepEqual(offer.failedChoice, {
      provider: 'anthropic',
      model: 'claude-opus-4-6',
    })
  } finally {
    harness.cleanup()
  }
})

test('two failed invocations in one step are offered nothing', async () => {
  // Consent is per invocation. One offer cannot say which of two attempts it
  // authorizes, and approving both from one click is not consent.
  const harness = makeHarness()
  try {
    for (const [dispatchId, agentName, invocation] of [
      ['dispatch-a', 'writer', 'invocation-a'],
      ['dispatch-b', 'reviewer', 'invocation-b'],
    ] as const) {
      writeStart(harness, EXPLICIT, {
        dispatchId,
        agentName,
        logicalInvocationId: invocation,
      })
      writeFailure(harness, {
        phase: 'provider-resolution',
        providerKind: 'authentication',
        dispatched: false,
      }, { dispatchId, agentName, logicalInvocationId: invocation })
    }

    assert.equal(
      await withDefault(AVAILABLE_DEFAULT, () => evaluate(harness)),
      undefined,
    )
  } finally {
    harness.cleanup()
  }
})

test('a repeated dispatch identity is contradictory evidence, not an update', async () => {
  // Dispatch ids repeat by design: a re-executed stage slot restarts at
  // attempt 1 with the same identity. Letting a later record overwrite an
  // earlier one would let a `dispatched: false` failure erase a dispatched one
  // that shares its id.
  const harness = makeHarness()
  try {
    writeStart(harness, EXPLICIT)
    writeFailure(harness, {
      phase: 'provider-request',
      providerKind: 'authentication',
      dispatched: true,
    })
    writeStart(harness, EXPLICIT)
    writeFailure(harness, {
      phase: 'provider-resolution',
      providerKind: 'authentication',
      dispatched: false,
    })

    assert.equal(
      await withDefault(AVAILABLE_DEFAULT, () => evaluate(harness)),
      undefined,
    )
  } finally {
    harness.cleanup()
  }
})

test('a re-executed attempt under one dispatch id is not a finished one', async () => {
  // A stage slot re-executes under the same concrete identity. The earlier
  // terminal must not stand in for the new attempt, which has not finished.
  const harness = makeHarness()
  try {
    writeStart(harness, EXPLICIT)
    writeFailure(harness, {
      phase: 'provider-resolution',
      providerKind: 'authentication',
      dispatched: false,
    })
    writeStart(harness, EXPLICIT)

    assert.equal(
      await withDefault(AVAILABLE_DEFAULT, () => evaluate(harness)),
      undefined,
    )
  } finally {
    harness.cleanup()
  }
})

test('an offer names the invocation it is for', async () => {
  const harness = makeHarness()
  try {
    writeStart(harness, EXPLICIT, { logicalInvocationId: 'invocation-1' })
    writeFailure(harness, {
      phase: 'provider-resolution',
      providerKind: 'authentication',
      dispatched: false,
    }, { logicalInvocationId: 'invocation-1' })

    const offer = await withDefault(AVAILABLE_DEFAULT, () => evaluate(harness))
    assert.ok(offer)
    assert.equal(offer.logicalInvocationId, 'invocation-1')
  } finally {
    harness.cleanup()
  }
})

test('a step that recorded no failure is offered nothing', async () => {
  const harness = makeHarness()
  try {
    // A start with no terminal failure is a step this build cannot say ended.
    writeStart(harness, EXPLICIT)

    assert.equal(
      await withDefault(AVAILABLE_DEFAULT, () => evaluate(harness)),
      undefined,
    )
  } finally {
    harness.cleanup()
  }
})

test('a failure whose dispatch recorded no selection is offered nothing', async () => {
  const harness = makeHarness()
  try {
    // A failure this build cannot attribute to a known pair is not evidence.
    writeFailure(harness, {
      phase: 'provider-resolution',
      providerKind: 'authentication',
    })

    assert.equal(
      await withDefault(AVAILABLE_DEFAULT, () => evaluate(harness)),
      undefined,
    )
  } finally {
    harness.cleanup()
  }
})

test('a step with no run log at all is offered nothing', async () => {
  const harness = makeHarness()
  try {
    assert.equal(
      await withDefault(AVAILABLE_DEFAULT, () => evaluate(harness)),
      undefined,
    )
  } finally {
    harness.cleanup()
  }
})

test('no application default means nothing to offer', async () => {
  const harness = makeHarness()
  try {
    writeStart(harness, EXPLICIT)
    writeFailure(harness, {
      phase: 'provider-resolution',
      providerKind: 'authentication',
    })

    assert.equal(
      await withDefault({ status: 'unset' }, () => evaluate(harness)),
      undefined,
    )
  } finally {
    harness.cleanup()
  }
})
