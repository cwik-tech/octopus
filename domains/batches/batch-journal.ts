import {
  canonicalizeJson,
  toCanonicalJsonObject,
} from "../../contracts/canonical-json.js";
import type { ExecutionJournalEvent } from "../../contracts/execution-journal.js";
import type { ExecutionJournal } from "../../core/execution-journal.js";
import { appendJournalStreamEvent } from "../../core/journal-stream-append.js";
import {
  journalProjectionsDirectory,
  JournalProjectionMetadataStore,
} from "../../core/journal-projection.js";
import {
  parseBatchExecution,
  type BatchExecution,
  type BatchItem,
} from "./batch-types.js";
import type { BatchStore } from "./batch-store.js";

/**
 * Batch migration onto the canonical execution journal (Phase 8 ADR §8). A
 * batch execution records one canonical stream per execution; every execution
 * write appends a full validated snapshot event before the on-disk execution
 * file is rewritten. Replay validates the stream — identity constancy,
 * item integrity, and child-assignment-link consistency — and rebuilds the
 * execution projection, recovering item outcomes plus child assignment links.
 */

export const BATCH_EXECUTION_STREAM_KIND = "batch.execution";
export const BATCH_SNAPSHOT_EVENT_TYPE = "batch.execution.snapshot";
export const BATCH_EXECUTION_PROJECTION_ID = "batch-execution";
export const BATCH_EXECUTION_REDUCER_VERSION = 1;

const BATCH_JOURNAL_PAYLOAD_SCHEMA_VERSION = 1;
const SAFE_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

export type BatchJournalErrorCode =
  | "append_rejected"
  | "child_link_invalid"
  | "corrupt"
  | "identity_mismatch"
  | "item_invalid"
  | "not_found";

export class BatchJournalError extends Error {
  constructor(
    readonly code: BatchJournalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BatchJournalError";
  }
}

/**
 * Statuses from which a legacy batch execution may be imported as a baseline.
 * An execution that can still progress must not change authorities mid-flight,
 * matching the workflow rule (ADR §9).
 */
const BASELINE_ELIGIBLE_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "cancelled",
  "failed",
]);

export function isBatchBaselineEligible(
  execution: Pick<BatchExecution, "status">,
): boolean {
  return BASELINE_ELIGIBLE_STATUSES.has(execution.status);
}

/**
 * Import a settled legacy batch execution as the first event of its canonical
 * stream. Idempotent for an identical already-imported execution; a divergent
 * one, or a stream that already has events, fails closed.
 */
export async function importBatchExecutionBaseline(
  journal: ExecutionJournal,
  store: BatchStore,
  batchId: string,
  executionId: string,
): Promise<void> {
  const execution = await store.readExecution(batchId, executionId);
  if (!execution) {
    throw new BatchJournalError(
      "not_found",
      `Batch execution '${executionId}' was not found.`,
    );
  }
  if (!isBatchBaselineEligible(execution)) {
    throw new BatchJournalError(
      "corrupt",
      `Batch execution '${executionId}' is '${execution.status}' and may still progress; a running execution is never switched between authorities.`,
    );
  }
  const streamId = batchExecutionStreamId(executionId);
  const existing = (
    await journal.scanStream(BATCH_EXECUTION_STREAM_KIND, streamId)
  ).events;
  if (existing.length > 0) {
    const imported = reduceBatchExecutionStream(existing, batchId, executionId);
    if (canonicalizeJson(imported) === canonicalizeJson(execution)) return;
    throw new BatchJournalError(
      "identity_mismatch",
      `A different batch execution was already imported for '${executionId}'.`,
    );
  }
  await createJournalBackedBatchRecorder(journal).recordExecution(execution);
}

export function batchExecutionStreamId(executionId: string): string {
  return executionId;
}

export interface BatchJournalRecorder {
  recordExecution(execution: BatchExecution): Promise<void>;
}

export function createJournalBackedBatchRecorder(
  journal: ExecutionJournal,
): BatchJournalRecorder {
  return new JournalBackedBatchRecorder(journal);
}

class JournalBackedBatchRecorder implements BatchJournalRecorder {
  private readonly streamRevisions = new Map<string, number>();

  constructor(private readonly journal: ExecutionJournal) {}

  async recordExecution(execution: BatchExecution): Promise<void> {
    const streamId = batchExecutionStreamId(execution.id);
    const expectedStreamRevision =
      this.streamRevisions.get(streamId) ??
      (await this.currentStreamRevision(streamId));
    const eventId = `${streamId}:${BATCH_SNAPSHOT_EVENT_TYPE}:${expectedStreamRevision}`;
    const payload: Record<string, unknown> = { execution };
    const event = await appendJournalStreamEvent(this.journal, {
      eventId,
      streamKind: BATCH_EXECUTION_STREAM_KIND,
      streamId,
      expectedStreamRevision,
      type: BATCH_SNAPSHOT_EVENT_TYPE,
      payloadSchemaVersion: BATCH_JOURNAL_PAYLOAD_SCHEMA_VERSION,
      payload: toCanonicalJsonObject(payload),
      correlationId: streamId,
    });
    this.streamRevisions.set(streamId, event.streamRevision);
  }

  private async currentStreamRevision(streamId: string): Promise<number> {
    const stream = await this.journal.scanStream(
      BATCH_EXECUTION_STREAM_KIND,
      streamId,
    );
    return stream.events[stream.events.length - 1]?.streamRevision ?? 0;
  }
}

/**
 * Rebuild the batch execution projection from the canonical journal stream.
 * Returns the journal sequence of the last applied event.
 */
export async function rebuildBatchExecutionProjection(
  journal: ExecutionJournal,
  store: BatchStore,
  batchId: string,
  executionId: string,
): Promise<{ lastAppliedSequence: number }> {
  const streamId = batchExecutionStreamId(executionId);
  const stream = (
    await journal.scanStream(BATCH_EXECUTION_STREAM_KIND, streamId)
  ).events;
  if (stream.length === 0) {
    throw new BatchJournalError(
      "not_found",
      `No batch journal events found for execution '${executionId}'.`,
    );
  }
  const execution = reduceBatchExecutionStream(stream, batchId, executionId);
  await store.writeExecutionProjection(execution);
  const lastSequence = stream[stream.length - 1]?.sequence ?? 0;
  await createBatchProjectionMetadataStore(journal, executionId).recordApplied(
    lastSequence,
  );
  return { lastAppliedSequence: lastSequence };
}

/**
 * Validate an ordered batch execution stream and return the latest execution.
 * Enforces identity constancy, item integrity, and child-assignment-link
 * consistency; fails closed on any violation.
 */
export function reduceBatchExecutionStream(
  events: readonly ExecutionJournalEvent[],
  expectedBatchId: string,
  expectedExecutionId: string,
): BatchExecution {
  let latest: BatchExecution | undefined;

  for (const event of events) {
    if (event.type !== BATCH_SNAPSHOT_EVENT_TYPE) {
      throw new BatchJournalError(
        "corrupt",
        `Unexpected batch journal event type '${event.type}'.`,
      );
    }
    // The stream is the fail-closed boundary for a damaged journal, so the
    // payload is parsed with the domain's own schema rather than trusted.
    let execution: BatchExecution;
    try {
      execution = parseBatchExecution(event.payload["execution"]);
    } catch (error) {
      throw new BatchJournalError(
        "corrupt",
        `Batch journal event payload is not a valid execution: ${
          error instanceof Error ? error.message : "unknown reason"
        }`,
      );
    }
    if (
      execution.batchId !== expectedBatchId ||
      execution.id !== expectedExecutionId
    ) {
      throw new BatchJournalError(
        "identity_mismatch",
        `Batch execution identity '${execution.batchId}/${execution.id}' does not match '${expectedBatchId}/${expectedExecutionId}'.`,
      );
    }
    assertBatchItems(execution.items);
    latest = execution;
  }

  if (!latest) {
    throw new BatchJournalError(
      "not_found",
      "Batch journal stream did not contain a usable execution snapshot.",
    );
  }
  return latest;
}

/**
 * Item integrity: item identities must be unique and well-formed, and any
 * child-assignment link must be internally consistent (a task link requires
 * its session link; an execution-attempt id must be a safe identifier).
 */
function assertBatchItems(items: readonly BatchItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.id || seen.has(item.id)) {
      throw new BatchJournalError(
        "item_invalid",
        `Batch item identity is missing or duplicated: '${item.id}'.`,
      );
    }
    seen.add(item.id);
    if (!Number.isInteger(item.ordinal) || item.ordinal < 0) {
      throw new BatchJournalError(
        "item_invalid",
        `Batch item '${item.id}' has an invalid ordinal.`,
      );
    }
    assertChildAssignmentLink(item);
  }
}

function assertChildAssignmentLink(item: BatchItem): void {
  if (item.taskId !== undefined && item.sessionId === undefined) {
    throw new BatchJournalError(
      "child_link_invalid",
      `Batch item '${item.id}' references a child task without its session link.`,
    );
  }
  if (
    item.taskExecutionAttemptId !== undefined &&
    !SAFE_ATTEMPT_ID_PATTERN.test(item.taskExecutionAttemptId)
  ) {
    throw new BatchJournalError(
      "child_link_invalid",
      `Batch item '${item.id}' carries an unsafe child execution-attempt identity.`,
    );
  }
}

/**
 * Lag tracking for one batch execution's file projection. A journal may hold
 * many execution streams, so each gets its own metadata file under the shared
 * projection-metadata shape.
 */
export function createBatchProjectionMetadataStore(
  journal: ExecutionJournal,
  executionId: string,
  clock?: { readonly now: () => number },
): JournalProjectionMetadataStore {
  return new JournalProjectionMetadataStore({
    projectionId: BATCH_EXECUTION_PROJECTION_ID,
    reducerVersion: BATCH_EXECUTION_REDUCER_VERSION,
    projectionDirectory: journalProjectionsDirectory(journal),
    metadataFileName: `${BATCH_EXECUTION_PROJECTION_ID}-${executionId}.json`,
    ...(clock === undefined ? {} : { clock }),
  });
}
