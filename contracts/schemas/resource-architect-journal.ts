import * as z from 'zod/v4';
import { isSafeResolverIdentifier } from '../model-diagnostics.js';
import { resourceArchitectFeedbackDiagnosticsSchema } from './resource-architect-review.js';

export const resourceArchitectJournalJobIdSchema = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u);
const safeIdentifier = z.string().refine(isSafeResolverIdentifier);
const pair = z.strictObject({ provider: safeIdentifier, model: safeIdentifier });

export const resourceArchitectFallbackPayloadSchema = z.strictObject({
  jobId: resourceArchitectJournalJobIdSchema,
  conversationId: resourceArchitectJournalJobIdSchema,
  reviewerId: z.literal('reviewer-of-agent-architect'),
  requestedReviewer: pair.optional(),
  attemptedReviewers: z.array(pair).max(2),
  defaultFallbackAttempted: z.boolean(),
  reason: resourceArchitectFeedbackDiagnosticsSchema.shape.failureReason.unwrap(),
  diagnosticCode: resourceArchitectFeedbackDiagnosticsSchema.shape.diagnosticCode,
  reviewStatus: z.literal('not_reviewed'),
  action: z.literal('return_unreviewed_draft'),
  proposalSuppressed: z.literal(true),
});
export type ResourceArchitectFallbackPayload = z.infer<typeof resourceArchitectFallbackPayloadSchema>;

export const resourceArchitectTerminalPayloadSchema = z.strictObject({
  jobId: resourceArchitectJournalJobIdSchema,
  conversationId: resourceArchitectJournalJobIdSchema,
  outcome: z.enum(['completed', 'failed', 'cancelled']),
});
export type ResourceArchitectJournalTerminal = z.infer<typeof resourceArchitectTerminalPayloadSchema>['outcome'];
