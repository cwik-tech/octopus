import {
  readModelSelectionRecord,
  type ModelSelectionRecord,
} from "@contracts/agent-model-selection";

/**
 * Which Architect turns ran on the application default, and on what.
 *
 * Two sources answer that, and they answer at different times. A turn in flight
 * publishes its selection on the stream before the provider is called, which is
 * the only disclosure a person gets while they are waiting. A turn that already
 * finished is described by what the run recorded, read back from the server —
 * never re-derived from Settings, because the default moves and a finished turn
 * did not.
 *
 * They overlap. A turn can be live here, recorded there, and its history load
 * can land after it finished — so the two are folded by the job the turn
 * belongs to. Without that, one turn is described twice, and a reload shows a
 * transcript with more notices in it than turns.
 */
export interface ArchitectTurnRecord {
  readonly jobId: string;
  /**
   * When the run recorded this turn.
   *
   * Carried so a restored notice can say which turn it describes. It is the
   * record's own time — never today's, and never re-derived — because a label
   * stamped when history was read would date every old turn to this moment.
   */
  readonly recordedAt?: string;
  readonly selection?: ModelSelectionRecord;
}

export interface ArchitectSelectionNotice {
  readonly jobId: string;
  readonly speaker: string;
  readonly selection: ModelSelectionRecord;
  /** The recorded time, where the turn came from history rather than the wire. */
  readonly recordedAt?: string;
}

/**
 * Reads the turn history a server sent.
 *
 * Validated rather than asserted, entry by entry. A malformed entry is dropped
 * and the rest are kept: one unreadable row is not a reason to leave a person
 * with no account of the turns that *are* readable, and a half-read record
 * would state something no turn recorded.
 */
export function readArchitectTurnHistory(value: unknown): ArchitectTurnRecord[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const turns = (value as { turns?: unknown }).turns;
  if (!Array.isArray(turns)) return [];
  const records: ArchitectTurnRecord[] = [];
  for (const entry of turns) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const jobId = (entry as { jobId?: unknown }).jobId;
    if (typeof jobId !== "string" || jobId === "") continue;
    // Absent on a turn that failed before choosing a pair, and present-but-
    // unreadable is treated the same way: the turn is kept, the claim is not.
    const selection = readModelSelectionRecord(
      (entry as { selection?: unknown }).selection,
    );
    const recordedAt = (entry as { recordedAt?: unknown }).recordedAt;
    records.push({
      jobId,
      ...(typeof recordedAt === "string" && recordedAt !== ""
        ? { recordedAt }
        : {}),
      ...(selection ? { selection } : {}),
    });
  }
  return records;
}

/**
 * The notices to show, one per turn, from both sources at once.
 *
 * Only `app-default` produces one. A pair somebody chose is a choice, and
 * describing it as inherited would be false even when it happens to equal the
 * current default — which is exactly when the mistake is invisible.
 *
 * Live entries win over recorded ones for the same job. Both describe the same
 * turn, and the live one is what the person is watching; a history load that
 * lands afterwards must not replace it, and must not add a second line for the
 * turn it already describes.
 */
export function architectSelectionNotices(input: {
  readonly history: readonly ArchitectTurnRecord[];
  readonly live: readonly ArchitectTurnRecord[];
  readonly speaker: string;
}): ArchitectSelectionNotice[] {
  // Folded first, asked second. Deciding which records deserve a notice before
  // resolving which record *is* the turn leaves a retracted one behind: a turn
  // recorded as inheriting and now live on a pair somebody chose would keep the
  // stale default line, because the live record was filtered out before it
  // could displace it.
  const byJob = new Map<string, ArchitectTurnRecord>();
  for (const record of [...input.history, ...input.live]) {
    const earlier = byJob.get(record.jobId);
    byJob.set(record.jobId, {
      ...record,
      // The later record decides which pair is shown; it does not decide what
      // time the turn happened. A live entry has no timestamp of its own, and
      // it outlives the turn's completion — so replacing the record wholesale
      // would throw away the only time that turn has, on the ordinary path.
      ...(record.recordedAt === undefined && earlier?.recordedAt !== undefined
        ? { recordedAt: earlier.recordedAt }
        : {}),
    });
  }
  const notices: ArchitectSelectionNotice[] = [];
  for (const record of byJob.values()) {
    if (record.selection?.source !== "app-default") continue;
    notices.push({
      jobId: record.jobId,
      speaker: input.speaker,
      selection: record.selection,
      ...(record.recordedAt ? { recordedAt: record.recordedAt } : {}),
    });
  }
  return notices;
}
