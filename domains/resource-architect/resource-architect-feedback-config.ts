import * as z from "zod/v4";

const feedbackEnvironmentSchema = z.object({
  PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED: z.enum(["true", "false"], {
    error: "PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED must be true or false.",
  }).optional(),
}).transform((environment) => ({
  reviewEnabled: environment.PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED !== "false",
}));

export type ResourceArchitectFeedbackConfig = z.infer<typeof feedbackEnvironmentSchema>;

/** Call once at server startup, then inject the resolved value into each Create turn. */
export function parseResourceArchitectFeedbackConfig(environment: unknown): ResourceArchitectFeedbackConfig {
  return feedbackEnvironmentSchema.parse(environment);
}
