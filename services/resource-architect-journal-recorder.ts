import { createHash } from 'node:crypto';
import { toCanonicalJsonObject, type CanonicalJsonObject } from '../contracts/canonical-json.js';
import type { ExecutionJournalEvent } from '../contracts/execution-journal.js';
import { isSafeResolverIdentifier } from '../contracts/model-diagnostics.js';
import {
  resourceArchitectFallbackPayloadSchema,
  resourceArchitectJournalJobIdSchema,
  resourceArchitectTerminalPayloadSchema,
  type ResourceArchitectFallbackPayload,
  type ResourceArchitectJournalTerminal,
} from '../contracts/schemas/resource-architect-journal.js';
import type { ResourceArchitectFeedbackDiagnostics } from '../contracts/schemas/resource-architect-review.js';
import { isSafePathSegment } from '../core/path-safety.js';
import type { ConversationJournalLease, WorkspaceConversationJournalRegistry } from './workspace-conversation-journal-registry.js';

export const RESOURCE_ARCHITECT_JOURNAL_STREAM = 'resource-architect.review';
const FALLBACK_EVENT = 'resource-architect.review.fallback';
const TERMINAL_EVENT = 'resource-architect.review.terminal';
const PUBLICATION_FAILED_EVENT = 'resource-architect.review.publication-failed';
type JournalStage = 'fallback' | 'terminal' | 'publication-failed';

export interface ResourceArchitectJournalRecorder {
  recordFallback(review: ResourceArchitectFeedbackDiagnostics): Promise<void>;
  recordTerminal(outcome: ResourceArchitectJournalTerminal): Promise<void>;
  recordPublicationFailed(): Promise<void>;
  release(): Promise<void>;
}
interface JournalRequest {
  registry: WorkspaceConversationJournalRegistry;
  conversationId: string;
  jobId: string;
}
export type ResourceArchitectJournalRead =
  | { kind: 'absent' | 'unreadable' }
  | { kind: 'read'; activityId: string; jobId?: string; eventCount: number; fallback?: ResourceArchitectFallbackPayload; terminal?: ResourceArchitectJournalTerminal; serverTerminal?: ResourceArchitectJournalTerminal; publicationFailed?: true };

export class ResourceArchitectJournalRecordingError extends Error {
  constructor(readonly stage: JournalStage, readonly outcome: string) {
    super(`Agent Architect could not record ${stage}: ${outcome}.`);
    this.name = 'ResourceArchitectJournalRecordingError';
  }
}

/** Hash correlation text into the existing activity UUID shape without changing it. */
export function resourceArchitectJournalActivityId(jobId: string): string {
  const valid = resourceArchitectJournalJobIdSchema.parse(jobId);
  return stableUuid(`resource-architect/activity/${valid}`);
}
function stableUuid(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function scopeFor(conversationId: string, activityId: string) {
  resourceArchitectJournalJobIdSchema.parse(conversationId);
  if (!isSafePathSegment(conversationId)) throw new Error('Invalid Create conversation identity.');
  return { owner: { kind: 'create-resource-architect' as const, conversationId }, activityId, activityKind: 'turn' as const };
}

export async function resolveResourceArchitectJournalRecorder(input: JournalRequest): Promise<ResourceArchitectJournalRecorder> {
  const activityId = resourceArchitectJournalActivityId(input.jobId);
  const lease = await input.registry.acquire(scopeFor(input.conversationId, activityId));
  if (!lease) throw new ResourceArchitectJournalRecordingError('fallback', 'journal_unavailable');
  return new Recorder(lease, input.conversationId, input.jobId, activityId);
}

class Recorder implements ResourceArchitectJournalRecorder {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly lease: ConversationJournalLease, private readonly conversationId: string, private readonly jobId: string, private readonly activityId: string) {}

  recordFallback(review: ResourceArchitectFeedbackDiagnostics): Promise<void> {
    return this.enqueue(async () => {
      if (review.reviewStatus !== 'not_reviewed' || review.failureReason === undefined) {
        throw new ResourceArchitectJournalRecordingError('fallback', 'invalid_review_status');
      }
      const requestedReviewer = safePair(review.requestedReviewer);
      const attemptedReviewers = review.phases.filter(phase => phase.phase === 'review')
        .flatMap(phase => {
          const pair = safePair(phase);
          return pair ? [pair] : [];
        });
      const payload = resourceArchitectFallbackPayloadSchema.parse({
        jobId: this.jobId,
        conversationId: this.conversationId,
        reviewerId: 'reviewer-of-agent-architect',
        ...(requestedReviewer ? { requestedReviewer } : {}),
        attemptedReviewers,
        defaultFallbackAttempted: review.defaultFallbackAttempted,
        reason: review.failureReason,
        ...(review.diagnosticCode === undefined ? {} : { diagnosticCode: review.diagnosticCode }),
        reviewStatus: 'not_reviewed',
        action: 'return_unreviewed_draft',
        proposalSuppressed: true,
      });
      await this.append('fallback', FALLBACK_EVENT, toCanonicalJsonObject(payload));
    });
  }
  recordTerminal(outcome: ResourceArchitectJournalTerminal): Promise<void> {
    return this.enqueue(async () => {
      const payload = resourceArchitectTerminalPayloadSchema.parse({ jobId: this.jobId, conversationId: this.conversationId, outcome });
      await this.append('terminal', TERMINAL_EVENT, payload);
    });
  }
  recordPublicationFailed(): Promise<void> {
    return this.enqueue(async () => {
      const payload = resourceArchitectTerminalPayloadSchema.parse({ jobId: this.jobId, conversationId: this.conversationId, outcome: 'failed' });
      await this.append('publication-failed', PUBLICATION_FAILED_EVENT, payload);
    });
  }
  async release(): Promise<void> {
    await this.tail;
    await this.lease.release();
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const operation = this.tail.then(work);
    // Preserve serialization after failure; the original promise rejects to its caller.
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  private async append(stage: JournalStage, type: string, payload: CanonicalJsonObject): Promise<void> {
    const scan = await this.lease.journal.scanStream(RESOURCE_ARCHITECT_JOURNAL_STREAM, this.activityId);
    const eventId = stableUuid(`${this.activityId}/${stage}`);
    const existing = scan.events.find(event => event.eventId === eventId);
    const terminalEvent = scan.events.find(event => event.type === TERMINAL_EVENT);
    if (stage === 'publication-failed' && terminalEvent?.payload.outcome !== 'completed') {
      throw new ResourceArchitectJournalRecordingError(stage, 'completion_required');
    }
    if (!existing && stage !== 'publication-failed' && terminalEvent) {
      throw new ResourceArchitectJournalRecordingError(stage, 'already_terminal');
    }
    const outcome = await this.lease.journal.append({
      eventId,
      streamKind: RESOURCE_ARCHITECT_JOURNAL_STREAM,
      streamId: this.activityId,
      expectedStreamRevision: existing ? existing.streamRevision - 1 : scan.eventCount,
      type,
      payloadSchemaVersion: 1,
      payload,
      correlationId: this.jobId,
    });
    if (outcome.kind !== 'appended' && outcome.kind !== 'already-accepted') {
      throw new ResourceArchitectJournalRecordingError(stage, outcome.kind);
    }
  }
}
function safePair(pair: { provider: string; model: string } | undefined) {
  return pair && isSafeResolverIdentifier(pair.provider) && isSafeResolverIdentifier(pair.model)
    ? { provider: pair.provider, model: pair.model } : undefined;
}

export async function readResourceArchitectJournal(input: JournalRequest): Promise<ResourceArchitectJournalRead> {
  return readResourceArchitectJournalActivity({ ...input, activityId: resourceArchitectJournalActivityId(input.jobId) });
}
export async function readResourceArchitectJournalActivity(input: {
  registry: WorkspaceConversationJournalRegistry;
  conversationId: string;
  activityId: string;
}): Promise<ResourceArchitectJournalRead> {
  const snapshot = await input.registry.snapshot(scopeFor(input.conversationId, input.activityId));
  if (snapshot.kind !== 'read') return { kind: snapshot.kind };
  if (snapshot.manifest.ownerKind !== 'create-resource-architect' || snapshot.manifest.conversationId !== input.conversationId || snapshot.manifest.scopeId !== input.activityId) return { kind: 'unreadable' };
  return summarizeEvents(input, snapshot.events);
}
function summarizeEvents(input: { conversationId: string; activityId: string }, events: readonly ExecutionJournalEvent[]): ResourceArchitectJournalRead {
  let fallback: ResourceArchitectFallbackPayload | undefined;
  let terminal: ResourceArchitectJournalTerminal | undefined;
  let jobId: string | undefined;
  let publicationFailed = false;
  for (const event of events) {
    if (event.streamKind !== RESOURCE_ARCHITECT_JOURNAL_STREAM || event.streamId !== input.activityId || event.payloadSchemaVersion !== 1) return { kind: 'unreadable' };
    const parsed = event.type === FALLBACK_EVENT
      ? resourceArchitectFallbackPayloadSchema.safeParse(event.payload)
      : (event.type === TERMINAL_EVENT || event.type === PUBLICATION_FAILED_EVENT) ? resourceArchitectTerminalPayloadSchema.safeParse(event.payload) : undefined;
    if (!parsed?.success || parsed.data.conversationId !== input.conversationId || event.correlationId !== parsed.data.jobId || resourceArchitectJournalActivityId(parsed.data.jobId) !== input.activityId || (jobId !== undefined && jobId !== parsed.data.jobId)) return { kind: 'unreadable' };
    jobId = parsed.data.jobId;
    if ('outcome' in parsed.data && event.type === PUBLICATION_FAILED_EVENT) {
      if (terminal !== 'completed' || publicationFailed || parsed.data.outcome !== 'failed') return { kind: 'unreadable' };
      publicationFailed = true;
    } else if ('outcome' in parsed.data) {
      if (terminal !== undefined) return { kind: 'unreadable' };
      terminal = parsed.data.outcome;
    } else {
      if (fallback !== undefined || terminal !== undefined) return { kind: 'unreadable' };
      fallback = parsed.data;
    }
  }
  return { kind: 'read', activityId: input.activityId, eventCount: events.length, ...(jobId === undefined ? {} : { jobId }), ...(fallback ? { fallback } : {}), ...(terminal ? { terminal: publicationFailed ? 'failed' : terminal } : {}), ...(publicationFailed && terminal !== undefined ? { serverTerminal: terminal, publicationFailed: true as const } : {}) };
}
