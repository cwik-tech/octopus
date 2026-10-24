/** Owns safe import, removal, and relocation of files in an agent package. */
import { whenDefined } from "../../core/optional-properties.js";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type {
  AgentDetail,
  AgentPackageAddKind,
  AgentPackageFileInput,
  AgentPackageImportAction,
  AgentPackageImportChoice,
  AgentPackageImportItem,
  AgentPackageRemoveMode,
} from "./types.js";
import { readAgentDetail } from "./list-agents.js";
import { preserveSkillSnapshot } from "./skill-preservation.js";

interface PackageImportPlanItem extends AgentPackageImportItem {
  file: AgentPackageFileInput;
  targetParts: string[];
}

export async function addAgentPackageFiles(params: {
  repoRoot: string;
  agentName: string;
  kind: AgentPackageAddKind;
  files: AgentPackageFileInput[];
}): Promise<AgentDetail> {
  const name = sanitizeAgentName(params.agentName);
  const agentDir = requireAgentDir(params.repoRoot, name);
  if (params.files.length === 0) {
    throw new Error("At least one file is required");
  }

  if (params.kind === "skill") {
    await addSkillFiles(agentDir, params.files);
  } else {
    const targetDir = path.join(agentDir, folderForKind(params.kind));
    await fs.mkdir(targetDir, { recursive: true });
    for (const file of params.files) {
      const fileName = sanitizeFileName(path.basename(file.relativePath));
      if (!fileName) throw new Error(`Invalid file name: ${file.relativePath}`);
      const target = nextAvailablePath(path.join(targetDir, fileName));
      await fs.writeFile(target, decodeBase64(file.contentBase64));
    }
  }

  return readAgentDetail(params.repoRoot, name);
}

export async function removeAgentPackageItem(params: {
  repoRoot: string;
  agentName: string;
  kind: AgentPackageAddKind;
  agentPath: string;
  mode?: AgentPackageRemoveMode;
}): Promise<AgentDetail> {
  const name = sanitizeAgentName(params.agentName);
  const agentDir = requireAgentDir(params.repoRoot, name);

  if (params.kind === "skill") {
    const skillName = sanitizeAgentName(
      params.agentPath.replace(/^skills\//, "").split("/")[0] ?? "",
    );
    if (!skillName) throw new Error("Skill name is required");
    if ((params.mode ?? "delete") === "disconnect") {
      await preserveSkillCopy(params.repoRoot, agentDir, skillName);
    }
    await fs.rm(path.join(agentDir, "skills", skillName), {
      recursive: true,
      force: true,
    });
    await removeEmptyParents(path.join(agentDir, "skills"), agentDir);
    return readAgentDetail(params.repoRoot, name);
  }

  const target = safeAgentPath(agentDir, params.agentPath);
  if (path.resolve(target) === path.resolve(agentDir, `${name}.md`)) {
    throw new Error("Persona files cannot be removed from package tabs");
  }
  const stat = await fs.stat(target).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`Package file does not exist: ${params.agentPath}`);
  }
  await fs.rm(target, { force: true });
  await removeEmptyParents(path.dirname(target), agentDir);

  return readAgentDetail(params.repoRoot, name);
}

export function previewAgentPackageImport(params: {
  repoRoot: string;
  agentName: string;
  preferredKind: AgentPackageAddKind;
  files: AgentPackageFileInput[];
}): { items: AgentPackageImportItem[] } {
  const name = sanitizeAgentName(params.agentName);
  const agentDir = requireAgentDir(params.repoRoot, name);
  const items = buildImportPlan(agentDir, params.preferredKind, params.files)
    .map(({ file: _file, targetParts: _targetParts, ...item }) => item);
  return { items };
}

export async function commitAgentPackageImport(params: {
  repoRoot: string;
  agentName: string;
  preferredKind: AgentPackageAddKind;
  files: AgentPackageFileInput[];
  choices: AgentPackageImportChoice[];
}): Promise<AgentDetail> {
  const name = sanitizeAgentName(params.agentName);
  const agentDir = requireAgentDir(params.repoRoot, name);
  const choiceById = new Map(params.choices.map((choice) => [choice.id, choice]));
  const plan = buildImportPlan(agentDir, params.preferredKind, params.files);

  for (const item of plan) {
    const choice = choiceById.get(item.id);
    const selected = choice?.selected ?? item.defaultSelected;
    if (!selected) continue;

    const action = normalizeImportAction(
      choice?.action ?? item.defaultAction,
      item,
    );
    if (action === "skip") continue;

    const baseTarget = path.join(agentDir, ...item.targetParts);
    const target =
      action === "keepBoth" || (item.exists && action === "add")
        ? nextAvailablePath(baseTarget)
        : baseTarget;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, decodeBase64(item.file.contentBase64));
  }

  return readAgentDetail(params.repoRoot, name);
}

function buildImportPlan(
  agentDir: string,
  preferredKind: AgentPackageAddKind,
  files: AgentPackageFileInput[],
): PackageImportPlanItem[] {
  if (files.length === 0) {
    throw new Error("At least one file is required");
  }

  const skillRoots = detectSkillRoots(files);
  const items = files
    .map((file) => planFileImport(agentDir, preferredKind, file, skillRoots))
    .filter((item): item is PackageImportPlanItem => item !== null);

  if (items.length === 0) {
    throw new Error("No importable files were found");
  }
  items.sort((a, b) => a.targetAgentPath.localeCompare(b.targetAgentPath));
  return items;
}

function planFileImport(
  agentDir: string,
  preferredKind: AgentPackageAddKind,
  file: AgentPackageFileInput,
  skillRoots: Set<string>,
): PackageImportPlanItem | null {
  const sourceParts = safeRelativeParts(file.relativePath);
  if (sourceParts.length === 0) return null;

  const skillRoot = findSkillRoot(sourceParts, skillRoots);
  const targetParts = skillRoot
    ? targetPartsForSkillFile(sourceParts, skillRoot)
    : targetPartsForStandaloneFile(preferredKind, sourceParts);
  if (targetParts.length === 0) return null;

  const targetAgentPath = targetParts.join("/");
  const target = path.join(agentDir, ...targetParts);
  const exists = fsSync.existsSync(target);
  const kind = classifyTargetParts(targetParts);

  return {
    id: itemId(file.relativePath, targetAgentPath),
    kind,
    label: labelForTarget(targetParts, kind),
    sourcePath: sourceParts.join("/"),
    targetAgentPath,
    ...whenDefined(targetParts[0] === "skills" ? targetParts[1] : undefined, (parentSkill) => ({ parentSkill })),
    exists,
    defaultSelected: !exists && kind === preferredKind,
    defaultAction: exists ? "skip" : "add",
    availableActions: exists
      ? ["skip", "replace", "keepBoth"]
      : ["add", "skip"],
    file,
    targetParts,
  };
}

function detectSkillRoots(files: AgentPackageFileInput[]): Set<string> {
  const roots = new Set<string>();
  for (const file of files) {
    const parts = safeRelativeParts(file.relativePath);
    const skillMdIndex = parts.lastIndexOf("SKILL.md");
    if (skillMdIndex < 0) continue;
    const root = skillMdIndex > 0 ? parts[skillMdIndex - 1] ?? "__root__" : "__root__";
    roots.add(root);
  }
  return roots;
}

function findSkillRoot(parts: string[], roots: Set<string>): string | null {
  if (roots.has("__root__") && parts.includes("SKILL.md")) return "__root__";
  for (const root of roots) {
    if (root !== "__root__" && parts[0] === root) return root;
  }
  return null;
}

function targetPartsForSkillFile(parts: string[], root: string): string[] {
  const skillName =
    root === "__root__"
      ? sanitizeAgentName(path.basename(parts[0] ?? "imported-skill", path.extname(parts[0] ?? "")))
      : sanitizeAgentName(root);
  if (!skillName) throw new Error(`Invalid skill folder: ${root}`);
  const relativeParts = root === "__root__" ? parts : parts.slice(1);
  return ["skills", skillName, ...relativeParts];
}

function targetPartsForStandaloneFile(
  preferredKind: AgentPackageAddKind,
  parts: string[],
): string[] {
  const fileName = sanitizeFileName(parts[parts.length - 1] ?? "");
  if (!fileName) return [];
  if (preferredKind === "skill") {
    throw new Error("Selected skill folder must contain SKILL.md");
  }
  const detectedKind = detectStandaloneKind(parts) ?? preferredKind;
  return [folderForKind(detectedKind), fileName];
}

function detectStandaloneKind(
  parts: string[],
): Exclude<AgentPackageAddKind, "skill"> | null {
  if (parts.includes("templates")) return "template";
  if (parts.includes("references")) return "reference";
  if (parts.includes("scripts")) return "script";
  if (parts.includes("knowledge") || parts.includes("experience")) return "context";
  return null;
}

function classifyTargetParts(parts: string[]): AgentPackageAddKind {
  if (parts[0] === "skills" && parts.length >= 3) {
    if (parts.includes("templates")) return "template";
    if (parts.includes("references")) return "reference";
    if (parts.includes("scripts")) return "script";
    if (parts[2] === "SKILL.md") return "skill";
    return "skill";
  }
  if (parts[0] === "templates") return "template";
  if (parts[0] === "references") return "reference";
  if (parts[0] === "scripts") return "script";
  return "context";
}

function labelForTarget(parts: string[], kind: AgentPackageAddKind): string {
  if (kind === "skill" && parts[0] === "skills") {
    return parts[1] ?? "skill";
  }
  return parts[parts.length - 1] ?? kind;
}

function normalizeImportAction(
  action: AgentPackageImportAction,
  item: AgentPackageImportItem,
): AgentPackageImportAction {
  if (item.availableActions.includes(action)) return action;
  return item.defaultAction;
}

function itemId(sourcePath: string, targetAgentPath: string): string {
  return Buffer.from(`${sourcePath}\0${targetAgentPath}`).toString("base64url");
}

async function addSkillFiles(
  agentDir: string,
  files: AgentPackageFileInput[],
): Promise<void> {
  const grouped = new Map<string, AgentPackageFileInput[]>();
  for (const file of files) {
    const parts = safeRelativeParts(file.relativePath);
    const root = parts.length > 1 ? parts[0] : "";
    const groupKey = root || "__root__";
    grouped.set(groupKey, [...(grouped.get(groupKey) ?? []), file]);
  }

  for (const [groupKey, groupFiles] of grouped) {
    const skillFile = groupFiles.find((file) => {
      const parts = safeRelativeParts(file.relativePath);
      return groupKey === "__root__"
        ? parts.length === 1 && parts[0] === "SKILL.md"
        : parts.length === 2 && parts[0] === groupKey && parts[1] === "SKILL.md";
    });
    if (!skillFile) {
      throw new Error("Selected skill folder must contain SKILL.md");
    }

    const skillParts = safeRelativeParts(skillFile.relativePath);
    const rootName = groupKey === "__root__" ? "imported-skill" : groupKey;
    const targetSkillName = sanitizeAgentName(rootName);
    if (!targetSkillName) throw new Error(`Invalid skill folder: ${rootName}`);
    const targetSkillDir = nextAvailablePath(
      path.join(agentDir, "skills", targetSkillName),
    );
    await fs.mkdir(targetSkillDir, { recursive: true });

    for (const file of groupFiles) {
      const parts = safeRelativeParts(file.relativePath);
      const relativeParts =
        groupKey === "__root__" ? parts : parts.slice(1);
      if (relativeParts.length === 0) continue;
      const target = path.join(targetSkillDir, ...relativeParts);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, decodeBase64(file.contentBase64));
    }

    const writtenSkillMd = path.join(
      targetSkillDir,
      ...skillParts.slice(groupKey === "__root__" ? 0 : 1),
    );
    if (!fsSync.existsSync(writtenSkillMd)) {
      throw new Error("Failed to import selected skill folder");
    }
  }
}

async function preserveSkillCopy(
  repoRoot: string,
  agentDir: string,
  skillName: string,
): Promise<void> {
  await preserveSkillSnapshot({
    repoRoot,
    source: path.join(agentDir, "skills", skillName),
    skillName,
  });
}

function folderForKind(kind: Exclude<AgentPackageAddKind, "skill">): string {
  if (kind === "template") return "templates";
  if (kind === "reference") return "references";
  if (kind === "script") return "scripts";
  return "knowledge";
}

function requireAgentDir(repoRoot: string, agentName: string): string {
  if (!agentName) {
    throw new Error("agentName must be a non-empty kebab-case identifier");
  }
  const agentDir = path.join(repoRoot, "agents", agentName);
  const personaPath = path.join(agentDir, `${agentName}.md`);
  if (!fsSync.existsSync(personaPath)) {
    throw new Error(`Agent does not exist: ${agentName}`);
  }
  return agentDir;
}

function safeAgentPath(agentDir: string, agentPath: string): string {
  const parts = safeRelativeParts(agentPath);
  if (parts.length === 0) throw new Error("agentPath is required");
  const target = path.resolve(agentDir, ...parts);
  const root = path.resolve(agentDir);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("agentPath must stay inside the agent folder");
  }
  return target;
}

function safeRelativeParts(filePath: string): string[] {
  return filePath
    .replaceAll("\\", "/")
    .split("/")
    .map((part) => {
      const trimmed = part.trim();
      if (trimmed === "." || trimmed === "..") {
        throw new Error("Package paths cannot contain traversal segments");
      }
      return trimmed;
    })
    .filter(Boolean)
    .map(sanitizeFileName);
}

function sanitizeFileName(input: string): string {
  return input.replace(/[/:\\\0]/g, "-").trim();
}

function decodeBase64(value: string): Buffer {
  return Buffer.from(value, "base64");
}

function nextAvailablePath(target: string): string {
  if (!fsSync.existsSync(target)) return target;
  const parent = path.dirname(target);
  const parsed = path.parse(target);
  let index = 2;
  while (true) {
    const candidate = path.join(
      parent,
      `${parsed.name}-${index}${parsed.ext}`,
    );
    if (!fsSync.existsSync(candidate)) return candidate;
    index += 1;
  }
}

async function removeEmptyParents(dir: string, stopDir: string): Promise<void> {
  const stop = path.resolve(stopDir);
  let current = path.resolve(dir);
  while (current.startsWith(`${stop}${path.sep}`)) {
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function sanitizeAgentName(input: string): string {
  const trimmed = (input || "").trim().toLowerCase();
  return trimmed.replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
}
