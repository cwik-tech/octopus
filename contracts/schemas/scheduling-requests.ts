import * as z from "zod/v4";

import {
  isSafeWorkspaceProjectContextFilename,
  isValidWorkspaceProjectId,
} from "../projects.js";

const MAX_NAME_LENGTH = 120;
const MAX_TARGET_LENGTH = 200;
const MAX_PROMPT_LENGTH = 20_000;
const MAX_CRON_LENGTH = 100;
const MAX_LABEL_LENGTH = 200;

const SCHEDULE_FIELD_KEYS = [
  "name",
  "kind",
  "target",
  "modelOverride",
  "projectId",
  "projectContext",
  "prompt",
  "cron",
  "timezone",
  "scheduleLabel",
  "overlap",
  "notifyOnFailure",
  "enabled",
] as const;

const EXPLICIT_UNDEFINED = Symbol("explicit schedule patch undefined");

function scheduleBodySchema(
  subject: "Schedule" | "Schedule patch",
) {
  return z
    .object(
      {},
      { error: `${subject} must be a JSON object.` },
    )
    .passthrough()
    .superRefine((body, context) => {
      const unknown = Object.keys(body).filter(
        (key) =>
          !SCHEDULE_FIELD_KEYS.includes(
            key as (typeof SCHEDULE_FIELD_KEYS)[number],
          ),
      );
      if (unknown.length > 0) {
        context.addIssue({
          code: "custom",
          message: `${subject} contains unknown fields: ${unknown.join(", ")}.`,
        });
      }
    });
}

function scheduleStringSchema(key: string, maxLength: number) {
  const message =
    `Schedule field '${key}' must be a non-empty string of at most ${maxLength} characters.`;
  return z
    .string({
      error: `Schedule field '${key}' must be a string.`,
    })
    .trim()
    .min(1, { error: message })
    .max(maxLength, { error: message });
}

const scheduleKindSchema = z.enum(["agent", "workflow"], {
  error: "Schedule field 'kind' must be 'agent' or 'workflow'.",
});

const overlapPolicySchema = z.enum(
  ["skip", "queue", "cancel_previous"],
  {
    error:
      "Schedule field 'overlap' must be 'skip', 'queue', or 'cancel_previous'.",
  },
);

const timezoneSchema = z
  .string({
    error:
      "Schedule field 'timezone' must be a valid IANA timezone.",
  })
  .trim()
  .min(1, {
    error:
      "Schedule field 'timezone' must be a valid IANA timezone.",
  })
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    {
      error:
        "Schedule field 'timezone' must be a valid IANA timezone.",
    },
  );

function scheduleBooleanSchema(key: string, required: boolean) {
  return z.boolean({
    error: (issue) =>
      (issue.input === undefined && required) ||
      issue.input === EXPLICIT_UNDEFINED
        ? `Schedule field '${key}' is required.`
        : `Schedule field '${key}' must be a boolean.`,
  });
}

/**
 * A retired control that must fail loudly.
 *
 * A schedule runs an Agent; it never chose the Agent's model. Accepting this
 * field would report success for a setting the run ignores, leaving the user
 * believing a schedule pins a model.
 */
const retiredModelOverrideSchema = z
  .unknown()
  .refine(
    (value) =>
      value === undefined ||
      value === null ||
      // A patch that explicitly clears the field is removing dead data, which
      // is fine. Only *setting* it claims a control that no longer works.
      value === EXPLICIT_UNDEFINED,
    {
      error:
        "Schedule field 'modelOverride' is no longer supported. An agent runs with its own provider/model, or with the application default from Settings.",
    },
  );

const scheduleProjectIdSchema = z
  .string({ error: "Schedule field 'projectId' must be a UUID." })
  .refine(isValidWorkspaceProjectId, {
    error: "Schedule field 'projectId' must be a UUID.",
  });

const scheduleProjectContextSchema = z.object({
  version: z.literal(1, {
    error: "Schedule field 'projectContext.version' must be 1.",
  }),
  includeBrief: z.boolean({
    error: "Schedule field 'projectContext.includeBrief' must be a boolean.",
  }),
  fileNames: z
    .array(
      z
        .string({
          error:
            "Schedule field 'projectContext.fileNames' contains an invalid filename.",
        })
        .trim()
        .refine(isSafeWorkspaceProjectContextFilename, {
          error:
            "Schedule field 'projectContext.fileNames' contains an invalid filename.",
        }),
    )
    .max(20, {
      error:
        "Schedule field 'projectContext.fileNames' must contain at most 20 files.",
    })
    .refine((fileNames) => new Set(fileNames).size === fileNames.length, {
      error:
        "Schedule field 'projectContext.fileNames' must not contain duplicates.",
    }),
});

const scheduleCreateHeaderSchema = scheduleBodySchema("Schedule")
  .pipe(
    z
      .object({
        kind: scheduleKindSchema,
        modelOverride: retiredModelOverrideSchema.optional(),
        projectId: scheduleProjectIdSchema.optional(),
        projectContext: scheduleProjectContextSchema.optional(),
      })
      .passthrough(),
  )
  .pipe(
    z
      .object({
        kind: scheduleKindSchema,
        projectId: scheduleProjectIdSchema.optional(),
        projectContext: scheduleProjectContextSchema.optional(),
        enabled: scheduleBooleanSchema("enabled", false).optional(),
      })
      .passthrough(),
  );

export const scheduleCreateRequestSchema =
  scheduleCreateHeaderSchema.pipe(
    z.object({
      name: scheduleStringSchema("name", MAX_NAME_LENGTH),
      kind: scheduleKindSchema,
      target: scheduleStringSchema("target", MAX_TARGET_LENGTH),
      projectId: scheduleProjectIdSchema.optional(),
      projectContext: scheduleProjectContextSchema.optional(),
      prompt: scheduleStringSchema("prompt", MAX_PROMPT_LENGTH),
      cron: scheduleStringSchema("cron", MAX_CRON_LENGTH),
      timezone: timezoneSchema,
      scheduleLabel: scheduleStringSchema(
        "scheduleLabel",
        MAX_LABEL_LENGTH,
      ),
      overlap: overlapPolicySchema,
      notifyOnFailure: scheduleBooleanSchema(
        "notifyOnFailure",
        true,
      ),
      enabled: scheduleBooleanSchema("enabled", false).optional(),
    }),
  ).transform(
    ({
      name,
      kind,
      target,
      projectId,
      projectContext,
      prompt,
      cron,
      timezone,
      scheduleLabel,
      overlap,
      notifyOnFailure,
      enabled,
    }) => ({
      name,
      kind,
      target,
      ...(projectId ? { projectId } : {}),
      ...(projectContext ? { projectContext } : {}),
      prompt,
      cron,
      timezone,
      scheduleLabel,
      overlap,
      notifyOnFailure,
      ...(enabled === undefined ? {} : { enabled }),
    }),
  ).refine(
    (body) => body.projectContext === undefined || body.projectId !== undefined,
    { error: "Schedule field 'projectContext' requires 'projectId'." },
  );

const schedulePatchBodySchema = scheduleBodySchema(
  "Schedule patch",
).refine((body) => Object.keys(body).length > 0, {
  error: "Schedule patch must contain at least one field.",
});

const schedulePatchFieldsSchema = z.object({
  name: scheduleStringSchema("name", MAX_NAME_LENGTH).optional(),
  kind: scheduleKindSchema.optional(),
  target: scheduleStringSchema(
    "target",
    MAX_TARGET_LENGTH,
  ).optional(),
  modelOverride: retiredModelOverrideSchema.optional().transform(() => undefined),
  projectId: scheduleProjectIdSchema.nullable().optional(),
  projectContext: scheduleProjectContextSchema.nullable().optional(),
  prompt: scheduleStringSchema(
    "prompt",
    MAX_PROMPT_LENGTH,
  ).optional(),
  cron: scheduleStringSchema("cron", MAX_CRON_LENGTH).optional(),
  timezone: timezoneSchema.optional(),
  scheduleLabel: scheduleStringSchema(
    "scheduleLabel",
    MAX_LABEL_LENGTH,
  ).optional(),
  overlap: overlapPolicySchema.optional(),
  notifyOnFailure: scheduleBooleanSchema(
    "notifyOnFailure",
    true,
  ).optional(),
  enabled: scheduleBooleanSchema("enabled", true).optional(),
});

export const schedulePatchRequestSchema = z.preprocess((value) => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      entry === undefined ? EXPLICIT_UNDEFINED : entry,
    ]),
  );
}, schedulePatchBodySchema.pipe(schedulePatchFieldsSchema));

export type ParsedScheduleCreateRequest = z.infer<
  typeof scheduleCreateRequestSchema
>;
export type ParsedSchedulePatchRequest = z.infer<
  typeof schedulePatchRequestSchema
>;
