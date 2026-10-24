/**
 * S2 Sprint Tests
 *
 * Tests for:
 *   1. parsers/plan-parser.ts  — 'skipped' status, isTaskTerminal, isTaskDone, autoSkipDependents
 *   2. dashboard.ts            — failureCount indicator (✗N), errorCount in header
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  parsePlan,
  isTaskTerminal,
  isTaskDone,
  autoSkipDependents,
  updateTaskStatus,
  getReadyTasks,
} from '../../parsers/plan-parser.js'
import { renderAgentCard, updateDashboard } from '../../team-runtime/dashboard.js'
import { createRuntimeContext } from '../../domains/runtime/runtime-context.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function withPlan(content: string, fn: (planPath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's2-plan-test-'))
  const planPath = path.join(dir, 'plan.md')
  fs.writeFileSync(planPath, content)
  try {
    fn(planPath)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const MINIMAL_PLAN = `
# Plan: Sample
**Status:** draft

### S1: Sprint

#### T1: Root task
- **Agent:** alpha
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** t1.md

#### T2: Dependent task
- **Agent:** beta
- **Status:** pending
- **Validate:** false
- **Depends on:** T1
- **Gate:** false
- **Result file:** t2.md

#### T3: Another dependent
- **Agent:** gamma
- **Status:** pending
- **Validate:** false
- **Depends on:** T1
- **Gate:** false
- **Result file:** t3.md

#### T4: Independent task
- **Agent:** delta
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** t4.md
`

// ─── isTaskTerminal ───────────────────────────────────────────────────────────

test("isTaskTerminal: 'skipped' is terminal", () => {
  assert.equal(isTaskTerminal({ status: 'skipped' } as any), true)
})

test("isTaskTerminal: 'validated' is terminal", () => {
  assert.equal(isTaskTerminal({ status: 'validated' } as any), true)
})

test("isTaskTerminal: 'failed' is terminal", () => {
  assert.equal(isTaskTerminal({ status: 'failed' } as any), true)
})

test("isTaskTerminal: 'blocked' is terminal", () => {
  assert.equal(isTaskTerminal({ status: 'blocked' } as any), true)
})

test("isTaskTerminal: 'completed' without validate is terminal", () => {
  assert.equal(isTaskTerminal({ status: 'completed', validate: false } as any), true)
})

test("isTaskTerminal: 'completed' with validate required is NOT terminal", () => {
  assert.equal(isTaskTerminal({ status: 'completed', validate: true } as any), false)
})

test("isTaskTerminal: 'pending' is NOT terminal", () => {
  assert.equal(isTaskTerminal({ status: 'pending' } as any), false)
})

test("isTaskTerminal: 'in_progress' is NOT terminal", () => {
  assert.equal(isTaskTerminal({ status: 'in_progress' } as any), false)
})

// ─── isTaskDone ───────────────────────────────────────────────────────────────

test("isTaskDone: 'skipped' is NOT done (cannot unblock dependents)", () => {
  // This is the critical behavior: skipped ≠ done, so getReadyTasks won't unblock deps
  assert.equal(isTaskDone({ status: 'skipped' } as any), false)
})

test("isTaskDone: 'completed' (no validate) IS done", () => {
  assert.equal(isTaskDone({ status: 'completed', validate: false } as any), true)
})

test("isTaskDone: 'validated' IS done", () => {
  assert.equal(isTaskDone({ status: 'validated' } as any), true)
})

test("isTaskDone: 'pending' is NOT done", () => {
  assert.equal(isTaskDone({ status: 'pending' } as any), false)
})

// ─── parsePlan: skipped status parsed correctly ───────────────────────────────

test("parsePlan: parses 'skipped' task status", () => {
  withPlan(MINIMAL_PLAN.replace('- **Status:** pending\n- **Validate:** false\n- **Depends on:** none\n- **Gate:** false\n- **Result file:** t1.md', '- **Status:** skipped\n- **Validate:** false\n- **Depends on:** none\n- **Gate:** false\n- **Result file:** t1.md'), (planPath) => {
    const plan = parsePlan(planPath)
    assert.ok(plan)
    const t1 = plan!.tasks.get('T1')
    assert.equal(t1?.status, 'skipped')
  })
})

// ─── autoSkipDependents ───────────────────────────────────────────────────────

test("autoSkipDependents: skips pending tasks that depend on skipped task", () => {
  withPlan(MINIMAL_PLAN, (planPath) => {
    // Mark T1 as skipped first
    updateTaskStatus(planPath, 'T1', 'skipped')
    // Now auto-skip dependents
    const skipped = autoSkipDependents(planPath, 'T1')
    assert.ok(skipped.includes('T2'), 'T2 should be skipped')
    assert.ok(skipped.includes('T3'), 'T3 should be skipped')
    assert.equal(skipped.length, 2)
  })
})

test("autoSkipDependents: does NOT skip tasks with no dependency on skipped task", () => {
  withPlan(MINIMAL_PLAN, (planPath) => {
    updateTaskStatus(planPath, 'T1', 'skipped')
    const skipped = autoSkipDependents(planPath, 'T1')
    assert.ok(!skipped.includes('T4'), 'T4 has no dependency on T1, should not be skipped')
  })
})

test("autoSkipDependents: does NOT skip non-pending tasks", () => {
  withPlan(MINIMAL_PLAN, (planPath) => {
    updateTaskStatus(planPath, 'T2', 'completed') // T2 already completed
    updateTaskStatus(planPath, 'T1', 'skipped')
    const skipped = autoSkipDependents(planPath, 'T1')
    assert.ok(!skipped.includes('T2'), 'T2 was already completed, should not be re-skipped')
    assert.ok(skipped.includes('T3'), 'T3 is still pending, should be skipped')
  })
})

test("autoSkipDependents: returns empty array when no dependents", () => {
  withPlan(MINIMAL_PLAN, (planPath) => {
    const skipped = autoSkipDependents(planPath, 'T4')
    assert.equal(skipped.length, 0)
  })
})

test("autoSkipDependents: actually writes skipped status to file", () => {
  withPlan(MINIMAL_PLAN, (planPath) => {
    updateTaskStatus(planPath, 'T1', 'skipped')
    autoSkipDependents(planPath, 'T1')
    const plan = parsePlan(planPath)
    assert.equal(plan!.tasks.get('T2')?.status, 'skipped')
    assert.equal(plan!.tasks.get('T3')?.status, 'skipped')
  })
})

test("autoSkipDependents: returns empty array for non-existent plan path", () => {
  const result = autoSkipDependents('/nonexistent/plan.md', 'T1')
  assert.deepEqual(result, [])
})

// ─── getReadyTasks: skipped deps do not unblock ───────────────────────────────

test("getReadyTasks: tasks depending on a skipped task are NOT ready (need explicit autoSkip)", () => {
  withPlan(MINIMAL_PLAN, (planPath) => {
    updateTaskStatus(planPath, 'T1', 'skipped')
    const plan = parsePlan(planPath)
    const ready = getReadyTasks(plan!).map(t => t.id)
    // T2 and T3 depend on T1 which is skipped (not done), so they should NOT be ready
    assert.ok(!ready.includes('T2'), 'T2 should not be ready when dep is skipped')
    assert.ok(!ready.includes('T3'), 'T3 should not be ready when dep is skipped')
    // T4 has no deps and should still be ready
    assert.ok(ready.includes('T4'), 'T4 should be ready (independent)')
  })
})

// ─── Dashboard: failureCount indicator ───────────────────────────────────────

function makeMetrics(overrides: Record<string, any> = {}) {
  return {
    status: 'idle' as const,
    totalCost: 0,
    totalTokens: 0,
    startTime: null,
    lastActivity: null,
    model: null,
    runCount: 0,
    failureCount: 0,
    ...overrides,
  }
}

test("renderAgentCard: does NOT show ✗ when failureCount is 0", () => {
  const result = renderAgentCard('alice', makeMetrics({ failureCount: 0 }) as any, 60)
  assert.ok(!result.join('\n').includes('✗'), 'Should not show failure indicator when failureCount is 0')
})

test("renderAgentCard: shows ✗N when failureCount > 0", () => {
  const result = renderAgentCard('alice', makeMetrics({ failureCount: 2 }) as any, 60)
  assert.ok(result.join('\n').includes('✗2'), 'Should show ✗2 for failureCount=2')
})

test("renderAgentCard: shows ✗1 for single failure", () => {
  const result = renderAgentCard('alice', makeMetrics({ failureCount: 1 }) as any, 60)
  assert.ok(result.join('\n').includes('✗1'), 'Should show ✗1 for failureCount=1')
})

test("renderAgentCard: failure indicator visible even for DONE status", () => {
  const result = renderAgentCard('alice', makeMetrics({ status: 'done', failureCount: 3 }) as any, 60)
  assert.ok(result.join('\n').includes('✗3'), 'Should show ✗3 even when status is done')
})

test("renderAgentCard: shows the resolved model in brackets", () => {
  const result = renderAgentCard('alice', makeMetrics({ model: 'gpt-5.4' }) as any, 80)
  assert.ok(result.join('\n').includes('[gpt-5.4]'), 'Should preserve gpt-prefixed model names in brackets')
})

// ─── Dashboard: updateDashboard errorCount in status ──────────────────────────

const stubPi = {
  registerCommand: () => {},
  appendEntry: async () => {},
  setStatusBar: () => {},
  setWidget: () => {},
} as any

test("updateDashboard: status includes 'N error(s)' when agents have failures", () => {
  const ctx = createRuntimeContext(stubPi)
  ctx.teamConfig = {
    team: { name: 'Test', description: '' },
    levels: [],
    agents: [],
    constraints: { maxBudget: 10, maxTime: 60 },
  } as any
  ctx.state.startTime = Date.now()
  ctx.state.timerStarted = true

  ctx.agentMetrics.set('agent-a', makeMetrics({ status: 'done', failureCount: 1 }) as any)
  ctx.agentMetrics.set('agent-b', makeMetrics({ status: 'idle', failureCount: 0 }) as any)

  const statusParts: string[] = []
  const capturedPi = {
    ...stubPi,
    setWidget: (content: string) => {
      // Capture calls to setWidget if needed
    },
    setStatusBar: (...parts: string[]) => {
      statusParts.push(...parts)
    },
  } as any

  // updateDashboard modifies extCtx.ui.setStatus — let's test via ctx directly
  // We can verify errorCount logic by calling updateDashboard with a mock ui
  const capturedStatus: string[] = []
  const fakeExtCtx = {
    ui: {
      setStatus: (...parts: string[]) => { capturedStatus.push(...parts) },
      setWidget: () => {},
    },
    theme: { fg: (_s: string, t: string) => t },
  } as any

  updateDashboard(fakeExtCtx as any, ctx)

  const statusStr = capturedStatus.join(' ')
  assert.ok(statusStr.includes('1 error'), `Expected '1 error' in status: "${statusStr}"`)
})

test("updateDashboard: status does NOT include errors when no failures", () => {
  const ctx = createRuntimeContext(stubPi)
  ctx.teamConfig = {
    team: { name: 'Test', description: '' },
    levels: [],
    agents: [],
    constraints: { maxBudget: 10, maxTime: 60 },
  } as any
  ctx.state.startTime = Date.now()
  ctx.state.timerStarted = true

  ctx.agentMetrics.set('agent-a', makeMetrics({ failureCount: 0 }) as any)

  const capturedStatus: string[] = []
  const fakeExtCtx = {
    ui: {
      setStatus: (...parts: string[]) => { capturedStatus.push(...parts) },
      setWidget: () => {},
    },
    theme: { fg: (_s: string, t: string) => t },
  } as any

  updateDashboard(fakeExtCtx as any, ctx)

  const statusStr = capturedStatus.join(' ')
  assert.ok(!statusStr.includes('error'), `Should not have 'error' in status: "${statusStr}"`)
})

test("updateDashboard: shows 'N errors' (plural) when multiple agents have failures", () => {
  const ctx = createRuntimeContext(stubPi)
  ctx.teamConfig = {
    team: { name: 'Test', description: '' },
    levels: [],
    agents: [],
    constraints: { maxBudget: 10, maxTime: 60 },
  } as any
  ctx.state.startTime = Date.now()
  ctx.state.timerStarted = true

  ctx.agentMetrics.set('agent-a', makeMetrics({ failureCount: 2 }) as any)
  ctx.agentMetrics.set('agent-b', makeMetrics({ failureCount: 1 }) as any)

  const capturedStatus: string[] = []
  const fakeExtCtx = {
    ui: {
      setStatus: (...parts: string[]) => { capturedStatus.push(...parts) },
      setWidget: () => {},
    },
    theme: { fg: (_s: string, t: string) => t },
  } as any

  updateDashboard(fakeExtCtx as any, ctx)

  const statusStr = capturedStatus.join(' ')
  assert.ok(statusStr.includes('2 errors'), `Expected '2 errors' in status: "${statusStr}"`)
})
