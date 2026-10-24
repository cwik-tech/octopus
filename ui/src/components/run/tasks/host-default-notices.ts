import type { ModelSelectionRecord } from "@contracts/agent-model-selection";
import type { RunEvent } from "@/components/run/stage-renderers/index";

/**
 * Which host attempts of this run used the application default, and on what.
 *
 * The host process is a model use like any other, and until now it was the one
 * that never said so: a Team whose coordinator names no model runs its host on
 * the app default, and nothing on screen explained where that pair came from.
 *
 * Derived from `host.agent_start`, which the runtime writes before it calls a
 * provider, so the notice is available while the turn is still running rather
 * than after it. That event is emitted for every host turn including one whose
 * level declares no coordinator, which is the case that produces no agent
 * record at all — and therefore the case with no other source of disclosure.
 *
 * Only `app-default` produces a notice. An Agent that named its own pair made a
 * choice, and saying "using the app default" about a deliberate choice would be
 * false even when the two pairs happen to be identical.
 */
export interface HostDefaultNotice {
  /** The coordinator whose turn it was, or the run itself when it has none. */
  readonly speaker: string;
  readonly selection: ModelSelectionRecord;
  /**
   * The attempt this describes, stable across replays and unique across them.
   *
   * Carried out of here because a reader has to be able to key on it: the same
   * coordinator legitimately takes more than one turn, so its name alone
   * collides once two real attempts share it.
   */
  readonly attemptId: string;
}

/**
 * One notice per host attempt, however many times its events arrive.
 *
 * A run's events are replayed on reload and re-delivered on reconnect, so the
 * same attempt is seen more than once and must still be reported once.
 *
 * The identity is the host *process* and its turn counter together, and it
 * needs both. `coordinatorRunId` restarts at 0 in each process, so it reaches 1
 * on every process's first turn; a recovered run keeps its session id, so the
 * turn before a crash and the first turn after it arrive as the same run's turn
 * 1. Keyed on the counter alone they merge, and the recovered coordinator's
 * disclosure is dropped — the run then says it used one model when it used two.
 */
export function hostDefaultNotices(
  events: readonly RunEvent[],
  fallbackSpeaker = "This run's host",
): HostDefaultNotice[] {
  const byAttempt = new Map<string, HostDefaultNotice>();

  for (const event of events) {
    if (event.type !== "host.agent_start") continue;
    const selection = event.modelSelection;
    if (!selection || selection.source !== "app-default") continue;

    // The attempt, not the event. Two events for one attempt are one notice;
    // two attempts that happen to share a pair, a speaker, or a turn number are
    // two. Without a process identity the key cannot be trusted to separate
    // them, so an event that lacks one falls back to its own id: reporting a
    // replay twice is a worse answer than reporting a real turn not at all.
    const attempt =
      event.hostInstanceId === undefined || event.coordinatorRunId === undefined
        ? `${event.runId ?? ""}:event:${event.id}`
        : `${event.runId ?? ""}:${event.hostInstanceId}:${event.coordinatorRunId}`;
    if (byAttempt.has(attempt)) continue;

    byAttempt.set(attempt, {
      speaker: event.agentName ?? fallbackSpeaker,
      selection,
      attemptId: attempt,
    });
  }

  return [...byAttempt.values()];
}
