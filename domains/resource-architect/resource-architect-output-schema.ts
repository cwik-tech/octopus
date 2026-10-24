import { teamShapeProviderBranches } from "../../contracts/schemas/team-shape.js";
import { MAX_AGENT_NAME_LENGTH } from "../agent-generator/agent-name-rules.js";
import { MAX_PLANNED_AGENT_SUMMARY_LENGTH } from "../agent-generator/planned-agent-rules.js";

const agentProperties = {
  name: { type: "string", minLength: 1 },
  role: { type: "string", minLength: 1 },
  // Card copy, bounded, and separate from `description`, which is the detailed
  // build brief the Agent generator reads and is deliberately unbounded.
  summary: { type: "string", minLength: 1, maxLength: MAX_PLANNED_AGENT_SUMMARY_LENGTH },
  description: { type: "string", minLength: 1 },
  rationale: { type: "string", minLength: 1 },
  webResearchEnabled: { type: "boolean" },
};

const plannedAgentNameSchema = {
  ...agentProperties.name,
  maxLength: MAX_AGENT_NAME_LENGTH,
};

const existingAgentSchema = {
  type: "object",
  properties: {
    name: agentProperties.name,
    role: agentProperties.role,
    rationale: agentProperties.rationale,
  },
  required: ["name", "role", "rationale"],
  additionalProperties: false,
};

const documentSpecializationSchema = {
  type: "object",
  properties: {
    expertiseDomain: { type: "string", minLength: 1 },
    focus: { type: "string", minLength: 1 },
    evidenceAnchors: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
    },
    assessmentTargets: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
    },
    outOfScope: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
    },
  },
  required: [
    "expertiseDomain",
    "focus",
    "evidenceAnchors",
    "assessmentTargets",
    "outOfScope",
  ],
  additionalProperties: false,
};

const documentDomainsSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      domain: { type: "string", minLength: 1 },
      evidenceAnchors: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
      },
    },
    required: ["domain", "evidenceAnchors"],
    additionalProperties: false,
  },
};

const plannedAgentSchema = {
  type: "object",
  properties: {
    ...agentProperties,
    name: plannedAgentNameSchema,
  },
  required: ["name", "role", "summary", "description", "rationale", "webResearchEnabled"],
  additionalProperties: false,
};

const teamNewAgentSchema = {
  type: "object",
  properties: {
    ...agentProperties,
    name: plannedAgentNameSchema,
    // Optional in the domain, mandatory in the schema. Codex requires every
    // declared property to appear in `required`, so absence has to be a value
    // the model can actually send. The null variant is that value: it lets an
    // agent with no document work say so, where dropping the key from
    // `required` would be rejected and making the object itself required would
    // buy schema validity with invented document metadata.
    documentSpecialization: {
      anyOf: [documentSpecializationSchema, { type: "null" }],
    },
  },
  required: [
    "name",
    "role",
    "summary",
    "description",
    "rationale",
    "documentSpecialization",
    "webResearchEnabled",
  ],
  additionalProperties: false,
};

const teamUpdateTargetSchema = {
  type: "object",
  properties: {
    kind: { type: "string", const: "team" },
    id: { type: "string", minLength: 1 },
  },
  required: ["kind", "id"],
  additionalProperties: false,
};

// One operation owns one target and one build item, so a request touching
// several Teams keeps a separate revision and failure result for each.
//
// No `expectedRevision` appears anywhere in this schema. The prompt carries no
// source revision, so a revision the model returned would be invented; the
// server calculates it from the registered `team.yaml` when it persists the
// plan.
const addTeamAgentsOperationSchema = {
  type: "object",
  properties: {
    kind: { type: "string", const: "add_team_agents" },
    target: teamUpdateTargetSchema,
    libraryAgentsToAdd: { type: "array", items: existingAgentSchema },
    newAgentsToCreate: { type: "array", items: teamNewAgentSchema },
  },
  required: ["kind", "target", "libraryAgentsToAdd", "newAgentsToCreate"],
  additionalProperties: false,
};

const agentUpdateTargetSchema = {
  type: "object",
  properties: {
    kind: { type: "string", const: "agent" },
    id: { type: "string", minLength: 1 },
  },
  required: ["kind", "id"],
  additionalProperties: false,
};

// The same rule as the Team operation above: one operation owns one Agent, and
// no `expectedRevision` appears anywhere. `instruction` is what the skill
// author is asked to write from, so it is required on every entry — an action
// with nothing to author from is not an action.
const updateAgentSkillsOperationSchema = {
  type: "object",
  properties: {
    kind: { type: "string", const: "update_agent_skills" },
    target: agentUpdateTargetSchema,
    skillUpdates: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "update"] },
          name: { type: "string", minLength: 1 },
          instruction: { type: "string", minLength: 1 },
        },
        required: ["action", "name", "instruction"],
        additionalProperties: false,
      },
    },
  },
  required: ["kind", "target", "skillUpdates"],
  additionalProperties: false,
};

export const RESOURCE_ARCHITECT_PROPOSAL_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: {
    message: { type: "string", minLength: 1 },
    warnings: { type: "array", items: { type: "string" } },
    outcome: {
      anyOf: [
        {
          type: "object",
          // Every discriminator carries its own `type`. A bare `const` or
          // `enum` is rejected outright: Codex answers the turn with HTTP 400
          // `invalid_json_schema`, which this agent converts into a fallback
          // discussion, so the proposal is lost rather than reported.
          properties: { kind: { type: "string", const: "discussion" } },
          required: ["kind"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", const: "edit_existing" },
            target: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["agent", "team"] },
                id: { type: "string", minLength: 1 },
              },
              required: ["kind", "id"],
              additionalProperties: false,
            },
          },
          required: ["kind", "target"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1 },
            kind: { type: "string", const: "standalone_agents" },
            agents: {
              type: "array",
              items: plannedAgentSchema,
              minItems: 1,
            },
          },
          required: ["id", "kind", "agents"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1 },
            kind: { type: "string", const: "team" },
            team: {
              type: "object",
              properties: {
                teamId: { type: "string", minLength: 1 },
                description: { type: "string", minLength: 1 },
                tags: { type: "array", items: { type: "string" } },
                existingAgents: {
                  type: "array",
                  items: existingAgentSchema,
                },
                newAgents: {
                  type: "array",
                  items: teamNewAgentSchema,
                },
                // Null for the same reason as `documentSpecialization`: a team
                // that identified no document domains has to be able to say so.
                documentDomains: {
                  anyOf: [documentDomainsSchema, { type: "null" }],
                },
                questionsResolved: {
                  type: "array",
                  items: { type: "string" },
                },
                // How the members work together. Generated from the domain
                // schema, so the shapes the model may answer with are exactly
                // the shapes the app can build. Null for the same reason as
                // `documentDomains`: every key is required, so "not chosen"
                // has to be sayable.
                shape: {
                  anyOf: [...teamShapeProviderBranches(), { type: "null" }],
                },
              },
              required: [
                "teamId",
                "description",
                "tags",
                "existingAgents",
                "newAgents",
                "documentDomains",
                "questionsResolved",
                "shape",
              ],
              additionalProperties: false,
            },
          },
          required: ["id", "kind", "team"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1 },
            kind: { type: "string", const: "resource_updates" },
            operations: {
              type: "array",
              items: {
                anyOf: [addTeamAgentsOperationSchema, updateAgentSkillsOperationSchema],
              },
              minItems: 1,
            },
          },
          required: ["id", "kind", "operations"],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["message", "warnings", "outcome"],
  additionalProperties: false,
};
