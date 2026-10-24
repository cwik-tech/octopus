import * as z from "zod/v4";

function requiredReviewText(maximum: number) {
  return z.string().min(1).max(maximum).refine((value) => value.trim().length > 0);
}

const resourceArchitectReviewFindingSchema = z.strictObject({
  severity: z.enum(["low", "medium", "high"]),
  location: requiredReviewText(512),
  issue: requiredReviewText(2_000),
  requestedChange: requiredReviewText(2_000),
});

// Codex requires an object response schema and rejects a root oneOf. Keep the
// object shape transport-compatible and enforce verdict cardinality locally.
export const resourceArchitectReviewSchema = z.strictObject({
  verdict: z.enum(["pass", "revise"]),
  findings: z.array(resourceArchitectReviewFindingSchema).max(5),
}).superRefine((review, context) => {
  if (review.verdict === "pass" && review.findings.length !== 0) {
    context.addIssue({ code: "custom", path: ["findings"], message: "A passing review must contain no findings." });
  }
  if (review.verdict === "revise" && review.findings.length === 0) {
    context.addIssue({ code: "custom", path: ["findings"], message: "A revision requires at least one finding." });
  }
});

export type ResourceArchitectReview = z.infer<typeof resourceArchitectReviewSchema>;

export const RESOURCE_ARCHITECT_REVIEW_OUTPUT_SCHEMA = z.toJSONSchema(
  resourceArchitectReviewSchema,
  { target: "draft-7" },
);

const reviewerPairSchema = z.strictObject({
  provider: requiredReviewText(256),
  model: requiredReviewText(256),
});
const phaseSchema = z.enum(["draft", "review", "final"]);
const elapsedSchema = z.number().finite().nonnegative();
const tokenCountSchema = z.number().int().nonnegative();

/** Persist only selections, typed outcomes, and timing, never private review content. */
export const resourceArchitectFeedbackDiagnosticsSchema = z.strictObject({
  reviewStatus: z.enum(["completed", "disabled", "not_reviewed", "pending"]),
  reviewerId: z.literal("reviewer-of-agent-architect"),
  requestedReviewer: reviewerPairSchema.optional(),
  actualReviewer: reviewerPairSchema.optional(),
  defaultFallbackAttempted: z.boolean(),
  failureReason: z.enum([
    "reviewer_unavailable",
    "reviewer_timeout",
    "review_output_invalid",
    "reviewer_config_invalid",
    "reviewer_failed",
    "context_budget_exceeded",
  ]).optional(),
  diagnosticCode: z.string().min(1).max(96).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u).optional(),
  failedPhase: phaseSchema.optional(),
  phases: z.array(z.strictObject({
    phase: phaseSchema,
    provider: requiredReviewText(256),
    model: requiredReviewText(256),
    durationMs: elapsedSchema,
    startOffsetMs: elapsedSchema,
    firstProviderEventMs: elapsedSchema.nullable(),
    firstTextMs: elapsedSchema.nullable(),
    outcome: z.enum(["success", "failed", "cancelled"]),
  })).max(4),
  /**
   * What each phase request was estimated to cost before dispatch, and
   * whether it was sent. The selected Agent package rides in every phase, so
   * its size is recorded once and the dispatched phases are summed.
   */
  contextBudget: z.strictObject({
    selectedAgentPackageTokens: tokenCountSchema,
    phases: z.array(z.strictObject({
      phase: phaseSchema,
      estimatedInputTokens: tokenCountSchema,
      admissibleInputTokens: tokenCountSchema,
      dispatched: z.boolean(),
    })).max(4),
    aggregateEstimatedInputTokens: tokenCountSchema,
  }).optional(),
});

export type ResourceArchitectFeedbackDiagnostics = z.infer<typeof resourceArchitectFeedbackDiagnosticsSchema>;

export function resourceArchitectReviewWarnings(review: ResourceArchitectFeedbackDiagnostics): string[] {
  if (review.reviewStatus === "disabled") {
    return ["Review disabled. Reviewer of Agent Architect was not used."];
  }
  if (review.reviewStatus === "not_reviewed" && review.failureReason === "context_budget_exceeded") {
    if (review.failedPhase === "final") {
      return ["Not reviewed. The reviewed answer would not fit the Agent Architect's context window, so the unreviewed draft is shown."];
    }
    // The configured reviewer was asked and failed; only its fallback overflowed.
    return [review.defaultFallbackAttempted
      ? "Not reviewed. The configured model for Reviewer of Agent Architect was unavailable, and the complete request would not fit the application default's context window, so the application default was not asked."
      : "Not reviewed. The complete request would not fit the reviewer's context window, so Reviewer of Agent Architect was not asked."];
  }
  if (review.reviewStatus === "not_reviewed") {
    return ["Not reviewed. Reviewer of Agent Architect could not complete review."];
  }
  if (review.reviewStatus === "completed" && review.defaultFallbackAttempted) {
    return ["Reviewer of Agent Architect used the application default after its configured model was unavailable."];
  }
  return [];
}
