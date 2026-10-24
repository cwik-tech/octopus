import type {
  TeamBuilderDetail,
  TeamRosterAgent,
} from "@/lib/models/team-builder-model";

export function getTeamYaml(team: TeamBuilderDetail): string {
  return team.yaml?.trim() ? team.yaml : renderTeamYamlPreview(team);
}

export function renderTeamYamlPreview(team: TeamBuilderDetail): string {
  return ensureTrailingNewline(
    [
      "team:",
      `  name: ${quoteYaml(team.id)}`,
      "  description: >",
      ...blockLines(team.description || "No description.", 4),
      "",
      renderPreviewAgents(team.agents),
    ].join("\n"),
  );
}

function renderPreviewAgents(agents: TeamRosterAgent[]): string {
  if (agents.length === 0) return "agents: []";
  const lines = ["agents:"];
  for (const agent of agents) {
    lines.push(`  - name: ${quoteYaml(agent.name)}`);
    lines.push(`    type: ${agent.type}`);
    lines.push("    role: >");
    lines.push(...blockLines(agent.role || `${agent.name} library agent.`, 6));
    // Shown only where the member already declares one. The preview has to
    // match the file that will be written, and nothing written now has a grade
    // — but a member added before still does, and hiding that would make the
    // preview disagree with the roster on disk.
    if (agent.tier !== undefined) lines.push(`    tier: ${agent.tier}`);
    lines.push(renderPreviewStringList("    tools", agent.tools));
    if (agent.agent_file) {
      lines.push(`    agent_file: ${quoteYaml(agent.agent_file)}`);
    }
    if (agent.experience_enabled !== undefined) {
      lines.push(`    experience_enabled: ${agent.experience_enabled}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function renderPreviewStringList(label: string, values: string[]): string {
  if (values.length === 0) return `${label}: []`;
  const indent = (label.match(/^ */)?.[0].length ?? 0) + 2;
  const prefix = " ".repeat(indent);
  return [
    `${label}:`,
    ...values.map((value) => `${prefix}- ${quoteYaml(value)}`),
  ].join("\n");
}

function blockLines(text: string, indent: number): string[] {
  const collapsed = text.replace(/\s+/g, " ").trim() || "No description.";
  const prefix = " ".repeat(indent);
  return wrapText(collapsed, 76).map((line) => `${prefix}${line}`);
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : ["No description."];
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
