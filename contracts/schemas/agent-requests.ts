import * as z from "zod/v4";

import { whenDefined } from "../../core/optional-properties.js";

const PACKAGE_KINDS = [
  "skill",
  "template",
  "reference",
  "script",
  "context",
] as const;
const PACKAGE_IMPORT_ACTIONS = [
  "add",
  "skip",
  "replace",
  "keepBoth",
] as const;

function requiredTrimmedString(field: string) {
  const message =
    `Field ${field} is required and must be a non-empty string`;
  return z
    .string({ error: message })
    .refine((value) => value.trim().length > 0, { error: message })
    .transform((value) => value.trim());
}

function requiredStringValue(field: string) {
  return z.string({
    error: `Field ${field} is required and must be a string`,
  });
}

function requiredRawNonBlankString(field: string) {
  const message =
    `Field ${field} is required and must be a non-empty string`;
  return z
    .string({ error: message })
    .refine((value) => value.trim().length > 0, { error: message });
}

function optionalModelSchema(field: string) {
  return z.preprocess(
    (value) => value === null ? undefined : value,
    z
      .string({ error: `Field ${field} must be a string` })
      .transform((value) => value.trim() || undefined)
      .optional(),
  );
}

const optionalJobIdSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim()
      ? value.trim()
      : undefined,
  z
    .string()
    .max(128, { error: "Field jobId exceeds 128 characters" })
    .optional(),
);

function defaultedTrimmedStringList(field: string) {
  const itemMessage = `${field}[] must be non-empty strings`;
  return z.preprocess(
    (value) => value ?? [],
    z.array(
      z
        .string({ error: itemMessage })
        .refine((item) => item.trim().length > 0, {
          error: itemMessage,
        })
        .transform((item) => item.trim()),
      { error: `Field ${field} must be an array` },
    ),
  );
}

function indexedArraySchema<Item>(
  arrayMessage: string,
  itemSchema: (index: number) => z.ZodType<Item>,
) {
  return z
    .array(z.unknown(), { error: arrayMessage })
    .transform((items, context) => {
      const parsedItems: Item[] = [];
      for (const [index, item] of items.entries()) {
        const result = itemSchema(index).safeParse(item);
        if (!result.success) {
          context.addIssue({
            code: "custom",
            message:
              result.error.issues[0]?.message ?? "Request body is invalid",
          });
          return z.NEVER;
        }
        parsedItems.push(result.data);
      }
      return parsedItems;
    });
}

const chatHistorySchema = z.preprocess(
  (value) => value ?? [],
  z.array(
    z.object(
      {
        role: z.enum(["user", "assistant"], {
          error: "chatHistory[].role must be 'user' or 'assistant'",
        }),
        text: z.string({
          error: "chatHistory[].text must be a string",
        }),
      },
      { error: "Each chatHistory entry must be an object" },
    ),
    { error: "Field chatHistory must be an array" },
  ),
);

const generatedSkillsSchema = z
  .array(
    z.object(
      {
        name: z.string({
          error: "generatedSkills[] items must have name and body strings",
        }),
        body: z.string({
          error: "generatedSkills[] items must have name and body strings",
        }),
      },
      {
        error: "generatedSkills[] items must have name and body strings",
      },
    ),
    { error: "Field generatedSkills must be an array" },
  )
  .transform((skills) => skills.length > 0 ? skills : undefined)
  .optional();

const packageKindSchema = z.enum(PACKAGE_KINDS, {
  error:
    "Field kind must be skill, template, reference, script, or context",
});

const packageFilesGateSchema = z
  .array(z.unknown(), {
    error: "Field files must be a non-empty array",
  })
  .min(1, { error: "Field files must be a non-empty array" });

const packageFilesSchema = indexedArraySchema(
  "Field files must be a non-empty array",
  (index) =>
    z.object(
      {
        relativePath: requiredTrimmedString(
          `files[${index}].relativePath`,
        ),
        contentBase64: requiredTrimmedString(
          `files[${index}].contentBase64`,
        ),
      },
      { error: `files[${index}] must be an object` },
    ),
);

const packageChoicesSchema = indexedArraySchema(
  "Field choices must be an array",
  (index) =>
    z
      .object(
        {
          selected: z.boolean({
            error: `choices[${index}].selected must be a boolean`,
          }),
          id: requiredTrimmedString(`choices[${index}].id`),
          action: z.enum(PACKAGE_IMPORT_ACTIONS, {
            error:
              `choices[${index}].action must be add, skip, replace, or keepBoth`,
          }),
        },
        { error: `choices[${index}] must be an object` },
      )
      .transform((choice) => ({
        id: choice.id,
        selected: choice.selected,
        action: choice.action,
      })),
).optional();

export const listSkillsRequestSchema = z.object(
  { path: requiredTrimmedString("path") },
  { error: "Request body must be a JSON object" },
);

export const draftAgentRequestSchema = z
  .object(
    {
      skillPaths: defaultedTrimmedStringList("skillPaths"),
      chatHistory: chatHistorySchema,
      duplicatePolicy: z
        .enum(["overwrite", "duplicate"], {
          error: "Field duplicatePolicy must be 'overwrite' or 'duplicate'",
        })
        .optional(),
      jobId: optionalJobIdSchema,
      provider: optionalModelSchema("provider"),
      model: optionalModelSchema("model"),
    },
    { error: "Request body must be a JSON object" },
  )
  .transform((body) => ({
    ...whenDefined(body.jobId, (jobId) => ({ jobId })),
    skillPaths: body.skillPaths,
    chatHistory: body.chatHistory,
    ...whenDefined(body.duplicatePolicy, (duplicatePolicy) => ({ duplicatePolicy })),
    ...(body.provider ? { provider: body.provider } : {}),
    ...(body.model ? { model: body.model } : {}),
  }));

export const commitAgentRequestSchema = z
  .object(
    {
      approvedName: requiredTrimmedString("approvedName"),
      personaMarkdown: requiredRawNonBlankString("personaMarkdown"),
      skillPaths: defaultedTrimmedStringList("skillPaths"),
      generatedSkills: generatedSkillsSchema,
      overwrite: z.preprocess(
        (value) => value === true,
        z.boolean(),
      ),
    },
    { error: "Request body must be a JSON object" },
  )
  .transform((body) => ({
    approvedName: body.approvedName,
    personaMarkdown: body.personaMarkdown,
    skillPaths: body.skillPaths,
    ...whenDefined(body.generatedSkills, (generatedSkills) => ({ generatedSkills })),
    ...whenDefined(body.overwrite, (overwrite) => ({ overwrite })),
  }));

export const refineAgentRequestSchema = z
  .object(
    {
      jobId: optionalJobIdSchema,
      agentName: requiredTrimmedString("agentName"),
      currentPersona: requiredStringValue("currentPersona"),
      chatHistory: chatHistorySchema,
      provider: optionalModelSchema("provider"),
      model: optionalModelSchema("model"),
    },
    { error: "Request body must be a JSON object" },
  )
  .transform((body) => ({
    ...whenDefined(body.jobId, (jobId) => ({ jobId })),
    agentName: body.agentName,
    currentPersona: body.currentPersona,
    chatHistory: body.chatHistory,
    ...(body.provider ? { provider: body.provider } : {}),
    ...(body.model ? { model: body.model } : {}),
  }));

export const saveAgentPersonaRequestSchema = z.object(
  {
    agentName: requiredTrimmedString("agentName"),
    personaMarkdown: requiredStringValue("personaMarkdown"),
  },
  { error: "Request body must be a JSON object" },
);

const agentPackageAddGateSchema = z
  .object(
    {
      files: packageFilesGateSchema,
    },
    { error: "Request body must be a JSON object" },
  )
  .passthrough();

export const agentPackageAddRequestSchema = agentPackageAddGateSchema.pipe(
  z.object(
    {
      agentName: requiredTrimmedString("agentName"),
      kind: packageKindSchema,
      files: packageFilesSchema,
    },
    { error: "Request body must be a JSON object" },
  ),
);

export const agentPackageImportRequestSchema = agentPackageAddGateSchema
  .pipe(
    z.object(
      {
        agentName: requiredTrimmedString("agentName"),
        kind: packageKindSchema,
        files: packageFilesSchema,
        choices: packageChoicesSchema,
      },
      { error: "Request body must be a JSON object" },
    ),
  )
  .transform((body) => ({
    agentName: body.agentName,
    preferredKind: body.kind,
    files: body.files,
    ...whenDefined(body.choices, (choices) => ({ choices })),
  }));

export const agentPackageRemoveRequestSchema = z
  .object(
    {
      agentName: requiredTrimmedString("agentName"),
      kind: packageKindSchema,
      agentPath: requiredTrimmedString("agentPath"),
      mode: z.preprocess(
        (value) => value === "disconnect" ? "disconnect" : "delete",
        z.enum(["disconnect", "delete"]),
      ),
    },
    { error: "Request body must be a JSON object" },
  )
  .transform((body) => ({
    agentName: body.agentName,
    kind: body.kind,
    agentPath: body.agentPath,
    mode: body.mode,
  }));

const deleteSkillsSchema = z
  .boolean({ error: "Field deleteSkills must be a boolean" })
  .optional();

export const deleteAgentRequestSchema = z
  .preprocess(
    (payload) => payload === undefined || payload === null ? {} : payload,
    z.object(
      { deleteSkills: deleteSkillsSchema },
      { error: "Request body must be a JSON object" },
    ),
  )
  .transform((body) => ({ deleteSkills: body.deleteSkills === true }));

export const deleteAgentByNameRequestSchema = z
  .object(
    {
      agentName: requiredTrimmedString("agentName"),
      deleteSkills: deleteSkillsSchema,
    },
    { error: "Request body must be a JSON object" },
  )
  .transform((body) => ({
    agentName: body.agentName,
    deleteSkills: body.deleteSkills === true,
  }));

export const addAgentToTeamRequestSchema = z
  .object(
    {
      role: z
        .string({ error: "Field role must be a string" })
        .transform((value) => value.trim())
        .optional(),
      agentName: requiredTrimmedString("agentName"),
      teamId: requiredTrimmedString("teamId"),
    },
    { error: "Request body must be a JSON object" },
  )
  .transform((body) => ({
    agentName: body.agentName,
    teamId: body.teamId,
    ...whenDefined(body.role, (role) => ({ role })),
  }));

const filteredAgentNamesSchema = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? value
          .filter((name): name is string => typeof name === "string")
          .map((name) => name.trim())
          .filter(Boolean)
      : undefined,
  z.array(z.string()).optional(),
);

const filteredHealthTargetsSchema = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? value.flatMap((target) => {
          if (
            !target ||
            typeof target !== "object" ||
            Array.isArray(target)
          ) {
            return [];
          }
          const record = target as Record<string, unknown>;
          const agentName =
            typeof record.agentName === "string"
              ? record.agentName.trim()
              : "";
          if (!agentName) return [];
          const provider =
            typeof record.provider === "string"
              ? record.provider.trim()
              : "";
          const model =
            typeof record.model === "string"
              ? record.model.trim()
              : "";
          return [{
            agentName,
            ...(provider ? { provider } : {}),
            ...(model ? { model } : {}),
          }];
        })
      : undefined,
  z.array(
    z.object({
      agentName: z.string(),
      provider: z.string().optional(),
      model: z.string().optional(),
    }).transform((target) => ({
      agentName: target.agentName,
      ...whenDefined(target.provider, (provider) => ({ provider })),
      ...whenDefined(target.model, (model) => ({ model })),
    })),
  ).optional(),
);

export const agentHealthRequestSchema = z
  .preprocess(
    (payload) =>
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : {},
    z.object({
      agentNames: filteredAgentNamesSchema,
      targets: filteredHealthTargetsSchema,
    }),
  )
  .transform((body) => ({
    ...(body.agentNames && body.agentNames.length > 0
      ? { agentNames: body.agentNames }
      : {}),
    ...(body.targets && body.targets.length > 0
      ? { targets: body.targets }
      : {}),
  }));

export type ListSkillsRequestBody = z.infer<
  typeof listSkillsRequestSchema
>;
export type DraftAgentRequestBody = z.infer<
  typeof draftAgentRequestSchema
>;
export type CommitAgentRequestBody = z.infer<
  typeof commitAgentRequestSchema
>;
export type AgentPackageFileRequest = z.infer<
  typeof packageFilesSchema
>[number];
export type AgentPackageAddRequestBody = z.infer<
  typeof agentPackageAddRequestSchema
>;
export type AgentPackageImportRequestBody = z.infer<
  typeof agentPackageImportRequestSchema
>;
export type AgentHealthRequestBody = z.infer<
  typeof agentHealthRequestSchema
>;
