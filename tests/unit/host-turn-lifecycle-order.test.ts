/**
 * The host turn lifecycle's order, pinned by what the host run lifetime does
 * (inventory TR-10 to TR-13, matrix A4.4).
 *
 * A Team host is a Pi print-mode run that ends when the host run lifetime says
 * no work is left. `team-runtime/host-turn-lifecycle.ts` owns the order of the
 * outer-turn claim, the lifetime's signals and the settle's failure path, and
 * the lifetime reads "is a turn in flight?" from that same claim
 * (`team-runtime/index.ts`, where both are built). So an order mistake shows
 * as the host being released at the wrong moment, or for the wrong reason.
 *
 * These tests drive the lifecycle's real `startHostTurn` and `settleHostTurn`
 * over a real runtime context, a real `HostRunLifetime` wired to it the way the
 * runtime wires it, and the runtime's real follow-up queue and host-admission
 * functions. The ports that only write records, metrics or a dashboard are
 * recorded instead. Nothing waits on time: the lifetime's answer is read as
 * soon as the handler returns.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

import { STAGE_TYPE } from '../../core/constants.js'
import type { LevelConfig } from '../../core/types.js'
import {
  discardPendingStageEntries,
  enqueueFollowUp,
  flushPendingFollowUps,
} from '../../domains/runtime/follow-up.js'
import { settleHostEntry } from '../../domains/runtime/host-admission.js'
import { HostRunLifetime } from '../../domains/runtime/host-run-lifetime.js'
import {
  createRuntimeContext,
  type RuntimeContext,
} from '../../domains/runtime/runtime-context.js'
import {
  outerTurnOwnerSnapshot,
  settleHostTurn,
  startHostTurn,
  type HostTurnLifecyclePorts,
} from '../../team-runtime/host-turn-lifecycle.js'

const ENTRY_LEVEL: LevelConfig = {
  id: 'intake',
  name: 'Intake',
  order: 1,
  stage: {
    type: STAGE_TYPE.ROUTING,
    coordinator: 'intake-agent',
    config: { output: { format: 'markdown', user_review: false } },
  },
}
const DESTINATION_LEVEL: LevelConfig = {
  id: 'review',
  name: 'Review',
  order: 2,
  stage: {
    type: STAGE_TYPE.REVIEW,
    coordinator: 'review-lead',
    producer: 'writer',
    reviewer: 'critic',
    config: { max_iterations: 2, output: { format: 'markdown', user_review: false } },
  },
}

interface Harness {
  readonly ctx: RuntimeContext
  readonly lifetime: HostRunLifetime
  readonly extCtx: ExtensionContext
  readonly ports: HostTurnLifecyclePorts
  readonly runFailures: string[]
}

function harness(options: {
  readonly levels: readonly LevelConfig[]
  readonly enterDestination?: () => Promise<boolean>
}): Harness {
  // The lifecycle never reaches Pi here: nothing is flushed to the host before
  // the assertions. A full ExtensionAPI stand-in would be hundreds of members,
  // so this object is cast, as the follow-up queue's own tests do.
  const pi = {
    sendUserMessage() {
      throw new Error('nothing may be sent to the host in these tests')
    },
  } as unknown as RuntimeContext['pi']
  const ctx = createRuntimeContext(pi)
  // The runtime's wiring (`team-runtime/index.ts`): the lifetime reads the
  // follow-up queue and the outer-turn claim, never a copy of them.
  const lifetime = new HostRunLifetime({
    work: {
      pendingEntryCount: () => ctx.pendingFollowUps.length,
      turnInFlight: () => ctx.outerTurnOwner !== null,
    },
    clock: { setTimeout: () => ({ cancel: () => undefined }) },
    keepAlive: () => ({ release: () => undefined }),
    startDeadlineMs: 60_000,
  })
  ctx.hostRunLifetime = lifetime
  const levels = options.levels
  const currentLevel = (): LevelConfig | undefined => levels[ctx.state.currentLevelIndex]
  const runFailures: string[] = []
  // Only `model` is read, by `startHostTurn`; the rest of the context is never
  // touched on these paths, so the stand-in is cast.
  const extCtx = {
    model: { provider: 'lm-studio', id: 'fixture/host' },
  } as unknown as ExtensionContext
  const ports: HostTurnLifecyclePorts = {
    claim: {
      current: () => ctx.outerTurnOwner,
      claim: (owner) => {
        ctx.outerTurnOwner = owner
      },
      release: () => {
        ctx.outerTurnOwner = null
      },
    },
    coordinatorRun: {
      read: () => ({
        runId: ctx.coordinatorRunId,
        levelAdvancedRunId: ctx.levelAdvancedCoordinatorRunId,
      }),
      raiseRunId: () => {
        ctx.coordinatorRunId++
      },
      clearUsedLevelTools: () => undefined,
      clearInvocationAdmissions: () => undefined,
      clearFollowUpMarker: () => undefined,
      resetToolCallCount: () => {
        ctx.coordinatorToolCallsThisRun = 0
      },
      clearLevelAdvanceFence: () => {
        ctx.levelAdvancedCoordinatorRunId = null
      },
    },
    position: {
      startingPosition: () => {
        const level = currentLevel()
        return {
          level,
          coordinator: level
            ? { name: level.stage.coordinator ?? 'none', provider: 'lm-studio', model: 'fixture/host' }
            : undefined,
          admitted: undefined,
          desiredHostModelSelection: undefined,
          levelIndex: ctx.state.currentLevelIndex,
        }
      },
      levelIndex: () => ctx.state.currentLevelIndex,
      currentLevel,
      currentCoordinatorName: () => currentLevel()?.stage.coordinator ?? null,
      toolCallsThisRun: () => ctx.coordinatorToolCallsThisRun,
    },
    records: {
      runRecordIdentity: () => null,
      writeAgentRun: () => undefined,
      hostLifecycleEvent: () => undefined,
      assignmentOutputDir: () => '/assignment',
    },
    metrics: { markActive: () => undefined, markDoneWhenActive: () => undefined },
    hostRun: {
      turnStarted: () => {
        ctx.hostRunLifetime?.turnStarted()
      },
      turnSettled: () => {
        ctx.hostRunLifetime?.turnSettled()
      },
      runFailed: () => {
        ctx.hostRunLifetime?.runFailed()
      },
    },
    followUps: {
      anyOwed: () => ctx.pendingFollowUps.length > 0,
      flush: () => {
        flushPendingFollowUps(ctx)
      },
    },
    completion: {
      emitWhenIdle: () => undefined,
      requestRunFailure: (failure) => {
        runFailures.push(failure.error)
      },
    },
    settlement: {
      settleHostEntry: (levelId) => {
        settleHostEntry(ctx, levelId)
      },
      enterActiveLevelOnItsOwnPair: options.enterDestination ?? (() => Promise.resolve(true)),
      activatePendingStageEntry: () => undefined,
      discardPendingStageEntries: (reason) => {
        discardPendingStageEntries(ctx, reason)
      },
      clearPendingStageEntry: () => {
        ctx.pendingStageEntryLevelId = null
      },
    },
    blockedReport: {
      configErrorRecorded: () => ctx.configErrors.length > 0,
      record: (message) => {
        ctx.configErrors = [message]
      },
      show: () => undefined,
    },
    dashboard: {
      rememberExtensionContext: () => undefined,
      manageRefreshTimer: () => undefined,
      refresh: () => undefined,
    },
    clock: { now: () => 1_000, timestamp: () => '2026-09-28T00:00:00.000Z' },
  }
  return { ctx, lifetime, extCtx, ports, runFailures }
}

test('TR-13: a coordinator turn that starts for an entry handed to the host keeps the host open; its start is not read as a host with nothing to do', () => {
  const { ctx, lifetime, extCtx, ports } = harness({ levels: [ENTRY_LEVEL] })
  // The opening entry was handed to the host and owes a turn. Nothing else is
  // queued, and no turn owns the host yet.
  lifetime.entryDelivered()
  assert.equal(ctx.outerTurnOwner, null)
  assert.equal(ctx.pendingFollowUps.length, 0)

  startHostTurn(extCtx, ports)

  assert.notEqual(ctx.outerTurnOwner, null, 'the turn owns the host')
  assert.equal(
    lifetime.stopped(),
    null,
    'the host must stay open while the turn it started runs; a stop here would end the print-mode run at the start of its first turn',
  )

  // The same turn settling with nothing owed is what ends it.
  return settleHostTurn(extCtx, ports).then(() => {
    assert.deepEqual(lifetime.stopped(), { reason: 'no_work_remains' })
  })
})

test('TR-11: a settle whose completion cannot be written still releases the host, so the next turn is not refused as one already in flight', async () => {
  const { ctx, extCtx, ports } = harness({ levels: [ENTRY_LEVEL] })
  const failingPorts: HostTurnLifecyclePorts = {
    ...ports,
    completion: {
      ...ports.completion,
      emitWhenIdle: () => {
        throw new Error('the completion record could not be written')
      },
    },
  }
  startHostTurn(extCtx, failingPorts)
  assert.notEqual(ctx.outerTurnOwner, null, 'precondition: the turn owns the host')

  await assert.rejects(settleHostTurn(extCtx, failingPorts), /could not be written/)

  assert.equal(ctx.outerTurnOwner, null, 'the claim is released before the completion is written')
  // A later turn opens as a new outer turn rather than joining a claim that
  // outlived its turn.
  const runBefore = ctx.coordinatorRunId
  startHostTurn(extCtx, ports)
  assert.equal(ctx.coordinatorRunId, runBefore + 1, 'the next turn opens a new coordinator run')
})

test('TR-12: a settle that cannot put the host on the destination\'s pair ends the run as failed, never as a run that finished', async () => {
  const { ctx, lifetime, extCtx, ports, runFailures } = harness({
    levels: [ENTRY_LEVEL, DESTINATION_LEVEL],
    enterDestination: () => Promise.resolve(false),
  })
  // The entry level's turn owns the host; during it the run advanced to the
  // destination, whose entry was queued behind the held claim.
  ctx.outerTurnOwner = outerTurnOwnerSnapshot({
    position: {
      level: ENTRY_LEVEL,
      coordinator: { name: 'intake-agent', provider: 'lm-studio', model: 'fixture/host' },
      admitted: undefined,
      desiredHostModelSelection: undefined,
      levelIndex: 0,
    },
    hostProvider: 'lm-studio',
    hostModel: 'fixture/host',
    coordinatorRunId: 1,
    startedAt: 0,
  })
  ctx.state.currentLevelIndex = 1
  enqueueFollowUp(ctx, 'Enter the review level.', {
    kind: 'stage_entry',
    levelId: DESTINATION_LEVEL.id,
    stageType: DESTINATION_LEVEL.stage.type,
    delayMs: 0,
  })
  assert.equal(ctx.pendingFollowUps.length, 1, 'precondition: the destination\'s entry is queued')
  assert.equal(lifetime.stopped(), null)

  await settleHostTurn(extCtx, ports)

  assert.deepEqual(
    lifetime.stopped(),
    { reason: 'run_failed' },
    'the host stops because the run failed, not because the discarded entry left nothing to do',
  )
  assert.equal(ctx.outerTurnOwner, null, 'the claim is released')
  assert.equal(ctx.pendingFollowUps.length, 0, 'the destination\'s entry is discarded')
  assert.deepEqual(runFailures, [
    "Level 'review' could not be entered: host_pair_unavailable. Team execution is blocked.",
  ])
})
