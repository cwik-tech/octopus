import { readPersonaToolNames, writePersonaToolNames } from "../../contracts/persona-tools.js";

/** Applies the internet choice approved on the proposal card to generated tools. */
export function applyPlannedWebResearch(markdown: string, enabled: boolean | undefined): string {
  const tools = readPersonaToolNames(markdown).filter((tool) => !["browser", "research_web"].includes(tool));
  if (enabled === true) tools.push("research_web");
  return writePersonaToolNames(markdown, tools);
}
