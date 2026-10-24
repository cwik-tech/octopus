/** Applies the agent persona visibility contract used by catalogs and registries. */
import { parseAgentFrontmatter } from "../../parsers/load-agent.js";

export function isAgentHiddenFromUi(
  frontmatter: Readonly<Record<string, string>>,
): boolean {
  return frontmatter.ui_hidden?.trim().toLowerCase() === "true";
}

/**
 * Whether this persona belongs to the runtime rather than to the library.
 *
 * Separate from `ui_hidden` because the two answer different questions.
 * `ui_hidden` means "the app must not show this at all". `system` means "the
 * user does not pick this, but they do own it": the front door is never a Run
 * target and never a team member, and is still theirs to open and edit in
 * Create.
 */
export function isSystemAgent(
  frontmatter: Readonly<Record<string, string>>,
): boolean {
  return frontmatter.system?.trim().toLowerCase() === "true";
}

export function isAgentFileHiddenFromUi(agentFile: string): boolean {
  try {
    return isAgentHiddenFromUi(parseAgentFrontmatter(agentFile).frontmatter);
  } catch {
    return false;
  }
}
