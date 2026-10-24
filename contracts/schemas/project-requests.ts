import * as z from "zod/v4";
import { whenDefined } from "../../core/optional-properties.js";

import {
  isSafeWorkspaceProjectContextFilename,
  isValidWorkspaceProjectId,
} from "../projects.js";
import { isValidSessionId } from "../sessions.js";

const projectContextFilenameSchema = z
  .string({
    error: "Field projectContext.fileNames contains an invalid filename",
  })
  .refine(isSafeWorkspaceProjectContextFilename, {
    error: "Field projectContext.fileNames contains an invalid filename",
  });

export const workspaceProjectContextSelectionSchema = z.object(
  {
    projectId: z
      .string({ error: "Field projectContext.projectId must be a UUID" })
      .refine(isValidWorkspaceProjectId, {
        error: "Field projectContext.projectId must be a UUID",
      }),
    includeBrief: z.boolean({
      error: "Field projectContext.includeBrief must be a boolean",
    }),
    fileNames: z
      .array(projectContextFilenameSchema, {
        error: "Field projectContext.fileNames must be an array",
      })
      .max(20, { error: "Field projectContext.fileNames exceeds 20 files" })
      .refine((fileNames) => new Set(fileNames).size === fileNames.length, {
        error: "Field projectContext.fileNames must not contain duplicates",
      }),
  },
  { error: "Field projectContext must be an object" },
);

const projectNameSchema = z
  .string({ error: "Field name is required and must be a string" })
  .trim()
  .min(1, { error: "Field name must not be empty" })
  .max(200, { error: "Field name exceeds 200 characters" });

const projectDescriptionSchema = z
  .string({ error: "Field description must be a string" })
  .trim()
  .max(20_000, { error: "Field description exceeds 20000 characters" })
  .optional();

export const projectCreateRequestSchema = z.object(
  {
    name: projectNameSchema,
    description: projectDescriptionSchema,
  },
  { error: "Request body must be a JSON object" },
).transform((body) => ({
  name: body.name,
  ...whenDefined(body.description, (description) => ({ description })),
}));

export const projectUpdateRequestSchema = z
  .object(
    {
      name: projectNameSchema.optional(),
      description: projectDescriptionSchema,
      status: z.enum(["active", "archived"], {
        error: "Field status must be active or archived",
      }).optional(),
    },
    { error: "Request body must be a JSON object" },
  )
  .refine(
    (input) =>
      input.name !== undefined ||
      input.description !== undefined ||
      input.status !== undefined,
    { error: "At least one project field must be provided" },
  )
  .transform((body) => ({
    ...whenDefined(body.name, (name) => ({ name })),
    ...whenDefined(body.description, (description) => ({ description })),
    ...whenDefined(body.status, (status) => ({ status })),
  }));

export const projectDeleteRequestSchema = z.object(
  {
    mode: z.enum(["delete_sessions", "ungroup_sessions"], {
      error: "Field mode must be delete_sessions or ungroup_sessions",
    }),
  },
  { error: "Request body must be a JSON object" },
);

export const projectBriefUpdateRequestSchema = z.object(
  {
    content: z
      .string({ error: "Field content is required and must be a string" })
      .max(100_000, { error: "Field content exceeds 100000 characters" }),
  },
  { error: "Request body must be a JSON object" },
);

export const projectMemoryProposalCreateRequestSchema = z.object(
  {
    content: z
      .string({ error: "Field content is required and must be a string" })
      .trim()
      .min(1, { error: "Field content must not be empty" })
      .max(20_000, { error: "Field content exceeds 20000 characters" }),
    sourceSessionId: z
      .string({ error: "Field sourceSessionId must be a UUID" })
      .refine(isValidSessionId, {
        error: "Field sourceSessionId must be a UUID",
      })
      .optional(),
  },
  { error: "Request body must be a JSON object" },
).transform((body) => ({
  content: body.content,
  ...whenDefined(body.sourceSessionId, (sourceSessionId) => ({ sourceSessionId })),
}));

export type ProjectCreateRequestBody = z.infer<
  typeof projectCreateRequestSchema
>;
export type ProjectUpdateRequestBody = z.infer<
  typeof projectUpdateRequestSchema
>;
export type ProjectDeleteRequestBody = z.infer<
  typeof projectDeleteRequestSchema
>;
export type ProjectBriefUpdateRequestBody = z.infer<
  typeof projectBriefUpdateRequestSchema
>;
export type ProjectMemoryProposalCreateRequestBody = z.infer<
  typeof projectMemoryProposalCreateRequestSchema
>;
