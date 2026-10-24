import { whenDefined } from '../../core/optional-properties.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  discardPendingStageEntries,
  enqueueFollowUp,
  flushPendingFollowUps,
} from '../../domains/runtime/follow-up.js'
import type { RuntimeContext } from '../../domains/runtime/runtime-context.js'
import { AGENT_STATE } from '../../core/constants.js'

function makeCtx(): RuntimeContext {
  const messages: Array<{ message: string, options?: unknown }> = []
  return {
    teamConfig: null,
    teamRoot: '',
    inputFilesContent: '',
    agents: new Map(),
    rosterEntries: new Map(),
    teamRegistry: new Map(),
    workflowRegistry: new Map(),
    bootEntry: null,
    state: {
      sessionId: 's1',
      currentLevelIndex: 0,
      levelStates: new Map(),
      totalCost: 0,
      startTime: 0,
      timerStarted: false,
      endTime: null,
      spawnDepth: 0,
    },
    agentMetrics: new Map([['coordinator', {
      state: AGENT_STATE.IDLE,
      rounds: 0,
      totalCost: 0,
      contextTokens: 0,
      model: 'm',
      color: 1,
      failureCount: 0,
    }]]),
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
    coordinatorToolCallsThisRun: 0,
    outerTurnOwner: null,
    pendingStageEntryLevelId: null,
    currentRegisteredTools: [],
    currentToolInvokers: new Map(),
    delegatedAutostartOwnsStage: false,
    pendingFollowUps: [],
    pendingFollowUpTimer: null,
    pi: {
      sendUserMessage(message: string, options?: unknown) {
        messages.push({ message, options })
      },
    } as RuntimeContext['pi'],
    
    ENGINE_TOOLS: new Set(),
    shutdownController: new AbortController(),
    
  }
}

test('enqueueFollowUp sends immediately when host turn is idle', () => {
  const ctx = makeCtx()
  const sent: Array<{ message: string, options?: unknown }> = []
  ctx.pi = {
    sendUserMessage(message: string, options?: unknown) {
      sent.push({ message, options })
    },
  } as RuntimeContext['pi']

  enqueueFollowUp(ctx, 'next step')

  assert.equal(ctx.pendingFollowUps.length, 0)
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.message, 'next step')
})

test('enqueueFollowUp queues while host turn is active and flushes on demand', () => {
  const ctx = makeCtx()
  const sent: Array<{ message: string, options?: unknown }> = []
  ctx.pi = {
    sendUserMessage(message: string, options?: unknown) {
      sent.push({ message, options })
    },
  } as RuntimeContext['pi']
  const metrics = ctx.agentMetrics.get('coordinator')
  assert.ok(metrics)
  metrics!.state = AGENT_STATE.ACTIVE

  enqueueFollowUp(ctx, 'after current turn')

  assert.equal(sent.length, 0)
  assert.equal(ctx.pendingFollowUps.length, 1)
  assert.equal(ctx.pendingFollowUps[0]?.message, 'after current turn')

  metrics!.state = AGENT_STATE.DONE
  flushPendingFollowUps(ctx)

  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.message, 'after current turn')
  assert.equal(ctx.pendingFollowUps.length, 0)
})

// A stage entry is the next level's opening prompt. Sending it through a live
// turn hands it to the coordinator still finishing the previous level, on that
// coordinator's pair, so no kind is exempt from the gate.
test('stage-entry follow-ups defer while the coordinator is still active', () => {
  const ctx = makeCtx()
  const sent: Array<{ message: string, options?: unknown }> = []
  ctx.pi = {
    sendUserMessage(message: string, options?: unknown) {
      sent.push({ message, options })
    },
  } as RuntimeContext['pi']
  const metrics = ctx.agentMetrics.get('coordinator')
  assert.ok(metrics)
  metrics!.state = AGENT_STATE.ACTIVE

  enqueueFollowUp(ctx, 'enter review', { kind: 'stage_entry', levelId: 'editorial-review', stageType: 'review', delayMs: 0 })
  flushPendingFollowUps(ctx)

  assert.equal(sent.length, 0)
  assert.equal(ctx.pendingFollowUps.length, 1)
  assert.equal(ctx.pendingFollowUps[0]?.message, 'enter review')
  if (ctx.pendingFollowUpTimer) clearTimeout(ctx.pendingFollowUpTimer)
})

// The claim outlives the coordinator's own ACTIVE state: it is held from the
// first agent_start until agent_settled, which is exactly the window in which
// the level may already have advanced while Pi can still continue the turn.
test('a claimed outer turn defers a follow-up even with every agent idle', () => {
  const ctx = makeCtx()
  const sent: string[] = []
  ctx.pi = {
    sendUserMessage(message: string) {
      sent.push(message)
    },
  } as RuntimeContext['pi']
  ctx.outerTurnOwner = {
    coordinatorName: null,
    coordinatorProvider: null,
    coordinatorModel: null,
    hostModelSelection: undefined,
    levelIndex: 0,
    levelId: 'draft',
    stageType: 'discussion',
    hostProvider: 'anthropic-api',
    hostModel: 'model-a',
    coordinatorRunId: 1,
    startedAt: Date.now(),
  }

  enqueueFollowUp(ctx, 'enter review', { kind: 'stage_entry', levelId: 'review', stageType: 'review', delayMs: 0 })
  flushPendingFollowUps(ctx)

  assert.equal(sent.length, 0)
  assert.equal(ctx.pendingFollowUps.length, 1)

  ctx.outerTurnOwner = null
  flushPendingFollowUps(ctx)

  assert.deepEqual(sent, ['enter review'])
  assert.equal(ctx.pendingFollowUps.length, 0)
  if (ctx.pendingFollowUpTimer) clearTimeout(ctx.pendingFollowUpTimer)
})

test('runtime notices still defer while the coordinator is active', () => {
  const ctx = makeCtx()
  const sent: Array<{ message: string, options?: unknown }> = []
  ctx.pi = {
    sendUserMessage(message: string, options?: unknown) {
      sent.push({ message, options })
    },
  } as RuntimeContext['pi']
  const metrics = ctx.agentMetrics.get('coordinator')
  assert.ok(metrics)
  metrics!.state = AGENT_STATE.ACTIVE

  enqueueFollowUp(ctx, 'status update', { kind: 'runtime_notice', delayMs: 0 })
  flushPendingFollowUps(ctx)

  assert.equal(sent.length, 0)
  assert.equal(ctx.pendingFollowUps.length, 1)
  assert.equal(ctx.pendingFollowUps[0]?.message, 'status update')
})

test('stage-entry follow-ups are deferred and retried when the host is still busy', async () => {
  const ctx = makeCtx()
  const sent: Array<{ message: string, options?: unknown }> = []
  let attempts = 0
  ctx.pi = {
    sendUserMessage(message: string, options?: unknown) {
      attempts++
      if (attempts === 1) throw new Error('Agent is already processing a prompt.')
      sent.push({ message, options })
    },
  } as RuntimeContext['pi']

  enqueueFollowUp(ctx, 'advance level', { kind: 'stage_entry', levelId: 'l2', stageType: 'review', delayMs: 0 })
  flushPendingFollowUps(ctx)

  assert.equal(sent.length, 0)
  assert.equal(ctx.pendingFollowUps.length, 1)

  await new Promise((resolve) => setTimeout(resolve, 40))

  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.message, 'advance level')
  assert.equal(ctx.pendingFollowUps.length, 0)
})

test('a failed follow-up send preserves later ready follow-ups', () => {
  const ctx = makeCtx()
  const sent: string[] = []
  let calls = 0
  ctx.pi = {
    sendUserMessage(message: string) {
      calls++
      if (calls === 2) throw new Error('transport unavailable')
      sent.push(message)
    },
  } as RuntimeContext['pi']

  const now = Date.now() - 1
  for (const message of ['first', 'second', 'third']) {
    ctx.pendingFollowUps.push({
      id: message,
      message,
      kind: 'runtime_notice',
      notBefore: now,
      attempts: 0,
      createdAt: new Date().toISOString(),
    })
  }

  flushPendingFollowUps(ctx)

  assert.deepEqual(sent, ['first'])
  assert.deepEqual(ctx.pendingFollowUps.map((entry) => entry.message), ['second', 'third'])
  if (ctx.pendingFollowUpTimer) clearTimeout(ctx.pendingFollowUpTimer)
})

test('a flush hands over one entry and leaves the rest admitted', () => {
  // Not a pacing preference. `pi.sendUserMessage` is void and starts the turn
  // asynchronously, and Pi reads `isStreaming` once before awaiting its
  // `before_agent_start` handlers — so two sends from one synchronous loop both
  // pass that check and the second is refused with "Agent is already
  // processing a prompt". The refused entry is already out of the queue by
  // then, and the rejection makes Pi emit `agent_settled` for a turn that is
  // still running. The queue is the record of admitted work, so an entry stays
  // in it until the host has actually been given it.
  const ctx = makeCtx()
  const sent: string[] = []
  ctx.pi = {
    sendUserMessage(message: string) {
      sent.push(message)
    },
  } as RuntimeContext['pi']

  const due = Date.now() - 1
  for (const message of ['first', 'second', 'third']) {
    ctx.pendingFollowUps.push({
      id: message,
      message,
      kind: 'stage_entry',
      notBefore: due,
      attempts: 0,
      createdAt: new Date(due).toISOString(),
    })
  }

  flushPendingFollowUps(ctx)

  assert.deepEqual(sent, ['first'])
  assert.deepEqual(
    ctx.pendingFollowUps.map((entry) => entry.message),
    ['second', 'third'],
  )
  assert.equal(
    ctx.pendingFollowUpTimer,
    null,
    'the next entry waits for the turn to end, not for a timer that would race it',
  )
})

test('a flush that hands over nothing still wakes for work that is not due yet', () => {
  const ctx = makeCtx()
  const sent: string[] = []
  ctx.pi = {
    sendUserMessage(message: string) {
      sent.push(message)
    },
  } as RuntimeContext['pi']

  ctx.pendingFollowUps.push({
    id: 'later',
    message: 'later',
    kind: 'stage_entry',
    notBefore: Date.now() + 60_000,
    attempts: 0,
    createdAt: new Date().toISOString(),
  })

  flushPendingFollowUps(ctx)

  assert.deepEqual(sent, [])
  assert.notEqual(
    ctx.pendingFollowUpTimer,
    null,
    'nothing else is coming to ask again for an entry that is merely early',
  )
  if (ctx.pendingFollowUpTimer) clearTimeout(ctx.pendingFollowUpTimer)
})

// ── The dispatch admission ───────────────────────────────────────────────────

function makeAdmittedCtx(levelId: string): {
  readonly ctx: RuntimeContext
  readonly persists: () => number
} {
  const ctx = makeCtx()
  let persisted = 0
  ctx.persistRuntimeState = () => {
    persisted += 1
  }
  ctx.state.hostEntryAdmission = {
    levelId,
    visit: 0,
    state: 'pending',
    selection: {
      provider: 'lm-studio',
      model: 'loopback-b',
      source: 'app-default',
      reason: 'agent-default',
      caller: 'agent',
    },
  }
  return { ctx, persists: () => persisted }
}

test('a dispatch is recorded, and persisted, before the entry is sent', () => {
  // `sendUserMessage` returns void and its refusal arrives on Pi's own error
  // channel, so after the call there is nothing further to learn. A record
  // written afterwards would be missing for exactly the crash it exists to
  // survive — so the send itself is what observes the order here.
  const { ctx, persists } = makeAdmittedCtx('review')
  const seenAtSend: Array<{ state: string | undefined; persists: number }> = []
  ctx.pi = {
    sendUserMessage(_message: string, _options?: unknown) {
      seenAtSend.push({
        state: ctx.state.hostEntryAdmission?.state,
        persists: persists(),
      })
    },
  } as RuntimeContext['pi']

  enqueueFollowUp(ctx, 'enter review', {
    kind: 'stage_entry',
    levelId: 'review',
    delayMs: 0,
  })
  flushPendingFollowUps(ctx)

  assert.deepEqual(seenAtSend, [{ state: 'dispatching', persists: 1 }])
})

test('a runtime notice does not move a stage entry\'s admission', () => {
  // A notice enters no level and decides no model. It carries no level id, and
  // treating that absence as "any level" once marked a stage entry as handed
  // over on the strength of a message that was not it.
  const { ctx } = makeAdmittedCtx('review')

  enqueueFollowUp(ctx, 'a notice', { kind: 'runtime_notice', delayMs: 0 })
  flushPendingFollowUps(ctx)

  assert.equal(ctx.state.hostEntryAdmission?.state, 'pending')
})

test('a stage entry for a different level does not move this one', () => {
  // The mismatch the case above cannot reach: a real stage entry, with a real
  // level id, that is not the level holding the admission.
  const { ctx } = makeAdmittedCtx('review')

  enqueueFollowUp(ctx, 'enter draft', {
    kind: 'stage_entry',
    levelId: 'draft',
    delayMs: 0,
  })
  flushPendingFollowUps(ctx)

  assert.equal(ctx.state.hostEntryAdmission?.levelId, 'review')
  assert.equal(ctx.state.hostEntryAdmission?.state, 'pending')
})

test('a send that throws puts the admission back with the entry', () => {
  // The one failure this process can see. Leaving the record saying
  // `dispatching` would make a later recovery refuse an entry that
  // demonstrably never left.
  const { ctx } = makeAdmittedCtx('review')
  ctx.pi = {
    sendUserMessage(_message: string, _options?: unknown): void {
      throw new Error('Agent is already processing a prompt')
    },
  } as RuntimeContext['pi']

  enqueueFollowUp(ctx, 'enter review', {
    kind: 'stage_entry',
    levelId: 'review',
    delayMs: 0,
  })
  flushPendingFollowUps(ctx)

  assert.equal(ctx.state.hostEntryAdmission?.state, 'pending')
  assert.equal(ctx.pendingFollowUps.length, 1)
  assert.equal(ctx.pendingFollowUps[0]?.levelId, 'review')

  // The retry wake-up this failure armed belongs to a context this test is
  // finished with. It is unreferenced and so cannot hold the process open, but
  // leaving it armed lets a later flush fire against a discarded fixture.
  if (ctx.pendingFollowUpTimer) clearTimeout(ctx.pendingFollowUpTimer)
})

test('discarding a level\'s queued entries discards the record of them too', () => {
  const { ctx } = makeAdmittedCtx('review')
  enqueueFollowUp(ctx, 'enter review', {
    kind: 'stage_entry',
    levelId: 'review',
    delayMs: 25,
  })

  discardPendingStageEntries(ctx, 'team_reset')

  assert.equal(ctx.state.hostEntryAdmission, undefined)
  assert.deepEqual(ctx.pendingFollowUps, [])
})

test('an admission is discarded even when nothing happened to be queued', () => {
  // A reset can land at an instant with an empty queue, and the early return
  // for "nothing to discard" used to end the function there. An admission left
  // behind would still match by identity afterwards, because `team-reset`
  // clears a level's status without starting a new visit — so the next start
  // would re-open a level the run deliberately left.
  const { ctx } = makeAdmittedCtx('review')

  discardPendingStageEntries(ctx, 'team_reset')

  assert.equal(ctx.state.hostEntryAdmission, undefined)
})

// ── The send boundary ────────────────────────────────────────────────────────

/**
 * A context whose durable writes land in a real directory.
 *
 * The queue logs through `logRuntimeEvent`, which appends to
 * `<assignment>/logs/runtime-events.jsonl` with an unguarded `openSync`
 * (`domains/runtime/logger.ts:67-71`). Real files, because the failure under
 * test is a real filesystem failure and a replaced writer would only prove what
 * the replacement was told to do.
 */
function makeLoggingCtx(assignmentPath: string): {
  readonly ctx: RuntimeContext
  readonly sends: () => number
} {
  const { ctx } = makeAdmittedCtx('review')
  let sends = 0
  ctx.assignmentLocation = {
    layout: 'session',
    sessionId: 's1',
    runId: 'r1',
    assignmentId: 'a1',
    runPath: assignmentPath,
    assignmentPath,
    relativeRunPath: 'run',
    relativeAssignmentPath: 'run/assignment',
  }
  ctx.teamConfig = {
    team: { name: 'team', description: '' },
    workspace: { path: assignmentPath },
    agents: [],
    levels: [{ id: 'review', name: 'Review', order: 0, stage: { type: 'routing' } }],
    gates: [],
  } as unknown as RuntimeContext['teamConfig']
  ctx.pi = {
    sendUserMessage(_message: string, _options?: unknown): void {
      sends += 1
    },
  } as RuntimeContext['pi']
  return { ctx, sends: () => sends }
}

test('an entry the host has already been given is not requeued when a later write fails', () => {
  // Once `sendUserMessage` has returned, the host may already be running that
  // turn: the call is `void` and starts the turn asynchronously. Anything that
  // fails *after* it — a log append, a notification — says nothing about
  // whether the entry left, so treating it as a failed send is the one mistake
  // that turns executed work back into work the run believes it still owes.
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-up-log-fail-'))
  try {
    const assignmentPath = path.join(fixtureRoot, 'assignment')
    fs.mkdirSync(path.join(assignmentPath, 'logs'), { recursive: true })

    const { ctx, sends } = makeLoggingCtx(assignmentPath)
    // Enqueued behind a turn, which is how a real stage entry arrives: the
    // queue defers rather than sending, so the log is still writable for the
    // enqueue's own record and the dispatch happens later, from the flush.
    ctx.outerTurnOwner = { levelId: 'review' } as RuntimeContext['outerTurnOwner']
    enqueueFollowUp(ctx, 'enter review', {
      kind: 'stage_entry',
      levelId: 'review',
      delayMs: 0,
    })
    ctx.outerTurnOwner = null
    if (ctx.pendingFollowUpTimer) {
      clearTimeout(ctx.pendingFollowUpTimer)
      ctx.pendingFollowUpTimer = null
    }

    // Now a directory where the log file must be: `openSync(..., 'a')` fails
    // EISDIR. The checkpoint path stays writable, so the admission itself can
    // still be saved — only the diagnostics after the send are broken.
    const logPath = path.join(assignmentPath, 'logs', 'runtime-events.jsonl')
    fs.rmSync(logPath, { force: true })
    fs.mkdirSync(logPath)

    flushPendingFollowUps(ctx)

    assert.equal(sends(), 1, 'the entry must be handed over exactly once')
    assert.equal(
      ctx.state.hostEntryAdmission?.state,
      'dispatching',
      'an entry the host was given stays handed over, whatever fails afterwards',
    )
    assert.deepEqual(
      ctx.pendingFollowUps,
      [],
      'an entry the host was given must not go back on the queue',
    )
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('a failure before the send still requeues the entry and its record', () => {
  // The other side of the same boundary, so the fix cannot be "never requeue".
  // Nothing left, so the run still owes this entry.
  const { ctx } = makeAdmittedCtx('review')
  let sends = 0
  ctx.pi = {
    sendUserMessage(_message: string, _options?: unknown): void {
      sends += 1
      throw new Error('Agent is already processing a prompt')
    },
  } as RuntimeContext['pi']

  enqueueFollowUp(ctx, 'enter review', {
    kind: 'stage_entry',
    levelId: 'review',
    delayMs: 0,
  })
  flushPendingFollowUps(ctx)

  assert.equal(sends, 1)
  assert.equal(ctx.state.hostEntryAdmission?.state, 'pending')
  assert.equal(ctx.pendingFollowUps.length, 1)
  if (ctx.pendingFollowUpTimer) clearTimeout(ctx.pendingFollowUpTimer)
})

/** Drive the record to the state it is in between a level's turns. */
function markSettled(ctx: RuntimeContext): void {
  const admission = ctx.state.hostEntryAdmission
  if (!admission) return
  ctx.state.hostEntryAdmission = { ...admission, state: 'settled' }
}

test('a notice for a level puts that level back in flight before it is sent', () => {
  // The second turn on a level is started by a notice, and it executes tools
  // and a provider like any other. The durable record has to say so while it is
  // outstanding, or a crash during it reads as "nothing was owed" and the
  // restart replays the level.
  const { ctx } = makeAdmittedCtx('review')
  markSettled(ctx)
  const seenAtSend: Array<string | undefined> = []
  ctx.pi = {
    sendUserMessage(_message: string, _options?: unknown): void {
      seenAtSend.push(ctx.state.hostEntryAdmission?.state)
    },
  } as RuntimeContext['pi']

  enqueueFollowUp(ctx, 'the gate is not satisfied', {
    kind: 'runtime_notice',
    levelId: 'review',
    delayMs: 0,
  })
  flushPendingFollowUps(ctx)

  assert.deepEqual(seenAtSend, ['dispatching'])
})

test('a disk that stays broken does not turn a deferred entry into an escaped throw', () => {
  // The realistic shape of "the disk is gone" is not one failed write, it is
  // every write failing. The pre-send region is allowed to fail the dispatch —
  // that is the point of persisting before sending. What it may not do is raise
  // out of the queue: `flushPendingFollowUps` is called from Pi event handlers
  // and from timers, and a throw there leaves the runtime holding a claim
  // nothing releases.
  const { ctx } = makeAdmittedCtx('review')
  ctx.persistRuntimeState = () => {
    throw new Error('ENOSPC: no space left on device')
  }
  let sends = 0
  ctx.pi = {
    sendUserMessage(_message: string, _options?: unknown): void {
      sends += 1
    },
  } as RuntimeContext['pi']

  enqueueFollowUp(ctx, 'enter review', {
    kind: 'stage_entry',
    levelId: 'review',
    delayMs: 0,
  })
  flushPendingFollowUps(ctx)

  assert.equal(sends, 0, 'nothing may be sent when its admission cannot be recorded')
  assert.equal(
    ctx.state.hostEntryAdmission?.state,
    'pending',
    'the record stays owed, because nothing was handed over',
  )
  assert.equal(ctx.pendingFollowUps.length, 1, 'and so does the entry')
  if (ctx.pendingFollowUpTimer) clearTimeout(ctx.pendingFollowUpTimer)
})

test('an entry whose admission can never be recorded is given up, not retried for ever', () => {
  // A disk that stays broken makes every attempt fail the same way. Requeuing
  // each time leaves a pending entry for ever, and a pending entry is exactly
  // what stops the host lifetime concluding there is nothing left to do:
  // `entryDelivered` is only reached on a successful send, so no start deadline
  // is ever armed. The run neither proceeds nor ends.
  const { ctx } = makeAdmittedCtx('review')
  ctx.persistRuntimeState = () => {
    throw new Error('ENOSPC: no space left on device')
  }
  let sends = 0
  ctx.pi = {
    sendUserMessage(_message: string, _options?: unknown): void {
      sends += 1
    },
  } as RuntimeContext['pi']
  const stops: string[] = []
  ctx.hostRunLifetime = {
    entryDelivered: () => undefined,
    dispatchAbandoned: (reason: string) => stops.push(reason),
    reconsider: () => undefined,
  } as unknown as NonNullable<RuntimeContext['hostRunLifetime']>

  enqueueFollowUp(ctx, 'enter review', {
    kind: 'stage_entry',
    levelId: 'review',
    delayMs: 0,
  })
  for (let attempt = 0; attempt < 12; attempt += 1) {
    ctx.pendingFollowUps = ctx.pendingFollowUps.map((queued) => ({
      ...queued,
      notBefore: 0,
    }))
    flushPendingFollowUps(ctx)
  }

  assert.equal(sends, 0, 'nothing may be sent when its admission cannot be recorded')
  assert.deepEqual(
    ctx.pendingFollowUps,
    [],
    'an entry that can never be admitted must not stay queued for ever',
  )
  assert.deepEqual(
    stops,
    ['admission_unrecordable'],
    'and the host must be told, exactly once, that it will never be dispatched',
  )
  if (ctx.pendingFollowUpTimer) clearTimeout(ctx.pendingFollowUpTimer)
})
