/**
 * B3 — a delegated child team's failure must reach the parent's attempt loop
 * with the child's own retryability.
 *
 * `dispatchWithFailurePolicy` classifies retryability from the error it caught.
 * Anything it does not recognise defaults to retryable, so a `blocked` child —
 * which needs new input before it can proceed — would be retried against the
 * identical brief until the retry budget is spent.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { mock } from 'node:test'

let dispatchImpl: () => Promise<{ text: string; cost: number }> = async () => ({
  text: 'unused',
  cost: 0,
})
const dispatchMockFn = mock.fn(async () => dispatchImpl())

mock.module('../../domains/agent-execution/agent-runner.js', {
  namedExports: {
    dispatchToAgentOrTeam: dispatchMockFn,
    runAgent: mock.fn(async () => ({ text: '', cost: 0 })),
    runTeam: mock.fn(async () => ({ text: '', cost: 0, succeeded: true, status: 'completed' })),
  },
})

const { classifyDispatchRetryability, dispatchWithFailurePolicy, HaltError } = await import(
  '../../domains/agent-execution/failure-policy.js'
)
const { ProviderError } = await import('../../domains/provider/provider-error.js')
const { SubTeamFailedError } = await import(
  '../../domains/agent-execution/sub-team-failure.js'
)
const { globalCircuitBreaker } = await import(
  '../../domains/runtime/circuit-breaker.js'
)

function makeOptions(maxRetries: number, errorLogPath: string) {
  return {
    // A provider and model are still required, but not because this path
    // records anything: `domains/agent-execution/failure-policy.ts:681-683`
    // now deliberately excludes `SubTeamFailedError` from
    // `globalCircuitBreaker.recordFailure`, so a sub-team failure never counts
    // against the provider. The reason is the *read* side —
    // `globalCircuitBreaker.check(agent.provider)` at
    // `domains/agent-execution/failure-policy.ts:481` gates every dispatch, and
    // an `undefined` provider key resolves to a circuit these tests do not
    // control, which would block the attempt before it ever dispatches.
    agent: {
      name: 'delegator',
      provider: 'pi',
      model: 'default',
      thinking: 'low',
      systemPrompt: '',
      agentDir: '/tmp',
      experienceEnabled: false,
    },
    rosterEntry: { name: 'child', type: 'team', team_path: './child' },
    finalPrompt: 'prompt',
    userMessage: 'message',
    state: {
      sessionId: 'session',
      currentLevelIndex: 0,
      levelStates: new Map(),
      totalCost: 0,
      startTime: 0,
      timerStarted: false,
      endTime: null,
      spawnDepth: 0,
    },
    workspacePath: '/tmp',
    outputPath: '/tmp',
    metrics: undefined,
    policy: { policy: 'retry' as const, maxRetries },
    levelId: 'l0',
    stageType: 'pipeline',
    sessionId: 'session',
    // Isolates the written log files only; the provider circuit is global
    // in-process state and is reset separately below.
    errorLogPath,
  }
}

function withErrorLogDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-team-failure-'))
  globalCircuitBreaker.resetAll()
  return run(dir).finally(() => {
    globalCircuitBreaker.resetAll()
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

test('a blocked child team is not retried, because retrying cannot supply the input it needs', async () => {
  await withErrorLogDir(async (errorLogDir) => {
    dispatchMockFn.mock.resetCalls()
    dispatchImpl = async () => {
      throw new SubTeamFailedError('child', 'blocked')
    }

    await assert.rejects(
      dispatchWithFailurePolicy(makeOptions(2, errorLogDir) as never),
      (error: unknown) => {
        assert.ok(error instanceof HaltError, 'the parent halts on a non-retryable child')
        assert.match(String(error.message), /blocked/)
        return true
      },
    )
    assert.equal(
      dispatchMockFn.mock.calls.length,
      1,
      'a blocked child must be dispatched exactly once',
    )
  })
})

test('the retry classifier maps a child status to the retry channel', () => {
  // Driven through the exported decision rather than end to end: observing the
  // retryable case in the loop means sitting through real exponential backoff,
  // which a unit test must not do. The adaptive-policy tests already prove that
  // a retryable error consumes retry budget; what B3 adds is this mapping.
  assert.equal(
    classifyDispatchRetryability(new SubTeamFailedError('child', 'failed')),
    true,
    'a failed child may be transient, so it keeps its retry budget',
  )
  assert.equal(
    classifyDispatchRetryability(new SubTeamFailedError('child', 'blocked')),
    false,
    'a blocked child needs new input, which a retry cannot supply',
  )
  assert.equal(
    classifyDispatchRetryability(
      new ProviderError({ provider: 'pi', message: 'transient', retryable: true }),
    ),
    true,
    'provider errors keep their own verdict',
  )
  assert.equal(
    classifyDispatchRetryability(new Error('unclassified')),
    true,
    'an unrecognised error keeps the permissive default',
  )
})

test('sub-team failures never open the provider circuit', async () => {
  await withErrorLogDir(async (errorLogDir) => {
    // `blocked` exits the loop immediately, so this stays fast; repeating it
    // past the breaker's failure threshold is what makes poisoning observable.
    dispatchImpl = async () => {
      throw new SubTeamFailedError('child', 'blocked')
    }
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await assert.rejects(
        dispatchWithFailurePolicy(makeOptions(0, errorLogDir) as never),
        (error: unknown) => error instanceof HaltError,
      )
    }
    assert.equal(
      globalCircuitBreaker.getState('pi'),
      'closed',
      'a delegated team outcome is not a provider health signal',
    )
  })
})
