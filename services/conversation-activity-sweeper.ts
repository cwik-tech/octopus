/**
 * Makes the retention decision operational.
 *
 * The policy decides what may be forgotten; nothing acted on it, so the 30-day
 * and terminal-count limits bounded nothing. This is the caller that closes that
 * gap. It runs before a turn opens its activity, which is the one moment a
 * conversation is definitely being used and a little housekeeping is affordable.
 *
 * Three rules shape it, and each one is a defect that was fixed rather than a
 * preference:
 *
 * The work list comes from the retention record, not from the activity
 * directory. Listing the directory makes the newest turn pay for every turn
 * before it and pulls an unbounded number of entries from a directory a caller
 * can grow; and a window over that listing cannot enforce a per-conversation cap,
 * because the excess may sit entirely outside the window.
 *
 * The record is a hint, never a licence. Every candidate is re-checked against
 * its journal before anything is deleted, so a damaged or stale record cannot
 * become an instruction to delete live evidence.
 *
 * Deletion belongs to the registry. Reading an activity through a lease,
 * releasing it and then removing the directory leaves a window where anything
 * can acquire it and be handed a journal whose files are about to vanish.
 *
 * Sweeping is best-effort throughout: failing to delete an old activity must
 * never fail a live turn. It stops at the first thing it cannot forget rather
 * than skipping past it, so the order a conversation forgets in is preserved and
 * nothing is stranded behind a cursor that moved on without it.
 */
import {
  CONVERSATION_TERMINAL_RETENTION_MS,
  CONVERSATION_MAX_TERMINAL_ACTIVITIES,
} from '../domains/conversations/conversation-turn-retention-policy.js'
import {
  inspectReservedActivity,
  releaseConversationActivity,
} from './conversation-admission-reservation.js'
import {
  commitReclaimedActivities,
  conversationRetentionRoot,
  readRetentionDocument,
  selectReclaimableActivities,
} from './conversation-terminal-ledger.js'
import type { ConversationOwner } from '../core/conversation-activity-location.js'
import type { WorkspaceConversationJournalRegistry } from './workspace-conversation-journal-registry.js'

/**
 * How many finished turns one sweep will consider.
 *
 * A sweep is housekeeping on a live request, so it is bounded rather than
 * complete. Successive turns drain the record from the front, and the count cap
 * is generous enough that a conversation cannot outrun this in one turn.
 */
const MAX_RECLAIMED_PER_SWEEP = 32

/**
 * How many open reservations one sweep re-checks for abandonment.
 *
 * Small on purpose. An abandoned journal is rare — it needs a crash inside the
 * window between claiming an activity and writing its first event — and paying
 * for a large scan of the open set on every turn to catch it would cost far more
 * than the thing it recovers.
 */
const MAX_ABANDONED_CHECKS_PER_SWEEP = 4

export interface ConversationSweepResult {
  readonly deleted: readonly string[]
  /** True when the record still held reclaimable turns this sweep did not reach. */
  readonly partial: boolean
  /** Set when the retention record could not be read exactly. */
  readonly degraded?: string
}

export async function sweepConversationActivities(input: {
  readonly workspacePath: string
  readonly owner: ConversationOwner
  readonly registry: WorkspaceConversationJournalRegistry
  readonly now?: () => number
  readonly retentionMs?: number
  readonly maxTerminalActivities?: number
  /** How many finished turns to consider. Injected so tests need not seed a cap. */
  readonly limit?: number
}): Promise<ConversationSweepResult> {
  const now = input.now ?? (() => Date.now())
  const retentionMs = input.retentionMs ?? CONVERSATION_TERMINAL_RETENTION_MS
  const limit = Math.max(1, input.limit ?? MAX_RECLAIMED_PER_SWEEP)

  const selection = await selectReclaimableActivities({
    workspacePath: input.workspacePath,
    owner: input.owner,
    now,
    retentionMs,
    maxTerminalActivities:
      input.maxTerminalActivities ?? CONVERSATION_MAX_TERMINAL_ACTIVITIES,
    limit,
  })

  const deleted: string[] = []
  const reclaimed: string[] = []
  for (const candidate of selection.candidates) {
    const verdict = await inspectReservedActivity({
      registry: input.registry,
      owner: input.owner,
      turnId: candidate.activityId,
    })
    // The record said this turn finished. Only the journal can confirm it, and
    // anything short of confirmation stops the sweep here rather than deleting
    // on a projection that has drifted.
    if (verdict.kind === 'missing') {
      // Already gone. Forgetting it is the whole job.
      reclaimed.push(candidate.activityId)
      continue
    }
    if (verdict.kind !== 'terminal') break
    // The record said this turn was old. Only the journal knows when it
    // actually finished, and a stale or tampered entry claiming a recent turn
    // is ancient is exactly how retention would delete history that is not
    // expendable. Volume has nothing to re-check — it is a fact about the
    // conversation, not a claim about this turn.
    if (
      candidate.reason === 'aged' &&
      now() - verdict.atMs < retentionMs
    ) {
      break
    }

    const outcome = await input.registry.deleteActivity({
      owner: input.owner,
      activityId: candidate.activityId,
      activityKind: 'turn',
    })
    // In use. Stopping rather than skipping keeps the record's order intact:
    // advancing past it would strand it behind a cursor that moved on.
    if (outcome === 'busy') break
    reclaimed.push(candidate.activityId)
    if (outcome === 'deleted') deleted.push(candidate.activityId)
  }

  if (reclaimed.length > 0) {
    // By identity, not by count: anything this sweep could not forget must
    // still be there next time, whatever position it held.
    const committed = await commitReclaimedActivities({
      workspacePath: input.workspacePath,
      owner: input.owner,
      reclaimedIds: reclaimed,
    })
    if (committed === 'unavailable') {
      // The activities are gone and the record still lists them. That is not
      // housekeeping that can wait — the two halves of retention disagree, and
      // returning a clean result here would report the sweep as done. The
      // message is fixed: the fault underneath is an errno naming an absolute
      // path, and this reaches a process log.
      throw new Error('the retention record could not be updated')
    }
  }

  const abandoned = await reclaimAbandonedActivities({
    workspacePath: input.workspacePath,
    owner: input.owner,
    registry: input.registry,
    now,
    retentionMs,
  })
  deleted.push(...abandoned)

  return {
    deleted,
    // Work this sweep left behind, not merely turns it kept. A conversation
    // inside both limits has nothing to reclaim, and saying otherwise sends a
    // caller back for work that does not exist — so the page being full is not
    // the question; whether anything past it qualified is.
    partial:
      reclaimed.length < selection.candidates.length ||
      selection.hasMoreReclaimable,
    ...(selection.degraded ? { degraded: selection.degraded } : {}),
  }
}

/**
 * Reclaim journals that were claimed and never written to.
 *
 * The crash window before the first append leaves an activity that holds
 * nothing. It never reaches a terminal, so it never enters the retention record
 * and the rules above will never see it; and it is not unresolved work either,
 * because nothing started. Left alone it keeps both a directory and an admission
 * slot forever.
 *
 * Its age comes from the journal manifest, which is durable and written once at
 * creation — not from when a sweep happened to notice it, which would restart
 * the clock on every pass and mean it never aged at all.
 */
async function reclaimAbandonedActivities(input: {
  readonly workspacePath: string
  readonly owner: ConversationOwner
  readonly registry: WorkspaceConversationJournalRegistry
  readonly now: () => number
  readonly retentionMs: number
}): Promise<readonly string[]> {
  const root = conversationRetentionRoot(input)
  if (!root) return []
  let document
  try {
    document = await readRetentionDocument(root)
  } catch {
    return []
  }
  if (document === 'damaged') return []
  const open = [...document.openTurnIds].sort()
  if (open.length === 0) return []

  const start = document.reconcileCursor % open.length
  const deleted: string[] = []
  for (
    let offset = 0;
    offset < Math.min(MAX_ABANDONED_CHECKS_PER_SWEEP, open.length);
    offset += 1
  ) {
    const turnId = open[(start + offset) % open.length] as string
    const verdict = await inspectReservedActivity({
      registry: input.registry,
      owner: input.owner,
      turnId,
    })
    if (verdict.kind !== 'empty') continue
    if (input.now() - verdict.createdAtMs < input.retentionMs) continue

    const outcome = await input.registry.deleteActivity({
      owner: input.owner,
      activityId: turnId,
      activityKind: 'turn',
    })
    if (outcome === 'busy') continue
    // The slot goes back with it, and without a terminal time: nothing ever
    // finished here, so there is nothing to project.
    await releaseConversationActivity({
      workspacePath: input.workspacePath,
      owner: input.owner,
      turnId,
    })
    if (outcome === 'deleted') deleted.push(turnId)
  }
  return deleted
}
