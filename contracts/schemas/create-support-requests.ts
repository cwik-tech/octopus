import * as z from "zod/v4";

export function createRevealArtifactRequestSchema(params: {
  readonly isAbsolutePath: (value: string) => boolean;
}) {
  const artifactPathSchema = z
    .string({
      error: "Field artifactPath is required and must be a string",
    })
    .superRefine((value, context) => {
      const trimmed = value.trim();
      if (!trimmed) {
        context.addIssue({
          code: "custom",
          message: "Field artifactPath must not be empty",
        });
        return;
      }
      if (params.isAbsolutePath(trimmed) || trimmed.includes("\0")) {
        context.addIssue({
          code: "custom",
          message: "Field artifactPath must be a relative path",
        });
      }
    })
    .transform((value) => value.trim());

  return z.object(
    { artifactPath: artifactPathSchema },
    { error: "Request body must be a JSON object" },
  );
}

export type RevealArtifactRequestBody = z.infer<
  ReturnType<typeof createRevealArtifactRequestSchema>
>;
