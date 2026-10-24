/** Builds bounded Agent Architect context from the repository-owned agent library. */
import * as fs from "node:fs";
import * as path from "node:path";

import type { AgentAssetFile, AgentDetail, AgentSummary } from "./types.js";
import { listAgents, readAgentDetail } from "./list-agents.js";

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".tsv",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".sh",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".sql",
]);

export function renderAgentLibraryContextBlock(params: {
  repoRoot: string;
  focusAgentName?: string;
}): string {
  const agents = listAgents(params.repoRoot);
  const lines: string[] = [];
  lines.push("## Agent library context");
  lines.push("Use only this agent/package context for agent-page questions.");
  if (agents.length === 0) {
    lines.push("");
    lines.push("(No agents are currently available.)");
    return lines.join("\n");
  }

  for (const summary of agents) {
    if (params.focusAgentName && summary.name === params.focusAgentName) {
      lines.push("");
      lines.push(renderFocusedAgentBlock(params.repoRoot, summary.name));
    } else {
      lines.push("");
      lines.push(renderAgentSummary(summary));
    }
  }

  return lines.join("\n");
}

function renderAgentSummary(agent: AgentSummary): string {
  const lines: string[] = [];
  lines.push(`- **${agent.name}**`);
  if (agent.description) lines.push(`    description: ${agent.description}`);
  if (agent.provider || agent.model) {
    lines.push(`    model: ${[agent.provider, agent.model].filter(Boolean).join("/")}`);
  }
  if (agent.skills.length > 0) lines.push(`    skills: ${agent.skills.join(", ")}`);
  if (agent.usedInTeams.length > 0) {
    lines.push(`    used_in: ${agent.usedInTeams.map((team) => team.teamId).join(", ")}`);
  }
  return lines.join("\n");
}

function renderFocusedAgentBlock(repoRoot: string, agentName: string): string {
  let snapshot: AgentPackageSnapshot;
  try {
    snapshot = readAgentPackageSnapshot(repoRoot, agentName);
  } catch (error) {
    return [
      `- **${agentName}**`,
      `    error: ${error instanceof Error ? error.message : String(error)}`,
    ].join("\n");
  }

  const { detail } = snapshot;
  const lines: string[] = [];
  lines.push(`- **${detail.name}** (selected agent)`);
  if (detail.description) lines.push(`    description: ${detail.description}`);
  if (detail.provider || detail.model) {
    lines.push(`    model: ${[detail.provider, detail.model].filter(Boolean).join("/")}`);
  }
  if (detail.usedInTeams.length > 0) {
    lines.push(`    used_in: ${detail.usedInTeams.map((team) => team.teamId).join(", ")}`);
  }
  lines.push(renderAgentPackageDetailBody(snapshot));
  return lines.join("\n");
}

/** One saved package file, with its text when it has any. */
export interface AgentPackageFile {
  readonly asset: AgentAssetFile;
  /** The file's text, or null for a binary or unsupported file. */
  readonly content: string | null;
  /** Why a text file could not be read, when it could not. */
  readonly readError?: string;
}

/** An Agent package as saved on disk: the inspector's detail plus file contents. */
export interface AgentPackageSnapshot {
  readonly detail: AgentDetail;
  readonly files: readonly AgentPackageFile[];
}

/**
 * Read the saved package the Agent inspector shows.
 *
 * Throws only when the Agent itself cannot be read. A single file that
 * vanished or cannot be opened is reported on that file, so one unreadable
 * asset cannot hide the rest of the package.
 */
export function readAgentPackageSnapshot(
  repoRoot: string,
  agentName: string,
): AgentPackageSnapshot {
  const detail = readAgentDetail(repoRoot, agentName);
  const files = detail.assets.map((asset): AgentPackageFile => {
    try {
      return { asset, content: readTextAsset(repoRoot, asset.path) };
    } catch (error) {
      return { asset, content: null, readError: describeReadError(error) };
    }
  });
  return { detail, files };
}

/**
 * The package facts both Agent consumers share: counts, the full persona,
 * skill metadata, and every package file with its text.
 *
 * Pure. Each consumer adds its own heading and summary around it.
 */
export function renderAgentPackageDetailBody(snapshot: AgentPackageSnapshot): string {
  const { detail } = snapshot;
  const lines: string[] = [];
  lines.push(
    `    counts: ${Object.entries(detail.counts)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ")}`,
  );
  lines.push("    persona:");
  lines.push(indentFence("md", detail.personaMarkdown.trim(), "      "));

  if (detail.skillDetails.length > 0) {
    lines.push("    skills:");
    for (const skill of detail.skillDetails) {
      lines.push(`      - ${skill.name}${skill.description ? ` - ${skill.description}` : ""}`);
      lines.push(`          path: ${skill.path}`);
      const files = skill.files.map((file) => file.agentPath);
      if (files.length > 0) lines.push(`          files: ${files.join(", ")}`);
    }
  }

  if (snapshot.files.length > 0) {
    lines.push("    package_files:");
    for (const { asset, content, readError } of snapshot.files) {
      lines.push(`      - ${asset.agentPath} [${asset.kind}, ${asset.sizeBytes} bytes]`);
      if (readError !== undefined) {
        lines.push(`          content: (could not be read: ${readError})`);
      } else if (content === null) {
        lines.push("          content: (binary or unsupported text file)");
      } else {
        lines.push("          content:");
        lines.push(indentFence(extensionLanguage(asset.agentPath), content.trim(), "            "));
      }
    }
  }

  return lines.join("\n");
}

function describeReadError(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

function readTextAsset(repoRoot: string, repoRelativePath: string): string | null {
  const extension = path.extname(repoRelativePath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) return null;
  const absPath = path.resolve(repoRoot, repoRelativePath);
  const relative = path.relative(repoRoot, absPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const buffer = fs.readFileSync(absPath);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function extensionLanguage(filePath: string): string {
  const extension = path.extname(filePath).replace(/^\./, "").toLowerCase();
  if (extension === "yml") return "yaml";
  if (extension === "txt") return "text";
  return extension || "text";
}

function indentFence(language: string, value: string, prefix: string): string {
  return [
    `${prefix}\`\`\`${language}`,
    ...value.split("\n").map((line) => `${prefix}${line}`),
    `${prefix}\`\`\``,
  ].join("\n");
}
