import { randomUUID } from "node:crypto";
import { whenDefined } from "../../core/optional-properties.js";

import { AGENT_STATE } from '../../core/constants.js'
import {
  discardHostEntry,
  hostAdmissionCrashRequested,
  markHostEntryDispatching,
  revertHostEntryToPending,
  HOST_ADMISSION_DISPATCH_CRASH_POINT,
  HOST_NOTICE_DISPATCH_CRASH_POINT,
} from './host-admission.js'
import { logRuntimeEvent } from './logger.js'
import { getAssignmentPath } from './runtime-paths.js'
import type { RuntimeContext } from './runtime-context.js'

type FollowUpKind = 'stage_entry' | 'runtime_notice'

/**
 * How many times one entry may fail to leave before the run gives up on it.
 *
 * A dispatch fails for two very different reasons. Pi refusing a concurrent
 * prompt clears within a turn and is worth waiting out. A write that cannot
 * record the admission does not clear: the same broken disk fails the retry,
 * and retrying for ever leaves an entry pending — which is precisely the state
 * that stops the host lifetime ever concluding it has nothing left to do,
 * because nothing was handed over so no start deadline was armed.
 *
 * High enough that an ordinary contended moment is ridden out, low enough that
 * a run which cannot proceed ends instead of waiting on a watchdog.
 */
const MAX_DISPATCH_ATTEMPTS = 8

type EnqueueFollowUpOptions = {
  kind?: FollowUpKind
  levelId?: string
  stageType?: string
  delayMs?: number
}

/**
 * Whether the host is inside a turn, so nothing may be sent to it yet.
 *
 * A claimed outer turn is decisive on its own: it is held from the first
 * `agent_start` until `agent_settled`, which covers the window between a turn's
 * end and its settle — the window in which Pi may still retry, compact, or run
 * a queued continuation, and in which the level may already have advanced. The
 * agent-metrics check stays as a second condition because runtime-driven work
 * marks agents active without any host turn being claimed.
 */
function isOuterTurnInFlight(ctx: RuntimeContext): boolean {
  if (ctx.outerTurnOwner) return true
  for (const metrics of ctx.agentMetrics.values()) {
    if (metrics.state === AGENT_STATE.ACTIVE) return true
  }
  return false
}

/**
 * Write one diagnostic record, and never let writing it change what happened.
 *
 * `appendJsonl` opens and writes with no guard of its own
 * (`domains/runtime/logger.ts:67-71`), so a full disk, a read-only mount or a
 * path that is not a file throws straight back here. That must not reach the
 * caller: the queue's callers are Pi event handlers, and one of them has
 * already handed an entry to the host by the time it logs. An account of what
 * happened is not allowed to decide what happened.
 *
 * The failure is reported on this process's own stderr, which is the one
 * channel that does not depend on the writer that just failed.
 */
function logFollowUpEvent(
  ctx: RuntimeContext,
  event: string,
  payload: Record<string, unknown>,
): void {
  if (!ctx.teamConfig || !ctx.state.sessionId) return
  try {
    logRuntimeEvent(getAssignmentPath(ctx), {
      timestamp: new Date().toISOString(),
      event,
      session_id: ctx.state.sessionId,
      root_session_id: ctx.state.rootSessionId,
      active_level_id: ctx.teamConfig.levels[ctx.state.currentLevelIndex]?.id ?? null,
      ...payload,
    })
  } catch (error) {
    console.error(
      `[team-runtime] Failed to record '${event}':`,
      error instanceof Error ? error.message : String(error),
    )
  }
}

function schedulePendingFollowUps(ctx: RuntimeContext, delayMs = 0): void {
  if (ctx.pendingFollowUpTimer) return
  ctx.pendingFollowUpTimer = setTimeout(() => {
    ctx.pendingFollowUpTimer = null
    flushPendingFollowUps(ctx)
  }, delayMs)
  ctx.pendingFollowUpTimer.unref?.()
}

export function enqueueFollowUp(
  ctx: RuntimeContext,
  message: string,
  options: EnqueueFollowUpOptions = {},
): void {
  if (!message.trim()) return

  const kind = options.kind ?? 'runtime_notice'
  const delayMs = options.delayMs ?? (kind === 'stage_entry' ? 25 : 0)
  const entry = {
    id: randomUUID(),
    message,
    kind,
    ...whenDefined(options.levelId, (levelId) => ({ levelId })),
    ...whenDefined(options.stageType, (stageType) => ({ stageType })),
    notBefore: Date.now() + delayMs,
    attempts: 0,
    createdAt: new Date().toISOString(),
  }

  ctx.pendingFollowUps.push(entry)
  logFollowUpEvent(ctx, 'runtime.follow_up_enqueued', {
    follow_up_id: entry.id,
    follow_up_kind: entry.kind,
    target_level_id: entry.levelId ?? null,
    target_stage_type: entry.stageType ?? null,
    delay_ms: delayMs,
  })

  if (isOuterTurnInFlight(ctx) || delayMs > 0) {
    schedulePendingFollowUps(ctx, delayMs)
    return
  }

  flushPendingFollowUps(ctx)
}

/**
 * Drop stage entries queued for a level the run is no longer going to.
 *
 * A reset sends the run back to its entry level, which invalidates every stage
 * entry already written for the level it was leaving. Those entries are queued
 * behind a timer and would otherwise be delivered later, opening a level the
 * run has just left.
 *
 * The timer goes with them. Emptying the array alone leaves a wake-up armed for
 * work that no longer exists, and `schedulePendingFollowUps` keeps one timer at
 * a time (`:53`), so that stale one would silently stand in for the next real
 * schedule. Anything still queued is re-scheduled here, after the clear, so a
 * runtime notice waiting beside a discarded entry is not stranded.
 *
 * Only stage entries are discarded. A runtime notice is not about a level and
 * says something the user still needs.
 */
export function discardPendingStageEntries(
  ctx: RuntimeContext,
  reason: string,
): void {
  // The admission goes first, and before the early return below, because the
  // reason for dropping the entries is exactly the reason for dropping the
  // record of them. A reset that happened to have nothing queued at that
  // instant would otherwise leave an admission behind — and after a reset it
  // would still match by identity, because `team-reset` clears a level's status
  // without starting a new visit. The next start would then re-open a level the
  // run deliberately left.
  discardHostEntry(ctx)

  const discarded = ctx.pendingFollowUps.filter(
    (entry) => entry.kind === 'stage_entry',
  )
  if (discarded.length === 0) return

  if (ctx.pendingFollowUpTimer) {
    clearTimeout(ctx.pendingFollowUpTimer)
    ctx.pendingFollowUpTimer = null
  }
  ctx.pendingFollowUps = ctx.pendingFollowUps.filter(
    (entry) => entry.kind !== 'stage_entry',
  )

  for (const entry of discarded) {
    logFollowUpEvent(ctx, 'runtime.follow_up_discarded', {
      follow_up_id: entry.id,
      follow_up_kind: entry.kind,
      target_level_id: entry.levelId ?? null,
      target_stage_type: entry.stageType ?? null,
      reason,
    })
  }

  if (ctx.pendingFollowUps.length > 0) {
    const nextReadyAt = Math.min(
      ...ctx.pendingFollowUps.map((entry) => entry.notBefore),
    )
    schedulePendingFollowUps(ctx, Math.max(0, nextReadyAt - Date.now()))
    return
  }

  // Discarding the last queued entry can be the moment nothing is owed any
  // more. A host still holding its prompt open for work that no longer exists
  // would never end.
  ctx.hostRunLifetime?.reconsider()
}

export function flushPendingFollowUps(ctx: RuntimeContext): void {
  if (ctx.pendingFollowUps.length === 0) return

  // No kind is exempt. A stage entry used to be sent through a live turn on the
  // theory that it only primes the next one, but the host has a single input
  // loop: delivering it mid-turn hands the next level's opening prompt to the
  // coordinator still finishing the previous level, on that coordinator's pair.
  // Waiting costs one settle; not waiting misattributes a whole turn.
  const turnInFlight = isOuterTurnInFlight(ctx)
  const readyNow = ctx.pendingFollowUps.filter((entry) => entry.notBefore <= Date.now())

  if (readyNow.length > 0 && turnInFlight) {
    logFollowUpEvent(ctx, 'runtime.follow_up_dispatch_deferred', {
      reason: ctx.outerTurnOwner ? 'outer_turn_in_flight' : 'agent_active',
      pending_count: ctx.pendingFollowUps.length,
    })
    // A claimed turn announces its own end: `agent_settled` flushes. Re-asking
    // every 25ms until then would only burn wake-ups to learn what the event
    // already reports. Runtime-driven agent activity has no such event, so
    // that case keeps its poll.
    if (!ctx.outerTurnOwner) schedulePendingFollowUps(ctx, 25)
    return
  }

  const now = Date.now()
  const ready = ctx.pendingFollowUps.filter((entry) => entry.notBefore <= now)
  if (ready.length === 0) {
    const nextReadyAt = Math.min(...ctx.pendingFollowUps.map((entry) => entry.notBefore))
    schedulePendingFollowUps(ctx, Math.max(0, nextReadyAt - now))
    return
  }

  // One entry, not the batch that is due.
  //
  // `pi.sendUserMessage` is void and starts the turn asynchronously, and Pi
  // reads `isStreaming` once (`agent-session.js:831`) before awaiting its
  // `before_agent_start` handlers (`:885`) and only then starting the run
  // (`:919`). Two sends issued from one synchronous loop therefore both pass
  // that check, and the second is refused by `agent.prompt`
  // (`pi-agent-core/dist/agent.js:226-228`) — losing an entry this queue had
  // already removed, and making Pi emit `agent_settled` for a turn the winner
  // is still running. Whether the host accepted a send is not knowable from
  // here, so only one may be outstanding.
  const entry = ready[0]
  if (!entry) return
  ctx.pendingFollowUps = ctx.pendingFollowUps.filter((queued) => queued.id !== entry.id)

  // ── Before the send ────────────────────────────────────────────────────────
  //
  // Everything in here can still be taken back, because nothing has been handed
  // over yet. The record is written first: `sendUserMessage` returns `void` and
  // its refusal arrives asynchronously on Pi's own error channel, so once the
  // call has been made there is nothing further this process can learn, and a
  // record written afterwards would be missing for exactly the crash it exists
  // to survive. The persist is inside the try for the same reason the send is —
  // it writes to disk, the entry has already left the queue, and a throw
  // escaping here would take an admitted entry with it.
  try {
    markHostEntryDispatching(ctx, entry.levelId)
    ctx.pi.sendUserMessage(entry.message, { deliverAs: 'followUp' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const retryable = /already processing a prompt/i.test(message)
    const retryDelayMs = retryable ? Math.min(250, 25 * (entry.attempts + 1)) : 250
    const attempts = entry.attempts + 1

    if (attempts >= MAX_DISPATCH_ATTEMPTS) {
      // Given up, and said so. Leaving it queued would be the worst of both:
      // the entry never leaves, and the pending entry it leaves behind is
      // exactly what stops the host ever deciding it is finished. Nothing was
      // handed over, so nothing may have run — the run ends without this work
      // rather than waiting on it.
      logFollowUpEvent(ctx, 'runtime.follow_up_abandoned', {
        follow_up_id: entry.id,
        follow_up_kind: entry.kind,
        target_level_id: entry.levelId ?? null,
        target_stage_type: entry.stageType ?? null,
        attempts,
        reason: retryable ? 'host_busy' : 'send_failed',
        error: message,
      })
      ctx.hostRunLifetime?.dispatchAbandoned(
        retryable ? 'host_never_accepted' : 'admission_unrecordable',
      )
      return
    }

    // Back at the head, because it was removed before the send and the send is
    // what failed.
    ctx.pendingFollowUps = [
      { ...entry, attempts, notBefore: Date.now() + retryDelayMs },
      ...ctx.pendingFollowUps,
    ]
    // And the admission goes back with it. This is the one failure this process
    // can actually see: the send threw here, so nothing was handed over, and
    // leaving the record saying otherwise would make a later recovery refuse an
    // entry that demonstrably never left.
    //
    // Guarded, because the likely reason the send region failed at all is that
    // this write failed — and a disk that is gone is gone for the retry too.
    // The in-memory revert happens before the persist, so the queue and the
    // record still agree; what must not happen is the second failure escaping
    // into a Pi event handler, which would leave the runtime holding a claim
    // nothing releases and skip the reschedule below.
    try {
      revertHostEntryToPending(ctx, entry.levelId)
    } catch (revertError) {
      console.error(
        '[team-runtime] Failed to record a deferred dispatch:',
        revertError instanceof Error ? revertError.message : String(revertError),
      )
    }
    logFollowUpEvent(ctx, 'runtime.follow_up_dispatch_deferred', {
      follow_up_id: entry.id,
      follow_up_kind: entry.kind,
      target_level_id: entry.levelId ?? null,
      target_stage_type: entry.stageType ?? null,
      attempts,
      reason: retryable ? 'host_busy' : 'send_failed',
      error: message,
    })
    schedulePendingFollowUps(ctx, retryDelayMs)
    return
  }

  // ── After the send ─────────────────────────────────────────────────────────
  //
  // The host has the entry. It may already be running that turn — the call is
  // `void` and starts the turn asynchronously — so nothing below may put the
  // entry back on the queue or move its record back to `pending`. Whatever
  // fails here says something about this process's bookkeeping and nothing
  // about whether the entry left, and treating it as a failed send is how
  // executed work becomes work the run believes it still owes.
  //
  // Nothing below throws: `entryDelivered` is in-memory, and `logFollowUpEvent`
  // reports its own failures rather than raising them.
  //
  // Handed over, not finished. From here until `agent_start` the queue may be
  // empty and no turn in flight — and the host must not read that as having
  // nothing left to do.
  ctx.hostRunLifetime?.entryDelivered()
  logFollowUpEvent(ctx, 'runtime.follow_up_dispatched', {
    follow_up_id: entry.id,
    follow_up_kind: entry.kind,
    target_level_id: entry.levelId ?? null,
    target_stage_type: entry.stageType ?? null,
    attempts: entry.attempts + 1,
  })
  // Test-only, and after the log rather than before it, so the cut leaves the
  // run's own account of itself agreeing with its checkpoint. The state that
  // matters for recovery is already on disk either way: the admission says
  // `dispatching`, the host has the entry, and nothing that follows can
  // establish what it did with it.
  if (
    hostAdmissionCrashRequested(
      ctx.faultInjection,
      entry.kind === 'stage_entry'
        ? HOST_ADMISSION_DISPATCH_CRASH_POINT
        : HOST_NOTICE_DISPATCH_CRASH_POINT,
      entry.levelId,
    )
  ) {
    process.kill(process.pid, 'SIGKILL')
  }

  // Deliberately no wake-up for whatever is still queued. A timer would fire in
  // the window between this send and its `agent_start`, when no turn is yet
  // claimed, and hand the host a second entry into exactly the race above. The
  // turn that was just started announces its own end, and `agent_settled`
  // flushes again; an entry whose turn never starts is ended by the host
  // lifetime's own deadline rather than by another send.
}
