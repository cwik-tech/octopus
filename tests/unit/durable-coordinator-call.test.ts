import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { AgentRunResult } from '../../core/types.js'
import { AgentQuestionInterruptionError } from '../../core/agent-question-interruption.js'
import { ProviderError } from '../../domains/provider/provider-error.js'
import { BudgetLedger } from '../../core/budget-ledger.js'
import { withDirectAgentBudgetAdmission } from '../../team-runtime/direct-agent-budget-admission.js'
import {
  CoordinatorCallIndeterminateError,
  MAX_COORDINATOR_CALL_ATTEMPTS,
  durableCoordinatorCallReceiptPath,
  durableCoordinatorCallRequestDigest,
  executeDurableCoordinatorCall,
  reconcileDurableCoordinatorCost,
  type DurableCoordinatorCallResult,
} from '../../team-runtime/durable-coordinator-call.js'

function makeAssignment(): string {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), 'durable-coordinator-call-'),
  )
}

function createGate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let resolveGate: (() => void) | undefined
  const wait = new Promise<void>((resolve) => {
    resolveGate = resolve
  })
  return {
    wait,
    open: () => {
      if (!resolveGate) throw new Error('Gate resolver was not initialized.')
      resolveGate()
    },
  }
}

function providerResult(text = 'accepted decision'): AgentRunResult {
  return {
    text,
    cost: 0.4,
    durationMs: 20,
    inputTokens: 10,
    outputTokens: 5,
    contextTokens: 15,
    model: 'claude-haiku-4-5',
    costTracked: true,
    costSource: 'reported',
  }
}

const coordinatorRequest = {
  provider: 'claude',
  model: 'claude-haiku-4-5',
  thinking: 'low',
  systemPrompt: 'Coordinate this task.',
  userMessage: 'Choose the next step.',
} as const

test('a lead question stays suspended until an admitted continuation and does not replay its paid decisions', async (t) => {
  const assignmentPath = makeAssignment()
  t.after(() => fs.rmSync(assignmentPath, { recursive: true, force: true }))
  const common = {
    assignmentPath, invocationId: 'lead-selection', request: coordinatorRequest,
    baseTotalCost: 0, now: () => '2026-09-19T12:00:00.000Z',
    accept: (result: AgentRunResult) => result.text,
  }
  // The paid provider is the replaced boundary; receipt files and locks are real.
  let providerCalls = 0
  await assert.rejects(executeDurableCoordinatorCall({ ...common, invoke: async () => {
    providerCalls += 1
    return { ...providerResult(''), interruption: { kind: 'awaiting_input', interactionId: 'recipient' } }
  } }), AgentQuestionInterruptionError)
  await assert.rejects(executeDurableCoordinatorCall({ ...common, invoke: async () => {
    throw new Error('A pending question must not call the provider.')
  } }), AgentQuestionInterruptionError)
  const continuation = { ...common, baseTotalCost: 0.4, resumeAfterQuestion: true, invoke: async () => {
    providerCalls += 1
    return providerResult('Selected the writer for Marta.')
  } }
  const completed = await executeDurableCoordinatorCall(continuation)
  assert.equal(completed.value, 'Selected the writer for Marta.')
  assert.equal(completed.postTotalCost, 0.8)
  assert.equal((await executeDurableCoordinatorCall(continuation)).value, completed.value)
  assert.equal(providerCalls, 2)
})

test('a completed coordinator call is replayed without another provider charge', async () => {
  const assignmentPath = makeAssignment()
  let invocations = 0
  const execute = (baseTotalCost: number, now: string) => executeDurableCoordinatorCall({
    assignmentPath,
    invocationId: 'discussion:lead-decision:1',
    request: coordinatorRequest,
    baseTotalCost,
    now: () => now,
    invoke: async () => {
      invocations += 1
      return providerResult()
    },
    accept: (result) => result.text.toUpperCase(),
  })

  try {
    const first = await execute(0.5, '2026-08-31T12:00:00.000Z')
    const replay = await execute(0.1, '2026-08-31T12:05:00.000Z')

    assert.equal(invocations, 1)
    assert.equal(first.replayed, false)
    assert.equal(replay.replayed, true)
    assert.equal(first.startedAtMs, Date.parse('2026-08-31T12:00:00.000Z'))
    assert.equal(replay.startedAtMs, first.startedAtMs)
    assert.equal(replay.value, 'ACCEPTED DECISION')
    assert.equal(replay.postTotalCost, 0.9)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('two callers racing for one coordinator slot launch the provider once', async () => {
  const assignmentPath = makeAssignment()
  const providerStarted = createGate()
  const releaseProvider = createGate()
  let invocations = 0
  let winner: Promise<DurableCoordinatorCallResult<string>> | undefined
  const common = {
    assignmentPath,
    invocationId: 'discussion:racing-selection',
    request: coordinatorRequest,
    baseTotalCost: 0,
    now: () => '2026-08-31T12:00:00.000Z',
    accept: (result: AgentRunResult) => result.text,
  }

  try {
    winner = executeDurableCoordinatorCall({
      ...common,
      invoke: async () => {
        invocations += 1
        providerStarted.open()
        await releaseProvider.wait
        return providerResult('winning selection')
      },
    })
    await providerStarted.wait

    await assert.rejects(
      executeDurableCoordinatorCall({
        ...common,
        invoke: async () => {
          invocations += 1
          return providerResult('duplicate selection')
        },
      }),
      CoordinatorCallIndeterminateError,
    )
    assert.equal(invocations, 1)

    releaseProvider.open()
    assert.equal((await winner).value, 'winning selection')
  } finally {
    releaseProvider.open()
    await winner?.catch(() => undefined)
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('recovery refuses to repeat a coordinator attempt whose provider outcome is unknown', async () => {
  const assignmentPath = makeAssignment()
  const invocationId = 'routing:decision'
  const requestDigest = durableCoordinatorCallRequestDigest(coordinatorRequest)
  const receiptPath = durableCoordinatorCallReceiptPath(
    assignmentPath,
    invocationId,
  )
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    receiptPath,
    `${JSON.stringify({
      version: 1,
      phase: 'started',
      invocationId,
      requestDigest,
      attemptNumber: 1,
      baseTotalCost: 0.25,
      startedAt: '2026-08-31T12:00:00.000Z',
    })}\n`,
  )
  let invoked = false

  try {
    await assert.rejects(
      executeDurableCoordinatorCall({
        assignmentPath,
        invocationId,
        request: coordinatorRequest,
        baseTotalCost: 0.25,
        now: () => '2026-08-31T12:01:00.000Z',
        invoke: async () => {
          invoked = true
          return providerResult()
        },
        accept: (result) => result.text,
      }),
      CoordinatorCallIndeterminateError,
    )
    assert.equal(invoked, false)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('a request the provider refused frees its slot for a bounded number of retries', async () => {
  // A refusal of the request itself — a malformed schema, a rejected key — is
  // the one failure we know cost nothing, so it is the one that may be retried.
  const assignmentPath = makeAssignment()
  let invocations = 0
  const input = {
    assignmentPath,
    invocationId: 'discussion:roster-selection',
    request: coordinatorRequest,
    baseTotalCost: 0,
    now: () => '2026-08-31T12:00:00.000Z',
    accept: (result: AgentRunResult) => result.text,
  }

  try {
    await assert.rejects(
      executeDurableCoordinatorCall({
        ...input,
        invoke: async () => {
          invocations += 1
          throw new ProviderError({
            provider: 'claude',
            kind: 'invalid_request',
            message: 'provider rejected the request',
            retryable: false,
          })
        },
      }),
      /provider rejected the request/,
    )
    // The throw was observed here, so the outcome is known: nothing was
    // accepted. Wedging the slot would make one transient provider error end
    // the assignment for good, which is a worse trade than one repeat call.
    const recovered = await executeDurableCoordinatorCall({
      ...input,
      invoke: async () => {
        invocations += 1
        return providerResult('second attempt decision')
      },
    })
    assert.equal(recovered.value, 'second attempt decision')
    assert.equal(invocations, 2)

    // The retries are bounded, so a slot that keeps failing still stops.
    for (let attempt = 0; attempt < MAX_COORDINATOR_CALL_ATTEMPTS; attempt++) {
      await assert.rejects(
        executeDurableCoordinatorCall({
          ...input,
          invocationId: 'discussion:always-fails',
          invoke: async () => {
            throw new ProviderError({
            provider: 'claude',
            kind: 'invalid_request',
            message: 'provider rejected the request',
            retryable: false,
          })
          },
        }),
        /provider rejected the request/,
      )
    }
    await assert.rejects(
      executeDurableCoordinatorCall({
        ...input,
        invocationId: 'discussion:always-fails',
        invoke: async () => providerResult('should never run'),
      }),
      CoordinatorCallIndeterminateError,
    )
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('a paid result is durable and its charge recorded before semantic acceptance rejects it', async () => {
  const assignmentPath = makeAssignment()
  let invocations = 0
  let reconciledCost = 0

  try {
    await assert.rejects(
      executeDurableCoordinatorCall({
        assignmentPath,
        invocationId: 'discussion:invalid-selection',
        request: coordinatorRequest,
        baseTotalCost: 0.6,
        now: () => '2026-08-31T12:00:00.000Z',
        invoke: async () => {
          invocations += 1
          return providerResult('invalid selection')
        },
        onDurableResult: (
          _result: AgentRunResult,
          _baseTotalCost: number,
          postTotalCost: number,
        ) => {
          reconciledCost = postTotalCost
        },
        accept: () => {
          throw new Error('invalid coordinator selection')
        },
      }),
      /invalid coordinator selection/,
    )

    assert.equal(invocations, 1)
    // The provider was paid whether or not the runtime could use the answer,
    // so the charge is reconciled before acceptance is even attempted.
    assert.equal(reconciledCost, 1)

    // The refusal is recorded as its own terminal phase. It keeps the money
    // already spent and the reason, which is what makes the slot retryable
    // instead of replaying `accept` over the same text on every later visit.
    const receipt: unknown = JSON.parse(fs.readFileSync(
      durableCoordinatorCallReceiptPath(assignmentPath, 'discussion:invalid-selection'),
      'utf8',
    ))
    assert.ok(receipt && typeof receipt === 'object')
    const stored = receipt as Record<string, unknown>
    assert.equal(stored.phase, 'rejected')
    assert.equal(stored.attemptNumber, 1)
    assert.equal(stored.postTotalCost, 1)
    assert.match(String(stored.rejectionReason), /invalid coordinator selection/)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('a changed coordinator request cannot adopt a stale completed result', async () => {
  const assignmentPath = makeAssignment()
  let invocations = 0
  const run = (userMessage: string) => executeDurableCoordinatorCall({
    assignmentPath,
    invocationId: 'routing:stable-slot',
    request: { ...coordinatorRequest, userMessage },
    baseTotalCost: 0,
    now: () => '2026-08-31T12:00:00.000Z',
    invoke: async () => {
      invocations += 1
      return providerResult()
    },
    accept: (result) => result.text,
  })

  try {
    await run('Choose the original route.')
    await assert.rejects(
      run('Choose a different route.'),
      /request changed for an existing durable slot/,
    )
    assert.equal(invocations, 1)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('a changed provider configuration cannot adopt a stale completed result', async () => {
  const assignmentPath = makeAssignment()
  let invocations = 0
  const run = (baseUrl: string) => executeDurableCoordinatorCall({
    assignmentPath,
    invocationId: 'routing:provider-config-slot',
    request: {
      ...coordinatorRequest,
      providerConfig: { base_url: baseUrl },
    },
    baseTotalCost: 0,
    now: () => '2026-08-31T12:00:00.000Z',
    invoke: async () => {
      invocations += 1
      return providerResult()
    },
    accept: (result) => result.text,
  })

  try {
    await run('https://provider.example/v1')
    await assert.rejects(
      run('https://different-provider.example/v1'),
      /request changed for an existing durable slot/,
    )
    assert.equal(invocations, 1)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('an empty paid response is durable before semantic validation rejects it', async () => {
  const assignmentPath = makeAssignment()
  let invocations = 0
  const run = () => executeDurableCoordinatorCall({
    assignmentPath,
    invocationId: 'routing:empty-response',
    request: coordinatorRequest,
    baseTotalCost: 0.2,
    now: () => '2026-08-31T12:00:00.000Z',
    invoke: async () => {
      invocations += 1
      return providerResult('')
    },
    accept: (result) => {
      if (!result.text.trim()) throw new Error('empty coordinator response')
      return result.text
    },
  })

  try {
    await assert.rejects(run(), /empty coordinator response/)
    await assert.rejects(run(), /empty coordinator response/)
    // Each refusal buys a fresh reply within the slot's budget. Replaying the
    // stored empty text instead would fail identically for ever.
    assert.equal(invocations, 2)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('durable coordinator cost reconciliation applies once and rejects drift', () => {
  assert.equal(reconcileDurableCoordinatorCost(0.25, 0.25, 0.65), 0.65)
  assert.equal(reconcileDurableCoordinatorCost(0.65, 0.25, 0.65), 0.65)
  assert.throws(
    () => reconcileDurableCoordinatorCost(0.4, 0.25, 0.65),
    /cost cannot reconcile/,
  )
})

test('a failure of unknown outcome stays indeterminate instead of being re-bought', async () => {
  // A caught error is not proof that nothing was paid for. A timeout or an
  // abort can land after the provider completed and billed the call, so
  // retrying re-pays it. Only a refusal we can see the provider make — a
  // rejected request, a rejected key — is safe to treat as unfulfilled.
  const assignmentPath = makeAssignment()
  const input = {
    assignmentPath,
    invocationId: 'discussion:roster-selection',
    request: coordinatorRequest,
    baseTotalCost: 0,
    now: () => '2026-08-31T12:00:00.000Z',
    accept: (result: AgentRunResult) => result.text,
  }

  try {
    await assert.rejects(
      executeDurableCoordinatorCall({
        ...input,
        invoke: async () => {
          throw new ProviderError({
            provider: 'claude',
            kind: 'timeout',
            message: 'the provider did not answer in time',
            retryable: true,
          })
        },
      }),
      /did not answer in time/,
    )

    let reInvoked = false
    await assert.rejects(
      executeDurableCoordinatorCall({
        ...input,
        invoke: async () => {
          reInvoked = true
          return providerResult('second attempt decision')
        },
      }),
      CoordinatorCallIndeterminateError,
    )
    assert.equal(reInvoked, false, 'an unknown outcome must not be re-bought')
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('a reclaimed attempt keeps the start time the first attempt recorded', async () => {
  // `startedAtMs` is what the discussion reconciles its activation clock
  // against, so overwriting it on a retry silently moves the stage deadline.
  const assignmentPath = makeAssignment()
  const input = {
    assignmentPath,
    invocationId: 'discussion:roster-selection',
    request: coordinatorRequest,
    baseTotalCost: 0,
    accept: (result: AgentRunResult) => result.text,
  }

  try {
    await assert.rejects(
      executeDurableCoordinatorCall({
        ...input,
        now: () => '2026-08-31T12:00:00.000Z',
        invoke: async () => {
          throw new ProviderError({
            provider: 'claude',
            kind: 'invalid_request',
            message: 'the provider refused the request',
            retryable: false,
          })
        },
      }),
      /refused the request/,
    )

    const retried = await executeDurableCoordinatorCall({
      ...input,
      now: () => '2026-08-31T12:30:00.000Z',
      invoke: async () => providerResult('second attempt decision'),
    })
    assert.equal(retried.value, 'second attempt decision')
    assert.equal(
      retried.startedAtMs,
      Date.parse('2026-08-31T12:00:00.000Z'),
      'the retry must not move the start the first attempt recorded',
    )
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('a budget refusal frees its slot, because it happens before any provider call', async () => {
  // The refusal is raised inside `invoke`, but before the operation that
  // reaches the provider — so nothing was requested and nothing was billed.
  // Wedging the slot here would make a Team that briefly hit its cap
  // unresumable for the rest of the run, which is the case the bounded retry
  // exists to survive.
  const assignmentPath = makeAssignment()
  const ledger = new BudgetLedger({ capUsd: 1, policy: 'halt' })
  let providerCalled = false
  const input = {
    assignmentPath,
    invocationId: 'discussion:lead-decision',
    request: coordinatorRequest,
    baseTotalCost: 0,
    now: () => '2026-08-31T12:00:00.000Z',
    accept: (result: AgentRunResult) => result.text,
  }

  try {
    await assert.rejects(
      executeDurableCoordinatorCall({
        ...input,
        invoke: () => withDirectAgentBudgetAdmission({
          ledger,
          totalCost: 1,
          operation: async () => {
            providerCalled = true
            return providerResult('never reached')
          },
        }),
      }),
      /budget/i,
    )
    assert.equal(providerCalled, false)

    // The cap is lifted for the retry; the slot must still be usable.
    const retried = await executeDurableCoordinatorCall({
      ...input,
      invoke: () => withDirectAgentBudgetAdmission({
        ledger: new BudgetLedger({ capUsd: 100, policy: 'halt' }),
        totalCost: 1,
        operation: async () => providerResult('decision after the cap was raised'),
      }),
    })
    assert.equal(retried.value, 'decision after the cap was raised')
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

function rejectNonJson(result: AgentRunResult): string {
  if (!result.text.trimStart().startsWith('{')) {
    throw new Error('response is not valid JSON')
  }
  return result.text
}

test('a rejected coordinator reply is retried on the next visit and can then be accepted', async () => {
  const assignmentPath = makeAssignment()
  const replies = ['I have chosen the roster.', '{"agents":["a"]}']
  let invocations = 0
  let totalCost = 0.6
  const reconciled: Array<{ base: number; post: number }> = []
  const call = () => executeDurableCoordinatorCall({
    assignmentPath,
    invocationId: 'discussion:retry-slot',
    request: coordinatorRequest,
    baseTotalCost: totalCost,
    now: () => '2026-09-06T12:00:00.000Z',
    invoke: async () => {
      const text = replies[invocations]
      invocations += 1
      if (text === undefined) throw new Error('provider called more often than planned')
      return providerResult(text)
    },
    onDurableResult: (_result, base, post) => {
      reconciled.push({ base, post })
      totalCost = post
    },
    accept: rejectNonJson,
  })

  try {
    await assert.rejects(call(), /response is not valid JSON/)

    const second = await call()

    assert.equal(invocations, 2, 'the rejected slot must buy a fresh reply, not replay the old one')
    assert.equal(second.replayed, false)
    assert.equal(second.value, '{"agents":["a"]}')
    // Both paid attempts are accounted exactly once. The second attempt's base
    // is the first attempt's post, so neither charge is dropped or counted twice.
    assert.deepEqual(reconciled, [
      { base: 0.6, post: 1 },
      { base: 1, post: 1.4 },
    ])
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('consecutive rejected coordinator replies exhaust the attempt budget with a stated reason', async () => {
  const assignmentPath = makeAssignment()
  let invocations = 0
  let totalCost = 0
  const call = () => executeDurableCoordinatorCall({
    assignmentPath,
    invocationId: 'discussion:exhausted-slot',
    request: coordinatorRequest,
    baseTotalCost: totalCost,
    now: () => '2026-09-06T12:00:00.000Z',
    invoke: async () => {
      invocations += 1
      return providerResult('still prose, still not json')
    },
    onDurableResult: (_result, _base, post) => {
      totalCost = post
    },
    accept: rejectNonJson,
  })

  try {
    for (let attempt = 1; attempt <= MAX_COORDINATOR_CALL_ATTEMPTS; attempt += 1) {
      await assert.rejects(call(), /response is not valid JSON/)
    }
    assert.equal(invocations, MAX_COORDINATOR_CALL_ATTEMPTS)

    // The budget is spent. The next visit must refuse without buying a fourth
    // reply, and must say the replies were rejected rather than call the
    // outcome unknown — the provider answered every time.
    await assert.rejects(call(), /rejected/i)
    assert.equal(invocations, MAX_COORDINATOR_CALL_ATTEMPTS)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('a stored coordinator result the runtime can no longer accept stops being a permanent failure', async () => {
  const assignmentPath = makeAssignment()
  let invocations = 0
  let totalCost = 0.6
  const replies = ['I have chosen the roster.', '{"agents":["a"]}']
  const base = {
    assignmentPath,
    invocationId: 'discussion:poisoned-slot',
    request: coordinatorRequest,
    baseTotalCost: totalCost,
    now: () => '2026-09-06T12:00:00.000Z',
    invoke: async () => {
      const text = replies[invocations]
      invocations += 1
      if (text === undefined) throw new Error('provider called more often than planned')
      return providerResult(text)
    },
    onDurableResult: (
      _result: AgentRunResult,
      _base: number,
      post: number,
    ) => {
      totalCost = post
    },
  }

  try {
    // The first call is accepted and stored, so the slot holds a `completed`
    // receipt carrying prose.
    const first = await executeDurableCoordinatorCall({
      ...base,
      baseTotalCost: 0.6,
      accept: (result: AgentRunResult) => result.text,
    })
    assert.equal(first.value, 'I have chosen the roster.')

    // A later visit applies the real contract to that stored text and rejects
    // it. Replaying `accept` over the same bytes would re-throw forever, which
    // is what killed session b8e6afd8 on every restart.
    await assert.rejects(
      executeDurableCoordinatorCall({ ...base, baseTotalCost: totalCost, accept: rejectNonJson }),
      /response is not valid JSON/,
    )

    const recovered = await executeDurableCoordinatorCall({
      ...base,
      baseTotalCost: totalCost,
      accept: rejectNonJson,
    })

    assert.equal(recovered.value, '{"agents":["a"]}')
    assert.equal(invocations, 2)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('the roster and gate coordinator slots each carry their own rejection budget', async () => {
  // Both discussion coordinator calls — the roster selection and the gate
  // continuation decision — go through the same durable wrapper, so both had
  // the same permanent-failure exposure and both are fixed by the same change.
  // What must not happen is one slot's refusals spending the other's budget.
  const assignmentPath = makeAssignment()
  const invocations = new Map<string, number>()
  const call = (invocationId: string, accept: (result: AgentRunResult) => string) =>
    executeDurableCoordinatorCall({
      assignmentPath,
      invocationId,
      request: coordinatorRequest,
      baseTotalCost: 0,
      now: () => '2026-09-06T12:00:00.000Z',
      invoke: async () => {
        invocations.set(invocationId, (invocations.get(invocationId) ?? 0) + 1)
        return providerResult('prose where json was required')
      },
      accept,
    })

  try {
    await assert.rejects(call('visit:0:selection', rejectNonJson), /not valid JSON/)
    await assert.rejects(call('visit:0:selection', rejectNonJson), /not valid JSON/)

    // The gate slot has spent nothing, so its first call is attempt 1 and it
    // still has the full budget behind it.
    await assert.rejects(call('visit:0:continuation', rejectNonJson), /not valid JSON/)

    assert.equal(invocations.get('visit:0:selection'), 2)
    assert.equal(invocations.get('visit:0:continuation'), 1)

    // Proof the gate slot's budget is genuinely its own: it survives two more
    // attempts after the selection slot has already exhausted itself.
    await assert.rejects(call('visit:0:selection', rejectNonJson), /not valid JSON/)
    await assert.rejects(call('visit:0:selection', rejectNonJson), /rejected/i)
    await assert.rejects(call('visit:0:continuation', rejectNonJson), /not valid JSON/)

    assert.equal(invocations.get('visit:0:selection'), MAX_COORDINATOR_CALL_ATTEMPTS)
    assert.equal(invocations.get('visit:0:continuation'), 2)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})
