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
import type {
  ResearchExecutionManifest,
  ResearchJournal,
  ResearchRunSnapshot,
  ResearchWorkItem,
} from "../../contracts/deep-research.js";
import {
  validateJournal,
  validateManifest,
  validateWorkItem,
  type FileSystemResearchRunStore,
} from "./deep-research-store.js";

/**
 * Deep Research integration onto the canonical execution journal (Phase 8
 * ADR §10). A research run records one canonical stream; every mutation
 * appends a full validated snapshot event before the filesystem projection
 * (manifest + research-journal.json + work items) is rewritten. Replay
 * validates the stream — identity constancy, revision monotonicity, owner
 * fencing, attempt/receipt pairing, and safe outcome metadata — and rebuilds
 * the projection. The journal stores receipts and safe metadata only; it
 * never embeds raw prompts, responses, or unvalidated model prose.
 */

export const RESEARCH_RUN_STREAM_KIND = "research.run";
export const RESEARCH_SNAPSHOT_EVENT_TYPE = "research.run.snapshot";
export const RESEARCH_RUN_PROJECTION_ID = "research-run";
export const RESEARCH_RUN_REDUCER_VERSION = 1;

const RESEARCH_JOURNAL_PAYLOAD_SCHEMA_VERSION = 1;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type ResearchJournalErrorCode =
  | "append_rejected"
  | "corrupt"
  | "identity_mismatch"
  | "invalid_receipt"
  | "missing_receipt"
  | "not_found"
  | "ownership_conflict"
  | "revision_conflict"
  | "unsafe_metadata";

export class ResearchJournalError extends Error {
  constructor(
    readonly code: ResearchJournalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResearchJournalError";
  }
}

export function researchRunStreamId(runId: string): string {
  return runId;
}

export interface ResearchJournalRecorder {
  recordSnapshot(
    snapshot: ResearchRunSnapshot,
    options?: { readonly includeManifest?: boolean },
  ): Promise<void>;
}

export function createJournalBackedResearchRecorder(
  journal: ExecutionJournal,
): ResearchJournalRecorder {
  return new JournalBackedResearchRecorder(journal);
}

class JournalBackedResearchRecorder implements ResearchJournalRecorder {
  private readonly streamRevisions = new Map<string, number>();

  constructor(private readonly journal: ExecutionJournal) {}

  async recordSnapshot(
    snapshot: ResearchRunSnapshot,
    options?: { readonly includeManifest?: boolean },
  ): Promise<void> {
    const streamId = researchRunStreamId(snapshot.manifest.runId);
    const expectedStreamRevision =
      this.streamRevisions.get(streamId) ??
      (await this.currentStreamRevision(streamId));
    const payload: Record<string, unknown> = {
      journal: snapshot.journal,
      workItems: snapshot.workItems,
    };
    // The reducer needs the manifest to rebuild, and the first event of a
    // stream is the only one guaranteed to exist — including a journal
    // attached to a run that started under the legacy authority.
    if (options?.includeManifest || expectedStreamRevision === 0) {
      payload.manifest = snapshot.manifest;
    }
    const eventId = `${streamId}:${RESEARCH_SNAPSHOT_EVENT_TYPE}:${expectedStreamRevision}`;
    const event = await appendJournalStreamEvent(this.journal, {
      eventId,
      streamKind: RESEARCH_RUN_STREAM_KIND,
      streamId,
      expectedStreamRevision,
      type: RESEARCH_SNAPSHOT_EVENT_TYPE,
      payloadSchemaVersion: RESEARCH_JOURNAL_PAYLOAD_SCHEMA_VERSION,
      payload: toCanonicalJsonObject(payload),
      correlationId: streamId,
    });
    this.streamRevisions.set(streamId, event.streamRevision);
  }

  private async currentStreamRevision(streamId: string): Promise<number> {
    const stream = await this.journal.scanStream(
      RESEARCH_RUN_STREAM_KIND,
      streamId,
    );
    return stream.events[stream.events.length - 1]?.streamRevision ?? 0;
  }
}

/**
 * Rebuild the research projection (manifest + journal + work items) by
 * replaying the research journal stream. Returns the journal sequence of the
 * last applied event.
 */
export async function rebuildResearchProjection(
  journal: ExecutionJournal,
  store: FileSystemResearchRunStore,
): Promise<{ lastAppliedSequence: number }> {
  const scan = await journal.scan();
  const researchEvents = scan.events.filter(
    (event) => event.streamKind === RESEARCH_RUN_STREAM_KIND,
  );
  if (researchEvents.length === 0) {
    throw new ResearchJournalError(
      "not_found",
      "No research journal events found for this assignment.",
    );
  }
  const streamIds = new Set(researchEvents.map((event) => event.streamId));
  if (streamIds.size !== 1) {
    throw new ResearchJournalError(
      "identity_mismatch",
      `Expected exactly one research stream, found ${streamIds.size}.`,
    );
  }
  const snapshot = reduceResearchSnapshot(researchEvents);
  await store.writeResearchProjection(snapshot);
  const lastSequence =
    researchEvents[researchEvents.length - 1]?.sequence ?? 0;
  await createResearchProjectionMetadataStore(journal).recordApplied(lastSequence);
  return { lastAppliedSequence: lastSequence };
}

/**
 * Validate an ordered research journal stream and return the reconstructed
 * snapshot. Enforces identity constancy, revision monotonicity, owner
 * fencing, attempt/receipt pairing, and safe outcome metadata; fails closed
 * on any violation.
 */
export function reduceResearchSnapshot(
  events: readonly ExecutionJournalEvent[],
): ResearchRunSnapshot {
  let manifest: ResearchExecutionManifest | undefined;
  let previousJournal: ResearchJournal | undefined;
  let latest:
    | { journal: ResearchJournal; workItems: ResearchWorkItem[] }
    | undefined;

  for (const event of events) {
    if (event.type !== RESEARCH_SNAPSHOT_EVENT_TYPE) {
      throw new ResearchJournalError(
        "corrupt",
        `Unexpected research journal event type '${event.type}'.`,
      );
    }
    const payload = event.payload;
    const rawWorkItems = payload["workItems"];
    if (payload["journal"] === undefined || !Array.isArray(rawWorkItems)) {
      throw new ResearchJournalError(
        "corrupt",
        "Research journal event payload is missing journal or workItems.",
      );
    }
    // The stream is the fail-closed boundary for a damaged journal, so every
    // payload is validated with the domain's own schema before it is read.
    let journal: ResearchJournal;
    let workItems: ResearchWorkItem[];
    try {
      journal = validateJournal(payload["journal"]);
      workItems = rawWorkItems.map((item) => validateWorkItem(item));
    } catch (error) {
      throw new ResearchJournalError(
        "corrupt",
        `Research journal event payload failed validation: ${
          error instanceof Error ? error.message : "unknown reason"
        }`,
      );
    }
    if (payload["manifest"] !== undefined) {
      let eventManifest: ResearchExecutionManifest;
      try {
        eventManifest = validateManifest(payload["manifest"]);
      } catch (error) {
        throw new ResearchJournalError(
          "corrupt",
          `Research journal manifest failed validation: ${
            error instanceof Error ? error.message : "unknown reason"
          }`,
        );
      }
      if (manifest && canonicalizeJson(manifest) !== canonicalizeJson(eventManifest)) {
        throw new ResearchJournalError(
          "identity_mismatch",
          "Research execution manifest changed between events.",
        );
      }
      manifest = manifest ?? eventManifest;
    }

    if (previousJournal) {
      if (journal.revision < previousJournal.revision) {
        throw new ResearchJournalError(
          "revision_conflict",
          `Research journal revision decreased (${previousJournal.revision} -> ${journal.revision}).`,
        );
      }
      if (
        journal.ownerExecutionAttemptId !==
          previousJournal.ownerExecutionAttemptId &&
        journal.revision === previousJournal.revision
      ) {
        throw new ResearchJournalError(
          "ownership_conflict",
          "Research owner changed without a revision-advancing recovery claim.",
        );
      }
    }

    assertWorkItemInvariants(workItems);
    latest = { journal, workItems };
    previousJournal = journal;
  }

  if (!manifest || !latest) {
    throw new ResearchJournalError(
      "not_found",
      "Research journal stream did not contain a usable snapshot.",
    );
  }
  return { manifest, journal: latest.journal, workItems: latest.workItems };
}

/**
 * Work-item integrity: completed work must carry a receipt and completion
 * time; a receipt must pair exactly with its work item's identity; failed
 * work may only carry a safe identifier error code (never raw text).
 */
function assertWorkItemInvariants(
  workItems: readonly ResearchWorkItem[],
): void {
  for (const item of workItems) {
    if (item.status === "completed") {
      if (!item.receipt || !item.completedAt) {
        throw new ResearchJournalError(
          "missing_receipt",
          `Completed research work item '${item.taskId}' is missing its receipt or completion time.`,
        );
      }
      const receipt = item.receipt;
      if (
        receipt.taskId !== item.taskId ||
        receipt.assignmentId !== item.assignmentId ||
        receipt.attempt !== item.attempt ||
        receipt.workerSpecHash !== item.workerSpecHash
      ) {
        throw new ResearchJournalError(
          "invalid_receipt",
          `Research receipt for work item '${item.taskId}' does not match its attempt identity.`,
        );
      }
    }
    if (item.status === "failed" && item.errorCode !== undefined) {
      if (!SAFE_ID_PATTERN.test(item.errorCode)) {
        throw new ResearchJournalError(
          "unsafe_metadata",
          `Research work item '${item.taskId}' carries an unsafe error code.`,
        );
      }
    }
  }
}

/**
 * Lag tracking for the research file projection, in the shared
 * projection-metadata shape so recovery can classify it uniformly.
 */
export function createResearchProjectionMetadataStore(
  journal: ExecutionJournal,
  clock?: { readonly now: () => number },
): JournalProjectionMetadataStore {
  return new JournalProjectionMetadataStore({
    projectionId: RESEARCH_RUN_PROJECTION_ID,
    reducerVersion: RESEARCH_RUN_REDUCER_VERSION,
    projectionDirectory: journalProjectionsDirectory(journal),
    ...(clock === undefined ? {} : { clock }),
  });
}
