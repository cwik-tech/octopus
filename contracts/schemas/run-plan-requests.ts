import * as z from "zod/v4";

function requiredStringSchema(field: string) {
  return z
    .string({ error: `Field ${field} is required` })
    .trim()
    .min(1, { error: `Field ${field} is required` });
}

export const runPlanWorkflowSelectionRequestSchema = z.object(
  {
    workflowId: requiredStringSchema("workflowId"),
    expectedPlanId: requiredStringSchema("expectedPlanId"),
  },
  { error: "Request body must be a JSON object" },
);

export type RunPlanWorkflowSelectionRequestBody = z.infer<
  typeof runPlanWorkflowSelectionRequestSchema
>;
