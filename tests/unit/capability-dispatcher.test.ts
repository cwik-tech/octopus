import assert from 'node:assert/strict'
import test from 'node:test'

import {
  serialCapabilityEffect,
  type CapabilityEffect,
} from '../../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityApprovalDescription,
  CapabilityApprovalPort,
  CapabilityBudgetPort,
  CapabilityDispatchEvent,
  CapabilityDispatchResult,
  CapabilityDispatcherPorts,
  CapabilityExecutionContext,
  CapabilityInvocation,
  CapabilityPolicyDecision,
} from '../../contracts/capability-dispatch.js'
import type { CapabilityDurableDispatchPort } from '../../contracts/durable-dispatch.js'
import { CapabilityDispatcher } from '../../core/capability-dispatcher.js'
import { CapabilityInvocationBindings } from '../../core/capability-invocation-bindings.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'

test('dispatches one allowed capability through the fixed kernel stage order', async () => {
  const stages: string[] = []
  const adapter: CapabilityAdapter = {
    capabilityId: 'browser.interact',
    prepare: async () => {
      stages.push('prepare')
      return {
        effect: serialCapabilityEffect('read-only'),
        risk: 'safe',
        argumentNames: ['a', 'b'],
        policyDecision: { kind: 'allow' },
        authorize: async ({ phase }) => {
          stages.push(`adapter.authorize.${phase}`)
          return { kind: 'allow' }
        },
        execute: async () => {
          stages.push('execute')
          return { ok: true }
        },
        beginCompletion: async () => {
          stages.push('begin-completion')
          return {
            release: async () => {
              stages.push('completion-fence.release')
            },
          }
        },
        acceptResult: async ({ value }) => {
          stages.push('accept-result')
          return { value }
        },
        release: async () => {
          stages.push('release')
        },
      }
    },
  }
  const dispatcher = new CapabilityDispatcher({
    bindings: new CapabilityInvocationBindings({
      maxActivePerScope: 4,
      maxRetainedPerScope: 32,
    }),
    authority: {
      authorize: async ({ phase }) => {
        stages.push(`authority.${phase}`)
        return { kind: 'allow' }
      },
    },
    policy: {
      evaluate: async () => {
        stages.push('policy')
        return { kind: 'allow' }
      },
    },
    budget: {
      preflight: async () => {
        stages.push('budget.preflight')
        return { kind: 'not-metered' }
      },
      reserve: async () => {
        stages.push('budget.reserve')
        return { reservationId: 'unexpected' }
      },
      settle: async () => {
        stages.push('budget.settle')
        return { costTracked: false, budgetOverrun: false }
      },
      release: async () => {
        stages.push('budget.release')
      },
    },
    evidence: {
      append: async (event) => {
        stages.push(`evidence.${event.type.replace('capability.dispatch.', '')}`)
      },
    },
    scheduler: new PerAuthorityCapabilityExecutionScheduler(),
    clock: { now: () => 1_000 },
    ids: { nextAttemptId: () => 'attempt-1' },
  })

  const result = await dispatcher.dispatch({
    context: makeContext(),
    invocation: {
      capabilityId: 'browser.interact',
      source: { kind: 'builtin', id: 'browser', version: '1' },
      toolCallId: 'call-1',
      input: { b: 2, a: 1 },
    },
    adapter,
  })

  assert.equal(result.status, 'completed')
  if (result.status !== 'completed') return
  assert.deepEqual(result.value, { ok: true })
  assert.deepEqual(stages, [
    'authority.initial',
    'prepare',
    'evidence.requested',
    'adapter.authorize.initial',
    'policy',
    'budget.preflight',
    'adapter.authorize.before-execute',
    'authority.before-execute',
    'policy',
    'evidence.started',
    'policy',
    'authority.before-execute',
    'execute',
    'begin-completion',
    'authority.after-result',
    'adapter.authorize.after-result',
    'accept-result',
    'evidence.completed',
    'completion-fence.release',
    'release',
  ])
})

test('reauthorizes only after the scheduler grants the execution slot', async () => {
  const events: CapabilityDispatchEvent['type'][] = []
  let authorityRevoked = false
  let executeCount = 0
  const dispatcher = makeDispatcher({
    authority: {
      authorize: async ({ phase }) =>
        phase === 'before-execute' && authorityRevoked
          ? {
              kind: 'deny',
              code: 'authority_revoked',
              reason: 'The execution authority was revoked while queued.',
            }
          : { kind: 'allow' },
    },
    scheduler: {
      run: async ({ operation }) => {
        authorityRevoked = true
        return operation()
      },
    },
    evidence: {
      append: async (event) => {
        events.push(event.type)
      },
    },
  })

  const result = await dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'observe' }),
    adapter: makeAdapter({
      execute: async () => {
        executeCount += 1
        return { ok: true }
      },
    }),
  })

  assert.equal(result.status, 'rejected')
  if (result.status === 'rejected') {
    assert.equal(result.code, 'authority_revoked')
  }
  assert.equal(executeCount, 0)
  assert.deepEqual(events, [
    'capability.dispatch.requested',
    'capability.dispatch.rejected',
  ])
})

test('reevaluates shared policy after the scheduler grants the execution slot', async () => {
  let policyChanged = false
  let executeCount = 0
  const dispatcher = makeDispatcher({
    policy: {
      evaluate: async () =>
        policyChanged
          ? {
              kind: 'deny',
              code: 'policy_changed',
              reason: 'Policy changed while this invocation waited.',
            }
          : { kind: 'allow' },
    },
    scheduler: {
      run: async ({ operation }) => {
        policyChanged = true
        return operation()
      },
    },
  })

  const result = await dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'observe' }),
    adapter: makeAdapter({
      execute: async () => {
        executeCount += 1
        return { ok: true }
      },
    }),
  })

  assert.equal(result.status, 'rejected')
  if (result.status === 'rejected') {
    assert.equal(result.code, 'policy_changed')
  }
  assert.equal(executeCount, 0)
})

test('same-scope serial capabilities contend across capability IDs while queued cancellation remains prompt', async () => {
  const youtubeStarted = deferred<void>()
  const releaseYoutube = deferred<void>()
  const browserQueued = deferred<void>()
  const serialScheduler = new PerAuthorityCapabilityExecutionScheduler()
  let schedulerCalls = 0
  let browserExecuted = false
  const dispatcher = makeDispatcher({
    scheduler: {
      run: async (input) => {
        schedulerCalls += 1
        if (schedulerCalls === 2) browserQueued.resolve()
        return serialScheduler.run(input)
      },
    },
  })

  const youtube = dispatcher.dispatch({
    context: makeContext(),
    invocation: {
      capabilityId: 'youtube.extract',
      source: { kind: 'builtin', id: 'youtube', version: 'fixture' },
      toolCallId: 'youtube-capture-call',
      input: { action: 'capture' },
    },
    adapter: makeAdapter({
      capabilityId: 'youtube.extract',
      effect: serialCapabilityEffect('mutating'),
      execute: async () => {
        youtubeStarted.resolve()
        await releaseYoutube.promise
        return { captured: true }
      },
    }),
  })
  await youtubeStarted.promise

  const browserController = new AbortController()
  const browser = dispatcher.dispatch({
    context: makeContext(),
    invocation: {
      capabilityId: 'browser.interact',
      source: { kind: 'builtin', id: 'browser', version: 'fixture' },
      toolCallId: 'browser-observe-call',
      input: { action: 'observe' },
    },
    adapter: makeAdapter({
      capabilityId: 'browser.interact',
      effect: serialCapabilityEffect('read-only'),
      execute: async () => {
        browserExecuted = true
        return { observed: true }
      },
    }),
    signal: browserController.signal,
  })
  await browserQueued.promise
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(browserExecuted, false)

  browserController.abort(new DOMException('caller stopped waiting', 'AbortError'))
  const browserResult = await browser

  assert.equal(browserResult.status, 'cancelled')
  if (browserResult.status === 'cancelled') {
    assert.equal(browserResult.code, 'caller_cancelled')
  }
  assert.equal(browserExecuted, false)

  releaseYoutube.resolve()
  assert.equal((await youtube).status, 'completed')
})

for (const cancellationStage of [
  'authority',
  'budget-reserve',
  'running-lifecycle',
  'started-evidence',
] as const) {
  test(`cancellation during ${cancellationStage} never enters the executor`, async () => {
    const stageEntered = deferred<void>()
    const releaseStage = deferred<void>()
    const controller = new AbortController()
    const events: CapabilityDispatchEvent['type'][] = []
    let reserveCount = 0
    let releaseCount = 0
    let executeCount = 0
    const dispatcher = makeDispatcher({
      authority: {
        authorize: async ({ phase }) => {
          if (phase === 'before-execute' && cancellationStage === 'authority') {
            stageEntered.resolve()
            await releaseStage.promise
          }
          return { kind: 'allow' }
        },
      },
      budget: {
        preflight: async () => ({ kind: 'metered', estimateUsd: 1 }),
        reserve: async () => {
          reserveCount += 1
          if (cancellationStage === 'budget-reserve') {
            stageEntered.resolve()
            await releaseStage.promise
          }
          return { reservationId: `cancelled-during-${cancellationStage}` }
        },
        settle: async () => ({ costTracked: false, budgetOverrun: false }),
        release: async () => {
          releaseCount += 1
        },
      },
      evidence: {
        append: async (event) => {
          events.push(event.type)
          if (
            event.type === 'capability.dispatch.started' &&
            cancellationStage === 'started-evidence'
          ) {
            stageEntered.resolve()
            await releaseStage.promise
          }
        },
      },
    })
    const adapter = makeAdapter({
      projectLifecycle: async (transition) => {
        if (
          transition.kind === 'running' &&
          cancellationStage === 'running-lifecycle'
        ) {
          stageEntered.resolve()
          await releaseStage.promise
        }
        return undefined
      },
      execute: async () => {
        executeCount += 1
        return { ok: true }
      },
    })

    const resultPromise = dispatcher.dispatch({
      context: makeContext(),
      invocation: makeInvocation({ action: `cancel-during-${cancellationStage}` }),
      adapter,
      signal: controller.signal,
    })
    await stageEntered.promise
    controller.abort(new DOMException(
      `cancelled during ${cancellationStage}`,
      'AbortError',
    ))
    releaseStage.resolve()
    const result = await resultPromise

    assert.equal(result.status, 'cancelled')
    assert.equal(executeCount, 0)
    assert.equal(releaseCount, reserveCount)
    assert.deepEqual(
      events,
      cancellationStage === 'started-evidence'
        ? [
            'capability.dispatch.requested',
            'capability.dispatch.started',
            'capability.dispatch.cancelled',
          ]
        : [
            'capability.dispatch.requested',
            'capability.dispatch.cancelled',
          ],
    )
  })
}

for (const revokedDecision of ['authority', 'policy'] as const) {
  for (const waitStage of ['budget-reserve', 'started-evidence'] as const) {
    test(`${revokedDecision} revoked during ${waitStage} is rechecked before execution`, async () => {
      const stageEntered = deferred<void>()
      const releaseStage = deferred<void>()
      let revoked = false
      let executeCount = 0
      let reservationReleaseCount = 0
      const deniedDecision = {
        kind: 'deny' as const,
        code: `${revokedDecision}_revoked`,
        reason: `${revokedDecision} changed before execution.`,
      }
      const dispatcher = makeDispatcher({
        authority: {
          authorize: async ({ phase }) =>
            revokedDecision === 'authority' &&
              phase === 'before-execute' &&
              revoked
              ? deniedDecision
              : { kind: 'allow' },
        },
        policy: {
          evaluate: async () =>
            revokedDecision === 'policy' && revoked
              ? deniedDecision
              : { kind: 'allow' },
        },
        budget: {
          preflight: async () =>
            waitStage === 'budget-reserve'
              ? { kind: 'metered', estimateUsd: 1 }
              : { kind: 'not-metered' },
          reserve: async () => {
            stageEntered.resolve()
            await releaseStage.promise
            return { reservationId: `revoked-during-${waitStage}` }
          },
          settle: async () => ({ costTracked: false, budgetOverrun: false }),
          release: async () => {
            reservationReleaseCount += 1
          },
        },
        evidence: {
          append: async (event) => {
            if (
              waitStage === 'started-evidence' &&
              event.type === 'capability.dispatch.started'
            ) {
              stageEntered.resolve()
              await releaseStage.promise
            }
          },
        },
      })

      const resultPromise = dispatcher.dispatch({
        context: makeContext(),
        invocation: makeInvocation({
          action: `${revokedDecision}-during-${waitStage}`,
        }),
        adapter: makeAdapter({
          execute: async () => {
            executeCount += 1
            return { ok: true }
          },
        }),
      })
      await stageEntered.promise
      revoked = true
      releaseStage.resolve()
      const result = await resultPromise

      assert.equal(result.status, 'rejected')
      if (result.status === 'rejected') {
        assert.equal(result.code, `${revokedDecision}_revoked`)
      }
      assert.equal(executeCount, 0)
      assert.equal(
        reservationReleaseCount,
        waitStage === 'budget-reserve' ? 1 : 0,
      )
    })
  }
}

test('rejects a malformed optional task identity without throwing', async () => {
  const context = makeContext()
  Object.defineProperty(context, 'taskId', {
    configurable: true,
    enumerable: true,
    value: 42,
  })

  const result = await makeDispatcher().dispatch({
    context,
    invocation: makeInvocation({ action: 'observe' }),
    adapter: makeAdapter(),
  })

  assert.equal(result.status, 'failed')
  if (result.status === 'failed') {
    assert.equal(result.code, 'dispatch_request_invalid')
  }
})

test('rejects a malformed cancellation signal without throwing', async () => {
  const request = {
    context: makeContext(),
    invocation: makeInvocation({ action: 'observe' }),
    adapter: makeAdapter(),
  }
  Object.defineProperty(request, 'signal', {
    configurable: true,
    enumerable: true,
    value: { aborted: false },
  })

  const result = await makeDispatcher().dispatch(request)

  assert.equal(result.status, 'failed')
  if (result.status === 'failed') {
    assert.equal(result.code, 'dispatch_request_invalid')
  }
})

test('keeps normalized arguments immutable across prepare and approval', async () => {
  let mutationSucceeded: boolean | undefined
  let approvedArguments: string | undefined
  const dispatcher = makeDispatcher({
    approval: {
      request: async (input) => {
        approvedArguments = JSON.stringify(input.arguments)
        const interaction = { interactionId: 'interaction-1', reused: false }
        await input.onInteraction(interaction)
        return { outcome: 'approved', interaction }
      },
    },
  })
  const adapter: CapabilityAdapter = {
    capabilityId: 'browser.interact',
    prepare: async (input) => {
      mutationSucceeded = Reflect.set(
        input.arguments,
        'action',
        'mutated-after-digest',
      )
      return makePreparedExecution({
        policyDecision: {
          kind: 'require-approval',
          reason: 'Mutation requires approval.',
        },
        approval: approvalDescription(),
        execute: async () => input.arguments.action,
      })
    },
  }

  const result = await dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'observe' }),
    adapter,
  })

  assert.equal(mutationSucceeded, false)
  assert.equal(approvedArguments, '{"action":"observe"}')
  assert.equal(result.status, 'completed')
  if (result.status === 'completed') {
    assert.equal(result.value, 'observe')
  }
})

test('keeps dispatch identity stable while rejecting changed arguments bound to that identity', async () => {
  let executeCount = 0
  const dispatcher = makeDispatcher()
  const adapter = makeAdapter({
    execute: async () => {
      executeCount += 1
      return { call: executeCount }
    },
  })

  const first = await dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ query: 'first' }),
    adapter,
  })
  const changed = await dispatcher.dispatch({
    context: makeContext({ requestId: 'request-2' }),
    invocation: makeInvocation({ query: 'changed' }),
    adapter,
  })

  assert.equal(first.status, 'completed')
  assert.equal(changed.status, 'rejected')
  assert.equal(first.dispatchId, changed.dispatchId)
  if (changed.status === 'rejected') {
    assert.equal(changed.code, 'invocation_identity_conflict')
  }
  assert.equal(executeCount, 1)
})

test('separates runtime tasks in dispatch identity and authority scope', async () => {
  let executeCount = 0
  const dispatcher = makeDispatcher()
  const adapter = makeAdapter({
    execute: async () => {
      executeCount += 1
      return { call: executeCount }
    },
  })

  const firstTask = await dispatcher.dispatch({
    context: makeContext({ taskId: 'task-1' }),
    invocation: makeInvocation({ action: 'observe' }),
    adapter,
  })
  const secondTask = await dispatcher.dispatch({
    context: makeContext({ requestId: 'request-2', taskId: 'task-2' }),
    invocation: makeInvocation({ action: 'observe' }),
    adapter,
  })

  assert.equal(firstTask.status, 'completed')
  assert.equal(secondTask.status, 'completed')
  assert.notEqual(firstTask.dispatchId, secondTask.dispatchId)
  assert.equal(executeCount, 2)
})

test('separates activity lanes without destabilizing identity inside one lane', async () => {
  let executeCount = 0
  const dispatcher = makeDispatcher()
  const adapter = makeAdapter({
    execute: async () => {
      executeCount += 1
      return { call: executeCount }
    },
  })

  const laneA = await dispatcher.dispatch({
    context: makeContext({ activityScopeId: 'lane-a' }),
    invocation: makeInvocation({ action: 'observe' }),
    adapter,
  })
  const laneARetry = await dispatcher.dispatch({
    context: makeContext({
      requestId: 'request-lane-a-retry',
      activityScopeId: 'lane-a',
    }),
    invocation: makeInvocation({ action: 'observe' }),
    adapter,
  })
  const laneB = await dispatcher.dispatch({
    context: makeContext({
      requestId: 'request-lane-b',
      activityScopeId: 'lane-b',
    }),
    invocation: makeInvocation({ action: 'observe' }),
    adapter,
  })

  assert.equal(laneA.status, 'completed')
  assert.equal(laneARetry.status, 'completed')
  assert.equal(laneB.status, 'completed')
  assert.equal(laneA.dispatchId, laneARetry.dispatchId)
  assert.notEqual(laneA.dispatchId, laneB.dispatchId)
  assert.equal(executeCount, 2)
})

test('coalesces concurrent calls whose recursively reordered JSON arguments are canonical-equivalent', async () => {
  const executionStarted = deferred<void>()
  const allowExecutionToFinish = deferred<void>()
  let executeCount = 0
  const dispatcher = makeDispatcher()
  const adapter = makeAdapter({
    execute: async () => {
      executeCount += 1
      executionStarted.resolve()
      await allowExecutionToFinish.promise
      return { ok: true }
    },
  })

  const leader = dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ nested: { z: 1, a: 2 }, stable: true }),
    adapter,
  })
  await nextTurnOr(executionStarted.promise)
  const follower = dispatcher.dispatch({
    context: makeContext({ requestId: 'request-follower' }),
    invocation: makeInvocation({ stable: true, nested: { a: 2, z: 1 } }),
    adapter,
  })
  allowExecutionToFinish.resolve()

  const [leaderResult, followerResult] = await Promise.all([leader, follower])
  assert.equal(leaderResult.status, 'completed')
  assert.equal(followerResult.status, 'completed')
  assert.equal(leaderResult.dispatchId, followerResult.dispatchId)
  assert.equal(executeCount, 1)
})

test('a policy denial records rejection and never reaches the executor', async () => {
  const events: CapabilityDispatchEvent[] = []
  let executeCount = 0
  const dispatcher = makeDispatcher({
    policy: {
      evaluate: async () => ({
        kind: 'deny',
        code: 'policy_denied',
        reason: 'Denied by test policy',
      }),
    },
    evidence: {
      append: async (event) => {
        events.push(event)
      },
    },
  })

  const result = await dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ safe: true }),
    adapter: makeAdapter({
      execute: async () => {
        executeCount += 1
        return null
      },
    }),
  })

  assert.equal(result.status, 'rejected')
  if (result.status === 'rejected') assert.equal(result.code, 'policy_denied')
  assert.equal(executeCount, 0)
  assert.deepEqual(events.map((event) => event.type), [
    'capability.dispatch.requested',
    'capability.dispatch.rejected',
  ])
})

test('budget rejection happens before approval and execution', async () => {
  let approvalCount = 0
  let executeCount = 0
  const dispatcher = makeDispatcher({
    budget: {
      preflight: async () => ({
        kind: 'rejected',
        code: 'budget_exceeded',
        reason: 'No capacity remains',
      }),
      reserve: async () => ({ reservationId: 'must-not-reserve' }),
      settle: async () => ({ costTracked: false, budgetOverrun: false }),
      release: async () => undefined,
    },
    approval: approvalPort(async () => {
      approvalCount += 1
      return 'approved'
    }),
  })

  const result = await dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'click' }),
    adapter: makeAdapter({
      policyDecision: { kind: 'require-approval', reason: 'Mutation' },
      approval: approvalDescription(),
      execute: async () => {
        executeCount += 1
        return null
      },
    }),
  })

  assert.equal(result.status, 'rejected')
  if (result.status === 'rejected') assert.equal(result.code, 'budget_exceeded')
  assert.equal(approvalCount, 0)
  assert.equal(executeCount, 0)
})

test('an explicit not-metered decision never reserves or settles budget', async () => {
  let reserveCount = 0
  let settleCount = 0
  const result = await makeDispatcher({
    budget: {
      preflight: async () => ({ kind: 'not-metered' }),
      reserve: async () => {
        reserveCount += 1
        return { reservationId: 'unexpected' }
      },
      settle: async () => {
        settleCount += 1
        return { costTracked: false, budgetOverrun: false }
      },
      release: async () => undefined,
    },
  }).dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'observe' }),
    adapter: makeAdapter(),
  })

  assert.equal(result.status, 'completed')
  assert.equal(reserveCount, 0)
  assert.equal(settleCount, 0)
})

test('started evidence failure releases a metered reservation without executing', async () => {
  const stages: string[] = []
  const result = await makeDispatcher({
    budget: {
      preflight: async () => ({ kind: 'metered', estimateUsd: 0.1 }),
      reserve: async () => {
        stages.push('reserve')
        return { reservationId: 'reservation-1' }
      },
      settle: async () => {
        stages.push('settle')
        return { costTracked: false, budgetOverrun: false }
      },
      release: async () => {
        stages.push('release')
      },
    },
    evidence: {
      append: async (event) => {
        if (event.type === 'capability.dispatch.started') {
          throw new Error('started evidence unavailable')
        }
      },
    },
  }).dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'commit' }),
    adapter: makeAdapter({
      effect: serialCapabilityEffect('mutating'),
      execute: async () => {
        stages.push('execute')
        return null
      },
    }),
  })

  assert.equal(result.status, 'failed')
  assert.deepEqual(stages, ['reserve', 'release'])
})

test('an unsafe executor failure after start is indeterminate', async () => {
  const terminalEvents: CapabilityDispatchEvent['type'][] = []
  const result = await makeDispatcher({
    evidence: {
      append: async (event) => {
        if (isTerminalEvent(event.type)) terminalEvents.push(event.type)
      },
    },
  }).dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'commit' }),
    adapter: makeAdapter({
      effect: serialCapabilityEffect('mutating'),
      execute: async () => {
        throw new Error('transport result is unknown')
      },
    }),
  })

  assert.equal(result.status, 'indeterminate')
  assert.deepEqual(terminalEvents, ['capability.dispatch.indeterminate'])
})

test('approval denial maps to a rejected terminal result without executing', async () => {
  const events: CapabilityDispatchEvent[] = []
  let executeCount = 0
  const dispatcher = makeDispatcher({
    approval: approvalPort(async () => 'denied'),
    evidence: {
      append: async (event) => {
        events.push(event)
      },
    },
  })

  const result = await dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'click' }),
    adapter: makeAdapter({
      policyDecision: { kind: 'require-approval', reason: 'Mutation' },
      approval: approvalDescription(),
      execute: async () => {
        executeCount += 1
        return null
      },
    }),
  })

  assert.equal(result.status, 'rejected')
  if (result.status === 'rejected') assert.equal(result.code, 'approval_denied')
  assert.equal(executeCount, 0)
  assert.deepEqual(events.map((event) => event.type), [
    'capability.dispatch.requested',
    'capability.dispatch.approval_requested',
    'capability.dispatch.approval_resolved',
    'capability.dispatch.rejected',
  ])
})

test('projects browser lifecycle transitions around approval, execution, and terminal evidence', async () => {
  const stages: string[] = []
  const dispatcher = makeDispatcher({
    approval: approvalPort(async () => {
      stages.push('approval')
      return 'approved'
    }),
    evidence: {
      append: async (event) => {
        stages.push(`evidence.${event.type.replace('capability.dispatch.', '')}`)
      },
    },
  })

  const result = await dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'click' }),
    adapter: makeAdapter({
      policyDecision: { kind: 'require-approval', reason: 'Mutation' },
      approval: approvalDescription(),
      projectLifecycle: async (transition) => {
        stages.push(
          transition.kind === 'terminal'
            ? `lifecycle.terminal.${transition.result.status}`
            : `lifecycle.${transition.kind}`,
        )
      },
      execute: async () => {
        stages.push('execute')
        return { ok: true }
      },
      acceptResult: async ({ value }) => {
        stages.push('accept-result')
        return { value }
      },
    }),
  })

  assert.equal(result.status, 'completed')
  assert.ok(
    stages.indexOf('lifecycle.awaiting-approval') < stages.indexOf('approval'),
  )
  assert.ok(stages.indexOf('lifecycle.running') < stages.indexOf('execute'))
  assert.ok(
    stages.indexOf('accept-result') <
      stages.indexOf('lifecycle.terminal.completed'),
  )
  assert.ok(
    stages.indexOf('evidence.completed') <
      stages.indexOf('lifecycle.terminal.completed'),
  )
})

test('a policy denial includes detail projected by the prepared browser capability', async () => {
  const detail = {
    ok: false,
    action: 'click',
    error: {
      code: 'approval_denied',
      message: 'Unattended browser actions cannot pause for approval.',
      retryable: false,
    },
  }
  let executeCount = 0
  const result = await makeDispatcher().dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'click' }),
    adapter: makeAdapter({
      policyDecision: {
        kind: 'deny',
        code: 'approval_denied',
        reason: 'Unattended lane',
      },
      projectLifecycle: async (transition) =>
        transition.kind === 'terminal' ? { detail } : undefined,
      execute: async () => {
        executeCount += 1
        return null
      },
    }),
  })

  assert.equal(result.status, 'rejected')
  if (result.status === 'rejected') {
    assert.equal(result.code, 'approval_denied')
    assert.deepEqual(result.detail, detail)
  }
  assert.equal(executeCount, 0)
})

test('a running lifecycle projection failure prevents raw capability execution', async () => {
  const events: CapabilityDispatchEvent[] = []
  let executeCount = 0
  const result = await makeDispatcher({
    evidence: {
      append: async (event) => {
        events.push(event)
      },
    },
  }).dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'click' }),
    adapter: makeAdapter({
      projectLifecycle: async (transition) => {
        if (transition.kind === 'running') {
          throw new Error('browser activity store unavailable')
        }
      },
      execute: async () => {
        executeCount += 1
        return null
      },
    }),
  })

  assert.equal(result.status, 'failed')
  if (result.status === 'failed') {
    assert.equal(result.code, 'capability_lifecycle_projection_failed')
  }
  assert.equal(executeCount, 0)
  assert.deepEqual(events.map((event) => event.type), [
    'capability.dispatch.requested',
    'capability.dispatch.failed',
  ])
})

test('requested evidence failure still projects the browser terminal lifecycle', async () => {
  const terminalResults: CapabilityDispatchResult[] = []
  const result = await makeDispatcher({
    evidence: {
      append: async (event) => {
        if (event.type === 'capability.dispatch.requested') {
          throw new Error('requested evidence unavailable')
        }
      },
    },
  }).dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'observe' }),
    adapter: makeAdapter({
      projectLifecycle: async (transition) => {
        if (transition.kind === 'terminal') {
          terminalResults.push(transition.result)
        }
      },
    }),
  })

  assert.equal(result.status, 'failed')
  assert.deepEqual(
    terminalResults.map((terminal) => [
      terminal.status,
      terminal.status === 'completed' ? undefined : terminal.code,
    ]),
    [['failed', 'requested_evidence_write_failed']],
  )
})

test('approval request evidence failure cancels the exact wait and fails closed', async () => {
  let cancelledInteractionId: string | undefined
  let executeCount = 0
  const approval: CapabilityApprovalPort = {
    request: async (input) => {
      const interaction = { interactionId: 'interaction-1', reused: false }
      try {
        await input.onInteraction(interaction)
      } catch (error) {
        cancelledInteractionId = interaction.interactionId
        throw error
      }
      return { outcome: 'approved', interaction }
    },
  }
  const dispatcher = makeDispatcher({
    approval,
    evidence: {
      append: async (event) => {
        if (event.type === 'capability.dispatch.approval_requested') {
          throw new Error('evidence unavailable')
        }
      },
    },
  })

  const result = await dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'click' }),
    adapter: makeAdapter({
      policyDecision: { kind: 'require-approval', reason: 'Mutation' },
      approval: approvalDescription(),
      execute: async () => {
        executeCount += 1
        return null
      },
    }),
  })

  assert.equal(result.status, 'failed')
  if (result.status === 'failed') {
    assert.equal(result.code, 'approval_evidence_write_failed')
  }
  assert.equal(cancelledInteractionId, 'interaction-1')
  assert.equal(executeCount, 0)
})

test('approval resolution evidence failure blocks an approved action', async () => {
  let executeCount = 0
  const dispatcher = makeDispatcher({
    approval: approvalPort(async () => 'approved'),
    evidence: {
      append: async (event) => {
        if (event.type === 'capability.dispatch.approval_resolved') {
          throw new Error('evidence unavailable')
        }
      },
    },
  })

  const result = await dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'click' }),
    adapter: makeAdapter({
      policyDecision: { kind: 'require-approval', reason: 'Mutation' },
      approval: approvalDescription(),
      execute: async () => {
        executeCount += 1
        return null
      },
    }),
  })

  assert.equal(result.status, 'failed')
  if (result.status === 'failed') {
    assert.equal(result.code, 'approval_evidence_write_failed')
  }
  assert.equal(executeCount, 0)
})

test('metered budget reservation is acquired only after approval resolves', async () => {
  const stages: string[] = []
  const events: CapabilityDispatchEvent[] = []
  const dispatcher = makeDispatcher({
    budget: {
      preflight: async () => {
        stages.push('budget.preflight')
        return { kind: 'metered', estimateUsd: 0.25 }
      },
      reserve: async () => {
        stages.push('budget.reserve')
        return { reservationId: 'reservation-1' }
      },
      settle: async () => {
        stages.push('budget.settle')
        return { costTracked: true, budgetOverrun: false, actualCostUsd: 0.3 }
      },
      release: async () => {
        stages.push('budget.release')
      },
    },
    approval: approvalPort(async () => {
      stages.push('approval.resolved')
      return 'approved'
    }),
    evidence: {
      append: async (event) => {
        events.push(event)
      },
    },
  })

  const result = await dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'capture' }),
    adapter: makeAdapter({
      policyDecision: { kind: 'require-approval', reason: 'Metered action' },
      approval: approvalDescription(),
      execute: async () => {
        stages.push('execute')
        return { ok: true }
      },
      acceptResult: async ({ value }) => ({ value, actualCostUsd: 0.3 }),
    }),
  })

  assert.equal(result.status, 'completed')
  assert.ok(stages.indexOf('approval.resolved') < stages.indexOf('budget.reserve'))
  assert.ok(stages.indexOf('budget.reserve') < stages.indexOf('execute'))
  assert.ok(stages.indexOf('execute') < stages.indexOf('budget.settle'))
  assert.ok(stages.indexOf('budget.settle') < stages.indexOf('budget.release'))
  if (result.status === 'completed') {
    assert.equal(result.costTracked, true)
    assert.equal(result.budgetOverrun, false)
    assert.equal(result.actualCostUsd, 0.3)
  }
  const completed = events.find(
    (event) => event.type === 'capability.dispatch.completed',
  )
  assert.equal(completed?.actualCostUsd, 0.3)
})

test('a metered post-effect acceptance failure settles untrackable cost before release', async () => {
  const stages: string[] = []
  const dispatcher = makeDispatcher({
    budget: {
      preflight: async () => ({ kind: 'metered', estimateUsd: 0.2 }),
      reserve: async () => ({ reservationId: 'reservation-1' }),
      settle: async ({ actualCostUsd }) => {
        stages.push(`settle:${String(actualCostUsd)}`)
        return { costTracked: false, budgetOverrun: false }
      },
      release: async () => {
        stages.push('release')
      },
    },
  })

  const result = await dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'commit' }),
    adapter: makeAdapter({
      execute: async () => {
        stages.push('execute')
        return { committed: true }
      },
      acceptResult: async () => {
        throw new Error('acceptance storage unavailable')
      },
    }),
  })

  assert.equal(result.status, 'indeterminate')
  assert.deepEqual(stages, ['execute', 'settle:undefined', 'release'])
})

test('a completed budget overrun is returned and blocks only the next hard-budget call', async () => {
  let hardBudgetHalted = false
  let executeCount = 0
  const dispatcher = makeDispatcher({
    budget: {
      preflight: async () =>
        hardBudgetHalted
          ? {
              kind: 'rejected',
              code: 'budget_exceeded',
              reason: 'The hard budget was exceeded by the prior call.',
            }
          : { kind: 'metered', estimateUsd: 0.2 },
      reserve: async () => ({ reservationId: 'reservation-1' }),
      settle: async ({ actualCostUsd }) => {
        hardBudgetHalted = true
        return {
          costTracked: true,
          budgetOverrun: true,
          ...(actualCostUsd === undefined ? {} : { actualCostUsd }),
        }
      },
      release: async () => undefined,
    },
  })
  const adapter = makeAdapter({
    execute: async () => {
      executeCount += 1
      return { committed: true }
    },
    acceptResult: async ({ value }) => ({ value, actualCostUsd: 0.3 }),
  })

  const completed = await dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'first' }),
    adapter,
  })
  const blocked = await dispatcher.dispatch({
    context: makeContext({ requestId: 'request-2' }),
    invocation: {
      ...makeInvocation({ action: 'second' }),
      toolCallId: 'call-2',
    },
    adapter,
  })

  assert.equal(completed.status, 'completed')
  if (completed.status === 'completed') {
    assert.equal(completed.actualCostUsd, 0.3)
    assert.equal(completed.budgetOverrun, true)
  }
  assert.equal(blocked.status, 'rejected')
  if (blocked.status === 'rejected') {
    assert.equal(blocked.code, 'budget_exceeded')
  }
  assert.equal(executeCount, 1)
})

for (const settlementFault of ['throws', 'returns-malformed'] as const) {
  test(`a settlement port that ${settlementFault} latches uncertainty before the next hard-budget call`, async () => {
    let settlementUncertain = false
    let uncertaintyMarks = 0
    let executeCount = 0
    let releaseCount = 0
    const budget: CapabilityBudgetPort = {
      preflight: async () =>
        settlementUncertain
          ? {
              kind: 'rejected',
              code: 'budget_settlement_uncertain',
              reason: 'A prior metered settlement is uncertain.',
            }
          : { kind: 'metered', estimateUsd: 0.2 },
      reserve: async ({ invocation }) => ({
        reservationId: `reservation-${invocation.toolCallId}`,
      }),
      settle: async () => {
        throw new Error('budget settlement unavailable')
      },
      release: async () => {
        releaseCount += 1
      },
    }
    Object.defineProperty(budget, 'markSettlementUncertain', {
      configurable: true,
      value: async () => {
        uncertaintyMarks += 1
        settlementUncertain = true
      },
    })
    if (settlementFault === 'returns-malformed') {
      Object.defineProperty(budget, 'settle', {
        configurable: true,
        value: async () => ({
          costTracked: 'unknown',
          budgetOverrun: false,
        }),
      })
    }
    const dispatcher = makeDispatcher({ budget })
    const adapter = makeAdapter({
      execute: async () => {
        executeCount += 1
        return { committed: true }
      },
      acceptResult: async ({ value }) => ({ value, actualCostUsd: 0.3 }),
    })

    const completed = await dispatcher.dispatch({
      context: makeContext(),
      invocation: makeInvocation({ action: 'first' }),
      adapter,
    })
    const blocked = await dispatcher.dispatch({
      context: makeContext({ requestId: 'request-2' }),
      invocation: {
        ...makeInvocation({ action: 'second' }),
        toolCallId: 'call-2',
      },
      adapter,
    })

    assert.equal(completed.status, 'completed')
    if (completed.status === 'completed') {
      assert.equal(completed.costTracked, false)
      assert.equal(completed.budgetOverrun, false)
    }
    assert.equal(blocked.status, 'rejected')
    if (blocked.status === 'rejected') {
      assert.equal(blocked.code, 'budget_settlement_uncertain')
    }
    assert.equal(uncertaintyMarks, 1)
    assert.equal(executeCount, 1)
    assert.equal(releaseCount, 1)
  })
}

test('a malformed accepted result after execution is indeterminate with one terminal event', async () => {
  const terminalEvents: CapabilityDispatchEvent['type'][] = []
  const adapter: CapabilityAdapter = {
    capabilityId: 'browser.interact',
    prepare: async () => {
      const prepared = makePreparedExecution()
      Object.defineProperty(prepared, 'acceptResult', {
        configurable: true,
        value: async () => undefined,
      })
      return prepared
    },
  }
  const result = await makeDispatcher({
    evidence: {
      append: async (event) => {
        if (isTerminalEvent(event.type)) terminalEvents.push(event.type)
      },
    },
  }).dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'commit' }),
    adapter,
  })

  assert.equal(result.status, 'indeterminate')
  if (result.status === 'indeterminate') {
    assert.equal(result.code, 'result_acceptance_invalid')
  }
  assert.deepEqual(terminalEvents, ['capability.dispatch.indeterminate'])
})

test('caller cancellation after execute fulfillment does not discard result acceptance', async () => {
  const fenceMayOpen = deferred<void>()
  const fenceRequested = deferred<void>()
  const controller = new AbortController()
  let accepted = false
  const dispatcher = makeDispatcher()
  const adapter = makeAdapter({
    execute: async () => ({ effectCommitted: true }),
    beginCompletion: async () => {
      fenceRequested.resolve()
      await fenceMayOpen.promise
      return { release: async () => undefined }
    },
    acceptResult: async ({ value }) => {
      accepted = true
      return { value }
    },
  })

  const resultPromise = dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'commit' }),
    adapter,
    signal: controller.signal,
  })
  await nextTurnOr(fenceRequested.promise)
  controller.abort(new DOMException('caller cancelled', 'AbortError'))
  fenceMayOpen.resolve()
  const result = await resultPromise

  assert.equal(result.status, 'completed')
  assert.equal(accepted, true)
})

test('post-execute settlement has an independent bounded deadline', async () => {
  const never = deferred<void>()
  const dispatcher = makeDispatcher({
    clock: { now: Date.now },
  })
  const dispatch = dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'commit' }),
    adapter: makeAdapter({
      execute: async () => ({ committed: true }),
      beginCompletion: async () => {
        await never.promise
        return { release: async () => undefined }
      },
    }),
    settlementDeadlineMs: Date.now() + 15,
  })

  const result = await Promise.race([
    dispatch,
    new Promise<'test-timeout'>((resolve) => {
      setTimeout(() => resolve('test-timeout'), 150)
    }),
  ])

  assert.notEqual(result, 'test-timeout')
  if (result === 'test-timeout') return
  assert.equal(result.status, 'indeterminate')
  if (result.status === 'indeterminate') {
    assert.equal(result.code, 'settlement_deadline_exceeded')
  }
})

test('post-execute result acceptance cannot retain admission past the settlement deadline', async () => {
  const never = deferred<void>()
  const dispatcher = makeDispatcher({ clock: { now: Date.now } })
  const dispatch = dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'commit' }),
    adapter: makeAdapter({
      execute: async () => ({ committed: true }),
      acceptResult: async () => {
        await never.promise
        return { value: { accepted: true } }
      },
    }),
    settlementDeadlineMs: Date.now() + 15,
  })

  const result = await Promise.race([
    dispatch,
    new Promise<'test-timeout'>((resolve) => {
      setTimeout(() => resolve('test-timeout'), 150)
    }),
  ])

  assert.notEqual(result, 'test-timeout')
  if (result === 'test-timeout') return
  assert.equal(result.status, 'indeterminate')
  if (result.status === 'indeterminate') {
    assert.equal(result.code, 'settlement_deadline_exceeded')
  }
})

test('terminal evidence cannot retain admission past the settlement deadline', async () => {
  const never = deferred<void>()
  const dispatcher = makeDispatcher({
    clock: { now: Date.now },
    evidence: {
      append: async (event) => {
        if (isTerminalEvent(event.type)) await never.promise
      },
    },
  })
  const dispatch = dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'commit' }),
    adapter: makeAdapter({
      execute: async () => ({ committed: true }),
    }),
    settlementDeadlineMs: Date.now() + 15,
  })

  const result = await Promise.race([
    dispatch,
    new Promise<'test-timeout'>((resolve) => {
      setTimeout(() => resolve('test-timeout'), 150)
    }),
  ])

  assert.notEqual(result, 'test-timeout')
  if (result === 'test-timeout') return
  assert.equal(result.status, 'indeterminate')
  if (result.status === 'indeterminate') {
    assert.equal(result.code, 'terminal_evidence_write_failed')
  }
})

test('terminal append failure after execution returns indeterminate and attempts no second terminal', async () => {
  const terminalAttempts: CapabilityDispatchEvent['type'][] = []
  const projectedStatuses: CapabilityDispatchResult['status'][] = []
  let executeCount = 0
  const dispatcher = makeDispatcher({
    evidence: {
      append: async (event) => {
        if (isTerminalEvent(event.type)) {
          terminalAttempts.push(event.type)
          throw new Error('terminal append acknowledgement failed')
        }
      },
    },
  })

  const result = await dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'commit' }),
    adapter: makeAdapter({
      projectLifecycle: async (transition) => {
        if (transition.kind === 'terminal') {
          projectedStatuses.push(transition.result.status)
        }
      },
      execute: async () => {
        executeCount += 1
        return { committed: true }
      },
    }),
  })

  assert.equal(result.status, 'indeterminate')
  if (result.status === 'indeterminate') {
    assert.equal(result.code, 'terminal_evidence_write_failed')
  }
  assert.equal(executeCount, 1)
  assert.deepEqual(terminalAttempts, ['capability.dispatch.completed'])
  assert.deepEqual(projectedStatuses, ['indeterminate'])
})

test('approval must audit exactly one interaction and resolve that identity', async () => {
  let executeCount = 0
  const dispatcher = makeDispatcher({
    approval: {
      request: async () => ({
        outcome: 'approved',
        interaction: { interactionId: 'unaudited-interaction', reused: false },
      }),
    },
  })

  const result = await dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ action: 'click' }),
    adapter: makeAdapter({
      policyDecision: { kind: 'require-approval', reason: 'Mutation' },
      approval: approvalDescription(),
      execute: async () => {
        executeCount += 1
        return null
      },
    }),
  })

  assert.equal(result.status, 'failed')
  if (result.status === 'failed') {
    assert.equal(result.code, 'approval_interaction_invalid')
  }
  assert.equal(executeCount, 0)
})

test('requested evidence failure prevents execution and does not leak argument values', async () => {
  const serializedEvents: string[] = []
  let executeCount = 0
  const dispatcher = makeDispatcher({
    evidence: {
      append: async (event) => {
        serializedEvents.push(JSON.stringify(event))
        if (event.type === 'capability.dispatch.requested') {
          throw new Error('requested evidence failed')
        }
      },
    },
  })

  const result = await dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ password: 'secret-value-94c1' }),
    adapter: makeAdapter({
      execute: async () => {
        executeCount += 1
        return null
      },
    }),
  })

  assert.equal(result.status, 'failed')
  if (result.status === 'failed') {
    assert.equal(result.code, 'requested_evidence_write_failed')
  }
  assert.equal(executeCount, 0)
  assert.equal(serializedEvents.some((event) => event.includes('secret-value-94c1')), false)
  assert.equal(serializedEvents.some((event) => event.includes('password')), false)
})

test('evidence records every causal identity used to derive dispatch identity', async () => {
  const events: CapabilityDispatchEvent[] = []
  const context = makeContext({
    taskId: 'task-causal',
    workflowId: 'workflow-causal',
    workflowStepId: 'step-causal',
    agentId: 'agent-causal',
    activityScopeId: 'lane-causal',
    authority: {
      kind: 'parent-capability',
      endpointId: 'browser.interact',
      processIdentity: 'process-causal',
    },
  })
  const result = await makeDispatcher({
    evidence: {
      append: async (event) => {
        events.push(event)
      },
    },
  }).dispatch({
    context,
    invocation: makeInvocation({ action: 'observe' }),
    adapter: makeAdapter(),
  })

  assert.equal(result.status, 'completed')
  const requested = events[0]
  assert.ok(requested)
  assert.deepEqual(
    {
      taskId: requested.taskId,
      workflowId: requested.workflowId,
      workflowStepId: requested.workflowStepId,
      agentId: requested.agentId,
      activityScopeId: requested.activityScopeId,
      authorityKind: requested.authorityKind,
      sourceVersion: requested.sourceVersion,
    },
    {
      taskId: 'task-causal',
      workflowId: 'workflow-causal',
      workflowStepId: 'step-causal',
      agentId: 'agent-causal',
      activityScopeId: 'lane-causal',
      authorityKind: 'parent-capability',
      sourceVersion: '1',
    },
  )
})

test('missing mandatory kernel ports fail closed before preparation or execution', async () => {
  let prepareCount = 0
  let executeCount = 0
  const adapter: CapabilityAdapter = {
    capabilityId: 'browser.interact',
    prepare: async () => {
      prepareCount += 1
      return makePreparedExecution({
        execute: async () => {
          executeCount += 1
          return null
        },
      })
    },
  }

  const result = await new CapabilityDispatcher({}).dispatch({
    context: makeContext(),
    invocation: makeInvocation({ safe: true }),
    adapter,
  })

  assert.equal(result.status, 'failed')
  if (result.status === 'failed') {
    assert.equal(result.code, 'dispatch_configuration_invalid')
  }
  assert.equal(prepareCount, 0)
  assert.equal(executeCount, 0)
})

test('releases prepared capability state after a pre-execution rejection', async () => {
  let releaseCount = 0
  const dispatcher = makeDispatcher({
    policy: {
      evaluate: async () => ({
        kind: 'deny',
        code: 'policy_denied',
        reason: 'Denied',
      }),
    },
  })

  const result = await dispatcher.dispatch({
    context: makeContext(),
    invocation: makeInvocation({ safe: true }),
    adapter: makeAdapter({
      release: async () => {
        releaseCount += 1
      },
    }),
  })

  assert.equal(result.status, 'rejected')
  assert.equal(releaseCount, 1)
})

test('rejects an adapter whose trusted capability identity does not match the invocation', async () => {
  let prepareCount = 0
  const adapter = makeAdapter({ capabilityId: 'other.capability' })
  const originalPrepare = adapter.prepare
  const mismatched: CapabilityAdapter = {
    ...adapter,
    prepare: async (input) => {
      prepareCount += 1
      return originalPrepare(input)
    },
  }

  const result = await makeDispatcher().dispatch({
    context: makeContext(),
    invocation: makeInvocation({ safe: true }),
    adapter: mismatched,
  })

  assert.equal(result.status, 'rejected')
  if (result.status === 'rejected') {
    assert.equal(result.code, 'capability_adapter_mismatch')
  }
  assert.equal(prepareCount, 0)
})

interface AdapterOptions {
  readonly capabilityId?: string
  readonly effect?: CapabilityEffect
  readonly policyDecision?: CapabilityPolicyDecision
  readonly approval?: CapabilityApprovalDescription
  readonly projectLifecycle?: CapabilityAdapterPreparedOptions['projectLifecycle']
  readonly authorize?: CapabilityAdapterPreparedOptions['authorize']
  readonly execute?: CapabilityAdapterPreparedOptions['execute']
  readonly beginCompletion?: CapabilityAdapterPreparedOptions['beginCompletion']
  readonly acceptResult?: CapabilityAdapterPreparedOptions['acceptResult']
  readonly release?: CapabilityAdapterPreparedOptions['release']
}

interface CapabilityAdapterPreparedOptions {
  authorize(input: { readonly phase: 'initial' | 'before-execute' | 'after-result' }): Promise<CapabilityPolicyDecision>
  execute(input: { readonly signal: AbortSignal }): Promise<unknown>
  beginCompletion?(): Promise<{ release(): void | Promise<void> }>
  acceptResult(input: { readonly value: unknown }): Promise<{
    readonly value: unknown
    readonly actualCostUsd?: number
  }>
  projectLifecycle(input:
    | { readonly kind: 'awaiting-approval' }
    | { readonly kind: 'running' }
    | {
        readonly kind: 'terminal'
        readonly result: CapabilityDispatchResult
      }
  ): Promise<{ readonly detail?: unknown } | undefined>
  release?(): void | Promise<void>
}

function makeAdapter(options: AdapterOptions = {}): CapabilityAdapter {
  return {
    capabilityId: options.capabilityId ?? 'browser.interact',
    prepare: async () => makePreparedExecution(options),
  }
}

function makePreparedExecution(options: AdapterOptions = {}) {
  return {
    effect: options.effect ?? serialCapabilityEffect('read-only'),
    risk: 'safe',
    argumentNames: ['action'],
    policyDecision: options.policyDecision ?? { kind: 'allow' as const },
    ...(options.approval ? { approval: options.approval } : {}),
    ...(options.projectLifecycle
      ? { projectLifecycle: options.projectLifecycle }
      : {}),
    authorize: options.authorize ?? (async () => ({ kind: 'allow' as const })),
    execute: options.execute ?? (async () => ({ ok: true })),
    ...(options.beginCompletion
      ? { beginCompletion: options.beginCompletion }
      : {}),
    acceptResult: options.acceptResult ?? (async ({ value }) => ({ value })),
    ...(options.release ? { release: options.release } : {}),
  }
}

function makeDispatcher(overrides: CapabilityDispatcherPorts = {}): CapabilityDispatcher {
  return new CapabilityDispatcher({
    bindings: new CapabilityInvocationBindings({
      maxActivePerScope: 4,
      maxRetainedPerScope: 32,
    }),
    authority: { authorize: async () => ({ kind: 'allow' }) },
    policy: { evaluate: async () => ({ kind: 'allow' }) },
    budget: {
      preflight: async () => ({ kind: 'not-metered' }),
      reserve: async () => ({ reservationId: 'reservation-1' }),
      settle: async () => ({ costTracked: false, budgetOverrun: false }),
      release: async () => undefined,
    },
    evidence: { append: async () => undefined },
    scheduler: new PerAuthorityCapabilityExecutionScheduler(),
    clock: { now: () => 1_000 },
    ids: { nextAttemptId: () => 'attempt-1' },
    ...overrides,
  })
}

function makeInvocation(input: unknown): CapabilityInvocation {
  return {
    capabilityId: 'browser.interact',
    source: { kind: 'builtin', id: 'browser', version: '1' },
    toolCallId: 'call-1',
    input,
  }
}

function approvalDescription(): CapabilityApprovalDescription {
  return {
    serverId: 'builtin.browser',
    namespacedToolName: 'mcp__builtin-browser__click',
    title: 'Browser action',
    description: 'Allow this browser action?',
  }
}

function approvalPort(
  resolveOutcome: () => Promise<'approved' | 'denied' | 'expired' | 'cancelled' | 'interrupted'>,
): CapabilityApprovalPort {
  return {
    request: async (input) => {
      const interaction = { interactionId: 'interaction-1', reused: false }
      await input.onInteraction(interaction)
      return { outcome: await resolveOutcome(), interaction }
    },
  }
}

function deferred<T>() {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined
  let rejectPromise: ((reason?: unknown) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: (value?: T) => {
      if (!resolvePromise) throw new Error('Deferred resolve is unavailable')
      resolvePromise(value as T)
    },
    reject: (reason?: unknown) => {
      if (!rejectPromise) throw new Error('Deferred reject is unavailable')
      rejectPromise(reason)
    },
  }
}

async function nextTurnOr(promise: Promise<void>): Promise<void> {
  await Promise.race([
    promise,
    new Promise<void>((resolve) => setImmediate(resolve)),
  ])
}

function isTerminalEvent(type: CapabilityDispatchEvent['type']): boolean {
  return type === 'capability.dispatch.completed' ||
    type === 'capability.dispatch.rejected' ||
    type === 'capability.dispatch.cancelled' ||
    type === 'capability.dispatch.failed' ||
    type === 'capability.dispatch.indeterminate'
}

function makeContext(
  overrides: Partial<CapabilityExecutionContext> = {},
): CapabilityExecutionContext {
  return {
    contractVersion: 1,
    requestId: 'request-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    agentPath: 'agents/researcher',
    authority: {
      kind: 'runtime-assignment',
      processIdentity: 'process-1',
    },
    ...overrides,
  }
}

test('a dispatch blocked after the started barrier records a durable terminal', async () => {
  // ADR §6: once `started` has passed its durability barrier the stream must
  // reach a terminal state. A lease that expires while the dispatch waits in
  // the scheduler queue blocks it after that barrier but before the executor
  // is entered, so recovery must see a terminal, not an open `started`.
  const durableCalls: string[] = []
  const legacyEvidence: CapabilityDispatchEvent['type'][] = []
  let beforeExecuteAuthorityCalls = 0
  let executed = false

  const result = await makeDispatcher({
    evidence: {
      append: async (event) => {
        legacyEvidence.push(event.type)
      },
    },
    authority: {
      authorize: async ({ phase }) => {
        if (phase !== 'before-execute') return { kind: 'allow' }
        beforeExecuteAuthorityCalls += 1
        // The second before-execute check runs after the started barrier.
        return beforeExecuteAuthorityCalls >= 2
          ? { kind: 'deny', code: 'lease_expired', reason: 'lease expired' }
          : { kind: 'allow' }
      },
    },
    durable: async () => recordingDurablePort(durableCalls),
  }).dispatch({
    context: makeContext(),
    invocation: makeInvocation({ a: 1 }),
    adapter: {
      capabilityId: 'browser.interact',
      prepare: async () => ({
        effect: serialCapabilityEffect('mutating'),
        risk: 'mutating',
        argumentNames: ['a'],
        policyDecision: { kind: 'allow' },
        recoveryPolicy: 'non_retryable' as const,
        authorize: async () => ({ kind: 'allow' }),
        execute: async () => {
          executed = true
          return { ok: true }
        },
        acceptResult: async ({ value }) => ({ value }),
      }),
    },
  })

  assert.equal(executed, false, 'the executor must not be entered')
  assert.equal(result.status, 'rejected')
  assert.ok(
    durableCalls.includes('recordStarted'),
    `expected the started barrier to have been recorded, saw ${durableCalls.join(',')}`,
  )
  assert.ok(
    durableCalls.includes('recordTerminal'),
    `a dispatch blocked after the started barrier must record a durable terminal, saw ${durableCalls.join(',')}`,
  )
  // ADR §8: this port derives the legacy view, so the dispatcher must not also
  // write the terminal line into it. A second writer would put a record in the
  // projection that a rebuild from the journal could not reproduce.
  assert.deepEqual(
    legacyEvidence.filter(isTerminalEvent),
    [],
    'a deriving port must suppress the direct legacy terminal write',
  )
})

function recordingDurablePort(calls: string[]): CapabilityDurableDispatchPort {
  return {
    derivesCapabilityEvidence: true,
    bindInvocationIdentity: async (input) => ({
      kind: 'bound',
      invocation: input.invocation,
    }),
    recover: async () => ({ kind: 'unknown' }),
    inspectOutcome: async () => ({ kind: 'not_found' }),
    projectionStatus: async () => 'current',
    // Derives nothing, so there is nothing to bring forward.
    flushProjections: async () => undefined,
    recordRequested: async () => {
      calls.push('recordRequested')
    },
    recordApprovalRequested: async () => {
      calls.push('recordApprovalRequested')
    },
    recordApprovalResolved: async () => {
      calls.push('recordApprovalResolved')
    },
    recordPrepared: async () => {
      calls.push('recordPrepared')
    },
    recordStarted: async () => {
      calls.push('recordStarted')
    },
    recordCommitted: async () => {
      calls.push('recordCommitted')
    },
    recordAccepted: async () => {
      calls.push('recordAccepted')
    },
    recordIndeterminate: async () => {
      calls.push('recordIndeterminate')
    },
    recordTerminal: async () => {
      calls.push('recordTerminal')
    },
  }
}
