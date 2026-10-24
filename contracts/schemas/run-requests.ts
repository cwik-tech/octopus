import * as z from "zod/v4";
import { whenDefined } from "../../core/optional-properties.js";

const runEnvironmentSchema = z.record(
  z.string(),
  z.string({
    error: (issue) =>
      `Field env.${String(issue.path?.[issue.path.length - 1])} must be a string`,
  }),
  { error: "Field env must be an object of string values" },
);

export const runStartRequestSchema = z
  .object(
    {
      cwd: z
        .string({ error: "Missing required field: cwd" })
        .refine((value) => value.trim().length > 0, {
          error: "Missing required field: cwd",
        }),
      env: runEnvironmentSchema.optional(),
    },
    { error: "Request body must be a JSON object" },
  )
  .transform(({ cwd, env }) => ({
    cwd,
    ...whenDefined(env, (presentEnv) => ({ env: presentEnv })),
  }));

export type ParsedRunStartRequest = z.infer<
  typeof runStartRequestSchema
>;
