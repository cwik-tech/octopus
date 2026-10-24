import * as z from "zod/v4";

function exactBodySchema(
  expectedKeys: readonly string[],
): z.ZodType<Record<string, unknown>> {
  return z
    .object(
      {},
      { error: "Request body must be a JSON object" },
    )
    .passthrough()
    .refine(
      (body) => {
        const actual = Object.keys(body).sort();
        const expected = [...expectedKeys].sort();
        return (
          actual.length === expected.length &&
          actual.every((key, index) => key === expected[index])
        );
      },
      {
        error: `Request body must contain only ${expectedKeys.join(" and ")}`,
      },
    );
}

function requiredStringSchema(field: string) {
  return z
    .string({ error: `Field ${field} is required` })
    .trim()
    .min(1, { error: `Field ${field} is required` });
}

export const researchPlanGenerationRequestSchema = exactBodySchema([
  "expectedPlanId",
]).pipe(
  z.object({
    expectedPlanId: requiredStringSchema("expectedPlanId"),
  }),
);

export const researchPlanApprovalRequestSchema = exactBodySchema([
  "expectedPlanId",
  "expectedResearchPlanHash",
])
  .pipe(
    z.object({
      expectedResearchPlanHash: requiredStringSchema(
        "expectedResearchPlanHash",
      ).regex(/^[a-f0-9]{64}$/, {
        error:
          "Field expectedResearchPlanHash must be a SHA-256 hash",
      }),
      expectedPlanId: requiredStringSchema("expectedPlanId"),
    }),
  )
  .transform(({ expectedPlanId, expectedResearchPlanHash }) => ({
    expectedPlanId,
    expectedResearchPlanHash,
  }));

export type ResearchPlanGenerationRequestBody = z.infer<
  typeof researchPlanGenerationRequestSchema
>;
export type ResearchPlanApprovalRequestBody = z.infer<
  typeof researchPlanApprovalRequestSchema
>;
