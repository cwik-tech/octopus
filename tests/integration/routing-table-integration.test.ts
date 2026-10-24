/**
 * Integration tests for the routing table loop in tryAdvanceLevel().
 *
 * Unlike the unit tests (21-28 in conditional-routing.test.ts), these tests
 * do NOT mock checkGate.  Instead, they use real TeamConfig objects with
 * real files on disk so that artifact_exists and artifact_content conditions
 * evaluate through the full gate-checker code path.
 *
 * Dependencies that are impossible to run in a test environment (agent dispatch,
 * experience reflections, minutes generation) are still mocked.
 *
 * Test inventory:
 *   I-1  Single artifact_exists gate — artifact present → advances
 *   I-2  Single artifact_exists gate — artifact absent → waits
 *   I-3  Two artifact_exists gates — first artifact present → first-match-wins
 *   I-4  Two artifact_exists gates — first absent, second present → falls through to second
 *   I-5  Two artifact_exists gates — both absent → waits
 *   I-6  artifact_content (contains) gate — content matches → advances
 *   I-7  artifact_content (contains) gate — content no match → waits
 *   I-8  artifact_content (regex) gate — regex matches → advances
 *   I-9  Mixed routing table: artifact_content fallthrough to artifact_exists
 *   I-10 Completion gate (artifact_exists "done") — artifact present → completes pipeline
 *   I-11 Loopback via artifact_exists: routing to earlier level decrements index
 *   I-12 Gate from different level does not affect current level's evaluation
 */

import { describe, it, mock, before, after, afterEach } from 'node:test'
import assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { GateConfig } from '../../core/types.js'

// ── Module mocks ─────────────────────────────────────────────────────────────
// Must be registered BEFORE importing level-lifecycle so that its static
// imports resolve to the mocked versions.

// Mock agent-runner so agent_verdict gates (if any) don't try to run a real
// agent process.  Also stops failure-policy's transitive imports from needing
// real agent dispatch.
mock.module('../../domains/agent-execution/agent-runner.js', {
  namedExports: {
    runAgent: mock.fn(async () => ({ text: 'APPROVE\n', cost: 0 })),
    dispatchToAgentOrTeam: mock.fn(async () => ({ text: '', cost: 0 })),
  },
})

// Mock failure-policy to break the import chain from engines/* that would
// otherwise demand the full dispatchToAgentOrTeam API.
mock.module('../../domains/agent-execution/failure-policy.js', {
  namedExports: {
    DispatchResultValidationError: class DispatchResultValidationError extends Error {},
    HaltError: class HaltError extends Error {},
    resolveFailurePolicy: mock.fn(() => ({ policy: 'skip', maxRetries: 0, fallbackAgent: undefined })),
    dispatchWithFailurePolicy: mock.fn(async () => ({ text: '', cost: 0 })),
  },
})

// Mock experience-reflections and minutes — not relevant to gate routing logic.
mock.module('../../team-runtime/experience-reflections.js', {
  namedExports: { runExperienceReflections: mock.fn(async () => {}) },
})
mock.module('../../domains/agent-execution/minutes.js', {
  namedExports: { generateMinutes: mock.fn(async () => {}) },
})

// Import level-lifecycle AFTER all mocks — so its static imports pick up the
// mocked modules.  Gate-checker is NOT mocked here; it runs for real.
const { tryAdvanceLevel } = await import('../../team-runtime/level-lifecycle.js')

// ── Fixture helpers ───────────────────────────────────────────────────────────

function broadcastStage() {
  return {
    type: 'broadcast' as const,
    fan_out: ['agent1'],
    config: {
      aggregation: 'merge' as const,
      output: { format: 'broadcast-result.md', user_review: false },
    },
  }
}

function completedBroadcastEngine() {
  return {
    type: 'broadcast' as const,
    responses: [] as Array<{ agent: string; text: string; cost: number }>,
    aggregatedResult: 'done',
  }
}

/** Four levels: l0 (loopback target) → l1 (active) → l2 → l3 */
function makeLevels() {
  return [
    { id: 'l0', name: 'Level 0', order: 0, stage: broadcastStage() },
    { id: 'l1', name: 'Level 1', order: 1, stage: broadcastStage() },
    { id: 'l2', name: 'Level 2', order: 2, stage: broadcastStage() },
    { id: 'l3', name: 'Level 3', order: 3, stage: broadcastStage() },
  ]
}

/**
 * Build a RuntimeContext stub.
 * teamRoot is the tmpDir; assignment artifacts live under teamConfig.workspace.path.
 */
function makeCtx(
  levels: ReturnType<typeof makeLevels>,
  gates: GateConfig[],
  teamRoot: string,
) {
  const workspacePath = path.join(teamRoot, 'workspace')
  const levelStates = new Map(
    levels.map((l, i) => [
      l.id,
      {
        status: i === 1 ? 'active' : 'pending',
        stageStatus: i === 1 ? 'running' : 'not_started',
        loopbackCount: 0,
        engineState: i === 1 ? completedBroadcastEngine() : null,
      },
    ]),
  )

  return {
    teamConfig: {
      team: { name: 'test', description: 'test', version: '1.0.0' },
      workspace: { path: workspacePath, watch: false },
      models: {},
      levels,
      gates,
      agents: [],
    },
    teamRoot,
    inputFilesContent: '',
    agents: new Map(),
    rosterEntries: new Map(),
    teamRegistry: new Map(),
    bootEntry: null,
    state: {
      sessionId: 'default',
      currentLevelIndex: 1, // l1 is active
      levelStates,
      totalCost: 0,
      startTime: 0,
      timerStarted: false,
      endTime: null,
      spawnDepth: 0,
    },
    agentMetrics: new Map(),
    coordinatorRunId: 0,
    levelAdvancedCoordinatorRunId: null,
    activeSpawnCount: 0,
    setupMode: false,
    configErrors: [],
    lastCtx: null,
    refreshTimer: null,
    activeDelegations: new Map(),
    blockedToolCallIds: new Set(),
    usedLevelToolsThisCoordinatorTurn: new Set(),
    toolFailureFollowUpRunIds: new Set(),
    pendingStageEntryLevelId: null,
    currentRegisteredTools: [],
    pendingFollowUps: [],
    pendingFollowUpTimer: null,
    pi: { sendUserMessage: mock.fn() },
    ENGINE_TOOLS: new Set(),
    shutdownController: new AbortController(),
    budgetLedger: undefined,
  }
}

function makeExtCtx() {
  return { ui: { notify: mock.fn() } }
}

/**
 * @param runtimeOwnsLevel Whether the runtime drives the destination itself.
 *   Stated explicitly rather than read from the environment, because it is what
 *   decides whether the destination may be armed at advance time.
 */
function makeCallbacks(runtimeOwnsLevel = false) {
  return {
    registerLevelTools: mock.fn(),
    persistState: mock.fn(),
    updateDashboard: mock.fn(),
    runtimeOwnsLevel: mock.fn(() => runtimeOwnsLevel),
    prepareHostForActiveLevel: mock.fn(async () => true),
  }
}

// Gate factories — conditions use real artifact paths relative to teamRoot
function artifactExistsGate(from: string, to: string, artifact: string): GateConfig {
  return { from, to, condition: { type: 'artifact_exists', artifact } }
}
function artifactContentGate(
  from: string,
  to: string,
  artifact: string,
  match: string,
  match_type: 'contains' | 'regex' = 'contains',
): GateConfig {
  return { from, to, condition: { type: 'artifact_content', artifact, match, match_type } }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('tryAdvanceLevel — routing table integration (real checkGate)', () => {
  let tmpDir: string
  let assignmentPath: string

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-integration-'))
    assignmentPath = path.join(tmpDir, 'workspace', 'assignments', 'default')
    fs.mkdirSync(assignmentPath, { recursive: true })
  })

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  afterEach(() => {
    // Clean up any artifact files created by individual tests inside assignmentPath
    for (const f of fs.readdirSync(assignmentPath)) {
      if (f.endsWith('.md') || f.endsWith('.txt')) {
        fs.rmSync(path.join(assignmentPath, f), { force: true })
      }
    }
  })

  it('I-1: single artifact_exists gate — artifact present → advances to gate target', async () => {
    fs.writeFileSync(path.join(assignmentPath, 'output.md'), 'done')

    const gates = [artifactExistsGate('l1', 'l2', 'output.md')]
    const ctx = makeCtx(makeLevels(), gates, tmpDir)

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, makeCallbacks() as never)

    assert.equal(ctx.state.currentLevelIndex, 2, `Expected advance to l2 (index 2), got ${ctx.state.currentLevelIndex}`)
  })

  it('I-2: single artifact_exists gate — artifact absent → pipeline waits', async () => {
    // No artifact created — gate should fail
    const gates = [artifactExistsGate('l1', 'l2', 'output.md')]
    const ctx = makeCtx(makeLevels(), gates, tmpDir)
    const callbacks = makeCallbacks()

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, callbacks as never)

    assert.equal(ctx.state.currentLevelIndex, 1, `Expected no advancement, got index ${ctx.state.currentLevelIndex}`)
    assert.equal(
      (callbacks.persistState as ReturnType<typeof mock.fn>).mock.calls.length,
      0,
      'persistState should not be called when gate fails',
    )
  })

  it('I-3: two artifact_exists gates — first artifact present → first-match-wins, stops at first', async () => {
    fs.writeFileSync(path.join(assignmentPath, 'gate1.md'), 'gate1 output')
    fs.writeFileSync(path.join(assignmentPath, 'gate2.md'), 'gate2 output')

    const gates = [
      artifactExistsGate('l1', 'l2', 'gate1.md'),
      artifactExistsGate('l1', 'l3', 'gate2.md'),
    ]
    const ctx = makeCtx(makeLevels(), gates, tmpDir)

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, makeCallbacks() as never)

    // First gate passes → advance to l2 (index 2), not l3 (index 3)
    assert.equal(ctx.state.currentLevelIndex, 2, `Expected index 2 (l2, first gate wins), got ${ctx.state.currentLevelIndex}`)
  })

  it('I-4: two artifact_exists gates — first absent, second present → falls through to second gate', async () => {
    // gate1.md absent, gate2.md present — should advance to l3
    fs.writeFileSync(path.join(assignmentPath, 'gate2.md'), 'gate2 output')

    const gates = [
      artifactExistsGate('l1', 'l2', 'gate1.md'),
      artifactExistsGate('l1', 'l3', 'gate2.md'),
    ]
    const ctx = makeCtx(makeLevels(), gates, tmpDir)

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, makeCallbacks() as never)

    assert.equal(ctx.state.currentLevelIndex, 3, `Expected index 3 (l3, second gate wins), got ${ctx.state.currentLevelIndex}`)
  })

  it('I-5: two artifact_exists gates — both absent → pipeline waits', async () => {
    // Neither artifact exists
    const gates = [
      artifactExistsGate('l1', 'l2', 'gate1.md'),
      artifactExistsGate('l1', 'l3', 'gate2.md'),
    ]
    const ctx = makeCtx(makeLevels(), gates, tmpDir)
    const callbacks = makeCallbacks()

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, callbacks as never)

    assert.equal(ctx.state.currentLevelIndex, 1, 'Both gates failed — expected no advancement')
    assert.equal(
      (callbacks.persistState as ReturnType<typeof mock.fn>).mock.calls.length,
      0,
      'persistState must not be called',
    )
  })

  it('I-6: artifact_content (contains) gate — content matches case-insensitively → advances', async () => {
    fs.writeFileSync(path.join(assignmentPath, 'classification.md'), 'classification: TECHNICAL\nOther stuff here.')

    const gates = [artifactContentGate('l1', 'l2', 'classification.md', 'technical', 'contains')]
    const ctx = makeCtx(makeLevels(), gates, tmpDir)

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, makeCallbacks() as never)

    assert.equal(ctx.state.currentLevelIndex, 2, `Expected advance to l2 on content match, got ${ctx.state.currentLevelIndex}`)
  })

  it('I-7: artifact_content (contains) gate — content no match → pipeline waits', async () => {
    fs.writeFileSync(path.join(assignmentPath, 'classification.md'), 'classification: commercial')

    const gates = [artifactContentGate('l1', 'l2', 'classification.md', 'technical', 'contains')]
    const ctx = makeCtx(makeLevels(), gates, tmpDir)
    const callbacks = makeCallbacks()

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, callbacks as never)

    assert.equal(ctx.state.currentLevelIndex, 1, 'Content does not match — expected no advancement')
    assert.equal((callbacks.persistState as ReturnType<typeof mock.fn>).mock.calls.length, 0)
  })

  it('I-8: artifact_content (regex) gate — regex matches → advances', async () => {
    fs.writeFileSync(path.join(assignmentPath, 'verdict.md'), 'status: approved-with-conditions')

    // Regex: "approved" anywhere
    const gates = [artifactContentGate('l1', 'l2', 'verdict.md', 'approved.*', 'regex')]
    const ctx = makeCtx(makeLevels(), gates, tmpDir)

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, makeCallbacks() as never)

    assert.equal(ctx.state.currentLevelIndex, 2, `Expected advance to l2 via regex match, got ${ctx.state.currentLevelIndex}`)
  })

  it('I-9: mixed routing table — artifact_content fallthrough to artifact_exists fallback', async () => {
    // Gate 1: artifact_content looking for "technical" — file has "commercial"
    // Gate 2: artifact_exists fallback — file present
    fs.writeFileSync(path.join(assignmentPath, 'triage.md'), 'classification: commercial')
    fs.writeFileSync(path.join(assignmentPath, 'fallback.md'), 'fallback triggered')

    const gates = [
      artifactContentGate('l1', 'l2', 'triage.md', 'technical', 'contains'),  // fails
      artifactExistsGate('l1', 'l3', 'fallback.md'),                           // passes
    ]
    const ctx = makeCtx(makeLevels(), gates, tmpDir)

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, makeCallbacks() as never)

    // Gate 1 fails (no "technical"), Gate 2 passes → advance to l3
    assert.equal(ctx.state.currentLevelIndex, 3, `Expected advance to l3 via fallback gate, got ${ctx.state.currentLevelIndex}`)
  })

  it('I-10: completion gate (to "done") — artifact present → completes pipeline', async () => {
    fs.writeFileSync(path.join(assignmentPath, 'final-output.md'), 'complete')

    const completionGate: GateConfig = {
      from: 'l1',
      to: 'done',
      condition: { type: 'artifact_exists', artifact: 'final-output.md' },
    }
    const ctx = makeCtx(makeLevels(), [completionGate], tmpDir)
    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    // handleCompletionGatePassed sets endTime
    assert.ok(ctx.state.endTime !== null, 'Expected endTime to be set after completion gate passes')
    assert.equal(
      (callbacks.persistState as ReturnType<typeof mock.fn>).mock.calls.length,
      1,
      'persistState should be called once on completion',
    )
    // A notification should be emitted
    const notifyCalls = (extCtx.ui.notify as ReturnType<typeof mock.fn>).mock.calls
    assert.ok(
      notifyCalls.some((c) => String(c.arguments[0]).toLowerCase().includes('complete')),
      `Expected completion notification, got: ${JSON.stringify(notifyCalls.map((c) => c.arguments[0]))}`,
    )
  })

  it('I-11: loopback — winning gate targets earlier level → currentLevelIndex decreases', async () => {
    fs.writeFileSync(path.join(assignmentPath, 'needs-revision.md'), 'revision required')

    // Loopback gate: l1 → l0 (index 0 < current index 1)
    const gates = [artifactExistsGate('l1', 'l0', 'needs-revision.md')]
    const ctx = makeCtx(makeLevels(), gates, tmpDir)

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, makeCallbacks() as never)

    assert.equal(ctx.state.currentLevelIndex, 0, `Expected loopback to l0 (index 0), got ${ctx.state.currentLevelIndex}`)

    const l0State = ctx.state.levelStates.get('l0')
    assert.ok(l0State, 'l0 state must exist')
    assert.equal(l0State!.loopbackCount, 1, 'loopbackCount for l0 must be 1 after loopback')
    assert.equal(l0State!.status, 'active', 'l0 must be active after loopback')
  })

  it('I-12: gates from a different level do not affect evaluation of current level', async () => {
    // Gate from l2 — should be filtered out; only gate from l1 matters
    fs.writeFileSync(path.join(assignmentPath, 'l1-output.md'), 'l1 done')
    // l2-output.md absent intentionally to confirm l2's gate is not evaluated

    const gates = [
      artifactExistsGate('l2', 'l3', 'l2-output.md'), // from l2 — irrelevant
      artifactExistsGate('l1', 'l2', 'l1-output.md'), // from l1 — should pass
    ]
    const ctx = makeCtx(makeLevels(), gates, tmpDir)

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, makeCallbacks() as never)

    // Only the l1 gate is evaluated; it passes → advance to l2
    assert.equal(ctx.state.currentLevelIndex, 2, `Expected advance to l2 (l1 gate passes), got ${ctx.state.currentLevelIndex}`)
  })

  // A gate can be satisfied in the middle of a coordinator's turn, and that
  // coordinator still owns the host loop. Advancing is not entering: the
  // destination stays inert until the turn that actually enters it, which is
  // the settle that delivers its stage entry.
  it('I-13: a host-managed destination is not armed at advance time', async () => {
    fs.writeFileSync(path.join(assignmentPath, 'output.md'), 'done')

    const gates = [artifactExistsGate('l1', 'l2', 'output.md')]
    const ctx = makeCtx(makeLevels(), gates, tmpDir)
    ctx.coordinatorRunId = 7
    const callbacks = makeCallbacks(false)

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, callbacks as never)

    assert.equal(ctx.state.currentLevelIndex, 2, 'the gate must still advance the level')
    assert.equal(
      (callbacks.registerLevelTools as ReturnType<typeof mock.fn>).mock.calls.length,
      0,
      "l2's tools must not be registered while the advancing turn still owns the host",
    )
    assert.equal(
      ctx.pendingStageEntryLevelId,
      'l2',
      'the destination must be left pending for the turn that enters it',
    )

    // The post-advance fence is an equality test between the run that advanced
    // and the run asking for a tool (`capability-tool-policy.ts:88-91`). Both
    // sides have to still be the advancing run, or the previous level's engine
    // tools reopen inside the turn whose advance closed them.
    assert.equal(
      ctx.levelAdvancedCoordinatorRunId,
      ctx.coordinatorRunId,
      'the advance must fence engine tools for the run that advanced',
    )
    assert.equal(ctx.coordinatorRunId, 7, 'advancing must not renumber the coordinator run')
  })

  // The other side of the same rule: when the runtime drives the destination
  // itself there is no coordinator turn to wait for, so it is armed at once.
  it('I-14: a runtime-owned destination is armed at advance time', async () => {
    fs.writeFileSync(path.join(assignmentPath, 'output.md'), 'done')

    const gates = [artifactExistsGate('l1', 'l2', 'output.md')]
    const ctx = makeCtx(makeLevels(), gates, tmpDir)
    const callbacks = makeCallbacks(true)

    await tryAdvanceLevel(makeExtCtx() as never, ctx as never, callbacks as never)

    assert.equal(ctx.state.currentLevelIndex, 2, 'the gate must still advance the level')
    assert.equal(
      (callbacks.registerLevelTools as ReturnType<typeof mock.fn>).mock.calls.length,
      1,
      "a runtime-owned destination's tools must be registered at advance time",
    )
  })
})
