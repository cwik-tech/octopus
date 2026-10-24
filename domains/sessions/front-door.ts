/**
 * The Run front door: one agent that answers every untargeted turn.
 *
 * Everything here is pure. The registries this reads from live a layer away,
 * and keeping the rendering separate from the reading is what lets a test
 * state the catalog it wants without a repository on disk.
 */

export {
  GENERAL_AGENT_LABEL,
  GENERAL_AGENT_NAME,
} from "../../contracts/front-door.js";
import { GENERAL_AGENT_NAME } from "../../contracts/front-door.js";

export function isFrontDoorAgent(agentName: string): boolean {
  return agentName === GENERAL_AGENT_NAME;
}

/** One registered Team, as the front door needs to see it. */
export interface FrontDoorTeam {
  readonly id: string;
  readonly description?: string;
}

/** One registered Workflow, as the front door needs to see it. */
export interface FrontDoorWorkflow {
  readonly id: string;
  readonly description?: string;
}

/**
 * The session-chat rules the front door replaces.
 *
 * An ordinary agent is told not to append routing choices and not to offer
 * more work, which is the whole behaviour this identity exists to provide. The
 * exception is scoped to this one speaker rather than loosened for everybody:
 * a selected specialist that started proposing workflows would be a
 * regression, not a feature.
 */
export const FRONT_DOOR_REPLY_RULES: readonly string[] = [
  "- Answer the user's question directly and completely. The answer is the reply; routing is not a substitute for one.",
  "- Material already in this conversation is yours to read, quote and summarize: earlier messages, replies other agents gave in it, uploaded files, and the text of any delivered document included below.",
  "- After the answer, when exactly one registered Team or Workflow clearly fits the request, name it in one closing sentence and say why. Otherwise close on the answer.",
  "- Never propose something that is not in the catalog below, and never name more than one option.",
  "- Nothing you say starts anything on its own. When the user clearly confirms a Workflow you proposed — for example \"go for it\", \"start\", or \"yes, run it\" — start it with the start_workflow tool, and never claim a start the tool did not confirm. A proposal's closing sentence invites a chat confirmation, such as \"say the word and I'll start it\", rather than naming a button.",
  "- Results the user chose to carry into this turn appear below with their content, and those are yours to read, quote and summarize as well. A result marked truncated says so; never present an excerpt as the whole document.",
  "- You still cannot open anything nobody put in front of you. If the user asks about a run that is neither in this conversation nor carried into this turn, say you cannot open it and that they can attach it, rather than describing what it might have produced.",
];

/** The persona heading whose body is the planning-mode prompt. */
const PLANNING_SECTION_HEADING = "## Planning mode";

/**
 * The planning rules a persona states, if it states any.
 *
 * A section of the same persona rather than a file of its own, because
 * planning is a mode of one identity: the user opens the General Agent in
 * Create and sees both how it answers and how it readies a plan. `undefined`
 * when the section is absent, which is what a repository trimmed of its front
 * door has, and the caller then keeps the built-in rules.
 */
export function extractPlanningRules(
  personaMarkdown: string,
): string | undefined {
  const lines = personaMarkdown.split("\n");
  const start = lines.findIndex(
    (line) => line.trim() === PLANNING_SECTION_HEADING,
  );
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  // Ends at the next heading of the same level or higher. A deeper heading is
  // part of the section, so a persona may organise its planning rules without
  // silently losing half of them.
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line.trim()));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body || undefined;
}

/**
 * The Teams and Workflows the front door may propose.
 *
 * Rendered into the user message rather than the system prompt because it is
 * a fact about this session's registries at this moment, and the same shape
 * the architect's registry block already uses: an id, and what it is for.
 */
export function renderFrontDoorCatalog(input: {
  teams: readonly FrontDoorTeam[];
  workflows: readonly FrontDoorWorkflow[];
}): string {
  const lines: string[] = [];
  lines.push("Registered teams (propose only these):");
  if (input.teams.length === 0) {
    lines.push("(none registered)");
  } else {
    for (const team of input.teams) {
      lines.push(`- ${team.id}${team.description ? ` — ${team.description}` : ""}`);
    }
  }
  lines.push("");
  lines.push("Registered workflows (propose only these):");
  if (input.workflows.length === 0) {
    lines.push("(none registered)");
  } else {
    for (const workflow of input.workflows) {
      lines.push(
        `- ${workflow.id}${workflow.description ? ` — ${workflow.description}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}
