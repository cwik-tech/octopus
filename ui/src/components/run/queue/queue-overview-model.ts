import type {
  SchedulingQueueHoldReason,
  SchedulingQueueItemState,
  SchedulingQueueSnapshot,
} from "@/lib/clients/scheduling-queue-client";

const DESCENDANTS_STILL_RUNNING =
  "Processes this task started may still be running; its slot stays in use until they stop.";

const HOLD_SENTENCES: Record<SchedulingQueueHoldReason, string> = {
  unverified_live_process:
    "Its recorded worker is still running but cannot be confirmed as this task's, so it is not stopped automatically. New work starts once it exits.",
  ambiguous_marker:
    "More than one running process group carries this task's identity, so none of them is stopped automatically. New work starts once they exit.",
  owned_processes_unverified: DESCENDANTS_STILL_RUNNING,
  descendants_unverified_without_scope: DESCENDANTS_STILL_RUNNING,
};

/** Why a task holds its slot, as one sentence for the queue view. */
export function queueHoldSentence(reason: SchedulingQueueHoldReason): string {
  return HOLD_SENTENCES[reason];
}

/**
 * The diagnostic detail of a hold, shown after the task and its reason: the
 * pid of a worker that cannot be confirmed, or how many process groups carry
 * the task's identity.
 */
export function queueHoldDetail(hold: {
  processId?: number | undefined;
  processGroupCount?: number | undefined;
}): string | undefined {
  if (hold.processId !== undefined) return `Process ${hold.processId}`;
  if (hold.processGroupCount !== undefined) return `${hold.processGroupCount} process groups`;
  return undefined;
}

const STATE_RANK: Record<SchedulingQueueItemState, number> = {
  running: 0,
  starting: 1,
  finishing: 2,
  waiting: 3,
};

export interface QueueSessionSummary {
  sessionId: string;
  state: SchedulingQueueItemState;
  taskCount: number;
  firstQueueIndex: number;
}

export function buildQueueSessionSummaries(
  snapshot: SchedulingQueueSnapshot | null,
): QueueSessionSummary[] {
  const summaries = new Map<string, QueueSessionSummary>();
  for (const [index, item] of (snapshot?.items ?? []).entries()) {
    const current = summaries.get(item.sessionId);
    if (!current) {
      summaries.set(item.sessionId, {
        sessionId: item.sessionId,
        state: item.state,
        taskCount: 1,
        firstQueueIndex: index,
      });
      continue;
    }
    current.taskCount += 1;
    current.firstQueueIndex = Math.min(current.firstQueueIndex, index);
    if (STATE_RANK[item.state] < STATE_RANK[current.state]) {
      current.state = item.state;
    }
  }
  return [...summaries.values()].sort(
    (left, right) =>
      STATE_RANK[left.state] - STATE_RANK[right.state] ||
      left.firstQueueIndex - right.firstQueueIndex,
  );
}

export function queueStateLabel(state: SchedulingQueueItemState): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}
