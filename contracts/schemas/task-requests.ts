import { MAX_CONTEXT_RESULTS_PER_TURN } from "./result-reference.js";
import * as z from "zod/v4";

import { workspaceProjectContextSelectionSchema } from "./project-requests.js";

const TARGET_ERROR =
  "Request must name exactly one of workflowId or teamId";

export const taskCreateRequestSchema = z
  .object(
    {
      workflowId: z
        .string({
          error:
            "Field workflowId is required and must be a non-empty string",
        })
        .trim()
        .min(1, {
          error:
            "Field workflowId is required and must be a non-empty string",
        })
        .optional(),
      /**
       * A chat-selected team. The server materializes its one-step wrapper
       * workflow, so callers never name the generated id themselves.
       */
      teamId: z
        .string({
          error: "Field teamId must be a non-empty string",
        })
        .trim()
        .min(1, { error: "Field teamId must be a non-empty string" })
        .optional(),
      /**
       * Completed results this run carries forward, chosen in the composer.
       *
       * The same contract the message endpoint uses, because a Workflow task
       * brief is one of the four places a handoff has to reach.
       */
      contextResultIds: z
        .array(
          z
            .string({
              error: "Field contextResultIds must contain non-empty strings",
            })
            .trim()
            .min(1, {
              error: "Field contextResultIds must contain non-empty strings",
            })
            .max(400, {
              error: "Field contextResultIds contains an oversized id",
            }),
          { error: "Field contextResultIds must be an array" },
        )
        .nullish()
        .transform((values) => [...new Set(values ?? [])])
        .refine((values) => values.length <= MAX_CONTEXT_RESULTS_PER_TURN, {
          error: `Field contextResultIds exceeds ${MAX_CONTEXT_RESULTS_PER_TURN} results`,
        }),
      brief: z
        .string({ error: "Field brief must be a string" })
        .optional(),
      projectContext: workspaceProjectContextSelectionSchema.optional(),
    },
    { error: "Request body must be a JSON object" },
  )
  .refine(
    ({ workflowId, teamId }) =>
      (workflowId === undefined) !== (teamId === undefined),
    { error: TARGET_ERROR },
  )
  .transform(({ workflowId, teamId, brief, projectContext, contextResultIds }) => ({
    ...(workflowId !== undefined ? { workflowId } : {}),
    ...(teamId !== undefined ? { teamId } : {}),
    brief,
    ...(projectContext ? { projectContext } : {}),
    ...(contextResultIds.length > 0 ? { contextResultIds } : {}),
  }));

export type TaskCreateRequestBody = z.infer<
  typeof taskCreateRequestSchema
>;
