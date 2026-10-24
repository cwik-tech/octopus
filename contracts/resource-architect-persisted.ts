/**
 * What a plan file on disk may still contain, as opposed to what is authored.
 *
 * Authoring stopped producing model grades: `PlannedAgentSpec` and
 * `ResourceTeamAgentPlan` have no such field, and every new operation is built
 * by explicit field copies, so nothing this server writes can carry one.
 *
 * Files written before that are a different matter. A stored update operation
 * is identified by a digest over the operation exactly as persisted
 * (`digestResourceUpdateOperation`), and the executor refuses a receipt whose
 * digest does not match (`services/resource-update-executor.ts`). Dropping a
 * field while reading such a file would change the operation's identity, and
 * the run's own receipt would no longer describe the operation it was written
 * for — a completed update would be re-run or abandoned.
 *
 * So the reader carries the old field through, and these types are where that
 * is declared rather than smuggled in as a property no type admits to. Every
 * shape here is derived from the active contract it corresponds to, overriding
 * only the nested Agent lists; the skill-update branch is the active type
 * unchanged, because a skill operation never carried a grade. Deriving them is
 * what keeps this from becoming a second schema to maintain.
 *
 * These types describe the persistence boundary and nothing else. They do not,
 * on their own, stop a stored plan reaching authoring: structural typing makes
 * a persisted value assignable wherever the active type is expected, and an
 * extra property travels with it at runtime. What actually stops it is the
 * projection applied where a stored plan meets a write — `toAuthoredPlannedAgent`
 * and `toAuthoredTeamNewAgentPlan` at the generation boundary, and the explicit
 * field copies in `resource-update-policy.ts` for new proposals — together with
 * the tests that exercise those boundaries.
 */

import type {
  AuthoredPlannedAgentSpec,
  LegacyPlannedAgentSpec,
  PlannedAgentGenerationInput,
} from "./agent-generator.js";
import type {
  ResourceStandaloneAgentsPlan,
  ResourceTeamAgentPlan,
  ResourceTeamCreationPlan,
  ResourceTeamNewAgentPlan,
  ResourceTeamPlan,
  ResourceUpdateOperation,
  ResourceUpdatePlan,
} from "./resource-architect.js";

/**
 * A model grade an older file already holds.
 *
 * Optional because current files do not have one, and read-only because this
 * side of the boundary only ever reads what is already there.
 */
export interface PersistedLegacyAgentGrade {
  readonly tier?: string;
}

/**
 * A stored planned Agent: authored with its card summary, or saved before
 * summaries existed and read back without one. The two are separate branches
 * so a reader has to choose one, rather than an optional field that would let
 * a present summary be dropped without anything noticing.
 */
export type PersistedPlannedAgentSpec =
  & (AuthoredPlannedAgentSpec | LegacyPlannedAgentSpec)
  & PersistedLegacyAgentGrade;

export type PersistedResourceTeamAgentPlan =
  & ResourceTeamAgentPlan
  & PersistedLegacyAgentGrade;

export type PersistedResourceTeamNewAgentPlan =
  & (
    | (ResourceTeamNewAgentPlan & { summary: string })
    | (Omit<ResourceTeamNewAgentPlan, "summary"> & { summary?: never })
  )
  & PersistedLegacyAgentGrade;

export type PersistedResourceTeamPlan =
  & Omit<ResourceTeamPlan, "existingAgents" | "newAgents">
  & {
    existingAgents: PersistedResourceTeamAgentPlan[];
    newAgents: PersistedResourceTeamNewAgentPlan[];
  };

export type PersistedResourceStandaloneAgentsPlan =
  & Omit<ResourceStandaloneAgentsPlan, "agents">
  & { agents: PersistedPlannedAgentSpec[] };

export type PersistedResourceTeamCreationPlan =
  & Omit<ResourceTeamCreationPlan, "team">
  & { team: PersistedResourceTeamPlan };

/** A skill operation names no Agent plan, so it is the active type unchanged. */
export type PersistedResourceUpdateOperation =
  | (
    & Omit<
      Extract<ResourceUpdateOperation, { kind: "add_team_agents" }>,
      "libraryAgentsToAdd" | "newAgentsToCreate"
    >
    & {
      libraryAgentsToAdd: PersistedResourceTeamAgentPlan[];
      newAgentsToCreate: PersistedResourceTeamNewAgentPlan[];
    }
  )
  | Extract<ResourceUpdateOperation, { kind: "update_agent_skills" }>;

export type PersistedResourceUpdatePlan =
  & Omit<ResourceUpdatePlan, "operations">
  & { operations: PersistedResourceUpdateOperation[] };

/** A plan as it comes back from disk, legacy fields included. */
export type PersistedResourceArchitectPlan =
  | PersistedResourceStandaloneAgentsPlan
  | PersistedResourceTeamCreationPlan
  | PersistedResourceUpdatePlan;

/**
 * The generation view of a stored Agent: the fields generation reads, and
 * nothing else.
 *
 * Use this where a stored plan feeds something that writes a new file, so the
 * old grade stops at the boundary instead of travelling into generation. The
 * card summary stops here too: it is display copy, and the generator and the
 * fallback skill must be given the detailed brief in `description` exactly as
 * stored. It is a projection, not a rewrite: the stored record itself is
 * untouched, and the operation it belongs to still hashes to the identity its
 * receipt names.
 */
export function toAuthoredPlannedAgent(
  agent: PersistedPlannedAgentSpec,
): PlannedAgentGenerationInput {
  return {
    name: agent.name,
    role: agent.role,
    description: agent.description,
    rationale: agent.rationale,
    ...(typeof agent.webResearchEnabled === "boolean" ? { webResearchEnabled: agent.webResearchEnabled } : {}),
  };
}

/**
 * The generation view of a stored Agent that a Team plan will generate.
 *
 * `documentSpecialization` is part of the brief the generator is given, so it
 * is carried; the grade and the card summary are not, because nothing the
 * generator writes has a place for either.
 */
export function toAuthoredTeamNewAgentPlan(
  agent: PersistedResourceTeamNewAgentPlan,
): Omit<ResourceTeamNewAgentPlan, "summary"> {
  return {
    ...toAuthoredPlannedAgent(agent),
    ...(agent.documentSpecialization === undefined
      ? {}
      : { documentSpecialization: agent.documentSpecialization }),
  };
}
