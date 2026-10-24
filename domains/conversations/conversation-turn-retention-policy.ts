/**
 * Which conversation activities may be forgotten.
 *
 * Retention here cannot work the way a log's does. The accepted journal ADR
 * forbids rotating, truncating or compacting an acknowledged journal, so
 * nothing inside an activity is ever rewritten. Boundedness comes from the
 * other end: an activity that is finished and old is deleted whole, or not at
 * all.
 *
 * A pure selector over an injected clock, so the rules are decidable without a
 * filesystem and testable without waiting thirty days. The caller does the
 * deleting; this only decides.
 *
 * The rule that matters most is the refusal. An unresolved turn — started, or
 * prepared without a terminal — is exactly the evidence an operator needs to
 * diagnose a crash window, and exactly what a naive age sweep would remove
 * first. It is never selected, at any age. Nor is an activity whose state could
 * not be read: deleting what could not be understood would destroy the only
 * record that it existed.
 */
import type { ConversationTurnState } from './conversation-turn-journal.js'

/** Thirty days after a turn finished. */
export const CONVERSATION_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** Terminal activities kept per conversation before the oldest are dropped. */
export const CONVERSATION_MAX_TERMINAL_ACTIVITIES = 10_000

/**
 * How many finished turns the retention record names exactly at once.
 *
 * The cap plus headroom, because reclamation lags: a turn adds one entry and a
 * sweep gives back a bounded batch, so the retained set sits a little above the
 * cap between the moment it is crossed and the moment it is brought back down.
 *
 * Derived from the cap rather than chosen beside it. Knowing whether a finished
 * turn has already been counted has to be exact for every turn still being kept
 * — a window would mean a conversation only has to run past it before a replay
 * counts one twice, and the cap then deletes history that was never over the
 * limit. So the record carries one id per retained turn, and the cap is what
 * sizes it, never the other way round.
 */
export const CONVERSATION_MAX_PROJECTED_IDS =
  CONVERSATION_MAX_TERMINAL_ACTIVITIES + 512
/** Unresolved turns before a conversation stops admitting new ones. */
export const CONVERSATION_MAX_UNRESOLVED_ACTIVITIES = 100

export interface RetainedConversationActivity {
  readonly activityId: string
  readonly state: ConversationTurnState
  /** When the activity last recorded anything, in epoch milliseconds. */
  readonly lastEventAtMs: number
}

export interface ConversationRetentionOptions {
  readonly now: () => number
  readonly terminalRetentionMs?: number
  readonly maxTerminalActivities?: number
  readonly maxUnresolvedActivities?: number
}

export interface ConversationRetentionSelection {
  /** Activities that may be deleted whole, oldest first. */
  readonly expired: readonly string[]
  /** Turns still awaiting a terminal. Never expired, always reported. */
  readonly unresolved: readonly string[]
  /**
   * False when unresolved turns have piled up past the cap.
   *
   * The answer to that is to stop taking new work and surface it, not to delete
   * the evidence that produced it.
   */
  readonly admitsNewActivity: boolean
}

const TERMINAL_STATES: ReadonlySet<ConversationTurnState> = new Set<
  ConversationTurnState
>(['completed', 'failed', 'cancelled'])

const UNRESOLVED_STATES: ReadonlySet<ConversationTurnState> = new Set<
  ConversationTurnState
>(['started', 'prepared'])

export function selectExpiredConversationActivities(
  activities: readonly RetainedConversationActivity[],
  options: ConversationRetentionOptions,
): ConversationRetentionSelection {
  const now = options.now()
  const retentionMs =
    options.terminalRetentionMs ?? CONVERSATION_TERMINAL_RETENTION_MS
  const maxTerminal =
    options.maxTerminalActivities ?? CONVERSATION_MAX_TERMINAL_ACTIVITIES
  const maxUnresolved =
    options.maxUnresolvedActivities ?? CONVERSATION_MAX_UNRESOLVED_ACTIVITIES

  const unresolved = activities
    .filter((activity) => UNRESOLVED_STATES.has(activity.state))
    .map((activity) => activity.activityId)

  // Sorted by age, then by id, so the same set always yields the same answer
  // whatever order the directory happened to be read in.
  const terminals = activities
    .filter((activity) => TERMINAL_STATES.has(activity.state))
    .slice()
    .sort(
      (left, right) =>
        left.lastEventAtMs - right.lastEventAtMs ||
        (left.activityId < right.activityId ? -1 : left.activityId > right.activityId ? 1 : 0),
    )

  const expired = new Set<string>()
  for (const activity of terminals) {
    // `>=` so an activity exactly at the window has spent it, rather than
    // living one sweep longer than the number says.
    if (now - activity.lastEventAtMs >= retentionMs) {
      expired.add(activity.activityId)
    }
  }

  // The count cap applies to terminals only. Unresolved work is never evicted
  // by volume — that would delete the diagnosis along with the backlog.
  const overflow = terminals.length - maxTerminal
  if (overflow > 0) {
    for (const activity of terminals.slice(0, overflow)) {
      expired.add(activity.activityId)
    }
  }

  return {
    expired: terminals
      .filter((activity) => expired.has(activity.activityId))
      .map((activity) => activity.activityId),
    unresolved,
    admitsNewActivity: unresolved.length < maxUnresolved,
  }
}
