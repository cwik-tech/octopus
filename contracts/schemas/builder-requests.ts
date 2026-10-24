import * as z from "zod/v4";

import { whenDefined } from "../../core/optional-properties.js";
import { teamShapeSchema } from "./team-shape.js";
import { resourceArchitectComposerSelectionSchema } from "./resource-architect-composer.js";

import type {
  ResourceArchitectPlan,
  ResourceTeamPlan,
} from "../resource-architect.js";
import type { WorkflowDraft } from "../workflow-generator.js";

function requiredTrimmedString(field: string) {
  const message = `Field ${field} is required and must be a non-empty string`;
  return z
    .string({ error: message })
    .refine((value) => value.trim().length > 0, { error: message })
    .transform((value) => value.trim());
}

function architectRequiredString(field: string) {
  const message = `Field ${field} must be a non-empty string`;
  return z
    .string({ error: message })
    .refine((value) => value.trim().length > 0, { error: message })
    .transform((value) => value.trim());
}

/**
 * An identity, kept exactly as it arrived.
 *
 * A target id, an Agent name, a skill name and a revision are all executed
 * rather than read: the Team writer sanitizes what it is given, so a padded
 * ` contract-review-team ` accepted here would mutate `contract-review-team`.
 * Prose still goes through `architectRequiredString`, which trims.
 */
function architectExactString(field: string) {
  const message = `Field ${field} must be a non-empty string with no surrounding whitespace`;
  return z
    .string({ error: message })
    .refine((value) => value.length > 0 && value === value.trim(), { error: message });
}

function laxTrimmedStringSchema() {
  return z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : undefined),
    z.string().optional(),
  );
}

function optionalModelSchema(field: string) {
  return z.preprocess(
    (value) => (value === null ? undefined : value),
    z
      .string({ error: `Field ${field} must be a string` })
      .transform((value) => value.trim() || undefined)
      .optional(),
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

const optionalBuilderTagsSchema = z
  .array(
    z
      .string({ error: "tags[] must be strings" })
      .transform((value) => value.trim()),
    { error: "Field tags must be an array" },
  )
  .transform((tags) => tags.filter(Boolean))
  .optional();

/**
 * A field that no longer changes anything must fail loudly.
 *
 * Accepting a retired team runtime setting would return success for a control
 * the run ignores, leaving the user believing the team pins a model.
 */
function retiredFieldSchema(field: string, guidance: string) {
  return z
    .unknown()
    .refine((value) => value === undefined || value === null, {
      error: `Field ${field} is no longer supported. ${guidance}`,
    })
    .optional();
}

const RETIRED_TEAM_GUIDANCE =
  "An agent runs with its own provider/model, or with the application default from Settings.";

/**
 * Why a roster write may not name a grade.
 *
 * This is a new write, not an echo of something the server already produced, so
 * the value is the author's own. Accepting it would answer 200 for a setting
 * that decides nothing.
 */
const RETIRED_GRADE_GUIDANCE =
  "Remove it; a member's role describes what it does, and the agent's own file says what it runs on.";

export const teamBuilderRequestSchema = z
  .object(
    {
      id: requiredTrimmedString("id"),
      description: laxTrimmedStringSchema(),
      tags: optionalBuilderTagsSchema,
      defaultProvider: retiredFieldSchema(
        "defaultProvider",
        RETIRED_TEAM_GUIDANCE,
      ),
      models: retiredFieldSchema("models", RETIRED_TEAM_GUIDANCE),
    },
    { error: "Request body must be a JSON object" },
  )
  .transform((body) => ({
    id: body.id,
    ...whenDefined(body.description, (description) => ({ description })),
    ...whenDefined(body.tags, (tags) => ({ tags })),
  }));

export const teamBuilderAgentRequestSchema = z
  .object(
    {
      agentName: requiredTrimmedString("agentName"),
      role: laxTrimmedStringSchema(),
      tier: retiredFieldSchema("tier", RETIRED_GRADE_GUIDANCE),
      model: retiredFieldSchema("model", RETIRED_TEAM_GUIDANCE),
      provider: retiredFieldSchema("provider", RETIRED_TEAM_GUIDANCE),
    },
    { error: "Request body must be a JSON object" },
  )
  .transform((body) => ({
    agentName: body.agentName,
    ...whenDefined(body.role, (role) => ({ role })),
  }));

/**
 * The team revision a write was made against, when the caller names one.
 *
 * Read beside the write's own body (or from the query of a DELETE), so the
 * body schemas above stay what each write uses. Optional: a caller written
 * before revisions keeps writing as it did. A present value is kept exactly,
 * since it is a digest, and has to name something: an empty or non-string one
 * is refused rather than read as "skip the check".
 */
export const teamRevisionRequestSchema = z.object(
  {
    expectedRevision: z
      .string({ error: "Field expectedRevision must be a non-empty string" })
      .min(1, { error: "Field expectedRevision must be a non-empty string" })
      .optional(),
  },
  { error: "Request body must be a JSON object" },
);

const optionalArchitectJobIdSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z
    .string({ error: "Field jobId must be a non-empty string" })
    .refine((value) => value.trim().length > 0, {
      error: "Field jobId must be a non-empty string",
    })
    .transform((value) => value.trim())
    .refine((value) => value.length <= 128, {
      error: "Field jobId exceeds 128 characters",
    })
    .optional(),
);

const architectHistorySchema = indexedArraySchema(
  "Field history is required and must be an array",
  (index) =>
    z
      .object(
        {
          role: z.preprocess(
            (value) => (value === "assistant" ? "assistant" : "user"),
            z.enum(["user", "assistant"]),
          ),
          text: z.string({
            error: `history[${index}].text must be a string`,
          }),
        },
        { error: `history[${index}] must be an object` },
      )
      .transform((turn) => ({ role: turn.role, text: turn.text })),
).transform((history) => boundArchitectHistory(history));

const RESOURCE_ARCHITECT_HISTORY_MAX_CHARS = 24_000;

function boundArchitectHistory<T extends { text: string }>(history: T[]): T[] {
  const selected: T[] = [];
  let characters = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (!turn) throw new Error(`Architect history has no turn at index ${index}`);
    if (turn.text.length > RESOURCE_ARCHITECT_HISTORY_MAX_CHARS) {
      if (selected.length === 0) {
        selected.unshift({
          ...turn,
          text: turn.text.slice(-RESOURCE_ARCHITECT_HISTORY_MAX_CHARS),
        });
      }
      break;
    }
    if (characters + turn.text.length > RESOURCE_ARCHITECT_HISTORY_MAX_CHARS)
      break;
    selected.unshift(turn);
    characters += turn.text.length;
  }
  return selected;
}

const architectStringListSchema = z.preprocess(
  (value) => (value === undefined ? [] : value),
  z
    .array(z.unknown(), { error: "Expected a string array" })
    .transform((items) =>
      items.filter((item): item is string => typeof item === "string"),
    ),
);

function requiredArchitectStringList(field: string) {
  return z
    .array(z.unknown(), {
      error: `Field ${field} must be a string array`,
    })
    .transform((items, context) => {
      const parsedItems: string[] = [];
      for (const [index, item] of items.entries()) {
        const parsed = architectRequiredString(`${field}[${index}]`).safeParse(
          item,
        );
        if (!parsed.success) {
          context.addIssue({
            code: "custom",
            message:
              parsed.error.issues[0]?.message ?? "Request body is invalid",
          });
          return z.NEVER;
        }
        parsedItems.push(parsed.data);
      }
      return parsedItems;
    })
    .refine((items) => items.length > 0, {
      error: `Field ${field} must not be empty`,
    });
}

function documentSpecializationSchema(field: string) {
  return z.object(
    {
      expertiseDomain: architectRequiredString(`${field}.expertiseDomain`),
      focus: architectRequiredString(`${field}.focus`),
      evidenceAnchors: requiredArchitectStringList(`${field}.evidenceAnchors`),
      assessmentTargets: requiredArchitectStringList(
        `${field}.assessmentTargets`,
      ),
      outOfScope: requiredArchitectStringList(`${field}.outOfScope`),
    },
    { error: `${field} must be an object` },
  );
}

/**
 * A member's retired grade, where an agent plan arrives as context.
 *
 * Every agent-plan list in this file is reached through `currentPlan`, which is
 * not a new write: it is this server's own earlier output handed back, and a
 * plan recovered from before the field was retired still carries one. Refusing
 * it would make an old plan unusable for a follow-up, so it is read past and
 * dropped from the parsed value.
 *
 * The refusal lives where a grade would be an author's own input — the roster
 * write in `teamBuilderAgentRequestSchema`, which answers 400 by name rather
 * than returning success for a setting that decides nothing (§4.5).
 */
function architectEchoedGrade() {
  return z.unknown().optional();
}

/**
 * A new Agent's card summary, where an agent plan arrives as context.
 *
 * Absent only on a plan saved before summaries existed, which is read as it
 * is rather than given one. A present value is kept, because the model reads
 * the echoed plan on the next turn, and refused when it is not usable text.
 */
function architectEchoedSummary(field: string) {
  return architectRequiredString(`${field}.summary`).optional();
}

function architectAgentPlansSchema(withDescription: boolean) {
  // No coercion. Reading a wrong-typed value as an empty list would silently
  // rewrite the plan the user is looking at, dropping the very additions the
  // proposal named.
  return indexedArraySchema("Expected an agent plan array", (index) => {
      const field = `agent plan ${index}`;
      const base = {
        name: architectExactString(`${field}.name`),
        role: architectRequiredString(`${field}.role`),
        rationale: architectRequiredString(`${field}.rationale`),
        tier: architectEchoedGrade(),
      };
      if (!withDescription) {
        return z
          .object(base, { error: `${field} must be an object` })
          .transform(({ tier: _retired, ...agent }) => agent);
      }
      return z
        .object(
          {
            ...base,
            summary: architectEchoedSummary(field),
            description: architectRequiredString(`${field}.description`),
            documentSpecialization: documentSpecializationSchema(
              `${field}.documentSpecialization`,
            ).optional(),
          },
          { error: `${field} must be an object` },
        )
        .transform((agent) => ({
          name: agent.name,
          role: agent.role,
          rationale: agent.rationale,
          ...(agent.summary === undefined ? {} : { summary: agent.summary }),
          description: agent.description,
          ...(agent.documentSpecialization
            ? {
                documentSpecialization: agent.documentSpecialization,
              }
            : {}),
        }));
  });
}

const documentDomainsSchema = indexedArraySchema(
  "documentDomains must be an array",
  (index) => {
    const field = `documentDomains[${index}]`;
    return z.object(
      {
        domain: architectRequiredString(`${field}.domain`),
        evidenceAnchors: requiredArchitectStringList(
          `${field}.evidenceAnchors`,
        ),
      },
      { error: `${field} must be an object` },
    );
  },
).optional();

/**
 * The chosen interaction shape on an echoed plan.
 *
 * Absent and null both mean "no shape chosen": a plan proposed before shapes
 * existed carries neither, and null is the wire form the provider schema offers
 * the model. A present value is held to the same contract the emitter builds
 * from, so a plan cannot be continued carrying a shape nothing can build.
 */
const architectTeamShapeSchema = teamShapeSchema.nullish();

const architectPlanObjectSchema = z
  .object(
    {
      teamId: architectRequiredString("currentPlan.teamId"),
      description: architectRequiredString("currentPlan.description"),
      tags: architectStringListSchema,
      documentDomains: documentDomainsSchema,
      existingAgents: architectAgentPlansSchema(false),
      newAgents: architectAgentPlansSchema(true),
      questionsResolved: architectStringListSchema,
      // Declared as well as copied. Zod strips an undeclared key before the
      // transform runs, so adding it to the transform alone would still drop
      // it — and the model would be shown, on every follow-up turn, a plan with
      // the user's chosen topology erased.
      shape: architectTeamShapeSchema,
    },
    { error: "Field currentPlan must be an object or null" },
  )
  .transform(
    (plan) =>
      ({
        teamId: plan.teamId,
        description: plan.description,
        tags: plan.tags,
        ...(plan.documentDomains !== undefined
          ? { documentDomains: plan.documentDomains }
          : {}),
        ...(plan.shape === undefined || plan.shape === null
          ? {}
          : { shape: plan.shape }),
        existingAgents: plan.existingAgents,
        newAgents: plan.newAgents,
        questionsResolved: plan.questionsResolved,
      }) as ResourceTeamPlan,
  );

const optionalDraftIdSchema = optionalModelSchema("draftId").refine(
  (value) =>
    value === undefined || (value.length <= 128 && isSafePathSegment(value)),
  { error: "Field draftId is invalid" },
);

const documentReaderSelectionSchema = z
  .object(
    {
      provider: optionalModelSchema("documentReader.provider"),
      model: optionalModelSchema("documentReader.model"),
    },
    { error: "documentReader must be an object" },
  )
  .superRefine((selection, context) => {
    if (!selection.provider || !selection.model) {
      context.addIssue({
        code: "custom",
        message:
          "documentReader.provider and documentReader.model are required together",
      });
      return;
    }
    if (selection.provider.length > 80 || selection.model.length > 160) {
      context.addIssue({
        code: "custom",
        message: "documentReader is too long",
      });
    }
  })
  .transform((selection) => {
    const { provider, model } = selection;
    // The refinement above rejects a selection missing either field, and Zod
    // does not run a transform on input that already has issues.
    if (!provider || !model) {
      throw new Error(
        "documentReader transform ran without both provider and model",
      );
    }
    return { provider, model };
  });

const optionalDocumentReaderSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  documentReaderSelectionSchema.optional(),
);

const optionalResourceArchitectSelectionSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z
    .discriminatedUnion(
      "kind",
      [
        z.object({
          kind: z.literal("agent"),
          id: architectRequiredString("selectedResource.id"),
        }),
        z.object({
          kind: z.literal("team"),
          id: architectRequiredString("selectedResource.id"),
        }),
      ],
      {
        error: "Field selectedResource must identify an Agent or Team",
      },
    )
    .optional(),
);

const resourceArchitectAgentsSchema = indexedArraySchema(
  "Field currentPlan.agents must be an array",
  (index) => {
    const field = `currentPlan.agents[${index}]`;
    return z
      .object(
        {
          name: architectRequiredString(`${field}.name`),
          role: architectRequiredString(`${field}.role`),
          summary: architectEchoedSummary(field),
          description: architectRequiredString(`${field}.description`),
          rationale: architectRequiredString(`${field}.rationale`),
          tier: architectEchoedGrade(),
        },
        { error: `Field ${field} must be an object` },
      )
      .transform(({ tier: _retired, summary, ...agent }) => ({
        ...agent,
        ...(summary === undefined ? {} : { summary }),
      }));
  },
).refine((agents) => agents.length > 0, {
  error: "Field currentPlan.agents must contain at least one Agent",
});

/**
 * Both kinds of update operation, discriminated exactly as they are persisted.
 *
 * A boundary that accepted only one kind would make the other unusable the
 * moment the user said anything else: the proposal is still on screen, the
 * next turn carries it back, and the request would be refused for describing
 * a plan this server had itself just written.
 */
const resourceUpdateOperationsSchema = indexedArraySchema(
  "Field currentPlan.operations must be an array",
  (index) => {
    const field = `currentPlan.operations[${index}]`;
    return z.discriminatedUnion(
      "kind",
      [
        z.object({
          kind: z.literal("add_team_agents"),
          target: z.object(
            {
              kind: z.literal("team", { error: `Field ${field}.target.kind is invalid` }),
              id: architectExactString(`${field}.target.id`),
            },
            { error: `Field ${field}.target must be an object` },
          ),
          expectedRevision: architectExactString(`${field}.expectedRevision`),
          // Reached through `currentPlan` as well: a stored plan handed back
          // for a follow-up is context, not a new write, and one saved before
          // the field was retired still carries it.
          libraryAgentsToAdd: architectAgentPlansSchema(false),
          newAgentsToCreate: architectAgentPlansSchema(true),
        }),
        z.object({
          kind: z.literal("update_agent_skills"),
          target: z.object(
            {
              kind: z.literal("agent", { error: `Field ${field}.target.kind is invalid` }),
              id: architectExactString(`${field}.target.id`),
            },
            { error: `Field ${field}.target must be an object` },
          ),
          expectedRevision: architectExactString(`${field}.expectedRevision`),
          skillUpdates: architectSkillUpdatesSchema(field),
        }),
      ],
      { error: `Field ${field}.kind is invalid` },
    );
  },
).refine((operations) => operations.length > 0, {
  error: "Field currentPlan.operations must contain at least one operation",
});

/** The skill actions one operation carries, kept exactly as they were sent. */
function architectSkillUpdatesSchema(field: string) {
  return indexedArraySchema(
    `Field ${field}.skillUpdates must be an array`,
    (index) => {
      const entry = `${field}.skillUpdates[${index}]`;
      return z.object(
        {
          action: z.enum(["create", "update"], {
            error: `Field ${entry}.action is invalid`,
          }),
          name: architectExactString(`${entry}.name`),
          instruction: architectRequiredString(`${entry}.instruction`),
        },
        { error: `Field ${entry} must be an object` },
      );
    },
  ).refine((updates) => updates.length > 0, {
    error: `Field ${field}.skillUpdates must contain at least one skill`,
  });
}

const resourceArchitectPlanObjectSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      id: architectRequiredString("currentPlan.id"),
      kind: z.literal("standalone_agents"),
      agents: resourceArchitectAgentsSchema,
    }),
    z.object({
      id: architectRequiredString("currentPlan.id"),
      kind: z.literal("team"),
      team: architectPlanObjectSchema,
    }),
    z.object({
      id: architectRequiredString("currentPlan.id"),
      kind: z.literal("resource_updates"),
      operations: resourceUpdateOperationsSchema,
    }),
  ],
  {
    error: "Field currentPlan.kind is invalid",
  },
);

const resourceArchitectPlanContainerSchema = z.preprocess(
  (value) => (value === undefined ? null : value),
  z.union([z.null(), z.object({}).passthrough()], {
    error: "Field currentPlan must be an object or null",
  }),
);

const resourceArchitectPlanSchema =
  resourceArchitectPlanContainerSchema.transform((value, context) => {
    if (value === null) return null;
    const parsed = resourceArchitectPlanObjectSchema.safeParse(value);
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        message: parsed.error.issues[0]?.message ?? "Request body is invalid",
      });
      return z.NEVER;
    }
    return parsed.data as ResourceArchitectPlan;
  });

/**
 * An ad hoc pair is one choice, so half of one is refused.
 *
 * Completing a partial pair from wherever the rest happens to come from runs a
 * combination nobody selected, and the turn then records the provenance of the
 * pair it did not run. There is no correct way to describe that afterwards, so
 * it is rejected before anything is dispatched.
 */
function refusePartialModelPair(
  body: { provider?: string | undefined; model?: string | undefined },
  context: z.RefinementCtx,
): void {
  if (Boolean(body.provider) === Boolean(body.model)) return;
  context.addIssue({
    code: "custom",
    message: "Fields provider and model are required together",
  });
}

export const resourceArchitectTurnRequestSchema = z
  .object(
    {
      jobId: optionalArchitectJobIdSchema,
      operation: z.preprocess(
        (value) =>
          value === undefined || value === null ? "conversation" : value,
        z.enum(["conversation", "proposal"], {
          error: "Field operation must be conversation or proposal",
        }),
      ),
      history: architectHistorySchema,
      currentPlan: resourceArchitectPlanSchema,
      draftId: optionalDraftIdSchema,
      documentReader: optionalDocumentReaderSchema,
      selectedResource: optionalResourceArchitectSelectionSchema,
      composerSelection: resourceArchitectComposerSelectionSchema.optional(),
      provider: optionalModelSchema("provider"),
      model: optionalModelSchema("model"),
    },
    { error: "Request body must be a JSON object" },
  )
  .superRefine(refusePartialModelPair)
  .superRefine((body, context) => {
    const captured = body.composerSelection;
    if (captured && body.provider && body.model &&
      (body.provider !== captured.provider || body.model !== captured.model)) {
      context.addIssue({
        code: "custom",
        path: ["composerSelection"],
        message: "Composer selection must match the submitted provider/model pair",
      });
    }
  })
  .transform((body) => ({
    ...whenDefined(body.jobId, (jobId) => ({ jobId })),
    operation: body.operation,
    history: body.history,
    currentPlan: body.currentPlan,
    draftId: body.draftId,
    documentReader: body.documentReader,
    ...(body.selectedResource
      ? { selectedResource: body.selectedResource }
      : {}),
    ...(body.provider ? { provider: body.provider } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...whenDefined(body.composerSelection, (composerSelection) => ({ composerSelection })),
  }));

export const resourceArchitectBuildRequestSchema = z
  .object(
    {
      jobId: optionalArchitectJobIdSchema,
      operation: z
        .never({
          error: "Field operation is not valid for resource builds",
        })
        .optional(),
      planId: requiredTrimmedString("planId").refine(
        (value) => value.length <= 128,
        { error: "Field planId exceeds 128 characters" },
      ),
      draftId: optionalDraftIdSchema,
      provider: optionalModelSchema("provider"),
      model: optionalModelSchema("model"),
      /**
       * The plan revision the card the user pressed was rendered from.
       *
       * Optional, and deliberately so. Create sends it, so a stale card cannot
       * authorize a build of a plan someone has since amended. Retry does not:
       * it rebuilds a lineage that was already admitted rather than something
       * the user is looking at, and requiring one there would break it.
       */
      expectedRevision: optionalModelSchema("expectedRevision"),
    },
    { error: "Request body must be a JSON object" },
  )
  .superRefine(refusePartialModelPair)
  .transform((body) => ({
    ...whenDefined(body.jobId, (jobId) => ({ jobId })),
    planId: body.planId,
    draftId: body.draftId,
    ...(body.provider ? { provider: body.provider } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(body.expectedRevision ? { expectedRevision: body.expectedRevision } : {}),
  }));

const generatorJobIdSchema = z
  .string({ error: "Field jobId must be a string" })
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, {
    error: "Field jobId must not be empty",
  })
  .refine((value) => value.length <= 128, {
    error: "Field jobId exceeds 128 characters",
  })
  .optional();

const generatorHistoryContainerSchema = z.array(z.unknown(), {
  error: "Field history is required and must be an array",
});

const generatorHistorySchema = z.array(
  z.object(
    {
      role: z.enum(["user", "assistant"], {
        error: "history[].role must be 'user' or 'assistant'",
      }),
      text: z.string({
        error: "history[].text must be a string",
      }),
    },
    { error: "Each history entry must be an object" },
  ),
);

const permissiveWorkflowDraftSchema = z.preprocess(
  (value) =>
    value && typeof value === "object" && !Array.isArray(value) ? value : null,
  z
    .union([z.null(), z.object({}).passthrough()])
    .transform((value) => value as WorkflowDraft | null),
);

const generatorTurnGateSchema = z
  .object(
    {
      history: generatorHistoryContainerSchema,
      jobId: generatorJobIdSchema,
    },
    { error: "Request body must be a JSON object" },
  )
  .passthrough();

export const generatorTurnRequestSchema = generatorTurnGateSchema
  .pipe(
    z.object({
      history: generatorHistorySchema,
      jobId: z.string().optional(),
      currentDraft: permissiveWorkflowDraftSchema,
      provider: optionalModelSchema("provider"),
      model: optionalModelSchema("model"),
    }),
  )
  .superRefine(refusePartialModelPair)
  .transform((body) => ({
    ...whenDefined(body.jobId, (jobId) => ({ jobId })),
    history: body.history,
    currentDraft: body.currentDraft,
    ...(body.provider ? { provider: body.provider } : {}),
    ...(body.model ? { model: body.model } : {}),
  }));

const generatorSaveGateSchema = z
  .object(
    {
      draft: z.unknown().optional(),
      yaml: z.unknown().optional(),
      filename: z.unknown().optional(),
      replaceWorkflowId: z.unknown().optional(),
    },
    { error: "Request body must be a JSON object" },
  )
  .superRefine((body, context) => {
    if (
      body.draft === undefined &&
      (typeof body.yaml !== "string" || body.yaml.trim().length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Field draft or non-empty yaml is required",
      });
    }
  });

export const generatorSaveRequestSchema = generatorSaveGateSchema
  .pipe(
    z.object({
      draft: z
        .object({}, { error: "Field draft must be an object" })
        .passthrough()
        .optional(),
      yaml: z.string({ error: "Field yaml must be a string" }).optional(),
      filename: z
        .string({ error: "Field filename must be a string" })
        .optional(),
      replaceWorkflowId: z
        .string({
          error: "Field replaceWorkflowId must be a string",
        })
        .optional(),
    }),
  )
  .transform((body) => ({
    ...whenDefined(body.draft, (draft) => ({ draft })),
    ...whenDefined(body.yaml, (yaml) => ({ yaml })),
    ...whenDefined(body.filename, (filename) => ({ filename })),
    ...whenDefined(body.replaceWorkflowId, (replaceWorkflowId) => ({ replaceWorkflowId })),
  }));

export const workflowUpdateRequestSchema = z.object(
  {
    yaml: z
      .string({
        error: "Field yaml is required and must be a non-empty string",
      })
      .refine((value) => value.trim().length > 0, {
        error: "Field yaml is required and must be a non-empty string",
      }),
  },
  { error: "Request body must be a JSON object" },
);

export const generatorValidateYamlRequestSchema = z.object(
  {
    yaml: z.string({
      error: "Field yaml is required and must be a string",
    }),
  },
  { error: "Request body must be a JSON object" },
);

export type TeamBuilderRequestBody = z.infer<typeof teamBuilderRequestSchema>;
export type TeamBuilderAgentRequestBody = z.infer<
  typeof teamBuilderAgentRequestSchema
>;
export type DocumentReaderRequestSelection = z.infer<
  typeof documentReaderSelectionSchema
>;
export type GeneratorTurnRequestBody = z.infer<
  typeof generatorTurnRequestSchema
>;
export type GeneratorSaveRequestBody = z.infer<
  typeof generatorSaveRequestSchema
>;

function isSafePathSegment(value: string): boolean {
  const encodedPathSeparator = /%(?:2f|5c)/i;
  let candidate = value;
  for (let pass = 0; pass < 4; pass += 1) {
    if (
      hasUnsafePathStructure(candidate) ||
      encodedPathSeparator.test(candidate)
    ) {
      return false;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return false;
    }
    if (decoded === candidate) return true;
    candidate = decoded;
  }
  return (
    !hasUnsafePathStructure(candidate) && !encodedPathSeparator.test(candidate)
  );
}

function hasUnsafePathStructure(value: string): boolean {
  return (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  );
}
