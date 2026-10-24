/**
 * Reads one proposal answer out of untrusted provider text.
 *
 * Everything the provider sends stays `unknown` until a constructor here has
 * built the typed object field by field, so nothing is cast into shape. What
 * that buys is specific, and worth stating exactly:
 *
 * - A key the contract does not define is dropped. The outcome is rebuilt from
 *   named fields, so an invented one has nowhere to go.
 * - A required field that is missing or of the wrong type ends the whole
 *   outcome. A list whose entries have their own required fields ends it too
 *   when any single entry cannot be built: a shorter list would be a different
 *   proposal from the one the model sent.
 * - A list the schema requires must be a list. Reading a wrong-typed one as
 *   empty would accept a proposal with content silently removed from it. The
 *   two exceptions are `documentDomains` and `documentSpecialization`, where
 *   `null` means absent: Codex requires those keys on every object, so `null`
 *   is how it says there are none.
 * - `warnings` is the one tolerant list, because it describes the answer rather
 *   than a resource the answer proposes.
 */

import type { AuthoredPlannedAgentSpec } from "../../contracts/agent-generator.js";
import type {
  ResourceArchitectDraftProposalResponse,
  ResourceArchitectTurnDraftOutcome,
  ResourceTeamAgentPlan,
  ResourceTeamDocumentDomain,
  ResourceTeamDocumentSpecialization,
  ResourceTeamNewAgentPlan,
  ResourceSkillUpdate,
  ResourceTeamPlan,
  ResourceUpdateOperationDraft,
} from "../../contracts/resource-architect.js";
import {
  teamShapeSchema,
  validateShapeAgainstRoster,
  type TeamShape,
} from "../../contracts/schemas/team-shape.js";
import { validateExactAgentName } from "../agent-generator/agent-name-rules.js";
import { MAX_PLANNED_AGENT_SUMMARY_LENGTH } from "../agent-generator/planned-agent-rules.js";

export type ParsedProposalResponse = Omit<
  ResourceArchitectDraftProposalResponse,
  "operation"
>;

export type ParseResult =
  | { ok: true; value: ParsedProposalResponse }
  | { ok: false; reason: string };

/**
 * A refusal that names what was wrong, rather than "outcome is invalid".
 *
 * The reason is quoted verbatim back to the model in the repair turn
 * (`resource-architect-llm.ts:504`), so a generic one wastes the one free
 * retry the turn gets. A shape naming an agent who is not on the team is
 * exactly the kind of mistake a second pass can fix, if it is told.
 */
class ProposalRejection extends Error {}

export function parseProposalTurn(text: string): ParseResult {
  const source = extractJson(text);
  if (!source) return { ok: false, reason: "no JSON object found" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!isObject(parsed)) return { ok: false, reason: "top-level value is not an object" };
  const message = stringValue(parsed.message);
  if (!message) return { ok: false, reason: "message is required" };
  if (parsed.warnings !== undefined && !Array.isArray(parsed.warnings)) {
    return { ok: false, reason: "warnings must be a list" };
  }
  let outcome: ResourceArchitectTurnDraftOutcome | null;
  try {
    outcome = normalizeOutcome(parsed.outcome);
  } catch (error) {
    if (error instanceof ProposalRejection) return { ok: false, reason: error.message };
    throw error;
  }
  if (!outcome) return { ok: false, reason: "outcome is invalid" };
  return {
    ok: true,
    value: {
      message,
      outcome,
      warnings: stringList(parsed.warnings),
    },
  };
}

/**
 * Builds a typed list, or reports that the list could not be built.
 *
 * A `map` followed by a `some(entry => entry === null)` check leaves an array
 * still typed as possibly holding nulls, which is why passing it on used to
 * need an assertion. Collecting each constructed entry into a typed array
 * instead means nothing is ever claimed that was not built.
 *
 * The schema requires these arrays, so anything that is not an array fails the
 * outcome rather than reading as empty. Accepting a string where a list of
 * Agents belongs and calling it "no Agents" would turn a request the model got
 * wrong into a plan that quietly leaves the requested Agents out.
 */
function collectRequired<T>(
  value: unknown,
  build: (entry: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(value)) return null;
  const collected: T[] = [];
  for (const entry of value) {
    const built = build(entry);
    if (built === null) return null;
    collected.push(built);
  }
  return collected;
}

/** The same collector for a list the outcome cannot be empty of. */
function collectRequiredNonEmpty<T>(
  value: unknown,
  build: (entry: unknown) => T | null,
): T[] | null {
  const collected = collectRequired(value, build);
  return collected === null || collected.length === 0 ? null : collected;
}

/**
 * A required list of strings, with every entry usable.
 *
 * Dropping a blank or wrong-typed entry would accept a shorter list than the
 * model sent, which is the same silent rewrite the entry rule above exists to
 * prevent.
 */
function requiredStringList(value: unknown): string[] | null {
  return collectRequired(value, (entry) => {
    const text = stringValue(entry);
    return text.length > 0 ? text : null;
  });
}

export function normalizeOutcome(
  value: unknown,
): ResourceArchitectTurnDraftOutcome | null {
  if (!isObject(value)) return null;
  if (value.kind === "discussion") return { kind: "discussion" };
  if (value.kind === "edit_existing") {
    if (!isObject(value.target)) return null;
    const targetKind = value.target.kind;
    const targetId = stringValue(value.target.id);
    if ((targetKind !== "agent" && targetKind !== "team") || !targetId) return null;
    // The pointer opens a resource and writes nothing, so it pins nothing.
    // A revision the provider attached is dropped rather than carried on as
    // though something had checked it.
    return {
      kind: "edit_existing",
      target: { kind: targetKind, id: targetId },
    };
  }
  if (value.kind === "standalone_agents") {
    const agents = collectRequiredNonEmpty(value.agents, normalizeAgent);
    if (!agents) return null;
    return {
      id: stringValue(value.id) || "proposal",
      kind: "standalone_agents",
      agents,
    };
  }
  if (value.kind === "team") {
    const team = normalizeTeam(value.team);
    if (!team) return null;
    return {
      id: stringValue(value.id) || "proposal",
      kind: "team",
      team,
    };
  }
  if (value.kind === "resource_updates") {
    const operations = collectRequiredNonEmpty(value.operations, normalizeUpdateOperation);
    if (!operations) return null;
    return {
      id: stringValue(value.id) || "proposal",
      kind: "resource_updates",
      operations,
    };
  }
  return null;
}

/**
 * Reads one update operation from untrusted model output.
 *
 * The returned object is rebuilt field by field, so a revision, extra key, or
 * mismatched target kind the model sent never reaches the persisted plan.
 */
function normalizeUpdateOperation(value: unknown): ResourceUpdateOperationDraft | null {
  if (!isObject(value)) return null;
  if (value.kind === "update_agent_skills") return normalizeSkillUpdateOperation(value);
  if (value.kind !== "add_team_agents") return null;
  if (!isObject(value.target) || value.target.kind !== "team") return null;
  // Exact, like every other identity here. A trimmed ` contract-review-team `
  // is the id of a Team that really exists, so trimming would let the model
  // name one thing and the server mutate another.
  const targetId = exactString(value.target.id);
  if (!targetId) return null;
  // Exact names, because these are the Agents the operation adds. A trimmed
  // ` scoping-lawyer ` is checked against the library as `scoping-lawyer` and
  // then added as one: the model would name something that does not exist and
  // a real Agent would join the Team. Creation plans keep their own behaviour.
  const libraryAgentsToAdd = collectRequired(
    value.libraryAgentsToAdd,
    (entry) => withExactAgentName(normalizeExistingAgent(entry), entry),
  );
  const newAgentsToCreate = collectRequired(
    value.newAgentsToCreate,
    (entry) => withExactAgentName(normalizeTeamNewAgent(entry), entry),
  );
  if (!libraryAgentsToAdd || !newAgentsToCreate) return null;
  return {
    kind: "add_team_agents",
    target: { kind: "team", id: targetId },
    libraryAgentsToAdd,
    newAgentsToCreate,
  };
}

/**
 * One skill-update operation, rebuilt from named fields.
 *
 * The list may not be empty and may not lose an entry: a skill action the
 * model sent and this reader silently dropped would be a different proposal
 * from the one the user is about to authorize. Whether the named skills can
 * actually be created or updated is the server's decision, not this reader's.
 */
function normalizeSkillUpdateOperation(
  value: Record<string, unknown>,
): ResourceUpdateOperationDraft | null {
  if (!isObject(value.target) || value.target.kind !== "agent") return null;
  const targetId = exactString(value.target.id);
  if (!targetId) return null;
  const skillUpdates = collectRequiredNonEmpty(value.skillUpdates, normalizeSkillUpdate);
  if (!skillUpdates) return null;
  return {
    kind: "update_agent_skills",
    target: { kind: "agent", id: targetId },
    skillUpdates,
  };
}

function normalizeSkillUpdate(value: unknown): ResourceSkillUpdate | null {
  if (!isObject(value)) return null;
  const action = value.action;
  if (action !== "create" && action !== "update") return null;
  // The name is exact: it is the folder this update writes into and the `name`
  // its frontmatter must carry. The instruction is prose, so its surrounding
  // whitespace is normalized like every other narrative field here.
  const name = exactString(value.name);
  const instruction = stringValue(value.instruction);
  if (!name || !instruction) return null;
  return { action, name, instruction };
}

/**
 * The same Agent, with the name exactly as the provider wrote it.
 *
 * The shared normalizers trim every field, which is right for prose and wrong
 * for a name that will be looked up and written.
 */
function withExactAgentName<T extends { name: string }>(
  agent: T | null,
  raw: unknown,
): T | null {
  if (!agent || !isObject(raw)) return null;
  const name = raw.name;
  if (typeof name !== "string" || name.length === 0) return null;
  return { ...agent, name };
}

function normalizeAgent(value: unknown): AuthoredPlannedAgentSpec | null {
  if (!isObject(value)) return null;
  const name = stringValue(value.name);
  const role = stringValue(value.role);
  const description = stringValue(value.description);
  const rationale = stringValue(value.rationale);
  // No grade is read. Authoring stopped producing one, and a plan that carried
  // it would put a value in front of a reader that decides nothing.
  if (!name || !role || !description || !rationale) return null;
  try {
    validateExactAgentName(name);
  } catch {
    // A malformed generated identity is repairable provider output. Refuse it
    // here so the proposal loop gets its one correction attempt before the
    // server's materialization boundary has to reject the whole turn.
    return null;
  }
  if (value.webResearchEnabled !== undefined && typeof value.webResearchEnabled !== "boolean") return null;
  const summary = requirePlannedAgentSummary(name, value.summary, description);
  return { name, role, summary, description, rationale,
    ...(typeof value.webResearchEnabled === "boolean" ? { webResearchEnabled: value.webResearchEnabled } : {}),
  };
}

/**
 * The card summary of a newly proposed Agent, or a refusal that names it.
 *
 * Refused rather than clipped: a clipped sentence is copy nobody wrote, and the
 * repair turn can ask for a real one. Measured in code points, which is how
 * the provider schema's `maxLength` counts, so output the schema accepted is
 * never refused here for being written in characters outside the BMP.
 */
function requirePlannedAgentSummary(name: string, value: unknown, description: string): string {
  const summary = stringValue(value);
  if (!summary || Array.from(summary).length > MAX_PLANNED_AGENT_SUMMARY_LENGTH) {
    throw new ProposalRejection(
      `agent '${name}' needs a summary of 1-${MAX_PLANNED_AGENT_SUMMARY_LENGTH} characters for the proposal card; keep the detailed build brief in description`,
    );
  }
  if (copiesBuildBrief(summary, description)) {
    throw new ProposalRejection(
      `agent '${name}' summary copies its build brief; write the summary as its own sentence for the proposal card and keep the detailed build brief in description`,
    );
  }
  return summary;
}

/**
 * Whether a card summary is the build brief again rather than copy written for
 * the card: the whole brief, or its opening cut off before a sentence ends.
 *
 * The Architect's reviewer only sees conversation turns, never proposal JSON,
 * so this is the one place such a summary can be sent to repair. A brief that
 * opens with the summary sentence and goes on is fine. Letter case is ignored,
 * so a copy in lower case is still a copy. Whether a summary names the Agent's
 * purpose is left to the response contract, because no rule here could decide
 * it.
 */
function copiesBuildBrief(summary: string, description: string): boolean {
  const brief = description.replace(/\s+/gu, " ").toLowerCase();
  const marked = summary.replace(/\s+/gu, " ").toLowerCase();
  const card = marked.replace(/(?:\.\.\.|…)$/u, "").trimEnd();
  if (card === brief) return true;
  if (!brief.startsWith(card)) return false;
  // Dots at the end say the text was cut, whatever it was cut after.
  if (card !== marked) return true;
  const rest = brief.slice(card.length);
  // Only the brief's closing stop is left: the summary is the whole brief.
  if (/^[.!?]+["')\]”’]*$/u.test(rest)) return true;
  const endsSentence = /[.!?]["')\]”’]*$/u.test(card) && /^\s/u.test(rest);
  return !endsSentence && !/^[.!?]/u.test(rest);
}

function normalizeTeam(value: unknown): ResourceTeamPlan | null {
  if (!isObject(value)) return null;
  const teamId = stringValue(value.teamId);
  const description = stringValue(value.description);
  if (!teamId || !description) return null;
  const tags = requiredStringList(value.tags);
  const questionsResolved = requiredStringList(value.questionsResolved);
  const existingAgents = collectRequired(value.existingAgents, normalizeExistingAgent);
  const newAgents = collectRequired(value.newAgents, normalizeTeamNewAgent);
  const documentDomains = normalizeDocumentDomains(value.documentDomains);
  if (
    !tags ||
    !questionsResolved ||
    !existingAgents ||
    !newAgents ||
    documentDomains === null
  ) {
    return null;
  }
  const shape = normalizeTeamShape(value.shape, [
    ...existingAgents.map((agent) => agent.name),
    ...newAgents.map((agent) => agent.name),
  ]);
  return {
    teamId,
    description,
    tags,
    existingAgents,
    newAgents,
    ...(documentDomains === undefined ? {} : { documentDomains }),
    questionsResolved,
    ...(shape === undefined ? {} : { shape }),
  };
}

/**
 * The proposed interaction shape, rebuilt by the contract that defines it.
 *
 * Three cases, and they are not the same thing:
 *
 * - **absent, or explicitly null** — no shape was chosen. That is what a plan
 *   proposed before shapes existed carries, and it builds the chain generated
 *   teams have always built.
 * - **present but not a shape this app can build** — refused by name. Dropping
 *   it would build a different team from the one the proposal describes, and
 *   say nothing.
 * - **present and well-formed, but its roles do not fit the roster** — refused
 *   with the offending names. A proposal describes the *final* roster, so the
 *   partition rule applies here exactly as it does at amendment. Temporary
 *   assembly states are an internal matter and do not redefine what a valid
 *   proposal is.
 */
function normalizeTeamShape(
  value: unknown,
  roster: readonly string[],
): TeamShape | undefined {
  if (value === undefined || value === null) return undefined;
  const result = teamShapeSchema.safeParse(value);
  if (!result.success) {
    const kind = isObject(value) ? stringValue(value.kind) : undefined;
    throw new ProposalRejection(
      kind
        ? `team.shape kind '${kind}' is not one this app can build`
        : "team.shape is not a way a team can work together",
    );
  }
  const verdict = validateShapeAgainstRoster(result.data, roster);
  if (!verdict.ok) {
    const names = verdict.offendingNames?.length
      ? ` (${verdict.offendingNames.join(", ")})`
      : "";
    throw new ProposalRejection(`team.shape roles do not fit the team${names}: ${verdict.reason}`);
  }
  return result.data;
}

function normalizeTeamNewAgent(
  value: unknown,
): (ResourceTeamNewAgentPlan & AuthoredPlannedAgentSpec) | null {
  const agent = normalizeAgent(value);
  if (!agent || !isObject(value)) return null;
  const documentSpecialization = normalizeDocumentSpecialization(
    value.documentSpecialization,
  );
  if (documentSpecialization === null) return null;
  return {
    ...agent,
    ...(documentSpecialization === undefined ? {} : { documentSpecialization }),
  };
}

function normalizeDocumentDomains(
  value: unknown,
): ResourceTeamDocumentDomain[] | null | undefined {
  // Null is how the provider schema spells "absent". Codex requires the key on
  // every team, so a team with no document domains has to send something, and
  // null is the variant that says so without inventing a domain. Reading it as
  // malformed would discard the whole proposal.
  if (value === undefined || value === null) return undefined;
  return collectRequired(value, normalizeDocumentDomain);
}

function normalizeDocumentDomain(value: unknown): ResourceTeamDocumentDomain | null {
  if (!isObject(value)) return null;
  const domain = stringValue(value.domain);
  const evidenceAnchors = requiredStringList(value.evidenceAnchors);
  if (!domain || !evidenceAnchors || evidenceAnchors.length === 0) return null;
  return { domain, evidenceAnchors };
}

function normalizeDocumentSpecialization(
  value: unknown,
): ResourceTeamDocumentSpecialization | null | undefined {
  // Null means absent, for the same reason as `normalizeDocumentDomains`.
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) return null;
  const expertiseDomain = stringValue(value.expertiseDomain);
  const focus = stringValue(value.focus);
  const evidenceAnchors = requiredStringList(value.evidenceAnchors);
  const assessmentTargets = requiredStringList(value.assessmentTargets);
  const outOfScope = requiredStringList(value.outOfScope);
  if (
    !expertiseDomain ||
    !focus ||
    !evidenceAnchors ||
    !assessmentTargets ||
    !outOfScope ||
    evidenceAnchors.length === 0 ||
    assessmentTargets.length === 0 ||
    outOfScope.length === 0
  ) {
    return null;
  }
  return {
    expertiseDomain,
    focus,
    evidenceAnchors,
    assessmentTargets,
    outOfScope,
  };
}

function normalizeExistingAgent(value: unknown): ResourceTeamAgentPlan | null {
  if (!isObject(value)) return null;
  const name = stringValue(value.name);
  const role = stringValue(value.role);
  const rationale = stringValue(value.rationale);
  if (!name || !role || !rationale) return null;
  return { name, role, rationale };
}

function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i)?.[1];
  if (fenced) return fenced.trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (quoted) continue;
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A non-empty string kept exactly as it arrived.
 *
 * Identity fields go through this rather than `stringValue`. A trimmed
 * ` termination-clause-review ` is a different string from the one the model
 * sent, and it is a valid one: trimming here would manufacture a filesystem
 * identity the server's own rules would have refused, and the name that was
 * validated would not be the name that was published.
 */
function exactString(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "";
}

/**
 * Warnings, kept deliberately tolerant.
 *
 * A warning describes the answer, not a resource the answer proposes. Losing a
 * malformed note costs a note; refusing the proposal over one would cost the
 * work. Every other list the schema requires goes through `requiredStringList`.
 */
function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
