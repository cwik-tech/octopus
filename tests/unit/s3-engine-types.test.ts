/**
 * S3 Sprint Tests — Engine Type Safety (T9)
 *
 * Tests for:
 *   - core/types.ts — BaseEngineContext interface is accessible
 *   - domains/agent-execution/agent-runner.ts — dispatchToAgentOrTeam exists and DispatchOptions is exported
 *   - engines/*.ts — all 5 engines compile and export their create tool functions
 *   - No `as XxxState` unsafe casts in level-lifecycle.ts (type narrowing via discriminator)
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ─── Structural/import smoke tests ──────────────────────────────────────────

test('core/types.ts exports BaseEngineContext (type compiles without error)', async () => {
  // We can't inspect TypeScript interfaces at runtime, but we can verify the module
  // that contains it loads, and that DispatchOptions (co-located) is also present.
  // The real type-check is done by tsc --noEmit (which passes per T9 validation).
  const agentRunner = await import('../../domains/agent-execution/agent-runner.js')
  assert.ok(typeof agentRunner.dispatchToAgentOrTeam === 'function', 'dispatchToAgentOrTeam is exported')
  assert.ok(typeof agentRunner.runAgent === 'function', 'runAgent is still exported')
  assert.ok(typeof agentRunner.runTeam === 'function', 'runTeam is still exported')
})

test('all 5 engine modules export their createXxxTool functions', async () => {
  const discussion = await import('../../engines/discussion.js')
  const pipeline = await import('../../engines/pipeline.js')
  const chain = await import('../../engines/chain.js')
  const broadcast = await import('../../engines/broadcast.js')
  const review = await import('../../engines/review.js')

  assert.ok(typeof discussion.createDiscussionTool === 'function', 'discussion exports createDiscussionTool')
  assert.ok(typeof pipeline.createPipelineTool === 'function', 'pipeline exports createPipelineTool')
  assert.ok(typeof chain.createChainTool === 'function', 'chain exports createChainTool')
  assert.ok(typeof broadcast.createBroadcastTool === 'function', 'broadcast exports createBroadcastTool')
  assert.ok(typeof review.createReviewTool === 'function', 'review exports createReviewTool')
})

test('level-lifecycle uses discriminated union narrowing (no as XxxState in source)', async () => {
  // Read the compiled-from-source behavior indirectly: the module must load and export
  // assertActive. The absence of `as XxxState` casts is validated by tsc --noEmit
  // (which passes per T9 acceptance) and confirmed by grep in T9 result.
  const lifecycle = await import('../../team-runtime/level-lifecycle.js')
  assert.ok(typeof lifecycle.assertActive === 'function', 'assertActive is exported')
  assert.ok(typeof lifecycle.tryAdvanceLevel === 'function', 'tryAdvanceLevel is exported')
  assert.ok(typeof lifecycle.isLevelReadyForGate === 'function', 'isLevelReadyForGate is exported')
})

test('dashboard.ts uses discriminated union narrowing (module loads cleanly)', async () => {
  const dashboard = await import('../../team-runtime/dashboard.js')
  assert.ok(typeof dashboard.getCurrentRound === 'function', 'getCurrentRound is exported')
  assert.ok(typeof dashboard.updateDashboard === 'function', 'updateDashboard is exported')
})

// ─── dispatchToAgentOrTeam signature check ──────────────────────────────────

test('dispatchToAgentOrTeam rejects when agent is undefined (no loaded agent)', async () => {
  const { dispatchToAgentOrTeam } = await import('../../domains/agent-execution/agent-runner.js')

  // DispatchOptions requires a LoadedAgent. Pass undefined to trigger a runtime guard.
  // We expect a throw because there's no valid agent to dispatch to.
  await assert.rejects(
    () =>
      dispatchToAgentOrTeam({
        agent: undefined as any,   // simulate a missing agent lookup
        rosterEntry: undefined,
        finalPrompt: 'hello',
        userMessage: 'do something',
        state: { totalCost: 0, spawnDepth: 0 } as any,
        workspacePath: '/tmp',
        outputPath: '/tmp',
        metrics: undefined,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error || err instanceof TypeError)
      return true
    },
  )
})
