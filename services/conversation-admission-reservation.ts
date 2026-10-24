/**
 * Admission as a reservation, not a survey.
 *
 * Counting unresolved turns by reading every activity fails twice over. It
 * makes the newest turn pay for the whole conversation — the same growth that
 * per-activity journals exist to avoid — and counting then claiming is two
 * steps, so two turns can both read one-under-the-cap and both proceed. A cap
 * that two callers can step over together is not a cap.
 *
 * So the open set is held in one small document beside the activities, and a
 * turn takes its slot in the same locked step that checks for one. Cost is one
 * bounded read and write per turn, whatever the conversation's history.
 *
 * That document is shared with the retention record on purpose. Giving a slot
 * back and writing down that the turn finished have to be one atomic step: two
 * steps mean a crash between them either loses the finished turn forever or
 * counts it twice on retry, and the count cap then deletes history that was
 * never over the limit. One document, one rename, one lock.
 *
 * The document is a cache of facts the journals own, never an authority over
 * them. It is reconciled against the activities it names, so a crash that
 * leaves a stale entry costs a slot until the next reconciliation rather than
 * corrupting anything.
 */
import * as fs from 'node:fs/promises'

import { withFileLock } from '../domains/sessions/session-file-locks.js'
import {
  CONVERSATION_TURN_STREAM_KIND,
  reduceConversationTurnStream,
} from '../domains/conversations/conversation-turn-journal.js'
import {
  CONVERSATION_MAX_PROJECTED_IDS,
  CONVERSATION_MAX_UNRESOLVED_ACTIVITIES,
} from '../domains/conversations/conversation-turn-retention-policy.js'
import {
  conversationRetentionLockPath,
  conversationRetentionRoot,
  ensureConversationRetentionRoot,
  isTerminalRecorded,
  projectTerminalUnderLock,
  readRetentionDocument,
  writeRetentionDocument,
  type ConversationRetentionDocument,
} from './conversation-terminal-ledger.js'
import {
  ACTIVITY_SHAPED_NAME,
  isConversationActivityId,
  type ConversationOwner,
} from '../core/conversation-activity-location.js'
import type { WorkspaceConversationJournalRegistry } from './workspace-conversation-journal-registry.js'

export type ConversationReservation =
  | { readonly kind: 'reserved'; readonly unresolvedCount: number }
  | { readonly kind: 'refused'; readonly unresolvedCount: number }
  /** The document could not be read or written. Authority fails closed. */
  | { readonly kind: 'indeterminate'; readonly reason: string }

/**
 * Take a slot for this turn, or refuse.
 *
 * Idempotent for one turn id: a retry of the same turn holds the slot it
 * already has rather than consuming a second one.
 */
export async function reserveConversationActivity(input: {
  readonly workspacePath: string
  readonly owner: ConversationOwner
  readonly turnId: string
  readonly maxUnresolved?: number
}): Promise<ConversationReservation> {
  const cap = input.maxUnresolved ?? CONVERSATION_MAX_UNRESOLVED_ACTIVITIES
  const root = conversationRetentionRoot(input)
  if (!root) {
    return { kind: 'indeterminate', reason: 'the conversation has no valid root' }
  }
  if (!isConversationActivityId(input.turnId)) {
    return { kind: 'indeterminate', reason: 'the turn id is not a usable slot key' }
  }

  try {
    // The reservation runs before the registry opens anything, so it is the
    // first writer under this conversation and therefore the first thing a
    // redirected path could capture. Same primitive, same rule.
    await ensureConversationRetentionRoot(input)
    return await withFileLock(conversationRetentionLockPath(root), async () => {
      const stored = await readRetentionDocument(root)
      if (stored === 'damaged') {
        return {
          kind: 'indeterminate',
          reason: 'the admission document could not be read',
        }
      }
      if (stored.retained.length === 0 && stored.openTurnIds.size === 0) {
        // No authority yet. That is only legitimate before the conversation has
        // any activity: one that already holds activities and has lost its
        // document cannot have its unresolved count established, and rebuilding
        // it by reading every journal is the unbounded cost this exists to
        // avoid. Fail closed and say so.
        if (await hasAnyActivity(root)) {
          return {
            kind: 'indeterminate',
            reason:
              'the conversation holds activities but no admission document, so ' +
              'its unresolved count cannot be established',
          }
        }
      }

      if (stored.openTurnIds.has(input.turnId)) {
        return { kind: 'reserved', unresolvedCount: stored.openTurnIds.size }
      }
      if (stored.openTurnIds.size >= cap) {
        return { kind: 'refused', unresolvedCount: stored.openTurnIds.size }
      }
      // Judged on everything the record has to hold: the turns it is keeping
      // plus the ones still open, because every open turn is an ending this
      // record has already promised to make room for.
      if (
        stored.retained.length + stored.openTurnIds.size + 1 >
        CONVERSATION_MAX_PROJECTED_IDS
      ) {
        return { kind: 'refused', unresolvedCount: stored.openTurnIds.size }
      }
      const openTurnIds = new Set(stored.openTurnIds)
      openTurnIds.add(input.turnId)
      await writeRetentionDocument(root, { ...stored, openTurnIds })
      return { kind: 'reserved', unresolvedCount: openTurnIds.size }
    })
  } catch {
    // Fixed, and deliberately not the fault's own words. What went wrong here
    // is an errno message naming an absolute path, or a cause carrying whatever
    // a caller put in it — and this value is returned to a caller and written
    // to a log. Which turn and which stage is the whole of what anyone needs.
    return { kind: 'indeterminate', reason: 'the admission record could not be written' }
  }
}

/**
 * Give the slot back, writing down that the turn finished in the same step.
 *
 * The projection happens first and the slot is only surrendered once it is
 * durable, so a projection that cannot be written leaves the reservation in
 * place as a retry anchor rather than losing the finished turn silently.
 *
 * `terminalAtMs` is when the turn actually reached its terminal, taken from the
 * journal rather than from now: a turn recovered days later must not have its
 * retention clock restarted at the moment somebody noticed it.
 */
export async function releaseConversationActivity(input: {
  readonly workspacePath: string
  readonly owner: ConversationOwner
  readonly turnId: string
  /** Absent when the turn never reached a terminal — nothing to project. */
  readonly terminalAtMs?: number
}): Promise<void> {
  const root = conversationRetentionRoot(input)
  if (!root) return
  try {
    await withFileLock(conversationRetentionLockPath(root), async () => {
      const stored = await readRetentionDocument(root)
      if (stored === 'damaged') return
      if (!stored.openTurnIds.has(input.turnId)) {
        // Already released. Recording again here is exactly the double count
        // this ordering exists to prevent.
        return
      }

      // Recording the ending and giving the slot back are one write. A crash
      // before it leaves the slot for reconciliation to find; a crash after it
      // has already done both. There is no in-between to reconcile.
      let next: ConversationRetentionDocument = stored
      if (
        input.terminalAtMs !== undefined &&
        !isTerminalRecorded(stored, input.turnId)
      ) {
        // Throws rather than degrades: the slot below is only given back once
        // the ending is recorded alongside it.
        next = projectTerminalUnderLock({
          document: stored,
          entry: { activityId: input.turnId, atMs: input.terminalAtMs },
        })
      }
      const openTurnIds = new Set(next.openTurnIds)
      openTurnIds.delete(input.turnId)
      await writeRetentionDocument(root, { ...next, openTurnIds })
    })
  } catch {
    // The slot is kept. Losing it costs one reconciliation pass; releasing it
    // over a projection that never landed would cost the record itself.
  }
}

/** What one reserved turn's journal actually says. */
export type ReservedActivityVerdict =
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'terminal'; readonly atMs: number }
  /** A journal that exists and holds nothing: claimed, never begun. */
  | { readonly kind: 'empty'; readonly createdAtMs: number }
  /** No activity at all. The reservation is stale. */
  | { readonly kind: 'missing' }
  /** Not proof of anything, so the slot is kept. */
  | { readonly kind: 'unreadable' }

export interface ConversationReconciliation {
  /** Slots given back. */
  readonly released: readonly string[]
  /** Terminals written into the retention record by this pass. */
  readonly projected: readonly string[]
}

/**
 * Re-check reserved turns against their journals and settle what has finished.
 *
 * Two crashes are healed here. A turn that died before opening its activity
 * holds a slot for a journal that never existed; and a turn that appended its
 * terminal and died before the release left a finished turn the retention
 * record has never heard of. The journals are the authority in both cases and
 * neither is rewritten — only the projection catches up.
 *
 * Bounded and rotating: a few reserved ids are checked per turn, so the cost is
 * fixed and every id is eventually revisited.
 */
export async function reconcileConversationReservations(input: {
  readonly workspacePath: string
  readonly owner: ConversationOwner
  readonly registry: WorkspaceConversationJournalRegistry
  /** How many reserved ids to re-check now. Rotates across calls. */
  readonly limit?: number
}): Promise<ConversationReconciliation> {
  const root = conversationRetentionRoot(input)
  if (!root) return { released: [], projected: [] }
  let stored: ConversationRetentionDocument | 'damaged'
  try {
    stored = await readRetentionDocument(root)
  } catch {
    return { released: [], projected: [] }
  }
  if (stored === 'damaged') return { released: [], projected: [] }
  const current = [...stored.openTurnIds].sort()
  if (current.length === 0) return { released: [], projected: [] }

  // Rotating rather than always starting at the head: a reserved id that sorts
  // late would otherwise never be re-checked, and a slot leaked by a crash
  // would be leaked permanently. The cursor is durable so it survives restarts.
  const limit = Math.max(1, input.limit ?? current.length)
  const start = stored.reconcileCursor % current.length
  const examined: string[] = []
  for (let offset = 0; offset < Math.min(limit, current.length); offset += 1) {
    examined.push(current[(start + offset) % current.length] as string)
  }

  const released: string[] = []
  const projected: string[] = []
  for (const turnId of examined) {
    const verdict = await inspectReservedActivity({
      registry: input.registry,
      owner: input.owner,
      turnId,
    })
    if (verdict.kind === 'unresolved' || verdict.kind === 'unreadable') continue
    // An empty journal belongs to a turn that may simply not have written its
    // first event yet. Reclaiming it is retention's decision, made on the
    // manifest's age, not this one.
    if (verdict.kind === 'empty') continue
    await releaseConversationActivity({
      workspacePath: input.workspacePath,
      owner: input.owner,
      turnId,
      ...(verdict.kind === 'terminal' ? { terminalAtMs: verdict.atMs } : {}),
    })
    // Read back rather than assumed: the release is the only thing that knows
    // whether the slot really went, and whether the terminal was already there.
    const after = await readRetentionDocument(root).catch(() => 'damaged' as const)
    if (after === 'damaged' || after.openTurnIds.has(turnId)) continue
    released.push(turnId)
    if (verdict.kind === 'terminal' && !isTerminalRecorded(stored, turnId)) {
      projected.push(turnId)
    }
  }

  await advanceReconcileCursor(root, (start + examined.length) % current.length)
  return { released, projected }
}

/**
 * What a reserved turn's journal says, without provisioning anything.
 *
 * Every answer other than "unresolved" is a fact about durable state, and the
 * two that are not proof — unreadable, and a journal that cannot be scanned —
 * keep the slot. Giving a slot away on a failed read makes the cap fail open
 * exactly when something is already wrong.
 */
export async function inspectReservedActivity(input: {
  readonly registry: WorkspaceConversationJournalRegistry
  readonly owner: ConversationOwner
  readonly turnId: string
}): Promise<ReservedActivityVerdict> {
  // A snapshot, not a lease. Opening the activity the way a writer does would
  // create a missing journal and truncate a torn tail — so deciding whether a
  // slot may go back would repair the damage that decision is about.
  let snapshot
  try {
    snapshot = await input.registry.snapshot({
      owner: input.owner,
      activityId: input.turnId,
      activityKind: 'turn',
    })
  } catch {
    return { kind: 'unreadable' }
  }
  if (snapshot.kind === 'absent') return { kind: 'missing' }
  if (snapshot.kind === 'unreadable') return { kind: 'unreadable' }

  // The whole journal decides whether this is empty. Looking at one stream and
  // calling the absence of it "empty" means an activity holding something else
  // entirely reads as holding nothing — and empty is the answer that makes it
  // reclaimable.
  if (snapshot.events.length === 0) {
    const createdAtMs = Date.parse(snapshot.manifest.createdAt)
    if (!Number.isFinite(createdAtMs)) return { kind: 'unreadable' }
    return { kind: 'empty', createdAtMs }
  }

  // Every event, not just the ones this build recognises. An activity holding
  // anything outside this turn's stream is not one whose fate this can decide:
  // reporting it as finished returns the slot and lets retention delete the
  // activity, taking the unaccounted-for events with it.
  const foreign = snapshot.events.some(
    (event) =>
      event.streamKind !== CONVERSATION_TURN_STREAM_KIND ||
      event.streamId !== input.turnId,
  )
  if (foreign) return { kind: 'unreadable' }

  const summary = reduceConversationTurnStream(
    input.turnId,
    snapshot.events.map((event) => ({ type: event.type, payload: event.payload })),
  )
  if (summary.state === 'started' || summary.state === 'prepared') {
    return { kind: 'unresolved' }
  }
  // Named rather than assumed. `terminal` used to be whatever was left over, so
  // a stream that reduced to `invalid` — one that cannot have happened — was
  // reported as a turn that finished, its slot returned and its contents
  // eventually deleted. That journal is the only evidence anything went wrong.
  if (
    summary.state !== 'completed' &&
    summary.state !== 'failed' &&
    summary.state !== 'cancelled'
  ) {
    return { kind: 'unreadable' }
  }
  // The terminal's own recording time, so a turn recovered days later keeps the
  // age it actually has rather than being handed a fresh one.
  const last = snapshot.events[snapshot.events.length - 1]
  const atMs = last === undefined ? Number.NaN : Date.parse(last.recordedAt)
  if (!Number.isFinite(atMs)) return { kind: 'unreadable' }
  return { kind: 'terminal', atMs }
}

async function advanceReconcileCursor(
  root: string,
  cursor: number,
): Promise<void> {
  try {
    await withFileLock(conversationRetentionLockPath(root), async () => {
      const stored = await readRetentionDocument(root)
      if (stored === 'damaged') return
      await writeRetentionDocument(root, { ...stored, reconcileCursor: cursor })
    })
  } catch {
    // Losing a cursor costs one repeated pass over the same reserved ids.
  }
}

/**
 * Whether any activity exists yet.
 *
 * Streamed and stopped at the first hit rather than listed: the answer is a
 * boolean, and materialising every name in a directory a caller can grow is the
 * unbounded work this whole design refuses.
 */
async function hasAnyActivity(root: string): Promise<boolean> {
  let dir
  try {
    dir = await fs.opendir(root)
  } catch (error) {
    // Only "it is not there" is an empty conversation. Anything else is a
    // question that could not be answered, and answering it as "no activities"
    // hands a conversation with a lost admission document a fresh, empty count
    // — which is the fail-open this check exists to prevent. Thrown, so the
    // caller reports it as indeterminate rather than admitting work.
    if (errorCodeOf(error) === 'ENOENT') return false
    throw error
  }
  for await (const entry of dir) {
    if (entry.name.startsWith('.')) continue
    // Named like an activity, because that is what an activity is called. A
    // `notes` folder beside them is not history this conversation lost the
    // count of, and reading it as history refuses every turn in a conversation
    // that never had one.
    if (entry.isDirectory()) {
      if (isConversationActivityId(entry.name)) return true
      continue
    }
    // A name shaped like an activity, holding something that is not one. That
    // is evidence of a conversation with history, not of an empty one — and
    // reading it as empty hands a conversation with a lost document a fresh
    // count and admits work without limit.
    if (ACTIVITY_SHAPED_NAME.test(entry.name)) return true
  }
  return false
}

/** An errno, without asserting a shape onto an unknown error. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
