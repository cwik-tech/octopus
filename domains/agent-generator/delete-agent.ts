/** Deletes agent packages while preserving or removing their shared skills by policy. */
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type {
  AgentDeletePreview,
  AgentDeleteResult,
  AgentSkillUsage,
} from "./types.js";
import { listAgents, readAgentDetail } from "./list-agents.js";
import { preserveSkillSnapshot } from "./skill-preservation.js";

export function previewAgentDelete(
  repoRoot: string,
  agentName: string,
): AgentDeletePreview {
  const name = sanitizeAgentName(agentName);
  if (!name) {
    throw new Error("agentName must be a non-empty kebab-case identifier");
  }

  const agent = readAgentDetail(repoRoot, name);
  return {
    agentName: name,
    skills: buildSkillUsage(repoRoot, name, agent.skills),
  };
}

export async function deleteAgent(params: {
  repoRoot: string;
  agentName: string;
  deleteSkills: boolean;
}): Promise<AgentDeleteResult> {
  const preview = previewAgentDelete(params.repoRoot, params.agentName);
  const agentDir = path.join(params.repoRoot, "agents", preview.agentName);
  const skillsDir = path.join(agentDir, "skills");
  const globalSkillsDir = path.join(params.repoRoot, "skills");

  const deletedSkills: string[] = [];
  const preservedSkills: string[] = [];
  const preservedSkillPaths: string[] = [];

  if (params.deleteSkills) {
    deletedSkills.push(...preview.skills.map((skill) => skill.name));
  } else if (fsSync.existsSync(skillsDir)) {
    await fs.mkdir(globalSkillsDir, { recursive: true });
    for (const skill of preview.skills) {
      const preservedPath = await preserveSkillSnapshot({
        repoRoot: params.repoRoot,
        source: path.join(skillsDir, skill.name),
        skillName: skill.name,
      });
      preservedSkills.push(skill.name);
      preservedSkillPaths.push(toRepoRelative(params.repoRoot, preservedPath));
    }
  }

  await fs.rm(agentDir, { recursive: true, force: true });

  return {
    ...preview,
    deleted: true,
    deleteSkills: params.deleteSkills,
    deletedSkills,
    preservedSkills,
    preservedSkillPaths,
  };
}

function buildSkillUsage(
  repoRoot: string,
  agentName: string,
  skillNames: string[],
): AgentSkillUsage[] {
  const agents = listAgents(repoRoot);
  return skillNames.sort().map((skillName) => {
    const usedByAgents = agents
      .filter(
        (agent) =>
          agent.name !== agentName && agent.skills.includes(skillName),
      )
      .map((agent) => agent.name)
      .sort();

    return {
      name: skillName,
      usedByAgents,
      usedByCount: usedByAgents.length,
    };
  });
}

function toRepoRelative(repoRoot: string, absPath: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join("/");
}

function sanitizeAgentName(input: string): string {
  const trimmed = (input || "").trim().toLowerCase();
  return trimmed.replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
}
