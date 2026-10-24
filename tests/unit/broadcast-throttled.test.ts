/**
 * Integration tests for rate-limited broadcast engine:
 *   Test 11: No rate limiter — all agents dispatched simultaneously
 *   Test 12: With rate limiter (maxConcurrent=2, 5 agents) — max 2 active at any time
 *   Test 13: With rate limiter — all agents complete and results aggregated correctly
 *   Test 14: With rate limiter — agents pre-marked as ACTIVE only when no limiter
 *   Test 15: With rate limiter — failed agent does not leak semaphore slot
 *
 * Uses node:test with mock.module for agent-runner.
 * Run via `npm run test:unit` — do NOT run node --test directly.
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { RuntimeState, LoadedAgent } from '../../core/types.js'
import { AGENT_STATE, STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'

// ─── Concurrency tracking (reset in each test) ────────────────────────────────

let activeDispatches = 0
let maxActiveDispatches = 0

/** Controls per-test dispatch behaviour. */
let dispatchDelay = 20 // ms
let shouldDispatchThrow = false

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Mock dispatchToAgentOrTeam BEFORE importing broadcast/rate-limiter ───────
// The mock intercepts all calls through failure-policy.ts → agent-runner.js.
// NOTE: The mock does NOT set metrics.state or activeStartedAt — this is
// intentional so tests can use activeStartedAt as a signal for the
// pre-marking block in fanOut (which sets it only when !ctx.rateLimiter).

mock.module('../../domains/agent-execution/agent-runner.js', {
  namedExports: {
    dispatchToAgentOrTeam: mock.fn(async (opts: any) => {
      if (shouldDispatchThrow) {
        throw new Error('Simulated dispatch failure')
      }

      // Track concurrent dispatches
      activeDispatches++
      if (activeDispatches > maxActiveDispatches) maxActiveDispatches = activeDispatches

      await sleep(dispatchDelay)

      activeDispatches--

      return { text: `Response from ${opts.agent?.name ?? 'unknown'}`, cost: 0.001 }
    }),
  },
})

// Dynamic imports AFTER mock is registered
const { createBroadcastTool } = await import('../../engines/broadcast.js')
const { RateLimiter } = await import('../../core/rate-limiter.js')

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRuntimeState(): RuntimeState {
  return {
    sessionId: 'test-session',
    currentLevelIndex: 0,
    levelStates: new Map([['l1', {
      status: 'active' as any,
      stageStatus: STAGE_LIFECYCLE_STATUS.READY,
      engineState: null,
      loopbackCount: 0,
    }]]),
    totalCost: 0,
    startTime: Date.now(),
    timerStarted: false,
    endTime: null,
    spawnDepth: 0,
  }
}

function makeLoadedAgent(name: string): LoadedAgent {
  return {
    name,
    model: 'test-model',
    thinking: 'low' as any,
    systemPrompt: `You are ${name}.`,
    experienceContent: '',
    experienceEnabled: true,
    skillsContent: '',
    knowledgeContent: '',
    selection: null,
    agentDir: '/tmp',
    color: 0,
    provider: 'pi',
  }
}

function makeBroadcastCtx(
  agentNames: string[],
  outputPath: string,
  rateLimiter?: any,
): any {
  const state = makeRuntimeState()
  const agents = new Map<string, LoadedAgent>()
  const agentMetrics = new Map<string, any>()
  const rosterEntries = new Map<string, any>()

  for (const name of agentNames) {
    agents.set(name, makeLoadedAgent(name))
    agentMetrics.set(name, {
      state: AGENT_STATE.IDLE,
      rounds: 0,
      totalCost: 0,
      contextTokens: 0,
      model: 'test-model',
      color: 0,
      failureCount: 0,
      // NOTE: activeStartedAt intentionally absent at start
    })
    rosterEntries.set(name, { type: 'agent' })
  }

  return {
    config: {
      type: 'broadcast',
      coordinator: 'coordinator',
      fan_out: agentNames,
      config: {
        aggregation: 'merge',
        output: { format: 'output.md', user_review: false, path: '' },
        constraints: { max_time_minutes: 10, max_budget_usd: 100 },
      },
    },
    levelId: 'l1',
    teamRootPath: outputPath,
    agents,
    rosterEntries,
    state,
    workspacePath: outputPath,
    outputPath,
    inputFilesContent: '',
    agentMetrics,
    onDashboardUpdate: undefined,
    rateLimiter,
  }
}

const noopSignal = undefined as any
const noopUpdate = undefined as any
const noopExt = undefined as any

// ─── Test 11: No rate limiter — all agents dispatched simultaneously ───────────

test('broadcast with no rate limiter — all agents dispatched simultaneously', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-test-'))
  try {
    // Reset concurrency counters
    activeDispatches = 0
    maxActiveDispatches = 0
    dispatchDelay = 20
    shouldDispatchThrow = false

    const agentNames = ['agent-a', 'agent-b', 'agent-c']
    const ctx = makeBroadcastCtx(agentNames, tmpDir, /* no rateLimiter */ undefined)
    const tool = createBroadcastTool(ctx)

    await tool.execute('tc1', { message: 'Test broadcast' }, noopSignal, noopUpdate, noopExt)

    // All 3 agents should have run concurrently: max active should equal agent count
    assert.equal(
      maxActiveDispatches,
      agentNames.length,
      `Without rate limiter, all ${agentNames.length} agents should dispatch concurrently (max active = ${agentNames.length})`,
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ─── Test 12: With rate limiter — max 2 active at any time ────────────────────

test('broadcast with rate limiter (maxConcurrent=2, 5 agents) — max 2 active at any time', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-test-'))
  try {
    activeDispatches = 0
    maxActiveDispatches = 0
    dispatchDelay = 20
    shouldDispatchThrow = false

    const agentNames = ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5']
    const rateLimiter = new RateLimiter({ maxConcurrent: 2, delayBetweenMs: 0 })
    const ctx = makeBroadcastCtx(agentNames, tmpDir, rateLimiter)
    const tool = createBroadcastTool(ctx)

    await tool.execute('tc1', { message: 'Rate-limited broadcast' }, noopSignal, noopUpdate, noopExt)

    assert.ok(
      maxActiveDispatches <= 2,
      `With maxConcurrent=2, max active dispatches should be ≤ 2, got ${maxActiveDispatches}`,
    )
    assert.equal(rateLimiter.active, 0, 'All semaphore slots should be released after completion')
    assert.equal(rateLimiter.pending, 0, 'No pending waiters after completion')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ─── Test 13: With rate limiter — all agents complete and results aggregated ──

test('broadcast with rate limiter — all agents complete and results aggregated correctly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-test-'))
  try {
    activeDispatches = 0
    maxActiveDispatches = 0
    dispatchDelay = 10
    shouldDispatchThrow = false

    const agentNames = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
    const rateLimiter = new RateLimiter({ maxConcurrent: 2, delayBetweenMs: 0 })
    const ctx = makeBroadcastCtx(agentNames, tmpDir, rateLimiter)
    const tool = createBroadcastTool(ctx)

    const result = await tool.execute(
      'tc1',
      { message: 'Aggregate test' },
      noopSignal,
      noopUpdate,
      noopExt,
    )

    // All 5 agents should have contributed a response
    const text = (result.content[0] as any).text as string
    assert.ok(text.includes('5 responses'), `Result should report 5 responses, got: ${text.slice(0, 200)}`)

    // Each agent's response should appear in the aggregated output
    for (const name of agentNames) {
      assert.ok(
        text.includes(`Response from ${name}`) || text.includes(name),
        `Aggregated result should include response from ${name}`,
      )
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ─── Test 14: Agents pre-marked ACTIVE only when no limiter ───────────────────

test('broadcast with rate limiter — agents pre-marked as ACTIVE only when no limiter', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-test-'))
  try {
    dispatchDelay = 5
    shouldDispatchThrow = false

    const agentNames = ['x-agent', 'y-agent', 'z-agent']

    // ── Case A: No rate limiter ──
    // The pre-marking block in fanOut sets metrics.activeStartedAt for all agents
    // synchronously before any dispatch occurs.
    activeDispatches = 0
    maxActiveDispatches = 0

    const ctxNoLimiter = makeBroadcastCtx(agentNames, tmpDir, undefined)
    const toolNoLimiter = createBroadcastTool(ctxNoLimiter)
    await toolNoLimiter.execute('tc1', { message: 'Pre-mark test' }, noopSignal, noopUpdate, noopExt)

    for (const name of agentNames) {
      const metrics = ctxNoLimiter.agentMetrics.get(name)
      assert.ok(
        metrics?.activeStartedAt !== undefined,
        `Without rate limiter, ${name} should have activeStartedAt set by pre-marking block`,
      )
    }

    // ── Case B: With rate limiter ──
    // The pre-marking block is skipped. Our mock does NOT set activeStartedAt.
    // So activeStartedAt stays undefined for all agents.
    activeDispatches = 0
    maxActiveDispatches = 0

    const rateLimiter = new RateLimiter({ maxConcurrent: 1, delayBetweenMs: 0 })
    const ctxWithLimiter = makeBroadcastCtx(agentNames, path.join(tmpDir, 'limited'), rateLimiter)
    fs.mkdirSync(path.join(tmpDir, 'limited'), { recursive: true })
    const toolWithLimiter = createBroadcastTool(ctxWithLimiter)
    await toolWithLimiter.execute('tc1', { message: 'Pre-mark test' }, noopSignal, noopUpdate, noopExt)

    for (const name of agentNames) {
      const metrics = ctxWithLimiter.agentMetrics.get(name)
      assert.equal(
        metrics?.activeStartedAt,
        undefined,
        `With rate limiter, ${name} should NOT have activeStartedAt set by pre-marking block`,
      )
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ─── Test 15: Failed agent does not leak semaphore slot ───────────────────────

test('broadcast with rate limiter — failed agent does not leak semaphore slot', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-test-'))
  try {
    activeDispatches = 0
    maxActiveDispatches = 0
    dispatchDelay = 5
    shouldDispatchThrow = true // ALL agents fail to dispatch

    const agentNames = ['fail-1', 'fail-2', 'fail-3']
    const rateLimiter = new RateLimiter({ maxConcurrent: 2, delayBetweenMs: 0 })
    const ctx = makeBroadcastCtx(agentNames, tmpDir, rateLimiter)
    const tool = createBroadcastTool(ctx)

    // Broadcast should complete without throwing (errors are caught in doDispatch)
    const result = await tool.execute(
      'tc1',
      { message: 'Failure test' },
      noopSignal,
      noopUpdate,
      noopExt,
    )

    // Verify broadcast completed (returned a result, not threw)
    assert.ok(result, 'broadcast should complete even when all agents fail')

    // Critical: semaphore must be fully released — no leaked slots
    assert.equal(
      rateLimiter.active,
      0,
      'All semaphore slots must be released after failed dispatches (no semaphore leak)',
    )
    assert.equal(
      rateLimiter.pending,
      0,
      'No pending waiters should remain after all agents complete (with or without error)',
    )
  } finally {
    // Reset throw flag for any subsequent tests
    shouldDispatchThrow = false
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
