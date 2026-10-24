import { MAX_CONTEXT_RESULTS_PER_TURN } from "./result-reference.js";
import * as z from "zod/v4";

import { isValidWorkspaceProjectId } from "../projects.js";
import { isValidSessionId } from "../sessions.js";

import { workspaceProjectContextSelectionSchema } from "./project-requests.js";

const sessionCreateObjectSchema = z
  .object({
    title: z
      .string({ error: "Field title must be a string" })
      .optional(),
    projectId: z
      .string({ error: "Field projectId must be a UUID" })
      .refine(isValidWorkspaceProjectId, {
        error: "Field projectId must be a UUID",
      })
      .optional(),
    id: z
      .string({ error: "Field id must be a session id" })
      .refine(isValidSessionId, { error: "Field id must be a session id" })
      .optional(),
    // The token is ownership proof: presenting it is what entitles a retry to
    // be handed back a session someone already made. A guessable string would
    // make that entitlement guessable, so the format has to carry real entropy.
    creationToken: z
      .uuidv4({ error: "Field creationToken must be a v4 UUID" })
      .optional(),
  })
  // A claim is the pair. Honouring an id without the token that proves who
  // minted it would let a retry adopt a session it cannot show it created, and
  // a token without an id has nothing to claim.
  .refine(
    ({ id, creationToken }) =>
      (id === undefined) === (creationToken === undefined),
    { error: "Fields id and creationToken must be supplied together" },
  )
  .transform(({ title, projectId, id, creationToken }) => ({
    title,
    ...(projectId !== undefined ? { projectId } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(creationToken !== undefined ? { creationToken } : {}),
  }));

export const sessionCreateRequestSchema = z
  .unknown()
  .transform((input) =>
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? { kind: "object" as const, input }
      : { kind: "other" as const },
  )
  .pipe(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("object"),
        input: sessionCreateObjectSchema,
      }),
      z.object({
        kind: z.literal("other"),
      }),
    ]),
  )
  .transform((result) =>
    result.kind === "object" ? result.input : {},
  );

const sessionTitleSchema = z
  .string({
    error: "Field title is required and must be a string",
  })
  .trim()
  .min(1, { error: "Field title must not be empty" })
  .max(200, { error: "Field title exceeds 200 characters" });

export const sessionTitleRequestSchema = z.object(
  {
    title: sessionTitleSchema,
  },
  { error: "Request body must be a JSON object" },
);

const sessionTextSchema = z
  .string({
    error: "Field text is required and must be a string",
  })
  .trim()
  .min(1, { error: "Field text must not be empty" })
  .max(32_000, { error: "Field text exceeds 32000 characters" });

function optionalModelFieldSchema(field: "provider" | "model") {
  return z
    .string({ error: `Field ${field} must be a string` })
    // These are resolver identifiers, not free text. Bounding them prevents a
    // caller from carrying an arbitrary body through request diagnostics and
    // later lifecycle enrichment; 128 characters includes connection UUIDs.
    .max(128, { error: `Field ${field} exceeds 128 characters` })
    .nullish()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    });
}

/**
 * Who a turn is explicitly addressed to.
 *
 * Validated as a whole rather than field by field: the branches are mutually
 * exclusive addressees, so a body carrying two of them is a request nobody can
 * answer, not a request with one spare field to drop. Unknown keys are refused
 * for the same reason — silently discarding `teamId` from an Agents target
 * would send the turn somewhere the caller did not ask for.
 */
const TARGET_BRANCH_KEYS = {
  agents: ["kind", "agentNames"],
  team: ["kind", "teamId"],
  workflow: ["kind", "workflowId", "expectedPlanId"],
} as const;

type SessionMessageTargetKind = keyof typeof TARGET_BRANCH_KEYS;

function isTargetKind(value: unknown): value is SessionMessageTargetKind {
  return value === "agents" || value === "team" || value === "workflow";
}

function nonEmptyTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

const sessionMessageTargetSchema = z
  .unknown()
  .transform((raw, context) => {
    const fail = (message: string): never => {
      context.addIssue({ code: "custom", message });
      return z.NEVER;
    };

    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return fail("Field target must name agents, team, or workflow");
    }
    const record: Record<string, unknown> = { ...raw };
    const kind = record.kind;
    if (!isTargetKind(kind)) {
      return fail("Field target must name agents, team, or workflow");
    }
    // Indexed by a narrowed key, so the branch's allowed keys are a definite
    // value rather than a lookup that has to be asserted non-null.
    const allowed: readonly string[] = TARGET_BRANCH_KEYS[kind];
    if (Object.keys(record).some((key) => !allowed.includes(key))) {
      return fail("Field target must not mix dispatch branches");
    }

    if (kind === "agents") {
      if (!Array.isArray(record.agentNames)) {
        return fail("Field target.agentNames must name 1 to 8 agents");
      }
      const names: string[] = [];
      for (const candidate of record.agentNames) {
        const name = nonEmptyTrimmed(candidate);
        if (!name) {
          return fail("Field target.agentNames must contain non-empty strings");
        }
        if (!names.includes(name)) names.push(name);
      }
      if (names.length < 1 || names.length > 8) {
        return fail("Field target.agentNames must name 1 to 8 agents");
      }
      return { kind, agentNames: names };
    }

    if (kind === "team") {
      const teamId = nonEmptyTrimmed(record.teamId);
      if (!teamId) return fail("Field target.teamId must be a non-empty string");
      return { kind, teamId };
    }

    const workflowId = nonEmptyTrimmed(record.workflowId);
    if (!workflowId) {
      return fail("Field target.workflowId must be a non-empty string");
    }
    // Absence is not the same answer as `null`. `null` asserts "there is no
    // plan yet"; a missing field would leave the server to pick a base plan on
    // the caller's behalf, which is the silent rebase this contract forbids.
    const expectedPlanId = record.expectedPlanId;
    if (expectedPlanId === null) return { kind, workflowId, expectedPlanId: null };
    const expected = nonEmptyTrimmed(expectedPlanId);
    if (!expected) {
      return fail("Field target.expectedPlanId must be a plan id or null");
    }
    return { kind, workflowId, expectedPlanId: expected };
  });

/**
 * Derived from the schema, never restated beside it: a hand-written twin can
 * drift from what the boundary actually accepts, and the drift is invisible
 * until a request is answered by the wrong branch.
 */
export type SessionMessageTarget = z.infer<typeof sessionMessageTargetSchema>;

const contextResultIdsSchema = z
  .array(
    z
      .string({ error: "Field contextResultIds must contain non-empty strings" })
      .trim()
      .min(1, {
        error: "Field contextResultIds must contain non-empty strings",
      })
      .max(400, { error: "Field contextResultIds contains an oversized id" }),
    { error: "Field contextResultIds must be an array" },
  )
  .nullish()
  .transform((values) => [...new Set(values ?? [])])
  .refine((values) => values.length <= MAX_CONTEXT_RESULTS_PER_TURN, {
    error: `Field contextResultIds exceeds ${MAX_CONTEXT_RESULTS_PER_TURN} results`,
  });

const sessionMessageObjectSchema = z.object(
  {
    text: sessionTextSchema,
    provider: optionalModelFieldSchema("provider"),
    model: optionalModelFieldSchema("model"),
    projectContext: workspaceProjectContextSelectionSchema.optional(),
    target: sessionMessageTargetSchema.optional(),
    /**
     * Completed results this turn carries forward, chosen in the composer.
     *
     * Beside the target and independent of it: target selection never changes
     * context, and context never changes the target. Bounded here so a caller
     * cannot ask one turn to inline an unbounded number of past results.
     */
    contextResultIds: contextResultIdsSchema,
    // Client-minted so the display stream can be opened before the turn that
    // fills it exists. Validated here, at the boundary, exactly as the
    // agent-chat request does.
    turnId: z
      .string({ error: "Field turnId must be a UUID" })
      .refine(isValidSessionId, { error: "Field turnId must be a UUID" })
      .optional(),
  },
  { error: "Request body must be a JSON object" },
);

export const sessionMessageRequestSchema =
  sessionMessageObjectSchema.transform(
    ({ text, provider, model, projectContext, target, contextResultIds, turnId }) => ({
      text,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(projectContext ? { projectContext } : {}),
      ...(target ? { target } : {}),
      ...(contextResultIds.length > 0 ? { contextResultIds } : {}),
      ...(turnId ? { turnId } : {}),
    }),
  );

const agentNameSchema = z
  .string({
    error: "Field agentNames must contain non-empty strings",
  })
  .trim()
  .min(1, {
    error: "Field agentNames must contain non-empty strings",
  });

const agentNamesSchema = z
  .array(agentNameSchema, {
    error: "Field agentNames must be an array",
  })
  .nullish()
  .transform((values) => [...new Set(values ?? [])])
  .refine((values) => values.length <= 8, {
    error: "Field agentNames exceeds 8 agents",
  });

export const sessionAgentChatMessageRequestSchema = z
  .object(
    {
      text: sessionTextSchema,
      provider: optionalModelFieldSchema("provider"),
      model: optionalModelFieldSchema("model"),
      agentNames: agentNamesSchema,
      projectContext: workspaceProjectContextSelectionSchema.optional(),
      // Client-minted so the UI can subscribe to the turn's stream, and used as
      // the idempotency key. Validated here rather than downstream so a
      // malformed id is rejected before any project-context work runs.
      turnId: z
        .string({ error: "Field turnId must be a UUID" })
        .refine(isValidSessionId, { error: "Field turnId must be a UUID" })
        .optional(),
    },
    { error: "Request body must be a JSON object" },
  )
  .transform(({ text, provider, model, agentNames, projectContext, turnId }) => ({
    text,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    agentNames,
    ...(projectContext ? { projectContext } : {}),
    ...(turnId ? { turnId } : {}),
  }));


export type SessionCreateRequestBody = z.infer<
  typeof sessionCreateRequestSchema
>;
export type SessionTitleRequestBody = z.infer<
  typeof sessionTitleRequestSchema
>;
export type SessionMessageRequestBody = z.infer<
  typeof sessionMessageRequestSchema
>;
export type SessionAgentChatMessageRequestBody = z.infer<
  typeof sessionAgentChatMessageRequestSchema
>;
