/**
 * The transitions of the host's one admitted stage entry.
 *
 * The record itself and its reader live in
 * `contracts/host-entry-admission.ts`. This is where the runtime moves it, and
 * the whole point of collecting the moves here is that each one has a rule
 * about *when* it may be persisted, and those rules are the phase's contract:
 *
 *   - An admission is recorded in the same durable write as the destination it
 *     enters, so a checkpoint can never name a level with no record of the
 *     entry that was going to enter it. So {@link admitHostEntry} does not
 *     persist: its callers already persist immediately afterwards, and doing it
 *     here would split one write into two.
 *   - A dispatch is recorded *before* the send, because `sendUserMessage`
 *     returns `void` and its refusal is asynchronous — after the call there is
 *     nothing left to learn. So {@link markHostEntryDispatching} persists on
 *     its own.
 *
 * Every mutation is level-scoped. A settle that hands over runs while the slot
 * already holds the *destination's* new admission, written mid-turn by the
 * transition, so a blind write here would clobber the next level's entry with
 * the outgoing level's outcome.
 */

import type { ModelSelectionRecord } from '../../contracts/agent-model-selection.js'
import type { HostEntryAdmission } from '../../contracts/host-entry-admission.js'
import type { RuntimeContext } from './runtime-context.js'

/**
 * Record that a level is owed an opening entry, on this exact pair.
 *
 * Deliberately does not persist. The caller writes the destination and this
 * record together, which is what makes them inseparable on disk.
 */
export function admitHostEntry(
  ctx: RuntimeContext,
  input: {
    readonly levelId: string
    readonly visit: number
    readonly selection: ModelSelectionRecord
  },
): void {
  ctx.state.hostEntryAdmission = {
    levelId: input.levelId,
    visit: input.visit,
    state: 'pending',
    selection: input.selection,
  }
}

/**
 * Record that an entry has been handed to the host, before it is.
 *
 * From here the outcome is unprovable from inside this process, which is what
 * `dispatching` means and why recovery refuses to repeat it.
 *
 * A level takes more than one turn. Its opening entry settles, and then a
 * tool-failure notice or an unsatisfied completion gate hands the host another
 * entry for the same level — a turn that calls tools and a provider exactly
 * like the first. So a `settled` record goes back in flight rather than being
 * left alone: what this records is whether the level has an outstanding turn,
 * not whether it has ever had one. The identity and the pair are the level's
 * and do not change; only the state does.
 *
 * The level must still match. An entry that names no level at all belongs to no
 * level's turn, and moving some other level's record on its behalf would put a
 * barrier around work that is not running.
 */
export function markHostEntryDispatching(
  ctx: RuntimeContext,
  levelId: string | undefined,
): void {
  const admission = ctx.state.hostEntryAdmission
  if (!admission || admission.state === 'dispatching') return
  if (levelId === undefined || admission.levelId !== levelId) return
  ctx.state.hostEntryAdmission = { ...admission, state: 'dispatching' }
  ctx.persistRuntimeState?.()
}

/**
 * Put a dispatch back, because the send threw where this process could see it.
 *
 * The only failure a caller can observe synchronously. Leaving it
 * `dispatching` would make a recovery refuse an entry that demonstrably never
 * left, and the queue has already put the entry back at its head.
 */
export function revertHostEntryToPending(
  ctx: RuntimeContext,
  levelId: string | undefined,
): void {
  const admission = ctx.state.hostEntryAdmission
  if (!admission || admission.state !== 'dispatching') return
  if (levelId === undefined || admission.levelId !== levelId) return
  ctx.state.hostEntryAdmission = { ...admission, state: 'pending' }
  ctx.persistRuntimeState?.()
}

/**
 * The turn that entry started has ended.
 *
 * Only for the level whose turn settled. A handover settles while the slot
 * already holds the destination's pending admission, and that one is owed a
 * dispatch rather than a settlement.
 */
export function settleHostEntry(
  ctx: RuntimeContext,
  levelId: string | null,
): void {
  const admission = ctx.state.hostEntryAdmission
  if (!admission || admission.state !== 'dispatching') return
  if (levelId === null || admission.levelId !== levelId) return
  ctx.state.hostEntryAdmission = { ...admission, state: 'settled' }
  ctx.persistRuntimeState?.()
}

/**
 * Forget the admission entirely, with the queued entries it belonged to.
 *
 * A reset sends the run back to its entry level and a failed settle blocks it;
 * both discard the queued stage entries. An admission left behind would
 * outlive them and re-open, on the next start, a level the run deliberately
 * left — and after a reset it would match by identity, because `team-reset`
 * clears a level's status without starting a new visit.
 */
export function discardHostEntry(ctx: RuntimeContext): void {
  if (!ctx.state.hostEntryAdmission) return
  delete ctx.state.hostEntryAdmission
  ctx.persistRuntimeState?.()
}

/**
 * The admission that is owed a dispatch for this exact level and visit.
 *
 * Identity is the pair, not the level alone: a loopback re-enters a level on a
 * new visit, and an admission from the previous visit describes work the run
 * has already moved past.
 */
export function pendingHostEntryFor(
  ctx: RuntimeContext,
  levelId: string | undefined,
  visit: number,
): HostEntryAdmission | undefined {
  const admission = ctx.state.hostEntryAdmission
  if (!admission || admission.state !== 'pending') return undefined
  if (levelId === undefined || admission.levelId !== levelId) return undefined
  if (admission.visit !== visit) return undefined
  return admission
}

/**
 * The record of how this level was entered, whatever has happened to it since.
 *
 * The pair a level was entered on does not change when its entry's turn ends,
 * so this deliberately ignores the state. A level can take more than one turn —
 * a tool-failure notice, a runtime notice — and the second one runs on the pair
 * the first was switched to. Keying on `dispatching` alone would describe the
 * first turn from the record and the second from a fresh resolution, which
 * after a restart is a different pair: the run would speak to one model and
 * write the other into its own history.
 *
 * The slot holds one level's record at a time and is replaced when the run
 * moves on, so matching by level id is exactly "the record for the level this
 * turn is on".
 */
export function hostEntryForLevel(
  ctx: RuntimeContext,
  levelId: string | null | undefined,
): HostEntryAdmission | undefined {
  const admission = ctx.state.hostEntryAdmission
  if (!admission || !levelId || admission.levelId !== levelId) return undefined
  return admission
}

// ── Test-only cut points ─────────────────────────────────────────────────────

/**
 * Where a test may stop this process, named by the durable state it leaves.
 *
 * Recovery is decided from what reached the disk, so the useful cuts are the
 * two moments the admission changes what it says. Each is qualified by a level
 * id, because a run admits and dispatches an entry for every level it enters —
 * an unqualified point would always fire on the first one and could never
 * reach the handover these journeys are about.
 *
 * `TEAM_RUNTIME_FAULT_INJECT` is still read exactly once, at the extension
 * boundary, and handed here on the context.
 */
export const HOST_ADMISSION_PENDING_CRASH_POINT =
  'crash_after_host_admission_pending'
export const HOST_ADMISSION_DISPATCH_CRASH_POINT =
  'crash_after_host_admission_dispatch'
/**
 * The cut during a level's *second* turn.
 *
 * A level's opening entry and the notice that starts another turn on it are
 * both dispatches for the same level, so a point keyed on the level alone would
 * always fire on the first. This one fires only for a notice, which is what
 * starts a follow-up turn.
 */
export const HOST_NOTICE_DISPATCH_CRASH_POINT =
  'crash_after_host_notice_dispatch'
/**
 * A durable write that fails rather than a process that dies.
 *
 * The other points cut the process, which is the right shape for "what does a
 * restart find". This one is for the other failure a run has to survive: the
 * process is alive and its disk is not. One shot, at the settle of the named
 * level, because what has to be proved is that a run whose bookkeeping cannot
 * be saved still ends instead of holding its host open for ever.
 */
export const HOST_SETTLE_WRITE_FAILURE_POINT = 'fail_persist_on_settle'

export function hostAdmissionCrashRequested(
  faultInjection: string | undefined,
  point: string,
  levelId: string | undefined,
): boolean {
  if (!faultInjection || levelId === undefined) return false
  return faultInjection === `${point}:${levelId}`
}
